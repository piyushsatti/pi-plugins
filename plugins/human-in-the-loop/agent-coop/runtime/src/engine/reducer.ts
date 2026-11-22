// The reducer, split per contract-design §The event log: a pure `decide` with
// no I/O, and an impure apply step (engine.ts) that persists the decision to
// the log and every projection it touches in ONE SQLite transaction.
import type { DomainError, DomainErrorCode, Event, SessionState } from "../contract/index.ts";

/** Everything `decide` is allowed to know. Gathered by the caller's read-only
 *  validation phase (SQL projections + read-only Y.Doc probes, db-design D2). */
export type DecideContext = {
  /** Current projected session state; null = session does not exist. */
  state: SessionState | null;
  /** claude_apply only: this client_edit_id was already applied (D13). */
  duplicate_client_edit_id?: boolean;
  /** doc_added only: a document with this id is already in the database. */
  duplicate_doc_id?: boolean;
  /** user_edit / claude_apply only: block_ids the ops reference that are absent. */
  missing_block_ids?: string[];
  /** comment_reply / comment_resolve only: the referenced comment is absent. */
  missing_comment_id?: boolean;
  /** attachment / transcript_* only: the referenced attachment is absent. */
  missing_attachment_id?: boolean;
  /** note_written only: no revision row carries that label for that document. */
  missing_revision_id?: boolean;
};

export type Decision =
  | {
      ok: true;
      /** null when the event is legal but changes no state (e.g. pull in CLAUDE_TURN). */
      transition: { from: SessionState; to: SessionState } | null;
      /** true = append the event for audit but write no projection change. */
      noop: boolean;
    }
  /** A domain refusal and nothing else: no HTTP status, no MCP field. The
   *  boundary that received the request owns that translation (B1) — see
   *  src/contract/errors.ts. */
  | { ok: false; error: DomainError };

function reject(state: SessionState, code: DomainErrorCode, message: string): Decision {
  return { ok: false, error: { code, message, state } };
}

const ok = (
  transition: { from: SessionState; to: SessionState } | null = null,
  noop = false,
): Decision => ({ ok: true, transition, noop });

/**
 * Pure. Given the projected state and the read-only probe results, decide
 * whether an event is legal and what it transitions. No database, no Y.Doc.
 */
export function decide(ctx: DecideContext, event: Event): Decision {
  const state = ctx.state;
  if (state === null) {
    // No projected state to report, so the field carries the machine's start
    // state rather than a guess about a session that does not exist.
    return reject("USER_EDITING", "unknown_session", `unknown session ${event.session_id}`);
  }

  // Referential preconditions apply regardless of state.
  if (ctx.missing_block_ids && ctx.missing_block_ids.length > 0) {
    return reject(state, "unknown_block", `unknown block_id: ${ctx.missing_block_ids.join(", ")}`);
  }
  if (ctx.missing_comment_id) return reject(state, "unknown_comment", "unknown comment_id");
  if (ctx.missing_attachment_id) return reject(state, "unknown_attachment", "unknown attachment_id");
  if (ctx.missing_revision_id) return reject(state, "unknown_revision", "unknown revision_id");
  if (ctx.duplicate_doc_id) {
    return reject(state, "duplicate_document", "a document with that id already exists");
  }

  switch (event.type) {
    // --- turn-gated writes -------------------------------------------------
    case "user_edit":
      return state === "USER_EDITING"
        ? ok()
        : reject(state, "document_locked", "document is read-only outside USER_EDITING");

    case "claude_apply":
      if (state !== "CLAUDE_TURN") {
        return reject(
          state,
          "not_claude_turn",
          "Claude may only write during CLAUDE_TURN; ask the user to submit",
        );
      }
      // Idempotency (D13): a repeated client_edit_id is a legal no-op, not an error.
      return ctx.duplicate_client_edit_id ? ok(null, true) : ok();

    case "submit":
      // Zero changes is explicitly allowed (contract-design §Turn protocol edge cases).
      return state === "USER_EDITING"
        ? ok({ from: state, to: "SUBMITTED" })
        : reject(state, "not_user_editing", "submit is only valid from USER_EDITING");

    // The user taking the document back (PI-4). Legal from either non-editing
    // state and from neither more nor less:
    //
    //   SUBMITTED    an accidental submit, or one nothing ever pulled.
    //   CLAUDE_TURN  a Claude session that died, or a turn the user no longer
    //                wants. Whatever Claude already applied STAYS: cancel closes
    //                the turn, it does not undo the log. The next diff shows
    //                those blocks as Claude's, which is what happened.
    //
    // From USER_EDITING it is refused rather than a silent no-op: a control that
    // reports success for doing nothing teaches the user it did something. And
    // `nothing_to_cancel` is the one turn-gate code no submit would clear, which
    // is why the boundary's retry hint keys off the code and not the state.
    case "cancel":
      return state === "USER_EDITING"
        ? reject(state, "nothing_to_cancel", "nothing to cancel: the document is already yours to edit")
        : ok({ from: state, to: "USER_EDITING" });

    case "pull":
      if (state === "SUBMITTED") return ok({ from: state, to: "CLAUDE_TURN" });
      // Already CLAUDE_TURN: appended for audit, no transition, identical batch.
      if (state === "CLAUDE_TURN") return ok(null, true);
      return reject(state, "nothing_submitted", "nothing has been submitted yet");

    case "snapshot":
      return state === "CLAUDE_TURN"
        ? ok({ from: state, to: "USER_EDITING" })
        : reject(state, "no_open_turn", "snapshot closes a Claude turn; none is open");

    // --- valid in any state ------------------------------------------------
    // doc_added is here on purpose (A1, PI-2): adding a document writes no
    // existing document, so it collides with nothing the turn gate protects.
    // Claude adds one during CLAUDE_TURN, the user during USER_EDITING, and
    // neither has to wait for the other's turn to end.
    //
    // note_written is here for a sharper reason: it describes a turn that has
    // ALREADY closed, so by definition it is written outside CLAUDE_TURN. Gating
    // it the way `claude_apply` is gated would refuse it every single time, and
    // the feature would never work once. It touches no document and no block, so
    // there is nothing for the turn gate to protect from it — the same argument
    // as `comment_create`, which is also legal throughout.
    case "doc_added":
    case "note_written":
    case "comment_create":
    case "comment_reply":
    case "comment_resolve": // D7: resolve is valid from any state and any actor
    case "export":
    case "attachment_add":
    case "transcript_done":
    case "transcript_manual":
    case "transcript_failed":
    case "transcript_retry":
      return ok();
  }
}
