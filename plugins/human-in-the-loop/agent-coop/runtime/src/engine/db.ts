// Opening the database. SQLite PRAGMAs are per-connection state, not part of
// the file — so `foreign_keys` cannot live in a migration: a migration runs
// once in a database's lifetime, which would leave FK enforcement (and every
// `ON DELETE CASCADE` the schema relies on) off for every later boot.
// `journal_mode` IS persisted in the file, but setting it on open costs nothing
// and keeps one place that answers "how is an agent-coop connection configured".
//
// TWO entry points, and nothing in src/ or scripts/ may call `new Database`
// itself: `openDb` for the writer, `openReadOnlyDb` for the backup worker's
// read-only handle (SEC-1).
import { Database } from "bun:sqlite";

/** Per-connection settings. Must run on EVERY open, migrated or not. */
export function configureConnection(db: Database): void {
  db.run("PRAGMA foreign_keys = ON");
  // Returns "memory" for an in-memory database rather than failing.
  db.run("PRAGMA journal_mode = WAL");
}

/** The only way src/ opens the live database for writing. Creates the file if
 *  absent. */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  configureConnection(db);
  return db;
}

/**
 * The only way src/ opens a READ-ONLY handle: the backup worker, which reads the
 * whole database and writes a copy with `VACUUM INTO`.
 *
 * `configureConnection` is deliberately NOT run here, and that is the whole
 * reason this is a second function rather than a flag on `openDb`:
 * `PRAGMA journal_mode` writes the database header and fails on a read-only
 * connection, and `foreign_keys` bounds writes this handle cannot make. So
 * "every open goes through db.ts" holds, while "every open is
 * `configureConnection`'d" is true of the write path only.
 */
export function openReadOnlyDb(path: string): Database {
  return new Database(path, { readonly: true });
}
