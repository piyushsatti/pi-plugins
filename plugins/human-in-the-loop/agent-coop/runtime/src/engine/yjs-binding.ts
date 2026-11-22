// Yjs binding: one Y.XmlFragment per document, blocks as child elements
// carrying a block_id attribute, ordered natively by fragment position (D3,
// db-design §3.1). Every decode of a CommentAnchor.relative_position happens
// here and nowhere else (db-design §3.3).
import * as Y from "yjs";
import type { AnchorState, Block, BlockOp, CommentAnchor } from "../contract/index.ts";

export const FRAGMENT_NAME = "blocks";
export const BLOCK_TAG = "block";
export const BLOCK_ID_ATTR = "block_id";

export function fragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(FRAGMENT_NAME);
}

/** The Y.XmlText holding one block's raw markdown, or null if absent. */
export function blockText(doc: Y.Doc, block_id: string): Y.XmlText | null {
  const el = blockElement(doc, block_id);
  return el ? (el.firstChild as Y.XmlText | null) : null;
}

export function blockElement(doc: Y.Doc, block_id: string): Y.XmlElement | null {
  for (const child of fragment(doc).toArray()) {
    if (child instanceof Y.XmlElement && child.getAttribute(BLOCK_ID_ATTR) === block_id) return child;
  }
  return null;
}

export function blockIndex(doc: Y.Doc, block_id: string): number {
  const children = fragment(doc).toArray();
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c instanceof Y.XmlElement && c.getAttribute(BLOCK_ID_ATTR) === block_id) return i;
  }
  return -1;
}

/** Fragment walk → Block[]. Order is the fragment's own child ordering. */
export function readBlocks(doc: Y.Doc): Block[] {
  const out: Block[] = [];
  let order = 0;
  for (const child of fragment(doc).toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    const block_id = child.getAttribute(BLOCK_ID_ATTR);
    if (block_id === undefined) continue;
    const text = child.firstChild as Y.XmlText | null;
    out.push({ block_id, content: text ? text.toString() : "", order: order++ });
  }
  return out;
}

function makeBlock(block_id: string, content: string): Y.XmlElement {
  const el = new Y.XmlElement(BLOCK_TAG);
  el.setAttribute(BLOCK_ID_ATTR, block_id);
  const t = new Y.XmlText();
  if (content.length > 0) t.insert(0, content);
  el.insert(0, [t]);
  return el;
}

/**
 * Read-only probe: which block_ids referenced by these ops are missing from
 * the live fragment. Runs in the reducer's validation phase (db-design §1, D2)
 * — it must never mutate.
 */
export function missingBlockIds(doc: Y.Doc, ops: BlockOp[]): string[] {
  const present = new Set(readBlocks(doc).map((b) => b.block_id));
  const missing: string[] = [];
  for (const op of ops) {
    if (op.op === "insert") {
      if (op.after_block_id !== null && !present.has(op.after_block_id)) missing.push(op.after_block_id);
      present.add(op.block_id);
      continue;
    }
    if (!present.has(op.block_id)) missing.push(op.block_id);
    if (op.op === "delete") present.delete(op.block_id);
  }
  return missing;
}

/**
 * Rewrite a block's text as a minimal splice: keep the common prefix and
 * suffix, replace only the differing middle. A wholesale delete+insert would
 * destroy every comment anchor in the block on any edit, however small — and
 * Yjs does NOT report that as an orphan (it silently resolves the dead
 * position to a neighbouring offset), so the damage would be invisible.
 * Nothing here inspects or reformats block text; it only bounds the edit.
 */
function spliceMinimal(t: Y.XmlText, next: string): void {
  const prev = t.toString();
  if (prev === next) return;
  let head = 0;
  while (head < prev.length && head < next.length && prev[head] === next[head]) head++;
  let tail = 0;
  while (
    tail < prev.length - head &&
    tail < next.length - head &&
    prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail++;
  }
  const removed = prev.length - head - tail;
  const added = next.slice(head, next.length - tail);
  if (removed > 0) t.delete(head, removed);
  if (added.length > 0) t.insert(head, added);
}

/** BlockOp[] → fragment mutation, all ops in one Yjs transaction. */
export function applyBlockOps(doc: Y.Doc, ops: BlockOp[], origin: unknown = "engine"): void {
  doc.transact(() => {
    const frag = fragment(doc);
    for (const op of ops) {
      if (op.op === "insert") {
        const at = op.after_block_id === null ? 0 : blockIndex(doc, op.after_block_id) + 1;
        frag.insert(at, [makeBlock(op.block_id, op.content)]);
      } else if (op.op === "replace") {
        const t = blockText(doc, op.block_id);
        if (t === null) throw new Error(`replace: unknown block_id ${op.block_id}`);
        spliceMinimal(t, op.content);
      } else {
        const i = blockIndex(doc, op.block_id);
        if (i < 0) throw new Error(`delete: unknown block_id ${op.block_id}`);
        frag.delete(i, 1);
      }
    }
  }, origin);
}

// --- comment anchors (db-design §3.3) -------------------------------------

const b64 = {
  encode: (u: Uint8Array) => Buffer.from(u).toString("base64"),
  decode: (s: string) => new Uint8Array(Buffer.from(s, "base64")),
};

/** Encode a Y.RelativePosition into the contract's opaque base64 string. */
export function encodeRelativePosition(rel: Y.RelativePosition): string {
  return b64.encode(Y.encodeRelativePosition(rel));
}

export function decodeRelativePosition(encoded: string): Y.RelativePosition {
  return Y.decodeRelativePosition(b64.decode(encoded));
}

/**
 * Which side of its neighbouring character a relative position clings to.
 *
 * Yjs calls this `assoc`: >= 0 binds to the character on the RIGHT, < 0 to the
 * character on the LEFT. The two ends of a highlight want opposite answers, and
 * that asymmetry is the whole mechanism by which the run's length tracks edits:
 *
 *   head, assoc 0   binds rightwards to the first anchored character, so text
 *                   inserted immediately before the run pushes the run along
 *                   instead of being swallowed into it.
 *   tail, assoc -1  binds leftwards to the last anchored character, so text
 *                   typed at the closing boundary lands outside the highlight,
 *                   and a rewrite that shortens the run shortens the mark.
 */
const HEAD_ASSOC = 0;
const TAIL_ASSOC = -1;

/**
 * Build a CommentAnchor for [start, end) within one block's text.
 *
 * BOTH ends are pinned (PI-6). `quoted_text` is carried for display and is
 * never re-matched to find a position, nor — since PI-6 — used to size one.
 */
export function createAnchor(
  doc: Y.Doc,
  block_id: string,
  offsets: [number, number],
): CommentAnchor {
  const t = blockText(doc, block_id);
  if (t === null) throw new Error(`createAnchor: unknown block_id ${block_id}`);
  const [start, end] = offsets;
  return {
    block_id,
    relative_position: encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(t, start, HEAD_ASSOC),
    ),
    relative_position_end: encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(t, end, TAIL_ASSOC),
    ),
    quoted_text: t.toString().slice(start, end),
  };
}

/** One end of an anchor, resolved against the live doc, or null. */
function resolveEnd(doc: Y.Doc, encoded: string): number | null {
  const abs = Y.createAbsolutePositionFromRelativePosition(decodeRelativePosition(encoded), doc);
  return abs === null ? null : abs.index;
}

/**
 * Resolve an anchor's HEAD against the live doc. `null` from
 * createAbsolutePositionFromRelativePosition is the one and only orphan
 * condition (db-design §3.3) — no fuzzy fallback exists anywhere.
 */
export function resolveAnchor(doc: Y.Doc, anchor: CommentAnchor): number | null {
  if (blockElement(doc, anchor.block_id) === null) return null;
  return resolveEnd(doc, anchor.relative_position);
}

/** The live source-offset range of an anchor, with the reason when there is none. */
export type AnchorResolution =
  | { state: "attached"; start: number; end: number }
  | { state: "detached" | "orphaned" };

/**
 * Resolve BOTH ends of an anchor. This is the only function that decides an
 * `anchor_state`, and it decides it from Yjs's answers alone.
 *
 * The three outcomes, and why each is not the others:
 *
 *   orphaned  the block is gone, or the head resolved to null. There is no
 *             position at all, so there is nothing to say about extent.
 *   detached  the head resolved but the run did not — the tail resolved to null,
 *             the tail landed at or before the head (the anchored characters
 *             were deleted, and Yjs maps both ends onto the same surviving
 *             index), or the anchor predates PI-6 and stored no tail. The
 *             comment still names a block; it no longer names words.
 *   attached  both ends resolved and still span at least one character.
 *
 * `detached` is deliberately NOT collapsed into `attached`-with-a-guess. Before
 * PI-6 this function's predecessor sized the run as
 * `head + quoted_text.length`, so a rewritten block produced a mark of the
 * original length over whatever text now sat there — wrong words, highlighted
 * confidently, with the state still reading "attached".
 */
export function resolveAnchorRange(doc: Y.Doc, anchor: CommentAnchor): AnchorResolution {
  if (blockElement(doc, anchor.block_id) === null) return { state: "orphaned" };
  const start = resolveEnd(doc, anchor.relative_position);
  if (start === null) return { state: "orphaned" };
  if (anchor.relative_position_end === null) return { state: "detached" };
  const end = resolveEnd(doc, anchor.relative_position_end);
  if (end === null || end <= start) return { state: "detached" };
  return { state: "attached", start, end };
}

export function anchorState(doc: Y.Doc, anchor: CommentAnchor | null): AnchorState {
  if (anchor === null) return "attached";
  return resolveAnchorRange(doc, anchor).state;
}
