// Where the container directories are. Everything for one project sits under
// <project>/, with the repo and any worktree as siblings — so `data/` is
// ../data from the repo root and ../../data from a worktree. The depth is DECIDED
// from the path (see containerPath), never guessed from what exists.
//
// This is the ONE place that decision is made and the one place the AGENT_COOP_*
// overrides are read: scripts/db-reset.ts used to work the layout out again for
// itself and ignore AGENT_COOP_DB, so it deleted a database the server was not using
// (CQ6). Every script imports from here instead.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

/**
 * One container path, decided by LAYOUT rather than by which directory happens
 * to exist already.
 *
 * `<project>/worktrees/<branch>` is a worktree, so the container is two up;
 * anything else is the repo itself, so it is one up. The `worktrees` component is
 * the Studio convention and the only thing that distinguishes the two depths.
 *
 * The old rule probed for `<up2>/<name>` and fell back to `<up1>/<name>`, which
 * quietly did the wrong thing on a FIRST run from a worktree: with no `data/`
 * created yet there was nothing to find at the right depth, so it returned
 * `<project>/worktrees/data` and the caller's mkdir created a second container
 * inside the worktrees folder. Existence of the target must not decide where the
 * target is.
 *
 * The check with teeth is therefore the AMBIGUOUS case: the layout says the
 * directory belongs at one depth, it is not there, and the OTHER depth already
 * has one. That is a checkout this rule does not describe, and every outcome
 * except stopping is bad — a second `data/` splits the database in two and the
 * symptom is an empty session list, not an error. So it names both paths and
 * throws. Pure and exported so the layout rule is testable without moving real
 * directories around.
 */
export function containerPath(
  repoRoot: string,
  name: string,
  override: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const parent = join(repoRoot, "..");
  const inWorktree = basename(parent) === "worktrees";
  const chosen = join(inWorktree ? join(parent, "..") : parent, name);
  const other = join(inWorktree ? parent : join(parent, ".."), name);
  if (!exists(chosen) && exists(other)) {
    throw new Error(
      `agent-coop expected ${name}/ at ${chosen} (Studio container layout) but found one at ` +
        `${other} instead. Move it, or set ${override} explicitly — creating a second ` +
        `${name}/ would split agent-coop's state in two.`,
    );
  }
  return chosen;
}

/**
 * The four constants below are resolved AT MODULE LOAD, so a checkout this rule
 * does not describe throws on `import`, before any caller runs. That is
 * deliberate: the answer cannot change during a process (it is a function of the
 * checkout's path), and every consumer — the server, every script — needs it
 * before it does anything useful. Failing at import means the process never
 * starts; failing lazily would mean it starts, serves a health check, and throws
 * on the first request that touched the database.
 *
 * The cost is that importing this module for `PORT` alone can throw about
 * `data/`. Accepted: the throw only fires on a genuinely ambiguous layout, which
 * is a checkout nobody should be running anything from, and the message names
 * both paths and the override that fixes it. Anything that needs the layout rule
 * WITHOUT that consequence calls `containerPath` directly — it is pure and
 * exported for exactly that.
 */
const container = (name: string, override: string) => containerPath(repoRoot, name, override);

export const DATA_DIR = process.env.AGENT_COOP_DATA_DIR ?? container("data", "AGENT_COOP_DATA_DIR");
export const DB_PATH = process.env.AGENT_COOP_DB ?? join(DATA_DIR, "agent-coop.sqlite");
/** Where narration audio lands (src/server/notes.ts): a derived CACHE keyed by
 *  the revision ROW id, never the log or a projection
 *  (migrations/0003_turn_note.sql). Nested under DATA_DIR directly, like
 *  DB_PATH above rather than its own `container()` call like BACKUP_DIR/
 *  ARTIFACTS_DIR below: narration/ has no independent-existence question the
 *  way history/ or artifacts/ do — it is always "wherever this database's
 *  data/ is". */
export const NARRATION_DIR = process.env.AGENT_COOP_NARRATION_DIR ?? join(DATA_DIR, "narration");
export const BACKUP_DIR = process.env.AGENT_COOP_BACKUP_DIR ?? container("history", "AGENT_COOP_BACKUP_DIR");
/** Where exports land (A8, db-design §5). Every export target must resolve
 *  inside this directory (SEC-3) — relative paths resolve under it, absolute
 *  ones are accepted only if already inside; see src/export/index.ts. */
export const ARTIFACTS_DIR = process.env.AGENT_COOP_ARTIFACTS_DIR ?? container("artifacts", "AGENT_COOP_ARTIFACTS_DIR");
export const STATIC_DIR = process.env.AGENT_COOP_STATIC_DIR ?? join(repoRoot, "web", "dist");
export const PORT = Number(process.env.AGENT_COOP_PORT ?? 4317);
