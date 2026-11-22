// The engine: the only writer. Owns the SQLite handle, the live Y.Doc per
// document, and the one transaction per event (db-design §1).
//
// Ordering rule (D2, db-design §1): validation is strictly read-only — SQL
// preconditions AND read-only Y.Doc probes — then, and only then, the mutation
// phase runs: mutate the live Y.Doc, open the SQL transaction. If the
// transaction fails after the doc was mutated, the in-memory doc is DISCARDED
// and reloaded by replaying document_updates. There is no CRDT-level undo.
import type { Database } from "bun:sqlite";
import * as Y from "yjs";
import {
  EventSchema,
  type Block,
  type DomainError,
  type Event,
  type SessionState,
} from "../contract/index.ts";
import { findByClientEditId, insertEvent, nextSeq, readEvents } from "./log.ts";
import {
  getState,
  projectEvent,
  reanchorComments,
  revisionRowIdForLabel,
} from "./projections.ts";
import { decide, type DecideContext, type Decision } from "./reducer.ts";
import {
  anchorState,
  applyBlockOps,
  missingBlockIds,
  readBlocks,
} from "./yjs-binding.ts";

/** `Omit` collapses a union to its shared keys; this keeps each member intact. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** One event as a caller supplies it: the engine mints `seq`/`event_id` and
 *  stamps `created_at` when they are absent. Stays a union, one member per
 *  event type, so a wrong field for a given `type` is a compile error. */
export type EventInput = DistributiveOmit<Event, "seq" | "created_at" | "event_id"> & {
  event_id?: string;
  created_at?: string;
};

export type DispatchResult =
  | { ok: true; event: Event; transition: { from: SessionState; to: SessionState } | null; noop: boolean }
  /** The reducer's refusal, passed through unchanged. Turning it into an HTTP
   *  status or an MCP error is the boundary's job, not the engine's (B1). */
  | { ok: false; error: DomainError };

export class Engine {
  readonly db: Database;
  private readonly docs = new Map<string, Y.Doc>();
  private idCounter = 0;

  constructor(db: Database) {
    this.db = db;
  }

  // --- lifecycle rows (CRUD, db-design §2 session/document) ----------------

  createSession(input: { id: string; title: string; created_at?: string }): void {
    const created_at = input.created_at ?? new Date().toISOString();
    this.db.transaction(() => {
      this.db.run("INSERT INTO session (id, title, created_at, status) VALUES (?, ?, ?, 'active')", [
        input.id,
        input.title,
        created_at,
      ]);
      this.db.run(
        `INSERT INTO session_state (session_id, state, turn_started_at_seq, updated_at_seq, created_at)
         VALUES (?, 'USER_EDITING', NULL, 0, ?)`,
        [input.id, created_at],
      );
    })();
  }

  createDocument(input: {
    id: string;
    session_id: string;
    title: string;
    source_path?: string | null;
    created_at?: string;
  }): void {
    this.db.run(
      `INSERT INTO document (id, session_id, title, source_path, export_path, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
      [
        input.id,
        input.session_id,
        input.title,
        input.source_path ?? null,
        input.created_at ?? new Date().toISOString(),
      ],
    );
  }

  // --- documents -----------------------------------------------------------

  /** The live Y.Doc, materialized from document_updates on first touch. */
  getDoc(doc_id: string): Y.Doc {
    const live = this.docs.get(doc_id);
    if (live) return live;
    return this.reloadDoc(doc_id);
  }

  /** Discard whatever is in memory and rebuild from disk. The only recovery
   *  path for CRDT state (db-design §1). */
  reloadDoc(doc_id: string): Y.Doc {
    const doc = loadDocFromUpdates(this.db, doc_id);
    this.docs.set(doc_id, doc);
    return doc;
  }

  blocks(doc_id: string): Block[] {
    return readBlocks(this.getDoc(doc_id));
  }

  state(session_id: string): SessionState | null {
    return getState(this.db, session_id);
  }

  // --- the one write path --------------------------------------------------

  dispatch(input: EventInput): DispatchResult {
    const created_at = input.created_at ?? new Date().toISOString();
    const event = EventSchema.parse({
      ...input,
      event_id: input.event_id ?? `ev-${created_at}-${this.idCounter++}`,
      created_at,
      seq: nextSeq(this.db, input.session_id),
    }) as Event;

    // ---- validation phase: read-only, SQL + Y.Doc probes both -------------
    const ctx: DecideContext = { state: this.state(event.session_id) };
    let original: Event | null = null;
    if (event.type === "user_edit" || event.type === "claude_apply" || event.type === "doc_added") {
      const doc = this.getDoc(event.doc_id);
      ctx.missing_block_ids = missingBlockIds(doc, event.ops);
      if (event.type === "claude_apply") {
        original = findByClientEditId(this.db, event.client_edit_id);
        ctx.duplicate_client_edit_id = original !== null;
      }
      // A doc_added naming a document that already exists would retitle it and
      // write into it, which is not what the caller asked for.
      if (event.type === "doc_added") ctx.duplicate_doc_id = this.documentExists(event.doc_id);
    }
    if (event.type === "comment_reply") ctx.missing_comment_id = !this.commentExists(event.parent_id);
    if (event.type === "comment_resolve") ctx.missing_comment_id = !this.commentExists(event.comment_id);
    if (
      event.type === "transcript_done" ||
      event.type === "transcript_manual" ||
      event.type === "transcript_failed" ||
      event.type === "transcript_retry"
    ) {
      ctx.missing_attachment_id = !this.attachmentExists(event.attachment_id);
    }
    // A note names a revision by LABEL, and the label alone does not identify a
    // row — the lookup is per document (src/engine/projections.ts
    // `revisionRowIdForLabel`). Probed here, in the read-only phase, so the
    // refusal is a domain error like every other referential one rather than a
    // projection that silently updated nothing.
    if (event.type === "note_written") {
      ctx.missing_revision_id =
        revisionRowIdForLabel(this.db, event.doc_id, event.revision_id) === null;
    }

    const decision = decide(ctx, event);
    if (!decision.ok) return decision;

    // A retried claude_apply is the SAME event, not a new one: nothing is
    // appended (the unique client_edit_id index is the same rule in SQL), and
    // the caller gets back the event that already landed (D13).
    if (original !== null) return { ok: true, event: original, transition: null, noop: true };

    // ---- mutation phase ----------------------------------------------------
    const mutation =
      !decision.noop &&
      (event.type === "user_edit" || event.type === "claude_apply" || event.type === "doc_added")
        ? { doc_id: event.doc_id, ops: event.ops }
        : null;
    const doc_id = mutation === null ? null : mutation.doc_id;
    let update: Uint8Array | null = null;

    if (mutation !== null) {
      const doc = this.getDoc(mutation.doc_id);
      const before = Y.encodeStateVector(doc);
      applyBlockOps(doc, mutation.ops);
      update = Y.encodeStateAsUpdate(doc, before);
    }

    try {
      this.db.transaction(() => {
        insertEvent(this.db, event);
        projectEvent(this.db, event, decision, { doc_update: update });
        if (doc_id !== null) {
          const doc = this.docs.get(doc_id)!;
          reanchorComments(
            this.db,
            doc_id,
            // quoted_text is "" on purpose: anchorState resolves positions and
            // never reads the quote, so passing the real one would suggest it
            // participates. Both relative positions DO (PI-6).
            (_id, block_id, relative_position, relative_position_end) =>
              anchorState(doc, {
                block_id,
                relative_position,
                relative_position_end,
                quoted_text: "",
              }),
            event.created_at,
          );
        }
      })();
    } catch (err) {
      // SQL failed after the doc was already mutated: throw memory away and
      // replay from disk. Never an in-place CRDT rollback (db-design §1, D2).
      if (doc_id !== null) this.reloadDoc(doc_id);
      throw err;
    }

    return { ok: true, event, transition: decision.transition, noop: decision.noop };
  }

  // --- read helpers used by validation ------------------------------------

  private commentExists(comment_id: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM comment WHERE comment_id = ?")
        .get(comment_id)!.n > 0
    );
  }

  private documentExists(doc_id: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM document WHERE id = ?")
        .get(doc_id)!.n > 0
    );
  }

  private attachmentExists(attachment_id: string): boolean {
    return (
      this.db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM attachment WHERE attachment_id = ?")
        .get(attachment_id)!.n > 0
    );
  }

  events(session_id: string, afterSeq = -1): Event[] {
    return readEvents(this.db, session_id, afterSeq);
  }
}

/** Replay every stored update row for a document into a fresh Y.Doc. A
 *  merged_snapshot row is applied like any other update (db-design §3.2). */
export function loadDocFromUpdates(db: Database, doc_id: string, maxSeq = Infinity): Y.Doc {
  const doc = new Y.Doc();
  const rows =
    maxSeq === Infinity
      ? db
          .query<{ payload: Uint8Array }, [string]>(
            `SELECT "update" AS payload FROM document_updates WHERE document_id = ? ORDER BY seq, id`,
          )
          .all(doc_id)
      : db
          .query<{ payload: Uint8Array }, [string, number]>(
            `SELECT "update" AS payload FROM document_updates WHERE document_id = ? AND seq <= ? ORDER BY seq, id`,
          )
          .all(doc_id, maxSeq);
  doc.transact(() => {
    for (const r of rows) Y.applyUpdate(doc, new Uint8Array(r.payload));
  });
  return doc;
}

export type { Decision };
