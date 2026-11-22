// The server's periodic housekeeping: the attachment-file GC sweep (D12),
// update-log compaction (D11, B6) and the stale-submit sweep (LOOP-4).
//
// All of it lives off the request path, on one timer in serve(). Compaction was
// fully implemented in src/engine and called by nothing, so `document_updates`
// grew without bound for the life of a database — this module is the caller. The
// engine still schedules nothing itself: it exposes "which documents are over the
// threshold" and "compact this one", and deciding when belongs to the process
// that owns the clock.
//
// A compaction failure is logged and dropped rather than rethrown: the swap is
// transactional (src/engine/compaction.ts), so a failed run leaves the original
// rows intact and the next pass re-attempts.
import {
  COMPACTION_THRESHOLD,
  compactDocument,
  docsNeedingCompaction,
  sweep,
} from "../engine/index.ts";
import { dispatch, type DispatchContext } from "./context.ts";
import { submittedSessions } from "./queries.ts";

/**
 * How long a submit may sit unpulled before the sweep cancels it (LOOP-4).
 *
 * A day, because the failure this guards against is a session abandoned
 * overnight, not a slow turn: Claude can legitimately take a long time between
 * the submit and the pull, and a bound tight enough to catch a wandering user
 * would also cancel real work. Server policy, so it lives here and not in
 * src/contract — nothing across the seam names it.
 */
export const STALE_SUBMIT_MS = 24 * 60 * 60 * 1000;

export type MaintenanceResult = {
  /** Attachment files deleted by this pass. */
  deleted: string[];
  /** Documents whose update run was folded into one merged_snapshot. */
  compacted: string[];
  /** Sessions whose abandoned submit this pass cancelled (LOOP-4). */
  cancelled: string[];
};

export type MaintenanceOptions = {
  /** Update rows on one document before compaction folds them. */
  threshold?: number;
  /** Age at which an unpulled submit is abandoned. */
  staleSubmitMs?: number;
  log?: (message: string) => void;
};

/**
 * Cancel every submit nobody pulled in time.
 *
 * A `SUBMITTED` session locks its blocks, so an abandoned submit is a document
 * the user cannot edit and, before this, could only escape by finding the "Take
 * it back" control. It also used to pin the trigger: the pending answer named
 * the oldest submit, so one forgotten session hid every later one (that half is
 * fixed in queries.ts by ordering newest-first; this half stops the row existing
 * at all).
 *
 * The way out is the user's own way out (PI-4): a `cancel` event through the
 * reducer, which returns the session to USER_EDITING and clears the open turn.
 * The sweep gets no private path — it is the same event the "Take it back"
 * button sends, so the log records the same thing however it happened, and the
 * browser learns about it from the `state_changed` frame `dispatch` broadcasts.
 */
export function cancelStaleSubmits(
  ctx: DispatchContext,
  staleSubmitMs = STALE_SUBMIT_MS,
  log: (message: string) => void = (m) => console.error(m),
): string[] {
  const cutoff = new Date(Date.parse(ctx.now()) - staleSubmitMs).toISOString();
  const cancelled: string[] = [];
  for (const { session_id, submitted_at } of submittedSessions(ctx.db)) {
    if (submitted_at > cutoff) continue;
    const result = dispatch(ctx, { type: "cancel", session_id });
    if (result.ok) cancelled.push(session_id);
    // A refusal here means the state moved between the read and the dispatch —
    // someone pulled or cancelled it first, which is the outcome the sweep
    // wanted anyway. Logged, never thrown: a housekeeping pass that dies takes
    // GC and compaction down with it.
    else log(`stale-submit sweep could not cancel ${session_id}: already left SUBMITTED`);
  }
  return cancelled;
}

/**
 * One pass. Sequential on purpose: two concurrent compactions of the same
 * database would both be holding pinned row sets, and there is no reason to
 * overlap them on a single-user tool.
 */
export async function runMaintenance(
  ctx: DispatchContext,
  options: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const log = options.log ?? ((m: string) => console.error(m));
  const { deleted } = sweep(ctx.db);
  const cancelled = cancelStaleSubmits(ctx, options.staleSubmitMs, log);
  const compacted: string[] = [];
  for (const doc_id of docsNeedingCompaction(ctx.db, options.threshold ?? COMPACTION_THRESHOLD)) {
    try {
      const result = await compactDocument(ctx.db, doc_id);
      if (result.compacted) compacted.push(doc_id);
    } catch (err) {
      log(`compaction of ${doc_id} failed, retrying next pass: ${String(err)}`);
    }
  }
  return { deleted, compacted, cancelled };
}
