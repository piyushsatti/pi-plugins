// Backup on every `snapshot`, POST-COMMIT and off the request thread
// (db-design §Cross-cutting, D21). The snapshot event is already the natural
// "this is a good point to keep" marker, so there is no cron and no second
// backup mechanism.
//
// Every backup is a full copy of the database, so the set of them is capped
// (SEC-4): uncapped, a long session fills the disk with near-identical copies
// and nothing ever removes one.
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** How many backup files survive a prune. Ten revisions back is more history
 *  than a recovery reaches for, and bounds the cost at 10x the database size
 *  instead of one copy per snapshot forever. */
export const MAX_BACKUPS = 10;

/** Only files this module writes are ever considered, let alone deleted. */
const BACKUP_NAME = /^agent-coop-.*\.sqlite$/;

export type BackupResult = { ok: true; dest: string; ms: number } | { ok: false; error: string; ms: number };

/**
 * Delete all but the newest `keep` backups in `dir`, newest by mtime.
 *
 * Scoped by filename: `dir` is the container's `history/`, which holds other
 * things, so a prune that counted every file rather than matching `agent-coop-*.sqlite`
 * would eat them. Returns what it removed.
 */
export function pruneBackups(dir: string, keep = MAX_BACKUPS): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => BACKUP_NAME.test(n));
  } catch {
    return []; // no directory yet means nothing to prune
  }
  const dated = names.flatMap((name) => {
    const path = join(dir, name);
    try {
      return [{ path, mtime: statSync(path).mtimeMs }];
    } catch {
      return []; // vanished under us
    }
  });
  dated.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));

  const removed: string[] = [];
  for (const { path } of dated.slice(keep)) {
    try {
      unlinkSync(path);
      removed.push(path);
    } catch {
      // A backup that will not delete is left alone: pruning must never be the
      // thing that fails a snapshot.
    }
  }
  return removed;
}

/** Fire-and-forget: a failed backup must never fail the snapshot request. */
export function backupTo(dbPath: string, dir: string, revision_id: string): Promise<BackupResult> {
  // An in-memory database has nothing to back up (tests, and only tests).
  if (dbPath === ":memory:" || dbPath === "") {
    return Promise.resolve({ ok: false, error: "in-memory database", ms: 0 });
  }
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `agent-coop-${revision_id.replace(/[^A-Za-z0-9._-]/g, "_")}.sqlite`);
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./backup-worker.ts", import.meta.url).href, { type: "module" });
    worker.onmessage = (e: MessageEvent<BackupResult>) => {
      worker.terminate();
      // Prune AFTER the new file lands, so the newest copy is never the one
      // counted out — and only on success, so a failed backup never deletes.
      if (e.data.ok) pruneBackups(dir);
      resolve(e.data);
    };
    worker.onerror = (e) => {
      worker.terminate();
      resolve({ ok: false, error: String((e as ErrorEvent).message ?? e), ms: 0 });
    };
    worker.postMessage({ dbPath, dest });
  });
}
