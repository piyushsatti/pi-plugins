// The waker. Rev 3: agent-coop exposes ONE dumb wake channel — `GET /api/turn/wait` —
// and everything that WAITS lives on the harness side of the seam, which is this
// script, run by the Monitor tool from `.claude/skills/agent-coop/SKILL.md`.
//
// Why not an MCP tool: an MCP client request that outlives the client's own
// request timeout fails the whole tool call with JSON-RPC `-32001`, so a tool
// that held the wait turned "the user is thinking" into a broken call. The
// endpoint is unchanged; the tool is gone. Nothing in `src/mcp` waits.
//
// This script holds no agent-coop logic. It does not decide anything about turns, it
// never pulls (only `POST /api/pull` consumes a submit), and it touches no
// database. It converts one HTTP answer into one line of stdout, which is the
// only thing the harness can turn into a wake-up.
//
// Its ONE piece of state is de-duplication, and it is not optional: `wait`
// answers immediately for as long as a submit sits unpulled, so a memoryless
// loop would announce the same submit on every iteration for the whole of
// Claude's turn (WATCH-DEDUPE). `(session_id, submit_seq)` identifies a submit
// (src/contract/turn.ts), so a line is emitted only when that pair is new — and
// that memory EXPIRES after `TURN_WATCH_REANNOUNCE_MS`, so a wake lost to an
// interrupted turn comes back on its own instead of stranding the submit.
//
// It writes no timing number of its own. All three live in src/contract/turn.ts
// beside the cap they are defined against.
import {
  TURN_WAIT_CLIENT_SLACK_MS,
  TURN_WAIT_MAX_TIMEOUT_MS,
  TURN_WATCH_REANNOUNCE_MS,
  TURN_WATCH_RECHECK_MS,
  TURN_WATCH_RETRY_MS,
  TurnPendingSchema,
  type TurnPending,
} from "../src/contract/index.ts";
import { PORT } from "../src/server/paths.ts";

/** The line the harness turns into a wake-up. One per new submit. */
export const submitLine = (session_id: string | null): string =>
  // `pending: true` always carries a session by construction (the answer is
  // built from the submit row), so the fallback is unreachable rather than a
  // real case — it exists because the wire type allows null and swallowing a
  // submit would be worse than naming it badly.
  `agent-coop submit pending: ${session_id ?? "unknown session"}`;

/** Emitted once per unreachable episode, not once per failed request. Silence
 *  and "nothing has been submitted" look identical from the harness side, so a
 *  server that is simply not there has to say so — once. */
export const unreachableLine = (baseUrl: string): string =>
  `agent-coop watch: no agent-coop server answered at ${baseUrl}`;

/** Identity of a waiting submit, as one comparable string. */
const key = (state: TurnPending): string => `${state.session_id}:${state.submit_seq}`;

export type WatchOptions = {
  baseUrl?: string;
  /** Watch one session instead of every session. */
  sessionId?: string;
  /** Injected in tests. */
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The clock the re-announce interval is measured on. Injected in tests so a
   *  minute of quiet costs no wall time. */
  now?: () => number;
  /** Where a line goes. Real runs write stdout, which is the event stream. */
  emit?: (line: string) => void;
  /** Bound the loop. Undefined means forever, which is what a real run does. */
  iterations?: number;
};

/** One long poll. Null for every failure mode — refused, timed out, a non-agent-coop
 *  server on the port, a body that is not a `TurnPending` — because the caller
 *  does the same thing in all of them: wait a moment and ask again. */
export async function waitOnce(
  baseUrl: string,
  sessionId: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<TurnPending | null> {
  const query = [
    `timeout_ms=${TURN_WAIT_MAX_TIMEOUT_MS}`,
    ...(sessionId === undefined ? [] : [`session_id=${encodeURIComponent(sessionId)}`]),
  ].join("&");
  try {
    const res = await fetchFn(`${baseUrl}/api/turn/wait?${query}`, {
      // The client-side budget is DERIVED from the server's cap, never written
      // again: a client that gives up before the server answers surfaces a
      // transport error where `pending: false` was about to arrive
      // (src/contract/turn.ts, WAIT-TIMEOUT-ONE-PLACE).
      signal: AbortSignal.timeout(TURN_WAIT_MAX_TIMEOUT_MS + TURN_WAIT_CLIENT_SLACK_MS),
    });
    if (!res.ok) return null;
    const parsed = TurnPendingSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The loop: long-poll, emit one line per NEW submit, never exit on its own.
 *
 * A `pending: false` answer is not an event and is not an error — it is the
 * ordinary shape of a stretch in which the user did not submit — so it prints
 * nothing and costs one request per wait.
 *
 * The one submit it will announce TWICE is one that is still unpulled
 * `TURN_WATCH_REANNOUNCE_MS` after the last line about it. Nothing consumed the
 * wake — a pull would have cleared `pending` — so the wake is presumed lost and
 * is sent again. Without that, an interrupted turn strands the submit until a
 * human notices.
 */
export async function watch(options: WatchOptions = {}): Promise<void> {
  const baseUrl = options.baseUrl ?? `http://localhost:${PORT}`;
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? (() => Date.now());
  const emit = options.emit ?? ((line: string) => console.log(line));

  /** The submit last announced, and when — `null` means nothing is remembered. */
  let announced: { key: string; at: number } | null = null;
  let unreachable = false;

  for (let i = 0; options.iterations === undefined || i < options.iterations; i++) {
    const state = await waitOnce(baseUrl, options.sessionId, fetchFn);

    if (state === null) {
      if (!unreachable) {
        unreachable = true;
        emit(unreachableLine(baseUrl));
      }
      await sleep(TURN_WATCH_RETRY_MS);
      continue;
    }
    unreachable = false;

    if (!state.pending) {
      // Nothing is waiting, so the next submit is a new one whatever its seq.
      announced = null;
      continue;
    }

    const at = now();
    if (announced !== null && announced.key === key(state)) {
      if (at - announced.at < TURN_WATCH_REANNOUNCE_MS) {
        // Already told, recently. Claude is presumably mid-turn; do not re-wake
        // it, and do not spin.
        await sleep(TURN_WATCH_RECHECK_MS);
        continue;
      }
      // Still unpulled this long after the last line: nobody acted on it.
    }
    announced = { key: key(state), at };
    emit(submitLine(state.session_id));
  }
}

/** `--session <id>` / `--base <url>`; unknown flags are ignored rather than
 *  fatal, so a harness that passes something extra does not kill the waker. */
export function parseArgs(argv: string[]): WatchOptions {
  const opts: WatchOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === "--session" && next !== undefined) opts.sessionId = next;
    if (argv[i] === "--base" && next !== undefined) opts.baseUrl = next;
  }
  return opts;
}

if (import.meta.main) {
  await watch(parseArgs(process.argv.slice(2)));
}
