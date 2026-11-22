// Live-anchor decoration: a projection row says WHERE a comment was anchored;
// only the live Y.Doc says where that anchor is NOW. This module is the one
// place the two are joined, so no handler resolves an anchor by hand.
//
// Why it exists (ui-design §Selection-comment layer): the browser must paint a
// `<mark>` over the anchored characters, but it is forbidden to decode a
// relative position or to re-match `quoted_text`. Both rules leave exactly one
// legal source for the mark's position — the server. `rendered_offsets` on the
// wire `Comment` is that answer, recomputed on every read, so a comment that
// moved under a Claude edit comes back at its new position rather than a stale
// one.
//
// PI-6 changed WHAT is recomputed. Both ends are resolved from Yjs, so the
// highlight's LENGTH tracks edits too. Previously only the head was anchored and
// the extent was `quoted_text.length`, frozen at creation: after Claude rewrote
// the block the mark covered a run of the original length over whatever text now
// sat there, and `anchor_state` still said "attached". A wrong highlight
// presented as a right one is worse than no highlight, so when the run cannot be
// resolved this reports `detached` (or `orphaned`) and paints nothing.
import type { AnchorState, Comment } from "../contract/index.ts";
import { resolveAnchorRange } from "../engine/index.ts";
import type { Engine } from "../engine/index.ts";
import { mapSourceOffsetToRendered } from "./offsets.ts";

type WithEngine = { engine: Engine };

type Decoration = {
  anchor_state: AnchorState;
  rendered_offsets: [number, number] | null;
};

/**
 * The two read-only fields the wire `Comment` carries, resolved together.
 *
 * They are computed in one place because they are one answer: offsets exist
 * exactly when the state is `attached`, and any code path that could produce one
 * without the other is a path that can paint a highlight nobody vouched for.
 */
function decorate(ctx: WithEngine, comment: Comment): Decoration {
  const anchor = comment.anchor;
  // A global comment (A4) is not unanchored-and-broken; it never had an anchor,
  // so `attached` with nothing to paint is the correct reading of both fields.
  if (anchor === null) return { anchor_state: "attached", rendered_offsets: null };
  if (comment.doc_id === "") return { anchor_state: "orphaned", rendered_offsets: null };

  const block = ctx.engine.blocks(comment.doc_id).find((b) => b.block_id === anchor.block_id);
  if (block === undefined) return { anchor_state: "orphaned", rendered_offsets: null };

  // The engine decides the state; this function only translates coordinates.
  // Nothing here checks whether `quoted_text` still matches — that would be the
  // fuzzy re-matching the design rejected outright (db-design §3.3).
  const resolved = resolveAnchorRange(ctx.engine.getDoc(comment.doc_id), anchor);
  if (resolved.state !== "attached") {
    return { anchor_state: resolved.state, rendered_offsets: null };
  }

  return {
    anchor_state: "attached",
    rendered_offsets: [
      mapSourceOffsetToRendered(block.content, resolved.start, "start"),
      mapSourceOffsetToRendered(block.content, resolved.end, "end"),
    ],
  };
}

/**
 * One projection-read comment, decorated for the wire.
 *
 * The live resolution overrides the projection's stored `anchor_state` for an
 * anchored comment: the projection is a cached sweep result (projections.ts
 * `reanchorComments`), the live Y.Doc is the truth, and a read that returned the
 * cache while the offsets came from the doc could disagree with itself.
 */
export function liveComment(ctx: WithEngine, comment: Comment | null): Comment | null {
  if (comment === null) return null;
  return { ...comment, ...decorate(ctx, comment) };
}

export function liveComments(ctx: WithEngine, comments: Comment[]): Comment[] {
  return comments.map((c) => liveComment(ctx, c) as Comment);
}

/** A comment thread (PI-7), every member decorated the same way. */
export function liveThread(
  ctx: WithEngine,
  thread: { root: Comment; replies: Comment[] },
): { root: Comment; replies: Comment[] } {
  return {
    root: liveComment(ctx, thread.root) as Comment,
    replies: liveComments(ctx, thread.replies),
  };
}
