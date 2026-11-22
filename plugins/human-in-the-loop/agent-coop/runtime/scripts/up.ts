// `/agent-coop`'s three steps, in code: health-check, start if down, ensure/choose a
// session, print the URL (contract-design §`/agent-coop` skill). All of it lives
// here rather than in .claude/skills/agent-coop/SKILL.md so the skill stays a caller — a
// skill that reimplements any of this becomes a second definition of what a
// running agent-coop is, and drifts.
//
// This script is the ONE writer of new sessions (SEC-2): there is no
// POST /api/sessions, because creating a session names a markdown file on this
// machine and nothing the browser can reach may name a local path. It writes
// only in the window where no server is running — it has just probed the port
// and found nothing — so the single-writer rule still holds. With a server
// already up, this script is HTTP-only and creating a session is refused.
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  HealthSchema,
  STARTER_BLOCKS,
  pathString,
  titleString,
  type BlockOp,
  type Health,
  type Session,
} from "../src/contract/index.ts";
import { Engine, bootReplayAll, migrate, openDb } from "../src/engine/index.ts";
import { splitMarkdown } from "../src/export/markdown.ts";
import { DATA_DIR, DB_PATH, PORT } from "../src/server/paths.ts";
// The projection read, reused rather than re-written: one SQL statement for
// "what sessions exist", whoever is asking.
import { listSessions as listSessionRows } from "../src/server/queries.ts";

const repoRoot = join(import.meta.dir, "..");

/** Where a spawned server's stdout/stderr goes. A detached process with no log
 *  is a process you cannot debug. */
export const LOG_PATH = join(DATA_DIR, "server.log");

export type UpOptions = {
  baseUrl?: string;
  /** Use this session instead of choosing one. Unknown id is an error. */
  sessionId?: string;
  /** Title for a session created because none existed. */
  title?: string;
  /** Markdown file to open as the new session's first document. */
  file?: string;
  /** Database to create a session in when the server is down. Tests override it. */
  dbPath?: string;
  /** Injected in tests. Must make an agent-coop server answer on `baseUrl`. */
  spawn?: (baseUrl: string) => void;
  /** How long to wait for a spawned server to answer, in ms. */
  waitMs?: number;
};

export type UpResult = {
  base_url: string;
  session_id: string;
  /** What a human opens. */
  url: string;
  /** True only when this run spawned the server process. */
  started: boolean;
  /** True only when this run created the session. */
  created: boolean;
  health: Health;
};

/** One health probe. Returns null for every failure mode — connection refused,
 *  a non-agent-coop server on the port, an agent-coop server too old to answer — because
 *  the caller's decision is the same in all of them: start one. */
export async function probe(baseUrl: string, timeoutMs = 1_000): Promise<Health | null> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const parsed = HealthSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Poll until a server answers or the budget runs out. */
export async function waitForHealth(baseUrl: string, waitMs: number): Promise<Health | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const health = await probe(baseUrl, 500);
    if (health !== null) return health;
    if (Date.now() >= deadline) return null;
    await Bun.sleep(150);
  }
}

/**
 * Which session `/agent-coop` opens. Pure, so the rule is testable without a server.
 *
 * An explicit id wins and must exist. Otherwise: the newest active session,
 * because "ensure/choose" in a one-user tool means "the one I was just in".
 * Archived sessions are never chosen implicitly. No candidate returns null,
 * which is the caller's signal to create one.
 */
export function chooseSession(sessions: Session[], wanted?: string): Session | null {
  if (wanted !== undefined) return sessions.find((s) => s.id === wanted) ?? null;
  const active = sessions.filter((s) => s.status === "active");
  if (active.length === 0) return null;
  return active.reduce((newest, s) => (s.created_at >= newest.created_at ? s : newest));
}

/** The URL a human opens: the session view, which lists its documents. */
export function sessionUrl(baseUrl: string, session_id: string): string {
  return `${baseUrl}/session/${session_id}`;
}

/** Spawn the one server process, detached, and forget about it. `/agent-coop` may be
 *  invoked from a session that ends long before the server should. */
export function spawnServer(): void {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, `\n--- started by scripts/up.ts at ${new Date().toISOString()}\n`);
  // An append-mode fd, not Bun.file(): a BunFile as stdout truncates, which
  // would eat the header line above and every previous run's crash.
  const fd = openSync(LOG_PATH, "a");
  const child = Bun.spawn(["bun", "run", join(repoRoot, "scripts", "dev.ts"), "--no-watch"], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
    env: process.env,
    // setsid(): the server must outlive the `/agent-coop` invocation that started it.
    detached: true,
  });
  child.unref();
  closeSync(fd);
}

async function listSessions(baseUrl: string): Promise<Session[]> {
  const res = await fetch(`${baseUrl}/api/sessions`);
  if (!res.ok) throw new Error(`GET /api/sessions failed: ${res.status}`);
  return (await res.json()).sessions as Session[];
}

/**
 * Open the database directly. ONLY legal while no server is running: the caller
 * must have probed the port and found nothing. Sessions and documents are rows
 * rather than events (they precede any event), so they are created through the
 * engine's own creators; the seeded blocks still go through the log, as one
 * `user_edit`, like every other block mutation.
 */
function withDb<T>(dbPath: string, fn: (engine: Engine) => T): T {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  try {
    migrate(db);
    bootReplayAll(db);
    return fn(new Engine(db));
  } finally {
    db.close();
  }
}

/** Sessions in a database no server holds. */
function readSessions(dbPath: string): Session[] {
  return withDb(dbPath, (engine) => listSessionRows(engine.db));
}

/** Title of the session's first document when no file named it. `--file` opens
 *  that file; with no file the session still gets ONE document, holding one
 *  empty block (ENTRY-1) — a session with no document at all opens on a page
 *  with nothing to click, and the web UI cannot create the first document
 *  either (there is no create-session endpoint and the doc list needs a
 *  session that exists). The empty block matters as much as the document: the
 *  document view edits blocks that exist and cannot insert one.
 *
 *  Which is why the blocks themselves are NOT named here: `STARTER_BLOCKS` is
 *  the contract's (src/contract/session.ts). This document precedes any event,
 *  so it is written through the engine's creator and never passes through
 *  `DocAddSchema` — the constant is the only thing keeping the two paths saying
 *  the same thing. */
export const STARTER_DOC_TITLE = "Untitled";

/** Create the session and its first document locally.
 *
 *  The CLI is a write surface like any other, so its strings take the contract's
 *  caps too (SEC-6): a title or path past them is refused here rather than
 *  stored and then failing every read that parses the row back. */
function createSessionLocally(dbPath: string, opts: UpOptions): Session {
  const title = titleString().parse(opts.title ?? "agent-coop session");
  const file = opts.file === undefined ? undefined : pathString().parse(opts.file);

  // Read the file BEFORE touching the database: a failed read must not leave an
  // empty session behind.
  const fromFile = file === undefined ? [] : splitMarkdown(readFileSync(file, "utf8"));
  // An empty file lands here too: its document gets the starter block rather
  // than none, so "the first document always has a block to type in" holds
  // whatever the file said.
  const contents = fromFile.length > 0 ? fromFile : [...STARTER_BLOCKS];

  return withDb(dbPath, (engine) => {
    const now = new Date().toISOString();
    const session_id = `s-${crypto.randomUUID()}`;
    engine.createSession({ id: session_id, title, created_at: now });

    const doc_id = `d-${crypto.randomUUID()}`;
    engine.createDocument({
      id: doc_id,
      session_id,
      title:
        file === undefined
          ? STARTER_DOC_TITLE
          : titleString().parse(basename(file).replace(/\.md$/, "")),
      // No file named, no path recorded: `source_path` states where the document
      // came FROM, and inventing one would make export believe it round-trips a
      // file nobody opened.
      source_path: file ?? null,
      created_at: now,
    });
    // Always at least one op: `contents` falls back to STARTER_BLOCKS, so it is
    // never empty (ENTRY-1). A guard here would be a branch no input can reach.
    let after: string | null = null;
    const ops: BlockOp[] = contents.map((content) => {
      const block_id = `b-${crypto.randomUUID()}`;
      const op: BlockOp = { op: "insert", block_id, after_block_id: after, content };
      after = block_id;
      return op;
    });
    engine.dispatch({ type: "user_edit", session_id, doc_id, ops, created_at: new Date().toISOString() });

    const created = listSessionRows(engine.db).find((s) => s.id === session_id);
    if (created === undefined) throw new Error(`session ${session_id} did not persist`);
    return created;
  });
}

/** Health-check, start if down, ensure/choose a session, return the URL. */
export async function up(options: UpOptions = {}): Promise<UpResult> {
  const baseUrl = options.baseUrl ?? `http://localhost:${PORT}`;
  const dbPath = options.dbPath ?? DB_PATH;
  const spawn = options.spawn ?? (() => spawnServer());

  const health0 = await probe(baseUrl);

  // Naming a file is a request to open that file, so it always makes a session —
  // "ensure/choose" would otherwise silently hand back yesterday's session and
  // never open the document the user asked for.
  const mustCreate = options.file !== undefined && options.sessionId === undefined;

  if (health0 === null) {
    // Server down: this process is the only thing that can hold the database, so
    // this is the one window in which a session may be created.
    let session = mustCreate ? null : chooseSession(readSessions(dbPath), options.sessionId);
    if (session === null && options.sessionId !== undefined) {
      throw new Error(`unknown session ${options.sessionId}`);
    }
    let created = false;
    if (session === null) {
      session = createSessionLocally(dbPath, options);
      created = true;
    }

    spawn(baseUrl);
    const health = await waitForHealth(baseUrl, options.waitMs ?? 30_000);
    if (health === null) {
      throw new Error(`server did not answer on ${baseUrl} — see ${LOG_PATH}`);
    }
    return {
      base_url: baseUrl,
      session_id: session.id,
      url: sessionUrl(baseUrl, session.id),
      started: true,
      created,
      health,
    };
  }

  // Server up: HTTP only. Nothing here may open the database — the server owns
  // it — and there is no endpoint that creates a session (SEC-2), so a run that
  // needs a new one cannot be satisfied and says so.
  const session = mustCreate ? null : chooseSession(await listSessions(baseUrl), options.sessionId);
  if (session === null && options.sessionId !== undefined) {
    throw new Error(`unknown session ${options.sessionId}`);
  }
  if (session === null) {
    throw new Error(
      "cannot create a session while agent-coop is running: the server is the single writer and " +
        "there is no create-session endpoint. Stop it (or open an existing session with --session <id>) " +
        "and run this again.",
    );
  }
  return {
    base_url: baseUrl,
    session_id: session.id,
    url: sessionUrl(baseUrl, session.id),
    started: false,
    created: false,
    health: health0,
  };
}

/** `--flag value` pairs; unknown flags are ignored rather than fatal. */
export function parseArgs(argv: string[]): UpOptions {
  const opts: UpOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === "--session" && next !== undefined) opts.sessionId = next;
    if (argv[i] === "--title" && next !== undefined) opts.title = next;
    if (argv[i] === "--file" && next !== undefined) opts.file = next;
  }
  return opts;
}

if (import.meta.main) {
  const result = await up(parseArgs(process.argv.slice(2)));
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result));
  } else {
    console.log(result.started ? "started agent-coop" : "agent-coop already running");
    if (result.created) console.log(`created session ${result.session_id}`);
    console.log(result.url);
  }
}
