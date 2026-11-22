// Backup Worker (D21, db-design §Cross-cutting). Runs in the SAME dedicated
// worker mechanism as compaction — one mechanism, not two. It opens its own
// read-only handle and writes a single consistent file with VACUUM INTO.
// Never a raw `cp`: a WAL-mode database spans main/-wal/-shm and a file copy
// has no way to snapshot all three atomically.
//
// The handle comes from src/engine/db.ts like every other open (SEC-1):
// `openReadOnlyDb`, which is that file's read-only entry point and states there
// why a read-only connection is not PRAGMA-configured.
import { openReadOnlyDb } from "../engine/db.ts";

declare const self: Worker;

self.onmessage = (e: MessageEvent<{ dbPath: string; dest: string }>) => {
  const started = performance.now();
  try {
    const db = openReadOnlyDb(e.data.dbPath);
    // The destination is an SQL expression, not a bindable parameter.
    db.run(`VACUUM INTO '${e.data.dest.replace(/'/g, "''")}'`);
    db.close();
    self.postMessage({ ok: true, dest: e.data.dest, ms: performance.now() - started });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err), ms: performance.now() - started });
  }
};
