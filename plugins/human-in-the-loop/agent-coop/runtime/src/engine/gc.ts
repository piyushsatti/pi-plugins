// Attachment file GC (db-design §2 SE-F8, D12). File deletion is not
// transactional with SQLite, so it runs post-commit off a queue table; a
// failure is left queued for the next sweep rather than blocking anything.
// The server invokes sweep(); the engine only exports it.
import type { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";

export function enqueueForGc(db: Database, storage_path: string, queued_at: string): void {
  db.run("INSERT OR IGNORE INTO attachment_pending_gc (storage_path, queued_at) VALUES (?, ?)", [
    storage_path,
    queued_at,
  ]);
}

export type SweepResult = { deleted: string[]; failed: string[] };

export function sweep(db: Database, unlink: (p: string) => void = unlinkSync): SweepResult {
  const rows = db
    .query<{ storage_path: string }, []>("SELECT storage_path FROM attachment_pending_gc")
    .all();
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const r of rows) {
    try {
      unlink(r.storage_path);
      db.run("DELETE FROM attachment_pending_gc WHERE storage_path = ?", [r.storage_path]);
      deleted.push(r.storage_path);
    } catch {
      // Left queued deliberately: a periodic sweep retries it.
      failed.push(r.storage_path);
    }
  }
  return { deleted, failed };
}
