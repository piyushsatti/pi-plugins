// src/server — the ONE process that touches SQLite and Yjs (repo-design
// §Single writer process). It hosts the engine, the HTTP API, SSE and the
// static bundle together. MCP is a shim over this API, never a second writer.
//
// `createApp` returns a plain `fetch(Request) -> Response` handler so the
// endpoint tests exercise the real router without binding a socket; `serve`
// wraps it in Bun.serve and starts the periodic GC sweep.
import { MAX_REQUEST_BODY_BYTES } from "../contract/index.ts";
import { Engine, bootReplayAll, migrate, openDb } from "../engine/index.ts";
import type { SpeechBackend } from "../speech/index.ts";
import { backendFor as transcribeBackendFor } from "../transcribe/index.ts";
import type { TranscribeBackend } from "../transcribe/index.ts";
import { TRANSCRIBE_TIMEOUT_MS, WARM_TIMEOUT_MS, type ServerContext } from "./context.ts";
import { guardRequest, parseAllowedHosts } from "./guard.ts";
import { fail } from "./http.ts";
import { runMaintenance } from "./maintenance.ts";
import { ARTIFACTS_DIR, BACKUP_DIR, DB_PATH, NARRATION_DIR, PORT, STATIC_DIR } from "./paths.ts";
import * as read from "./routes/read.ts";
import * as write from "./routes/write.ts";
import { Broadcaster } from "./sse.ts";
import { serveStatic } from "./static.ts";

export type AppOptions = {
  engine: Engine;
  dbPath?: string;
  backupDir?: string;
  artifactsDir?: string;
  narrationDir?: string;
  /** null disables static serving entirely (tests, headless runs). */
  staticDir?: string | null;
  newId?: (prefix: string) => string;
  now?: () => string;
  /** Extra Host names allowed to read or write (A12 reverse-proxy seam; guard.ts). */
  allowedHosts?: ReadonlySet<string>;
  /** See ServerContext.speechBackend (src/server/context.ts). */
  speechBackend?: SpeechBackend;
  /** See ServerContext.transcribeBackend (src/server/context.ts). */
  transcribeBackend?: TranscribeBackend;
  /** See TRANSCRIBE_TIMEOUT_MS (src/server/context.ts). */
  transcribeTimeoutMs?: number;
};

export type App = {
  ctx: ServerContext;
  sse: Broadcaster;
  fetch: (req: Request) => Promise<Response>;
};

/** Match `/api/comments/:id/reply` style paths against a segment pattern. */
function match(pattern: string, segments: string[]): Record<string, string> | null {
  const parts = pattern.split("/").filter(Boolean);
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(segments[i]!);
    else if (p !== segments[i]) return null;
  }
  return params;
}

export function createApp(options: AppOptions): App {
  const sse = new Broadcaster();
  const ctx: ServerContext = {
    engine: options.engine,
    db: options.engine.db,
    sse,
    dbPath: options.dbPath ?? ":memory:",
    backupDir: options.backupDir ?? BACKUP_DIR,
    artifactsDir: options.artifactsDir ?? ARTIFACTS_DIR,
    narrationDir: options.narrationDir ?? NARRATION_DIR,
    staticDir: options.staticDir === undefined ? STATIC_DIR : options.staticDir,
    newId: options.newId ?? ((prefix) => `${prefix}-${crypto.randomUUID()}`),
    now: options.now ?? (() => new Date().toISOString()),
    backups: [],
    narrations: [],
    transcriptions: new Set(),
    speechBackend: options.speechBackend,
    transcribeBackend: options.transcribeBackend,
    transcribeTimeoutMs: options.transcribeTimeoutMs ?? TRANSCRIBE_TIMEOUT_MS,
  };

  type Handler = (p: Record<string, string>, req: Request, url: URL) => Response | Promise<Response>;
  const routes: [string, string, Handler][] = [
    // reads
    ["GET", "/api/health", () => read.health(ctx)],
    ["GET", "/api/sessions", () => read.sessions(ctx)],
    ["GET", "/api/sessions/:id", (p) => read.session(ctx, p.id!)],
    ["GET", "/api/docs/:id", (p, _r, url) => read.doc(ctx, p.id!, url)],
    ["GET", "/api/turn/pending", (_p, _r, url) => read.turnPending(ctx, url)],
    // The long poll `scripts/watch.ts` runs on, under the Monitor tool (LOOP-1,
    // rev 3). The skill runs no loop of its own and no `agent_coop_*` tool reaches
    // here. Same answer as /api/turn/pending, held open until there is one.
    // The request's own signal, so a caller that hangs up mid-wait releases the
    // timer and the listener instead of holding them out to the timeout.
    ["GET", "/api/turn/wait", (_p, req, url) => read.turnWait(ctx, url, req.signal)],
    ["GET", "/api/comments", (_p, _r, url) => read.comments(ctx, url)],
    ["GET", "/api/attachments/:id", (p) => read.attachment(ctx, p.id!)],
    ["GET", "/api/diff/:doc_id", (p, _r, url) => read.diff(ctx, p.doc_id!, url)],
    ["GET", "/api/revisions/:doc_id", (p) => read.revisions(ctx, p.doc_id!)],
    // The rendered audio cache for one revision's narration (src/server/notes.ts).
    // A missing file is the ordinary "not rendered yet" case, not a fault — see
    // read.narration.
    ["GET", "/api/narration/:doc_id", (p, _r, url) => read.narration(ctx, p.doc_id!, url)],
    ["GET", "/api/events", () => sse.response()],

    // writes. There is no POST /api/sessions: creating a session names a local
    // filesystem path, and no browser-reachable endpoint may do that (SEC-2).
    // Sessions come from the CLI (scripts/up.ts), against a database no server
    // holds. Adding a DOCUMENT to an existing session is a different case and is
    // allowed: its body names no path (see write.addDoc).
    ["POST", "/api/sessions/:id/docs", (p, req) => write.addDoc(ctx, p.id!, req)],
    ["POST", "/api/pull/:session_id", (p) => write.pull(ctx, p.session_id!)],
    ["PATCH", "/api/blocks/:doc_id", (p, req) => write.patchBlocks(ctx, p.doc_id!, req)],
    ["POST", "/api/apply/:doc_id", (p, req) => write.apply(ctx, p.doc_id!, req)],
    ["POST", "/api/comments", (_p, req) => write.createComment(ctx, req)],
    ["POST", "/api/comments/:id/reply", (p, req) => write.replyComment(ctx, p.id!, req)],
    ["POST", "/api/comments/:id/resolve", (p, req) => write.resolveComment(ctx, p.id!, req)],
    ["POST", "/api/submit", (_p, req) => write.submit(ctx, req)],
    // The user's escape from SUBMITTED/CLAUDE_TURN (PI-4). User-side only: there
    // is no matching MCP tool, see write.cancel.
    ["POST", "/api/cancel", (_p, req) => write.cancel(ctx, req)],
    ["POST", "/api/snapshot/:session_id", (p, req) => write.snapshot(ctx, p.session_id!, req)],
    ["POST", "/api/export/:doc_id", (p, req) => write.exportDoc(ctx, p.doc_id!, req)],
    ["POST", "/api/attachments", (_p, req) => write.addAttachment(ctx, req)],
    ["PATCH", "/api/attachments/:id/transcript", (p, req) => write.patchTranscript(ctx, p.id!, req)],
    ["POST", "/api/attachments/:id/retry", (p) => write.retryTranscript(ctx, p.id!)],
    // A turn note and its narration (src/contract/events.ts note_written),
    // legal in every session state — see write.createNote for why gating it
    // would refuse it every time.
    ["POST", "/api/notes/:doc_id", (p, req) => write.createNote(ctx, p.doc_id!, req)],
  ];

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Before anything is routed: loopback is not a boundary against the user's
    // own browser (guard.ts). Every request must address loopback or a listed
    // proxy host (A12); writes must also come from a JSON client on this origin.
    const refused = guardRequest(req, options.allowedHosts);
    if (refused !== null) return refused;

    const segments = url.pathname.split("/").filter(Boolean);
    let pathMatched = false;

    for (const [method, pattern, handler] of routes) {
      const params = match(pattern, segments);
      if (params === null) continue;
      pathMatched = true;
      if (req.method !== method) continue;
      try {
        return await handler(params, req, url);
      } catch (err) {
        return fail(500, `unhandled server error: ${String(err)}`);
      }
    }
    if (pathMatched) return fail(405, `method ${req.method} not allowed on ${url.pathname}`);
    if (url.pathname.startsWith("/api/")) return fail(404, `no such endpoint ${url.pathname}`);
    return serveStatic(ctx.staticDir, url.pathname);
  }

  return { ctx, sse, fetch };
}

export type ServeOptions = {
  dbPath?: string;
  port?: number;
  /** Bind address. Defaults to loopback; v1 has no auth, so this is the boundary. */
  hostname?: string;
  staticDir?: string | null;
  backupDir?: string;
  artifactsDir?: string;
  narrationDir?: string;
  /** Maintenance interval: attachment GC sweep (D12), update-log compaction
   *  (D11, B6) and the stale-submit sweep (LOOP-4). 0 disables the timer, and
   *  with it all three. */
  gcIntervalMs?: number;
  /** Update rows on one document before compaction folds them. Defaults to the
   *  documented COMPACTION_THRESHOLD; only a test has a reason to lower it. */
  compactionThreshold?: number;
  /** Age at which the sweep cancels an unpulled submit. Defaults to the
   *  documented STALE_SUBMIT_MS; only a test has a reason to lower it. */
  staleSubmitMs?: number;
  /** Extra Host names allowed to read or write (A12). Defaults to AGENT_COOP_ALLOWED_HOSTS
   *  from the environment; empty means loopback only, which is the boundary. */
  allowedHosts?: ReadonlySet<string>;
  /** Speech backend for narration renders (src/server/notes.ts). Defaults to
   *  src/speech's own resolution (`backendFor()`/AGENT_COOP_VOICE) when omitted;
   *  overridable so a test can inject a fake without spawning real `say` —
   *  exists for the same reason `compactionThreshold`/`staleSubmitMs` above
   *  do. */
  speechBackend?: SpeechBackend;
  /** Transcribe backend for voice-input comments (src/server/routes/write.ts).
   *  Defaults to src/transcribe's own resolution (`backendFor()`/
   *  AGENT_COOP_TRANSCRIBE) when omitted; overridable for the same reason
   *  `speechBackend` above is. */
  transcribeBackend?: TranscribeBackend;
  /** See TRANSCRIBE_TIMEOUT_MS (src/server/context.ts). */
  transcribeTimeoutMs?: number;
  /**
   * Warm the transcribe backend at boot: 7.91s cold against 0.33s warm,
   * measured on this machine (src/transcribe/whisper.ts's own header), so
   * without this the FIRST voice comment after a reboot pays the cold-page-
   * cache cost and looks broken. The warm call is 100ms of silence through
   * the SAME backend a real request would use (`TranscribeBackend.transcribe`,
   * src/transcribe/seam.ts), never a hardcoded `whisperBackend` reached some
   * other way, or a test that injects a fake here would still spawn the real
   * whisper-cli underneath it.
   *
   * OFF by default, and that default matters: `serve()` is the function a
   * great many tests boot a real socket with directly
   * (tests/server/test_boot.test.ts and the tests/web, tests/e2e suites), and
   * on the machine this was built on whisper-cli and both ggml models are
   * genuinely installed, so an always-on warm here would spawn a real
   * whisper-cli subprocess on every one of those boots, the same real-backend-
   * in-a-unit-test problem `speechBackend` above already exists to prevent for
   * `say`/kokoro.
   * scripts/dev.ts, the one actual long-lived server process, is the one
   * caller that sets this true.
   */
  warmTranscribeOnBoot?: boolean;
};

/** Boot the one process: migrate, replay the log, listen, sweep periodically. */
export function serve(options: ServeOptions = {}) {
  const dbPath = options.dbPath ?? DB_PATH;
  // openDb, never `new Database`: the per-connection PRAGMAs (foreign_keys)
  // must be set on this boot, not just the boot that ran the migrations.
  const db = openDb(dbPath);
  migrate(db);
  bootReplayAll(db); // crash recovery = replay; there is no separate resume path

  const engine = new Engine(db);
  const app = createApp({
    engine,
    dbPath,
    staticDir: options.staticDir === undefined ? STATIC_DIR : options.staticDir,
    backupDir: options.backupDir,
    artifactsDir: options.artifactsDir,
    narrationDir: options.narrationDir,
    allowedHosts: options.allowedHosts ?? parseAllowedHosts(process.env.AGENT_COOP_ALLOWED_HOSTS),
    speechBackend: options.speechBackend,
    transcribeBackend: options.transcribeBackend,
    transcribeTimeoutMs: options.transcribeTimeoutMs,
  });

  // Fire-and-forget, never awaited: this must not delay `serve` returning or
  // hold up the socket becoming ready. See warmTranscribeOnBoot above for why
  // it defaults off, and why the warm call goes through `backend`, the one
  // this call was actually given, or src/transcribe's own resolution if none
  // was, rather than a whisper.ts import that would warm the real singleton
  // regardless of what a caller injected.
  if (options.warmTranscribeOnBoot === true) {
    (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WARM_TIMEOUT_MS);
      try {
        const backend = options.transcribeBackend ?? transcribeBackendFor();
        // Sweep first, and ahead of the availability gate rather than behind
        // it, for two reasons. Warming is the thing most likely to wedge, so a
        // boot that hangs in the warm-up should still have cleaned up after the
        // last boot that did. And a recording stranded by a hard kill is the
        // user's voice: an engine that has since gone missing, a moved model or
        // an uninstalled binary, is a reason to clean up rather than a reason
        // to leave it there. What gets removed is the backend's own choice; see
        // the seam's `sweep` for why a caller must not delete by pattern on a
        // backend's behalf.
        await backend.sweep?.();
        if (!(await backend.available())) return;
        // 1_600 samples at 16_000 Hz: 100ms of silence. Silence is a safe
        // warm-up input because the backend runs voice detection ahead of the
        // model, so this comes back empty rather than hallucinated.
        // 16_000 is a literal rather than an import for the same reason
        // CommentAudioSchema pins it with `z.literal(16000)`: the two are not
        // free to diverge from each other, they are both simply 16000.
        //
        // The signal is why this is bounded at all. Without it a whisper-cli
        // that wedges on a half-downloaded model holds a subprocess and the
        // warm-up's own temp file for the life of the server, and nothing is
        // awaiting this promise to notice. The backend honors the signal by
        // killing the process group and removing the file, which is the whole
        // reason `signal` lives on the seam rather than in a caller's race.
        await backend.transcribe(new Int16Array(1_600), 16_000, { signal: controller.signal });
      } catch {
        // Best-effort only. A failed warm-up never blocks boot or any
        // request; the next real transcription simply pays the cold-cache
        // cost this was trying to avoid.
      } finally {
        clearTimeout(timer);
      }
    })();
  }

  // One timer for all periodic housekeeping (maintenance.ts). Compaction is
  // async and must not overlap itself, so a pass still running when the interval
  // fires again skips rather than stacking.
  const interval = options.gcIntervalMs ?? 60_000;
  let pass: Promise<unknown> | null = null;
  const timer =
    interval > 0
      ? setInterval(() => {
          if (pass !== null) return;
          pass = runMaintenance(app.ctx, {
            threshold: options.compactionThreshold,
            staleSubmitMs: options.staleSubmitMs,
          }).finally(() => {
            pass = null;
          });
        }, interval)
      : null;
  if (timer !== null) timer.unref?.();

  // Bind loopback explicitly: Bun.serve with no hostname accepts connections on
  // every interface (verified: reachable on the LAN IP even though server.hostname
  // reports "localhost"). v1 has no auth, so the loopback bind IS the boundary.
  // A12 (Tailscale) will front this with `tailscale serve`, not rebind it.
  //
  // idleTimeout is bounded rather than disabled: /api/events stays alive via the
  // SSE heartbeat (sse.ts HEARTBEAT_MS), so idle connections still get reaped
  // instead of accumulating without limit.
  const server = Bun.serve({
    port: options.port ?? PORT,
    hostname: options.hostname ?? "127.0.0.1",
    fetch: app.fetch,
    idleTimeout: 120,
    // A byte cap the Zod string caps cannot give: they only apply once a body
    // has been read into memory (SEC-6). Sized for an attachment upload (A10).
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  });
  return { server, app, engine, db, stop: () => {
    if (timer !== null) clearInterval(timer);
    server.stop(true);
    db.close();
  } };
}

export { createApp as createServer };
export * from "./errors.ts";
export * from "./maintenance.ts";
export * from "./offsets.ts";
export * from "./sse.ts";
