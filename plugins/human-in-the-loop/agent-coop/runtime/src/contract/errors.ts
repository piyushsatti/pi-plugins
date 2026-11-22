// The domain error vocabulary: what the engine says when it refuses an event
// (B1). One code per rule that can refuse, plus the message and the state the
// session was in.
//
// It carries NO HTTP status and NO MCP field, deliberately. src/engine must not
// know HTTP or MCP exists (repo-design §Architecture mapping), and it used to
// return both — a `409 | 404` and an `McpToolError` — which made the reducer the
// place where agent-coop's protocols were decided. A refusal now names the domain rule
// that refused it, and each boundary owns its own translation table:
//
//   src/server/errors.ts  code -> HTTP status, and the `retry_after_submit` hint
//                         on the `McpToolError` body it writes (HTTP is the
//                         server's boundary, so both belong to it).
//   src/mcp/tools.ts      that body -> `McpToolError` for Claude, including the
//                         transport failures no server ever answered.
//
// Defined here because the code crosses a seam (src/engine -> src/server) and
// src/contract is the only place a seam is described.
import { z } from "zod";
import { textString } from "./limits.ts";
import { SessionStateSchema } from "./session.ts";

/**
 * Every way `decide` can refuse, named by the rule rather than by a status.
 *
 * The five `unknown_*` codes are referential: the event names a row that is not
 * there. Most of the rest are the turn gate, see src/engine/reducer.ts, which
 * is the authority on which state each one fires in. `transcribe_failed`,
 * `transcript_empty` and `transcribe_busy` are the three codes `decide` never
 * produces: all three are raised by src/server/routes/write.ts, BEFORE
 * `comment_create`/`comment_reply` ever dispatches, when voice input riding a
 * comment (CommentAudioSchema, ./comment.ts) did not become usable text. They
 * live in this same enum anyway, because a refusal this boundary has to carry
 * a `state` for is a refusal this registry already exists to describe:
 * inventing a second, parallel error shape for three codes would just be this
 * file's own job done twice.
 */
export const DomainErrorCodeSchema = z.enum([
  "unknown_session",
  "unknown_block",
  "unknown_comment",
  "unknown_attachment",
  /** A `note_written` naming a revision label no row carries. */
  "unknown_revision",
  "duplicate_document",
  /** A block edit by the user outside USER_EDITING. */
  "document_locked",
  /** A `claude_apply` outside CLAUDE_TURN. */
  "not_claude_turn",
  /** A `submit` from anywhere but USER_EDITING. */
  "not_user_editing",
  /** A `cancel` from USER_EDITING: there is no turn to take back. */
  "nothing_to_cancel",
  /** A `pull` with nothing submitted. */
  "nothing_submitted",
  /** A `snapshot` with no turn open to close. */
  "no_open_turn",
  /** The transcribe backend threw, or src/server/routes/write.ts's own bound
   *  (TRANSCRIBE_TIMEOUT_MS) was exceeded. NOT part of the turn gate:
   *  resubmitting does not clear it, so it is deliberately absent from
   *  CLEARED_BY_SUBMIT in src/server/errors.ts. */
  "transcribe_failed",
  /** Audio rode the request but the backend heard nothing in it (an empty
   *  transcript). Distinct from `transcribe_failed`: the backend did not
   *  throw, it answered, and the answer was silence. Refused rather than
   *  silently kept as typed-text-only, so the voice half never vanishes with
   *  no signal anywhere (adversarial review of voice input). Also absent from
   *  CLEARED_BY_SUBMIT: resubmitting the same audio would not help either. */
  "transcript_empty",
  /** src/server/routes/write.ts's own bound on transcriptions running at
   *  once (MAX_CONCURRENT_TRANSCRIPTIONS, src/server/context.ts) was already
   *  at capacity, so this one was refused outright rather than queued.
   *  Absent from CLEARED_BY_SUBMIT for the same reason as `transcribe_failed`. */
  "transcribe_busy",
]);
export type DomainErrorCode = z.infer<typeof DomainErrorCodeSchema>;

/** Enumerated so a boundary's mapping table can be checked for completeness. */
export const DOMAIN_ERROR_CODES = DomainErrorCodeSchema.options;

export const DomainErrorSchema = z.object({
  code: DomainErrorCodeSchema,
  /** For a human. Never parsed by a caller — that is what `code` is for. */
  message: textString(),
  /** The projected state the event was refused in. */
  state: SessionStateSchema,
});
export type DomainError = z.infer<typeof DomainErrorSchema>;
