// Domain refusal -> HTTP (B1). This is the boundary that speaks HTTP, so this is
// where the engine's `DomainErrorCode` becomes a status code, and it is the only
// such table: src/engine returns a domain code and knows nothing about either
// number below.
import type { DomainError, DomainErrorCode } from "../contract/index.ts";
import { fail } from "./http.ts";

/**
 * Code -> status. `Record<DomainErrorCode, …>` rather than a partial map, so a
 * new code added to the contract is a compile error here until it is given one.
 *
 * Four statuses now, not two. The original split still holds for everything
 * `decide` itself can produce: a `unknown_*` refusal is "that row is not there"
 * (404), the turn gate is "the state machine says not now" (409). None of the
 * three voice-input codes are from the reducer at all (src/contract/errors.ts),
 * and resubmitting clears none of them the way a 409 promises. `transcribe_failed`
 * and `transcribe_busy` are both 503: the thing that was supposed to turn audio
 * into text either could not, or was too busy to try. `transcript_empty` is 400:
 * the backend ran and answered, so nothing about the SERVICE failed. The
 * recording itself had nothing in it, the same kind of client-side content
 * problem a 400 already names elsewhere in this file (parseBody's own schema
 * refusals).
 */
const STATUS: Record<DomainErrorCode, 400 | 404 | 409 | 503> = {
  unknown_session: 404,
  unknown_block: 404,
  unknown_comment: 404,
  unknown_attachment: 404,
  unknown_revision: 404,
  duplicate_document: 409,
  document_locked: 409,
  not_claude_turn: 409,
  not_user_editing: 409,
  nothing_to_cancel: 409,
  nothing_submitted: 409,
  no_open_turn: 409,
  transcribe_failed: 503,
  transcript_empty: 400,
  transcribe_busy: 503,
};

/**
 * The refusals a `submit` would clear, which is what `retry_after_submit` on the
 * `McpToolError` body means (D15). It lives here rather than in src/engine
 * because it is a field of agent-coop's HTTP error shape and this boundary writes it.
 *
 * The state matters as well as the code: `snapshot` refused from SUBMITTED is
 * waiting on a `pull`, not on a submit, so submitting again would not help.
 */
const CLEARED_BY_SUBMIT: ReadonlySet<DomainErrorCode> = new Set<DomainErrorCode>([
  "not_claude_turn",
  "nothing_submitted",
  "no_open_turn",
]);

export function statusFor(code: DomainErrorCode): 400 | 404 | 409 | 503 {
  return STATUS[code];
}

export function retryAfterSubmit(error: DomainError): boolean {
  return error.state === "USER_EDITING" && CLEARED_BY_SUBMIT.has(error.code);
}

/** The one place a domain refusal becomes a response. */
export function failDomain(error: DomainError): Response {
  return fail(statusFor(error.code), error.message, error.state, retryAfterSubmit(error));
}
