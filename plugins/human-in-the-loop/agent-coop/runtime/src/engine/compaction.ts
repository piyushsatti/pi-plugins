// Compaction (db-design §3.2, D11). The row-id set is pinned SYNCHRONOUSLY on
// the main thread before any async work begins, so rows landing while the
// Worker runs can neither be folded in nor deleted. The main thread does the
// only SQLite write, in one transaction: insert the merged_snapshot row, delete
// exactly the pinned primary keys.
import type { Database } from "bun:sqlite";

export const COMPACTION_THRESHOLD = 200;

export type PinnedRun = {
  doc_id: string;
  ids: number[];
  maxSeq: number;
  updates: Uint8Array[];
};

/** Synchronous pin: fixes the primary-key set under compaction. */
export function pinRun(db: Database, doc_id: string): PinnedRun | null {
  const rows = db
    .query<{ id: number; seq: number; payload: Uint8Array }, [string]>(
      `SELECT id, seq, "update" AS payload FROM document_updates
       WHERE document_id = ? ORDER BY seq, id`,
    )
    .all(doc_id);
  if (rows.length < 2) return null;
  return {
    doc_id,
    ids: rows.map((r) => r.id),
    maxSeq: rows[rows.length - 1]!.seq,
    updates: rows.map((r) => new Uint8Array(r.payload)),
  };
}

export function pendingUpdateCount(db: Database, doc_id: string): number {
  return db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM document_updates WHERE document_id = ? AND kind = 'update'",
    )
    .get(doc_id)!.n;
}

/** Merge the pinned blobs off the main thread. */
export function mergeInWorker(run: PinnedRun): Promise<{ merged: Uint8Array; ms: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./compaction-worker.ts", import.meta.url).href, {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<{ merged: Uint8Array; ms: number }>) => {
      worker.terminate();
      resolve({ merged: new Uint8Array(e.data.merged), ms: e.data.ms });
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(`compaction worker failed: ${(e as ErrorEvent).message ?? e}`));
    };
    worker.postMessage({ updates: run.updates });
  });
}

/** The transactional swap. Deletes by pinned primary key, never a re-derived
 *  range, so the deletion cannot diverge from what was actually merged. */
export function swapMerged(
  db: Database,
  run: PinnedRun,
  merged: Uint8Array,
  created_at = new Date().toISOString(),
): void {
  db.transaction(() => {
    db.run(
      `INSERT INTO document_updates (document_id, seq, kind, "update", created_at)
       VALUES (?, ?, 'merged_snapshot', ?, ?)`,
      [run.doc_id, run.maxSeq, merged, created_at],
    );
    const placeholders = run.ids.map(() => "?").join(",");
    db.run(`DELETE FROM document_updates WHERE id IN (${placeholders})`, run.ids);
  })();
}

/** Full cycle. Crash mid-compaction discards the merge; originals are intact
 *  and the next cycle re-attempts (contract-design §Turn protocol edge cases). */
export async function compactDocument(
  db: Database,
  doc_id: string,
): Promise<{ compacted: boolean; rows: number; ms: number }> {
  const run = pinRun(db, doc_id);
  if (run === null) return { compacted: false, rows: 0, ms: 0 };
  const { merged, ms } = await mergeInWorker(run);
  swapMerged(db, run, merged);
  return { compacted: true, rows: run.ids.length, ms };
}

export function shouldCompact(
  db: Database,
  doc_id: string,
  threshold = COMPACTION_THRESHOLD,
): boolean {
  return pendingUpdateCount(db, doc_id) >= threshold;
}

/**
 * Every document at or over the threshold, oldest run first (B6).
 *
 * The caller is the server's maintenance pass — nothing in src/engine schedules
 * itself. Before B6 nothing called compaction at all, so `document_updates` grew
 * for the life of a database; the threshold is a parameter here only so a test
 * can prove the shrink without writing 200 updates.
 */
export function docsNeedingCompaction(
  db: Database,
  threshold = COMPACTION_THRESHOLD,
): string[] {
  return db
    .query<{ document_id: string }, [number]>(
      `SELECT document_id FROM document_updates
       WHERE kind = 'update'
       GROUP BY document_id
       HAVING COUNT(*) >= ?
       ORDER BY MIN(seq)`,
    )
    .all(threshold)
    .map((r) => r.document_id);
}
