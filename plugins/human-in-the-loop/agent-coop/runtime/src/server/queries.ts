// Read-side row mappers. Projection rows -> contract wire shapes. No writes
// here and no business logic: every mutation goes through the engine reducer
// (repo-design §Architecture mapping, `Must not` column).
import type { Database } from "bun:sqlite";
import { revisionLabel } from "../engine/index.ts";
import {
  AttachmentSchema,
  CommentSchema,
  DocumentSchema,
  RevisionSchema,
  SessionSchema,
  type Attachment,
  type Comment,
  type DocumentMeta,
  type Revision,
  type Session,
} from "../contract/index.ts";

type CommentRow = {
  comment_id: string;
  session_id: string;
  doc_id: string | null;
  block_id: string | null;
  relative_position: string | null;
  relative_position_end: string | null;
  quoted_text: string | null;
  text: string;
  delivery: string;
  parent_id: string | null;
  status: string;
  resolved_by: string | null;
  anchor_state: string;
  created_at: string;
};

export function rowToComment(row: CommentRow): Comment {
  return CommentSchema.parse({
    comment_id: row.comment_id,
    session_id: row.session_id,
    doc_id: row.doc_id ?? "",
    anchor:
      row.block_id === null || row.relative_position === null
        ? null
        : {
            block_id: row.block_id,
            relative_position: row.relative_position,
            // NULL for an anchor created before PI-6. Carried through as null
            // rather than defaulted to the head: src/server/anchors.ts reports
            // that anchor as `detached`, which is the honest answer for a run
            // whose extent was never recorded.
            relative_position_end: row.relative_position_end,
            quoted_text: row.quoted_text ?? "",
          },
    text: row.text,
    delivery: row.delivery,
    parent_id: row.parent_id,
    status: row.status,
    resolved_by: row.resolved_by,
    // The projection already tracks this (projections.ts reanchor sweep); it
    // simply never reached the wire before P6.
    anchor_state: row.anchor_state,
    // Filled by src/server/anchors.ts, which needs the live Y.Doc. A comment
    // read without that decoration carries null, never a guess.
    rendered_offsets: null,
    created_at: row.created_at,
  });
}

const COMMENT_COLS = `comment_id, session_id, doc_id, block_id, relative_position,
  relative_position_end, quoted_text,
  text, delivery, parent_id, status, resolved_by, anchor_state, created_at`;

export function getComment(db: Database, comment_id: string): Comment | null {
  const row = db
    .query<CommentRow, [string]>(`SELECT ${COMMENT_COLS} FROM comment WHERE comment_id = ?`)
    .get(comment_id);
  return row === null ? null : rowToComment(row);
}

export function commentsForDoc(db: Database, doc_id: string, openOnly = false): Comment[] {
  return db
    .query<CommentRow, [string]>(
      `SELECT ${COMMENT_COLS} FROM comment WHERE doc_id = ?
       ${openOnly ? "AND status = 'open'" : ""} ORDER BY created_at_seq`,
    )
    .all(doc_id)
    .map(rowToComment);
}

/**
 * The pull batch's comments: open ROOTS only (PULL-ROOTS-ONLY, src/contract/pull.ts).
 *
 * Its own query rather than a third flag on `commentsForSession`, because it
 * answers a different question. That function answers "every comment on this
 * session", which is what a reader wants; this one answers "every thread that is
 * still waiting on an answer", which is what a turn wants. A reply is not a
 * thread — and because it never resolves, including it meant every turn's
 * replies rode back into every later turn's batch as work to do.
 */
export function openRootCommentsForSession(db: Database, session_id: string): Comment[] {
  return db
    .query<CommentRow, [string]>(
      `SELECT ${COMMENT_COLS} FROM comment
       WHERE session_id = ? AND status = 'open' AND parent_id IS NULL
       ORDER BY created_at_seq`,
    )
    .all(session_id)
    .map(rowToComment);
}

export function commentsForSession(db: Database, session_id: string, openOnly = false): Comment[] {
  return db
    .query<CommentRow, [string]>(
      `SELECT ${COMMENT_COLS} FROM comment WHERE session_id = ?
       ${openOnly ? "AND status = 'open'" : ""} ORDER BY created_at_seq`,
    )
    .all(session_id)
    .map(rowToComment);
}

/**
 * Comment threads on a document with activity inside `(fromSeq, toSeq]` (PI-7).
 *
 * A thread is included when its ROOT or ANY of its replies was created in the
 * window, so a reply Claude wrote this turn brings its (older) root along —
 * without which the reply would arrive with nothing to answer.
 *
 * A thread is a TREE in storage (`parent_id` may name another reply) and a FLAT
 * list on the wire: every descendant is bucketed under its root ANCESTOR, not
 * under its immediate parent. Bucketing by parent dropped every reply-to-reply
 * on the floor — it belonged to no root's list and no root claimed it.
 *
 * `created_at_seq` never reaches the wire: it is the log position the range test
 * needs, and the contract's `Comment` deliberately carries no seq. Ordering is
 * by that seq throughout, so the thread list is the log's order rather than a
 * re-sort of timestamps.
 *
 * Resolved comments are included: a thread the turn answered and closed is
 * exactly the thing the diff screen is being asked about.
 */
export function commentThreadsInRange(
  db: Database,
  doc_id: string,
  fromSeq: number,
  toSeq: number,
): { root: Comment; replies: Comment[] }[] {
  const rows = db
    .query<CommentRow & { created_at_seq: number }, [string]>(
      `SELECT ${COMMENT_COLS}, created_at_seq FROM comment WHERE doc_id = ? ORDER BY created_at_seq`,
    )
    .all(doc_id);

  const inRange = new Set(
    rows.filter((r) => r.created_at_seq > fromSeq && r.created_at_seq <= toSeq).map((r) => r.comment_id),
  );

  const byId = new Map(rows.map((r) => [r.comment_id, r]));

  /** The root of a row's thread: walk `parent_id` up until it is null. A row
   *  whose parent is missing, or a cycle, roots at itself rather than looping. */
  const rootOf = (row: CommentRow): CommentRow => {
    const seen = new Set<string>([row.comment_id]);
    let cur = row;
    for (;;) {
      if (cur.parent_id === null) return cur;
      const parent = byId.get(cur.parent_id);
      if (parent === undefined || seen.has(parent.comment_id)) return cur;
      seen.add(parent.comment_id);
      cur = parent;
    }
  };

  // Keyed by ROOT id, so a reply-to-reply lands in the same bucket as a direct
  // reply. Insertion order is `created_at_seq`, which the wire order keeps.
  const repliesByRoot = new Map<string, CommentRow[]>();
  for (const r of rows) {
    if (r.parent_id === null) continue;
    const root = rootOf(r);
    // Only reachable if a parent row vanished, which the FK forbids; skipping
    // beats listing a reply as the root of itself.
    if (root.comment_id === r.comment_id) continue;
    const list = repliesByRoot.get(root.comment_id);
    if (list === undefined) repliesByRoot.set(root.comment_id, [r]);
    else list.push(r);
  }

  const out: { root: Comment; replies: Comment[] }[] = [];
  for (const r of rows) {
    if (r.parent_id !== null) continue; // a reply is rendered under its root
    const replies = repliesByRoot.get(r.comment_id) ?? [];
    const touched = inRange.has(r.comment_id) || replies.some((x) => inRange.has(x.comment_id));
    if (!touched) continue;
    out.push({ root: rowToComment(r), replies: replies.map(rowToComment) });
  }
  return out;
}

/**
 * Every revision label on a document, newest first (PI-5).
 *
 * The turn summary was already persisted here by the reducer; this is the read
 * that makes a past turn reopenable instead of view-once. Each `id` is the
 * per-document label the diff endpoint accepts as `?to=`.
 */
export function revisionsForDoc(db: Database, doc_id: string): Revision[] {
  return db
    .query<
      {
        id: string;
        doc_id: string;
        seq: number;
        turn_summary: string | null;
        // Both NULL until a note_written event lands on this row (most
        // revisions, since notes are on demand). bun:sqlite maps a NULL column
        // to JS `null`, never `undefined`, so spreading `r` below hands
        // RevisionSchema's `.nullable().default(null)` fields a `null` it
        // accepts directly — never an absent key that only the default patches
        // over.
        turn_note: string | null;
        narration: string | null;
        created_at: string;
      },
      [string]
    >(
      `SELECT id, document_id AS doc_id, seq, turn_summary, turn_note, narration, created_at
       FROM revision WHERE document_id = ? ORDER BY seq DESC`,
    )
    .all(doc_id)
    .map((r) =>
      RevisionSchema.parse({
        ...r,
        // The label, not the per-document primary key: that suffix is storage's
        // and would not match the `revision_created` frame the client was given.
        revision_id: revisionLabel(r.id),
        turn_summary: r.turn_summary ?? "",
      }),
    );
}

/** Open `interrupt` comments Claude has not yet honoured (contract-design
 *  §Comment delivery classes — carried on every ApplyResult). */
export function pendingInterrupts(db: Database, session_id: string): number {
  return db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM comment WHERE session_id = ? AND status = 'open' AND delivery = 'interrupt'",
    )
    .get(session_id)!.n;
}

export function listSessions(db: Database): Session[] {
  return db
    .query<Record<string, unknown>, []>(
      `SELECT s.id, s.title, s.created_at, s.status, ss.state
       FROM session s JOIN session_state ss ON ss.session_id = s.id
       ORDER BY s.created_at`,
    )
    .all()
    .map((r) => SessionSchema.parse(r));
}

export function getSession(db: Database, id: string): Session | null {
  const row = db
    .query<Record<string, unknown>, [string]>(
      `SELECT s.id, s.title, s.created_at, s.status, ss.state
       FROM session s JOIN session_state ss ON ss.session_id = s.id WHERE s.id = ?`,
    )
    .get(id);
  return row === null ? null : SessionSchema.parse(row);
}

/** One waiting submit: the session, the seq of the `submit` event that opened it,
 *  and when that event was appended. `(session_id, submit_seq)` is the submit's
 *  identity on the wire (`TurnPending.submit_seq`). */
export type SubmittedSession = { session_id: string; submit_seq: number; submitted_at: string };

/**
 * Every session waiting to be pulled, **most recent submit first**.
 *
 * `SUBMITTED` is exactly "a submit no pull has consumed": the reducer enters it
 * on `submit` and leaves it on `pull`, so no event scan is needed.
 *
 * `submitted_at` is the wall-clock time of the event that entered the state —
 * `session_state.updated_at_seq` names it, and seq is per-session so the event's
 * `created_at` is the only thing comparable ACROSS sessions.
 *
 * The join is LEFT so that a projection row whose event cannot be found still
 * reports its session: a waiting submit that no query returns is a submit that
 * reaches nobody. **That fallback is not "safe", it is a choice with a cost on
 * each side.** Falling back to the session's `created_at` makes the submit look
 * OLD, which is the direction the staleness sweep wants (it gets cancelled and
 * the blocks unlock) and the wrong direction for `pending`, which sorts
 * newest-first: a genuinely new submit with a missing event row sinks behind
 * older ones and can be swept before its real day is up. Both consequences fall
 * on a row that should not exist — the event is written in the same transaction
 * as the projection — so the choice is between two bad answers, and this one at
 * least ends with an editable document rather than a locked one.
 *
 * Newest-first is deliberate (LOOP-4). Oldest-first let one abandoned submit
 * sit at the head of the list forever and pin `pending` to a session nobody was
 * working in, so every later submit was invisible until that one was dealt with.
 * Ties break on `s.id`, ascending, so two submits landing in the same
 * millisecond still give every reader the same answer.
 */
export function submittedSessions(db: Database, session_id?: string): SubmittedSession[] {
  return db
    .query<{ session_id: string; submit_seq: number; submitted_at: string }, string[]>(
      `SELECT s.id AS session_id, ss.updated_at_seq AS submit_seq,
              COALESCE(e.created_at, s.created_at) AS submitted_at
       FROM session s
       JOIN session_state ss ON ss.session_id = s.id
       LEFT JOIN event e ON e.session_id = s.id AND e.seq = ss.updated_at_seq
       WHERE ss.state = 'SUBMITTED' AND s.status = 'active'
       ${session_id === undefined ? "" : "AND s.id = ?"}
       ORDER BY submitted_at DESC, s.id`,
    )
    .all(...(session_id === undefined ? [] : [session_id]));
}

/**
 * The session waiting to be pulled, or null: the most recently submitted one.
 *
 * One SQL definition of "a submit is waiting", shared with the staleness sweep —
 * two would drift, and the pair "which session is pending" / "which submits are
 * stale" must agree or the sweep would cancel the session Claude was just woken
 * to pull.
 */
export function pendingSubmit(db: Database, session_id?: string): SubmittedSession | null {
  return submittedSessions(db, session_id)[0] ?? null;
}

/** The same answer, id only, for callers that do not need the submit's identity. */
export function submittedSession(db: Database, session_id?: string): string | null {
  return pendingSubmit(db, session_id)?.session_id ?? null;
}

export function documentsForSession(db: Database, session_id: string): DocumentMeta[] {
  return db
    .query<Record<string, unknown>, [string]>(
      "SELECT id, session_id, title, source_path, export_path, created_at FROM document WHERE session_id = ? ORDER BY created_at",
    )
    .all(session_id)
    .map((r) => DocumentSchema.parse(r));
}

export function getDocument(db: Database, id: string): DocumentMeta | null {
  const row = db
    .query<Record<string, unknown>, [string]>(
      "SELECT id, session_id, title, source_path, export_path, created_at FROM document WHERE id = ?",
    )
    .get(id);
  return row === null ? null : DocumentSchema.parse(row);
}

export function getAttachment(db: Database, attachment_id: string): Attachment | null {
  const row = db
    .query<Record<string, unknown>, [string]>(
      `SELECT attachment_id, session_id, doc_id, comment_id, kind, source, storage_path,
              transcript_status, transcript_text
       FROM attachment WHERE attachment_id = ?`,
    )
    .get(attachment_id);
  return row === null ? null : AttachmentSchema.parse(row);
}

/** The log position of the most recent revision label in a session, or -1. */
export function lastRevisionSeq(db: Database, session_id: string): number {
  return (
    db
      .query<{ seq: number | null }, [string]>(
        "SELECT MAX(seq) AS seq FROM revision WHERE session_id = ?",
      )
      .get(session_id)?.seq ?? -1
  );
}

/**
 * The log position a revision label points at FOR ONE DOCUMENT.
 *
 * `snapshot` is session-scoped but `revision` is per-document, so the reducer
 * stamps one row per doc and disambiguates multi-doc sessions by suffixing the
 * label (`rev-x:0`, `rev-x:1`). The SSE payload carries the bare label, so a
 * lookup by exact id alone 404s on any session with two documents; matching
 * the bare label or its `:n` form against this document is the whole fix.
 */
export function revisionSeqForDoc(db: Database, doc_id: string, label: string): number | null {
  return (
    db
      .query<{ seq: number }, [string, string, string, string]>(
        `SELECT seq FROM revision
         WHERE document_id = ? AND (id = ? OR substr(id, 1, length(?) + 1) = ? || ':')
         ORDER BY seq LIMIT 1`,
      )
      .get(doc_id, label, label, label)?.seq ?? null
  );
}

// There is deliberately no `previousRevisionSeq` here any more. "The revision
// before this one" was the old turn-diff base and it was the wrong question
// (PI-1): the base is the state at the user's last submit, which
// src/engine/diff.ts `turnDiffBase` answers from the event log.

export function turnStartedAtSeq(db: Database, session_id: string): number {
  return (
    db
      .query<{ turn_started_at_seq: number | null }, [string]>(
        "SELECT turn_started_at_seq FROM session_state WHERE session_id = ?",
      )
      .get(session_id)?.turn_started_at_seq ?? 0
  );
}

export function maxSeq(db: Database, session_id: string): number {
  return (
    db
      .query<{ seq: number | null }, [string]>("SELECT MAX(seq) AS seq FROM event WHERE session_id = ?")
      .get(session_id)?.seq ?? -1
  );
}
