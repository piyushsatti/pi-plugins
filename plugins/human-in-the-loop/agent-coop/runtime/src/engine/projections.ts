// Projections (db-design §2). Every table here is derived from the event log
// and written ONLY by this module, called only from the engine's single
// transaction. Nothing in here reads the clock or generates an id: every value
// comes from the event, so replay reproduces projections exactly.
import type { Database } from "bun:sqlite";
import type { AnchorState, Event, SessionState } from "../contract/index.ts";
import type { Decision } from "./reducer.ts";

/** Tables rebuilt wholesale by a replay-from-zero. `session`/`document` are
 *  CRUD lifecycle rows (db-design §2), not projections, and are NOT listed. */
export const PROJECTION_TABLES = [
  "session_state",
  "revision",
  "comment",
  "attachment",
  "attachment_pending_gc",
  "checkpoint",
] as const;

/**
 * `revision.id` is a PRIMARY KEY, but a snapshot's `revision_id` is not unique
 * across a multi-doc session: one snapshot stamps one row per document. These two
 * functions are the suffix rule and its inverse, and they live side by side so
 * that neither can drift from the other.
 *
 * Only the LABEL crosses the seam. It is what the `revision_created` SSE frame
 * carries, what `?to=` and `?revision=` accept, and what `Revision.revision_id`
 * reports. The suffixed row id is a primary key and nothing else; a client that
 * saw it could not match it against the frame it was told about.
 */
const REVISION_SUFFIX = /:\d+$/;

export function revisionRowId(label: string, index: number, docCount: number): string {
  return docCount === 1 ? label : `${label}:${index}`;
}

export function revisionLabel(rowId: string): string {
  return rowId.replace(REVISION_SUFFIX, "");
}

/**
 * The one revision ROW a (document, label) pair names, or null.
 *
 * A label alone does not identify a row, and the row id is not derivable from the
 * label either: `revisionRowId` needs the document's INDEX in the session's
 * document list AT SNAPSHOT TIME, and documents added since would move it. So the
 * lookup goes the other way — narrow to the document, then match on the inverse
 * `revisionLabel`, which is exact by construction.
 *
 * Never pattern-match the id instead (`id = ? OR id LIKE ? || ':%'`): a label is
 * caller-supplied and a `%` in it would silently widen the match.
 */
export function revisionRowIdForLabel(db: Database, doc_id: string, label: string): string | null {
  const rows = db
    .query<{ id: string }, [string]>("SELECT id FROM revision WHERE document_id = ?")
    .all(doc_id);
  return rows.find((r) => revisionLabel(r.id) === label)?.id ?? null;
}

export function getState(db: Database, session_id: string): SessionState | null {
  const row = db
    .query<{ state: string }, [string]>("SELECT state FROM session_state WHERE session_id = ?")
    .get(session_id);
  return (row?.state as SessionState) ?? null;
}

export type ProjectOptions = {
  /** Binary Yjs diff to persist for a user_edit/claude_apply. Null during a
   *  projection-only replay: document_updates is already on disk. */
  doc_update?: Uint8Array | null;
};

/**
 * Apply one event's effects to the projection tables. Caller supplies the
 * decision so a legal no-op (duplicate client_edit_id, pull during
 * CLAUDE_TURN) still appends the event but writes nothing else.
 */
export function projectEvent(
  db: Database,
  event: Event,
  decision: Extract<Decision, { ok: true }>,
  opts: ProjectOptions = {},
): void {
  const { session_id, seq, created_at } = event;

  if (decision.transition !== null) {
    // turn_started_at_seq marks an OPEN turn: `submit`/`pull` move it forward,
    // `cancel` clears it (PI-4) because after a cancel no turn is open, and a
    // leftover seq would have the next pull report a turn that was called off.
    db.run(
      `UPDATE session_state SET state = ?, updated_at_seq = ?,
         turn_started_at_seq = CASE
           WHEN ? IN ('submit','pull') THEN ?
           WHEN ? = 'cancel' THEN NULL
           ELSE turn_started_at_seq END
       WHERE session_id = ?`,
      [decision.transition.to, seq, event.type, seq, event.type, session_id],
    );
  }

  if (!decision.noop) {
    switch (event.type) {
      case "doc_added": {
        // The document row and its first update land together (A1, PI-2), row
        // first: document_updates has a foreign key to it.
        //
        // Upsert rather than plain INSERT because `document` is NOT in
        // PROJECTION_TABLES — a replay does not delete it (documents seeded at
        // session creation are CRUD rows no event describes, and dropping them
        // would destroy data), so replaying this event meets its own row. Every
        // value written comes from the event, so the upsert is reproducible.
        db.run(
          `INSERT INTO document (id, session_id, title, source_path, export_path, created_at)
           VALUES (?, ?, ?, NULL, NULL, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, created_at = excluded.created_at`,
          [event.doc_id, session_id, event.title, created_at],
        );
        if (opts.doc_update != null) {
          db.run(
            `INSERT INTO document_updates (document_id, seq, kind, "update", created_at)
             VALUES (?, ?, 'update', ?, ?)`,
            [event.doc_id, seq, opts.doc_update, created_at],
          );
        }
        break;
      }

      case "user_edit":
      case "claude_apply": {
        if (opts.doc_update != null) {
          db.run(
            `INSERT INTO document_updates (document_id, seq, kind, "update", created_at)
             VALUES (?, ?, 'update', ?, ?)`,
            [event.doc_id, seq, opts.doc_update, created_at],
          );
        }
        break;
      }

      case "comment_create": {
        const c = event.comment;
        // D-gap: the contract's comment_create payload carries no comment_id,
        // so the event_id IS the comment_id. Deterministic under replay.
        db.run(
          `INSERT INTO comment (comment_id, session_id, doc_id, block_id, relative_position,
             relative_position_end, quoted_text, text, delivery, parent_id, status, resolved_by,
             anchor_state, created_at_seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, 'attached', ?, ?, ?)`,
          [
            event.event_id,
            session_id,
            // doc_id is stored for global comments too: the contract's Comment
            // carries a non-null doc_id, and GET /api/comments?doc_id= must
            // return whole-document comments alongside anchored ones (A4).
            c.doc_id,
            c.anchor?.block_id ?? null,
            c.anchor?.relative_position ?? null,
            // PI-6: the anchored TAIL, so the highlight's extent is Yjs's answer
            // rather than a length frozen at creation.
            c.anchor?.relative_position_end ?? null,
            c.anchor?.quoted_text ?? null,
            c.text,
            c.delivery,
            c.parent_id,
            seq,
            created_at,
            created_at,
          ],
        );
        break;
      }

      case "comment_reply": {
        // Reply = new row; nothing about the parent changes (COV-F7).
        const parent = db
          .query<{ doc_id: string | null; delivery: string }, [string]>(
            "SELECT doc_id, delivery FROM comment WHERE comment_id = ?",
          )
          .get(event.parent_id);
        // A reply carries no anchor of its own, so relative_position and
        // relative_position_end are both left NULL: `anchor === null` is what
        // makes it a thread entry rather than a highlight.
        db.run(
          `INSERT INTO comment (comment_id, session_id, doc_id, text, delivery, parent_id,
             status, resolved_by, anchor_state, created_at_seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, 'attached', ?, ?, ?)`,
          [
            event.comment_id,
            session_id,
            parent?.doc_id ?? null,
            event.text,
            parent?.delivery ?? "queued",
            event.parent_id,
            seq,
            created_at,
            created_at,
          ],
        );
        break;
      }

      case "comment_resolve":
        db.run(
          "UPDATE comment SET status = 'resolved', resolved_by = ?, updated_at = ? WHERE comment_id = ?",
          [event.resolved_by, created_at, event.comment_id],
        );
        break;

      case "snapshot": {
        // D-gap: snapshot is session-scoped but `revision` is per-document,
        // so one revision row is stamped per document in the session.
        const docs = db
          .query<{ id: string }, [string]>("SELECT id FROM document WHERE session_id = ?")
          .all(session_id);
        docs.forEach((d, i) => {
          db.run(
            `INSERT INTO revision (id, document_id, session_id, seq, event_id, turn_summary, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              revisionRowId(event.revision_id, i, docs.length),
              d.id,
              session_id,
              seq,
              event.event_id,
              event.turn_summary,
              created_at,
            ],
          );
        });
        break;
      }

      // The note lands on the revision row the label names for THIS document.
      // A missing row is not defended against here: the caller's read-only
      // validation phase already refused that as `unknown_revision`, and this
      // module writes what the reducer allowed rather than re-deciding it.
      //
      // A second note for the same revision overwrites, and both events stay on
      // the log — so a replay ends on the last one written, which is the same
      // answer a live run gives.
      case "note_written": {
        const rowId = revisionRowIdForLabel(db, event.doc_id, event.revision_id);
        if (rowId !== null) {
          db.run("UPDATE revision SET turn_note = ?, narration = ? WHERE id = ?", [
            event.note,
            event.narration,
            rowId,
          ]);
        }
        break;
      }

      case "export":
        db.run("UPDATE document SET export_path = ? WHERE id = ?", [event.path, event.doc_id]);
        break;

      case "attachment_add": {
        const a = event.attachment;
        db.run(
          `INSERT INTO attachment (attachment_id, session_id, doc_id, comment_id, kind, source,
             storage_path, mime_type, transcript_status, transcript_text, created_at_seq, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          [
            event.event_id, // same id rule as comment_create
            a.session_id,
            a.doc_id,
            a.comment_id,
            a.kind,
            a.source,
            a.storage_path,
            a.kind === "image" ? "image/*" : "audio/*",
            a.kind === "audio" ? "pending" : "n/a",
            seq,
            created_at,
          ],
        );
        break;
      }

      case "transcript_done":
      case "transcript_manual":
        db.run(
          "UPDATE attachment SET transcript_text = ?, transcript_status = 'done' WHERE attachment_id = ?",
          [event.text, event.attachment_id],
        );
        break;

      case "transcript_failed":
        db.run("UPDATE attachment SET transcript_status = 'failed' WHERE attachment_id = ?", [
          event.attachment_id,
        ]);
        break;

      case "transcript_retry":
        db.run("UPDATE attachment SET transcript_status = 'pending' WHERE attachment_id = ?", [
          event.attachment_id,
        ]);
        break;

      case "submit":
      case "cancel":
      case "pull":
        break; // state transition only, handled above
    }
  }

  db.run(
    `INSERT INTO checkpoint (session_id, last_applied_seq, checkpointed_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET last_applied_seq = excluded.last_applied_seq,
       checkpointed_at = excluded.checkpointed_at`,
    [session_id, seq, created_at],
  );
}

/**
 * Re-resolve anchor_state for every anchored comment on a doc after a mutation.
 * Called inside the same transaction as the event that mutated the doc.
 *
 * The probe is handed BOTH ends (PI-6), because a run whose head still resolves
 * but whose characters are gone is `detached`, and that is invisible to a probe
 * given only the head.
 */
export function reanchorComments(
  db: Database,
  doc_id: string,
  probe: (
    comment_id: string,
    block_id: string,
    relative_position: string,
    relative_position_end: string | null,
  ) => AnchorState,
  updated_at: string,
): void {
  const rows = db
    .query<
      {
        comment_id: string;
        block_id: string;
        relative_position: string;
        relative_position_end: string | null;
        anchor_state: string;
      },
      [string]
    >(
      `SELECT comment_id, block_id, relative_position, relative_position_end, anchor_state
       FROM comment WHERE doc_id = ? AND relative_position IS NOT NULL`,
    )
    .all(doc_id);
  for (const r of rows) {
    const next = probe(r.comment_id, r.block_id, r.relative_position, r.relative_position_end);
    if (next !== r.anchor_state) {
      db.run("UPDATE comment SET anchor_state = ?, updated_at = ? WHERE comment_id = ?", [
        next,
        updated_at,
        r.comment_id,
      ]);
    }
  }
}
