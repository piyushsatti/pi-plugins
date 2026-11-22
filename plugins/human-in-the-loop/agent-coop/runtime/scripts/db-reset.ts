// Wipe the database the server actually uses and re-apply the DDL migrations in
// src/contract/migrations/ from scratch.
//
// The path comes from src/server/paths.ts, which is the one place the layout is
// probed and the one place `AGENT_COOP_DB` / `AGENT_COOP_DATA_DIR` are read (CQ6). This script
// used to recompute the container layout itself and ignore `AGENT_COOP_DB`, so with that
// variable set it deleted a different database than the server had open.
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { openDb } from "../src/engine/db.ts";
import { migrate } from "../src/engine/migrate.ts";
import { DB_PATH } from "../src/server/paths.ts";

for (const suffix of ["", "-wal", "-shm"]) rmSync(DB_PATH + suffix, { force: true });
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = openDb(DB_PATH);
const applied = migrate(db);
db.close();

console.log(`db reset: ${DB_PATH} (applied: ${applied.map((m) => m.name).join(", ") || "none"})`);
