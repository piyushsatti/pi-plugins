// Migration runner: numbered .sql files from src/contract/migrations applied in
// order, tracked in schema_migrations (db-design §Cross-cutting, Migration).
// The DDL lives in src/contract; the logic to apply it lives here, because
// src/contract must contain no logic (repo-design §Architecture mapping).
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.ts";

export const MIGRATIONS_DIR = join(import.meta.dir, "..", "contract", "migrations");

export type Migration = { version: number; name: string; sql: string };

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const version = Number.parseInt(name.slice(0, 4), 10);
      if (Number.isNaN(version)) throw new Error(`migration filename is not NNNN_*.sql: ${name}`);
      return { version, name, sql: readFileSync(join(dir, name), "utf8") };
    });
}

/** Applies every unapplied migration in version order. Returns those applied. */
export function migrate(db: Database, dir: string = MIGRATIONS_DIR): Migration[] {
  // schema_migrations is created by 0001 itself, so its absence just means
  // nothing has been applied yet — the runner never creates it.
  const tracked = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  const done = new Set(
    tracked
      ? db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all().map((r) => r.version)
      : [],
  );
  const applied: Migration[] = [];
  for (const m of loadMigrations(dir)) {
    if (done.has(m.version)) continue;
    // One transaction per migration: the DDL and the row that records it land
    // together or not at all. The migration files carry no PRAGMA (those are
    // per-connection, see db.ts), which is what makes a transaction possible
    // here — SQLite refuses `PRAGMA journal_mode` inside one.
    db.transaction(() => {
      db.run(m.sql);
      db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        m.version,
        new Date().toISOString(),
      ]);
    })();
    applied.push(m);
  }
  return applied;
}

/** Fresh in-memory (or file) db, connection configured, schema applied. */
export function openMigrated(path = ":memory:"): Database {
  const db = openDb(path);
  migrate(db);
  return db;
}
