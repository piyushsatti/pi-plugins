// Word-level diff inside a modified block (ui-design §Turn-diff view).
//
// It lives server-side for the same reason `rendered_offsets` does: the client
// is not allowed to work out what changed. `src/engine/diff.ts` answers WHICH
// blocks changed (structural, by block_id, from two reconstructions); this
// answers WHICH WORDS inside one of them, and the browser only paints the
// answer. Nothing here is heuristic re-anchoring — it never feeds a position,
// only a rendering.
import type { BlockDiff, WordOp } from "../contract/index.ts";

export type { WordOp };

/** Words and the whitespace between them, as separate tokens so a diff can
 *  land on a word boundary without eating the spaces around it. */
export function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t !== "");
}

/** Above this, the O(n*m) table stops being worth it and the whole block is
 *  reported as replaced. Blocks are paragraphs; this is a guard, not a policy. */
const MAX_TOKENS = 600;

/**
 * A word-level diff of two block sources. Plain LCS over tokens: exact, with
 * no similarity threshold to tune (the thing root-fixes R3 rejected for
 * anchors, and which has no business here either).
 */
export function diffWords(from: string, to: string): WordOp[] {
  if (from === to) return from === "" ? [] : [{ op: "equal", text: from }];
  const a = tokenize(from);
  const b = tokenize(to);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return compress([
      ...a.map((text): WordOp => ({ op: "delete", text })),
      ...b.map((text): WordOp => ({ op: "insert", text })),
    ]);
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: WordOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ op: "equal", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ op: "delete", text: a[i]! });
      i++;
    } else {
      ops.push({ op: "insert", text: b[j]! });
      j++;
    }
  }
  for (; i < a.length; i++) ops.push({ op: "delete", text: a[i]! });
  for (; j < b.length; j++) ops.push({ op: "insert", text: b[j]! });
  return compress(ops);
}

/** Merge adjacent ops of the same kind, so the client paints one span per run. */
function compress(ops: WordOp[]): WordOp[] {
  const out: WordOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last !== undefined && last.op === op.op) last.text += op.text;
    else out.push({ ...op });
  }
  return out;
}

/** Decorate a structural diff with word ops on every modified block. `words` is
 *  part of the contract's `BlockChange`, so this narrows nothing and invents
 *  nothing — it fills in a field the wire type already declares. */
export function withWordDiff(diff: BlockDiff): BlockDiff {
  return {
    ...diff,
    changes: diff.changes.map((c) =>
      c.change === "modified" ? { ...c, words: diffWords(c.from.content, c.to.content) } : c,
    ),
  };
}
