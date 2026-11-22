// The server's ambient context and the single mutation helper. Every write
// endpoint goes through `dispatch` — handlers contain no turn logic, no state
// checks and no projection writes (repo-design §Architecture mapping).
import type { Database } from "bun:sqlite";
import type { Event } from "../contract/index.ts";
import type { Engine, EventInput } from "../engine/index.ts";
import type { SpeechBackend } from "../speech/index.ts";
import type { TranscribeBackend } from "../transcribe/index.ts";
import { sseEventsFor } from "./emit.ts";
import { failDomain } from "./errors.ts";
import type { Broadcaster } from "./sse.ts";

/**
 * Ceiling on one transcription call (src/server/routes/write.ts
 * `transcribeBounded`). 30 seconds by default: whisper.cpp measures 0.98s
 * warm for 20.8s of speech, 7.91s cold (src/transcribe/whisper.ts's own
 * header), so this is headroom for a slow cold start queued behind another
 * request, not a number tuned to the model's own latency. Overridable
 * through ServerContext.transcribeTimeoutMs
 * (AppOptions.transcribeTimeoutMs, src/server/index.ts) for the same reason
 * `compactionThreshold`/`staleSubmitMs` are: a test that wants to exercise
 * the timeout branch itself cannot wait out a real 30 seconds.
 */
export const TRANSCRIBE_TIMEOUT_MS = 30_000;

/**
 * The bound on the boot warm-up (src/server/index.ts), which is a different
 * question from the bound on a request and so is a different number.
 *
 * Shorter than TRANSCRIBE_TIMEOUT_MS because nobody is waiting on it: a warm-up
 * that has not finished in fifteen seconds has already failed at its only job,
 * which is to be done before the first real voice comment arrives. Longer than
 * the 0.33s a warm run costs because the whole point is the cold case, and the
 * one cold measurement on record was 7.91s.
 */
export const WARM_TIMEOUT_MS = 15_000;

/**
 * Ceiling on transcriptions running AT ONCE (src/server/routes/write.ts
 * `resolveCommentText`, adversarial review of voice input). Each one is its
 * own whisper-cli process holding the whole ggml-large-v3-turbo-q5_0 model in
 * memory (574 MB, src/transcribe/whisper.ts's own header), so this is a real
 * memory bound, not a nicety: two already means past a gigabyte resident, and
 * a client that retries a timed-out request (the recording is kept precisely
 * so it can) stacks another process on top rather than replacing the first.
 * A request over the bound is REFUSED by name (`transcribe_busy`), never
 * queued: queueing behind a request that can itself take
 * TRANSCRIBE_TIMEOUT_MS would just move the wait somewhere less visible.
 */
export const MAX_CONCURRENT_TRANSCRIPTIONS = 2;

export type ServerContext = {
  engine: Engine;
  db: Database;
  sse: Broadcaster;
  /** Path of the live database, for the post-commit backup Worker. */
  dbPath: string;
  backupDir: string;
  /** Where a relative export path resolves to (A8, db-design §5). */
  artifactsDir: string;
  /** Where narration audio is cached. Overridable for the same reason
   *  `backupDir` and `artifactsDir` are: a module constant would point every
   *  importing process, the test suite included, at the live data directory. */
  narrationDir: string;
  staticDir: string | null;
  newId: (prefix: string) => string;
  now: () => string;
  /** The most recent post-commit backups kicked off, newest last, capped at
   *  MAX_BACKUPS (SEC-4). Nothing awaits these on the request path; the
   *  snapshot response does not wait for a backup. Dropping an older entry
   *  releases the reference only — it never cancels a backup in flight. */
  backups: Promise<unknown>[];
  /** In-flight narration renders kicked off by src/server/notes.ts, newest
   *  last, capped at MAX_NARRATION_RENDERS the same way `backups` is capped at
   *  MAX_BACKUPS (SEC-4-style: unbounded promise accumulation is a leak for the
   *  process lifetime). Nothing awaits these on the request path either —
   *  POST /api/notes responds before a render starts. */
  narrations: Promise<unknown>[];
  /** Speech backend for narration renders (src/server/notes.ts). undefined in
   *  production, where src/speech's own `synthesize` default (`backendFor()`,
   *  reading AGENT_COOP_VOICE) applies. Overridable so a test can inject a fake and
   *  assert narration_ready/narration_failed without spawning real `say` —
   *  exists for the same reason `compactionThreshold`/`staleSubmitMs` exist on
   *  ServeOptions (src/server/index.ts). */
  speechBackend?: SpeechBackend;
  /** Transcribe backend for voice-input comments
   *  (src/server/routes/write.ts `resolveCommentText`). undefined in
   *  production, where src/transcribe's own `backendFor()` (AGENT_COOP_TRANSCRIBE)
   *  applies. Overridable so a test can inject a fake and assert the
   *  `transcribe_failed` refusal without spawning real whisper-cli, same
   *  reason `speechBackend` above exists. */
  transcribeBackend?: TranscribeBackend;
  /** See TRANSCRIBE_TIMEOUT_MS above. Always has a value: createApp fills the
   *  default in, so every call site reads this field directly, no `??`. */
  transcribeTimeoutMs: number;
  /** Transcriptions currently RUNNING, not merely started (MAX_CONCURRENT_
   *  TRANSCRIPTIONS above). Unlike `backups`/`narrations`, which retain
   *  settled promises up to a cap purely so something can await them later,
   *  a caller here removes its own entry the instant its transcription
   *  settles (`resolveCommentText`'s `finally`), so `.size` always answers
   *  "how many whisper-cli processes are alive right now", never "how many
   *  were ever started". */
  transcriptions: Set<Promise<unknown>>;
};

export type DispatchOk = { ok: true; event: Event; noop: boolean };
export type Dispatched = DispatchOk | { ok: false; response: Response };

/** What `dispatch` actually needs. Named so off-request callers — the periodic
 *  sweep in maintenance.ts — can mutate through the same helper without
 *  inventing an artifactsDir or a backup list they have no use for. A full
 *  `ServerContext` satisfies it. */
export type DispatchContext = Pick<ServerContext, "engine" | "db" | "sse" | "now">;

/**
 * Dispatch one event through the engine, then broadcast the SSE rows it
 * produced. A refusal is a domain code, translated to a status and an
 * `McpToolError` body by errors.ts — the 409 for writing outside CLAUDE_TURN is
 * the contract working, and picking that number is this boundary's job (B1).
 */
export function dispatch(ctx: DispatchContext, input: EventInput): Dispatched {
  const result = ctx.engine.dispatch({ created_at: ctx.now(), ...input });
  if (!result.ok) return { ok: false, response: failDomain(result.error) };
  for (const e of sseEventsFor(ctx, result.event, result.transition, result.noop)) ctx.sse.send(e);
  return { ok: true, event: result.event, noop: result.noop };
}

/** Session id that owns a document, or null if the document is unknown. */
export function sessionOfDoc(ctx: ServerContext, doc_id: string): string | null {
  return (
    ctx.db
      .query<{ session_id: string }, [string]>("SELECT session_id FROM document WHERE id = ?")
      .get(doc_id)?.session_id ?? null
  );
}
