// Start the single long-lived server process (src/server) for local
// development — engine + HTTP API + SSE + Yjs in one process, the sole writer
// to ../data/agent-coop.sqlite. Serves web/dist/ statically.
// web/dist/ is rebuilt (and watched) from web/src/ by scripts/build.ts before
// the socket opens; `--no-watch` builds once.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "../src/server/index.ts";
import { DB_PATH, PORT, STATIC_DIR } from "../src/server/paths.ts";
import { build } from "./build.ts";

mkdirSync(dirname(DB_PATH), { recursive: true });
await build(!process.argv.includes("--no-watch"));

// warmTranscribeOnBoot: true only here. This is the one real, long-lived
// server process (src/server/index.ts's own comment on the option explains
// why every test-driven `serve()` call leaves it off).
const { server } = serve({ dbPath: DB_PATH, port: PORT, staticDir: STATIC_DIR, warmTranscribeOnBoot: true });

console.log(`agent-coop listening on http://localhost:${server.port}`);
console.log(`  db      ${DB_PATH}`);
console.log(`  static  ${STATIC_DIR}`);
