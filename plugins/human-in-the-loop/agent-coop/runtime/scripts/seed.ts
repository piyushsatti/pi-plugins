// Seed one session + one document so the UI has something to render.
//
// It opens NO database handle of its own (B4/CQ2). A second SQLite writer is
// forbidden outright, and the only exception in the codebase is scripts/up.ts,
// which writes solely in the window where it has probed the port and found no
// server. So this script does not repeat that window's rules — it hands the work
// to `up()`, which owns them, and contributes only the seed content.
//
// The content is a real markdown file rather than an inline block list for the
// same reason: `up({ file })` is the one create-a-session path, and giving it a
// file exercises the same import a user gets from `/agent-coop --file`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/server/paths.ts";
import { up } from "./up.ts";

const MARKDOWN = [
  "# Agent Coop slice",
  "This paragraph has **bold** text and an &amp; entity, so selection comments have something interesting to anchor to.",
  "```\nfenced code stays raw\n```",
].join("\n\n");

mkdirSync(DATA_DIR, { recursive: true });
// Beside the database rather than in a temp directory: `document.source_path`
// records where a document was imported from, and a path that no longer exists
// makes that column a lie.
const file = join(DATA_DIR, "seed.md");
writeFileSync(file, `${MARKDOWN}\n`);

const result = await up({ title: "seed session", file });
console.log(`seeded session ${result.session_id} from ${file}`);
console.log(`  open ${result.url}`);
