// The submit trigger's wire shape (PI-3). Defined here because src/contract is
// the only place a seam is described, and this seam has two consumers that are
// not the browser: `scripts/watch.ts` (the harness-side waker) and any other
// caller of the two turn endpoints.
import { z } from "zod";
import { idString, tokenString } from "./limits.ts";
import { SessionStateSchema } from "./session.ts";

/**
 * Body of `GET /api/turn/pending[?session_id=…]`.
 *
 * `pending` answers exactly one question: is there a submit nothing has pulled
 * yet? That is the projected `SUBMITTED` state and nothing more — `submit`
 * enters it, `pull` leaves it (src/engine/reducer.ts), so the state IS
 * "submitted, not yet consumed". No event scan and no separate flag.
 *
 * `session_id` names the session `pending` is about: the one asked for, or,
 * when the query parameter is omitted, the active session that is waiting. It
 * is null when nothing is pending, so a caller that watches every session still
 * learns which one to pull.
 *
 * `submit_seq` is the log seq of the `submit` event that entered the state, so
 * `(session_id, submit_seq)` IDENTIFIES one submit. Two reads that return the
 * same pair are looking at the same waiting submit; a different pair is a
 * different one. That identity is what makes a repeating watcher possible:
 * `wait` answers immediately while a submit sits unpulled, so a loop with no
 * memory would announce the same submit on every iteration. `scripts/watch.ts`
 * emits one line per NEW pair (WATCH-DEDUPE). Null exactly when `pending` is
 * false.
 */
export const TurnPendingSchema = z.object({
  pending: z.boolean(),
  session_id: idString().nullable(),
  submit_seq: z.number().int().nullable(),
  contract_version: tokenString(),
});
export type TurnPending = z.infer<typeof TurnPendingSchema>;

/**
 * `GET /api/turn/wait?session_id=&timeout_ms=` answers with a `TurnPending`
 * body too, deliberately: the question is identical ("is there a submit nothing
 * has pulled yet?") and only the WAITING differs. `wait` holds the request open
 * until a submit lands or `timeout_ms` elapses; `pending` answers now. There is
 * no second schema for it, because a second copy of these four fields is the
 * restatement src/contract exists to prevent — `TurnPendingSchema` above IS the
 * wait body, and both routes build it through one function
 * (src/server/routes/read.ts `answerPending`).
 *
 * Both are pure reads. Neither consumes the submit it reports — only
 * `POST /api/pull` does.
 */

/**
 * Bounds on one `wait` call.
 *
 * The cap is what makes the long poll safe to drive from a shell loop: one call
 * returns within a minute whatever happens. Waiting longer than the cap is the
 * CALLER's job — it calls again. There is deliberately no unbounded wait.
 *
 * The max must stay under the server's `idleTimeout` (src/server/index.ts, 120s)
 * or Bun would reap the held connection before the handler answered it.
 *
 * **The client's own request timeout is a second, independent bound, and this
 * cap does not protect against it.** A client that gives the request less than
 * `timeout_ms` + round trip surfaces a transport error instead of the
 * `pending: false` the server was about to send — the wait looks broken when it
 * worked. So the client-side budget is derived here rather than restated
 * anywhere: `TURN_WAIT_MAX_TIMEOUT_MS + TURN_WAIT_CLIENT_SLACK_MS` is what
 * `scripts/watch.ts` aborts on, and no document, skill, or script writes either
 * number again (WAIT-TIMEOUT-ONE-PLACE). Nothing in the server can detect a
 * mismatch, which is why the rule lives on the constants.
 *
 * No MCP tool may hold a wait. An MCP client request that outlives the client's
 * own request timeout fails the whole tool call with JSON-RPC `-32001` (request
 * timed out), which is why waiting left the MCP surface entirely: the wait is
 * driven by the harness against these endpoints, never by a `agent_coop_*` tool.
 */
export const TURN_WAIT_MAX_TIMEOUT_MS = 60_000;
export const TURN_WAIT_DEFAULT_TIMEOUT_MS = 30_000;
export const TURN_WAIT_CLIENT_SLACK_MS = 10_000;

/**
 * The three numbers the WATCHER runs on.
 *
 * They live here, beside the cap they sit next to, because they are semantics of
 * the trigger channel rather than of one script: they are only meaningful in
 * terms of what `wait` answers and when. Keeping them in `scripts/watch.ts` made
 * the claim "every timing number lives in src/contract" false the moment anyone
 * checked, and the skill and the README both make that claim.
 *
 * `scripts/watch.ts` imports all three and writes none of them again.
 */

/** How long the watcher sits still when the answer is a submit it has already
 *  announced. Without it that case is a busy loop for the length of Claude's
 *  turn, because `wait` returns instantly while a submit is unpulled. */
export const TURN_WATCH_RECHECK_MS = 2_000;

/** How long the watcher sits still after a failed request. A watcher that exits
 *  on one refused connection stops waking Claude the first time the server
 *  restarts. */
export const TURN_WATCH_RETRY_MS = 2_000;

/**
 * How long the SAME unpulled submit stays quiet before it is announced again.
 *
 * De-duplication is what stops one submit waking Claude on every iteration
 * (WATCH-DEDUPE), and on its own it is also how a wake gets LOST: a notification
 * that arrives during an interrupted or abandoned turn is never repeated, the
 * submit stays unpulled for ever, and the only way out is the user typing in
 * chat — which is the one thing agent-coop exists to avoid.
 *
 * So de-duplication is bounded rather than permanent. Still unpulled after this
 * long means nothing acted on the wake, because a turn that acted would have
 * pulled and `pending` would be false. Re-announcing costs at most one extra
 * notification for a turn that is genuinely slow to reach its `agent_coop_pull`; that
 * is the trade, and it is the cheap side.
 */
export const TURN_WATCH_REANNOUNCE_MS = 60_000;

/**
 * The `timeout_ms` query parameter, from raw string to a usable number.
 *
 * Every unusable input — absent, empty, not a number, zero, negative — becomes
 * the default rather than a 400, and anything over the cap is clamped to it.
 * A wait that refused the request would turn a caller's bad arithmetic into a
 * broken loop; a clamped wait just returns sooner and gets called again.
 */
export const TurnWaitTimeoutSchema = z.coerce
  .number()
  .int()
  .positive()
  .catch(TURN_WAIT_DEFAULT_TIMEOUT_MS)
  .transform((ms) => Math.min(ms, TURN_WAIT_MAX_TIMEOUT_MS));

/**
 * REQUEST body of the two session-scoped turn actions the user drives:
 * `POST /api/submit` and `POST /api/cancel` (PI-4). What they answer WITH is
 * `TurnActionResult` below.
 *
 * One schema for both because they are the same request in opposite directions,
 * and a second hand-written `{ session_id }` object is the kind of restated
 * shape src/contract exists to prevent.
 */
export const SessionActionSchema = z.object({ session_id: idString() });
export type SessionAction = z.infer<typeof SessionActionSchema>;

/**
 * RESPONSE body of `POST /api/submit` and `POST /api/cancel` — the request body
 * of both is `SessionAction` above. Two schemas, two directions: naming them
 * both "body of POST /api/submit" is how a reader ends up sending the wrong one.
 *
 * `state` is the projected state AFTER the action, read back from the engine
 * rather than assumed by the handler: `cancel` is the one action whose result
 * depends on where the session was (either non-editing state lands in
 * USER_EDITING), and a handler that echoed a constant would be asserting a
 * transition it did not perform.
 */
export const TurnActionResultSchema = z.object({
  session_id: idString(),
  state: SessionStateSchema,
  contract_version: tokenString(),
});
export type TurnActionResult = z.infer<typeof TurnActionResultSchema>;
