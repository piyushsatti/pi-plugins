// Replay (db-design §1 "Crash recovery = replay", §3.4 revision
// reconstruction). Replay-from-zero and incremental application are the same
// code path applied over different event ranges; that is the property the
// replay-equals-live test asserts.
import type { Database } from "bun:sqlite";
import type * as Y from "yjs";
import type { Event, SessionState } from "../contract/index.ts";
import { loadDocFromUpdates } from "./engine.ts";
import { readEvents } from "./log.ts";
import { getState, PROJECTION_TABLES, projectEvent } from "./projections.ts";
import { decide, type DecideContext } from "./reducer.ts";
import { readBlocks } from "./yjs-binding.ts";
import type { Block } from "../contract/index.ts";

/** Reset every projection table for a session to its at-creation state. */
function resetProjections(db: Database, session_id: string): void {
  db.run("DELETE FROM revision WHERE session_id = ?", [session_id]);
  db.run("DELETE FROM attachment WHERE session_id = ?", [session_id]);
  db.run("DELETE FROM comment WHERE session_id = ?", [session_id]);
  db.run("DELETE FROM checkpoint WHERE session_id = ?", [session_id]);
  db.run("DELETE FROM attachment_pending_gc", []);
  db.run(
    `UPDATE session_state SET state = 'USER_EDITING', turn_started_at_seq = NULL, updated_at_seq = 0
     WHERE session_id = ?`,
    [session_id],
  );
  db.run("UPDATE document SET export_path = NULL WHERE session_id = ?", [session_id]);
}

/**
 * Re-derive the projections for one event during replay. `document_updates` is
 * NOT rewritten: it is already persisted, so replay passes doc_update: null.
 */
function replayOne(db: Database, event: Event): void {
  const ctx: DecideContext = { state: getState(db, event.session_id) };
  // Historical events were already validated when first accepted; only the
  // idempotency no-op has to be reproduced, because it changed projections.
  if (event.type === "claude_apply") {
    const first = db
      .query<{ event_id: string }, [string]>(
        "SELECT event_id FROM event WHERE client_edit_id = ? ORDER BY seq LIMIT 1",
      )
      .get(event.client_edit_id);
    ctx.duplicate_client_edit_id = first !== null && first.event_id !== event.event_id;
  }
  const decision = decide(ctx, event);
  if (!decision.ok) {
    throw new Error(`replay rejected a logged event ${event.event_id} (${event.type})`);
  }
  projectEvent(db, event, decision, { doc_update: null });
}

/** Full rebuild from seq 0. Always produces the same result as incremental
 *  application — `checkpoint` only bounds how far back boot has to start. */
export function rebuildProjections(db: Database, session_id: string): number {
  let applied = 0;
  db.transaction(() => {
    resetProjections(db, session_id);
    for (const event of readEvents(db, session_id)) {
      replayOne(db, event);
      applied++;
    }
  })();
  return applied;
}

/** Boot path: replay only events past the checkpoint (db-design §4). */
export function bootReplay(db: Database, session_id: string): number {
  const cp = db
    .query<{ last_applied_seq: number }, [string]>(
      "SELECT last_applied_seq FROM checkpoint WHERE session_id = ?",
    )
    .get(session_id);
  if (cp === null) return rebuildProjections(db, session_id);
  let applied = 0;
  db.transaction(() => {
    for (const event of readEvents(db, session_id, cp.last_applied_seq)) {
      replayOne(db, event);
      applied++;
    }
  })();
  return applied;
}

export function bootReplayAll(db: Database): number {
  return db
    .query<{ id: string }, []>("SELECT id FROM session")
    .all()
    .reduce((n, s) => n + bootReplay(db, s.id), 0);
}

/** Snapshot of every projection row for a session, for byte-identical
 *  comparison between replay-from-zero and incremental application. */
export function dumpProjections(db: Database, session_id: string): string {
  const out: Record<string, unknown[]> = {};
  for (const table of PROJECTION_TABLES) {
    const col = table === "attachment_pending_gc" ? null : "session_id";
    out[table] = col
      ? db.query(`SELECT * FROM ${table} WHERE ${col} = ? ORDER BY rowid`).all(session_id)
      : db.query(`SELECT * FROM ${table} ORDER BY rowid`).all();
  }
  return JSON.stringify(out);
}

/** Reconstruct a document as of `seq` into a fresh, disposable Y.Doc (D1). */
export function reconstructDocAt(db: Database, doc_id: string, seq: number): Y.Doc {
  return loadDocFromUpdates(db, doc_id, seq);
}

export function blocksAt(db: Database, doc_id: string, seq: number): Block[] {
  const doc = reconstructDocAt(db, doc_id, seq);
  const blocks = readBlocks(doc);
  doc.destroy();
  return blocks;
}

/** The event.seq a revision label points at (db-design §2 revision). */
export function revisionSeq(db: Database, revision_id: string): number | null {
  const row = db
    .query<{ seq: number }, [string]>("SELECT seq FROM revision WHERE id = ?")
    .get(revision_id);
  return row?.seq ?? null;
}

export type { SessionState };
