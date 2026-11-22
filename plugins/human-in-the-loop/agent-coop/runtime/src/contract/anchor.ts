// CommentAnchor — contract-design.md §Comment anchor.
// Both relative positions are opaque outside the engine's Yjs binding.
//
// PI-6: an anchor pins BOTH ends of the highlighted run, not just its start.
// The old shape stored one position and sized the highlight with
// `quoted_text.length`, which freezes the extent at creation time: after Claude
// rewrote the block the mark confidently covered a run of the wrong length
// while `anchor_state` still read "attached". Anchoring the tail as well makes
// the length a thing Yjs answers, so it tracks edits inside the run — and when
// either end fails to resolve, or the two collapse onto each other, the answer
// is `detached`/`orphaned` rather than a highlight nobody checked.
import { z } from "zod";
import { idString, textString, tokenString } from "./limits.ts";

export const CommentAnchorSchema = z.object({
  block_id: idString(),
  // Opaque Yjs encoding, not free text: capped as a token, never as a body.
  /** Head of the run. Associates rightwards, so text inserted before it pushes
   *  the whole highlight along. */
  relative_position: tokenString(),
  /**
   * Tail of the run, associating leftwards so it sticks to the last anchored
   * character rather than absorbing text typed at the boundary.
   *
   * Nullable for exactly one reason: anchors created before PI-6 recorded no
   * tail, and a Yjs position cannot be invented for them after the fact. Such an
   * anchor resolves to `detached` — never to a guessed length, which is the
   * defect this field exists to remove.
   */
  relative_position_end: tokenString().nullable(),
  /** Display-only snapshot of what was highlighted. Never re-matched to find a
   *  position, and since PI-6 never used to size one either. */
  quoted_text: textString(),
});
export type CommentAnchor = z.infer<typeof CommentAnchorSchema>;
