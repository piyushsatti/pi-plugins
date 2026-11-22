// Markdown <-> blocks: the two directions of one rule (db-design §5).
//
// Blocks store RAW markdown source, never a parsed tree, so export is a
// concatenation and import is a split — no normalising, no reformatting, no
// re-rendering. That is the whole reason the round trip is verbatim, and it is
// why nothing in this file may "tidy" a block's text.
//
// Canonical form: exactly one blank line between blocks, one trailing newline.
// `blocksToMarkdown(splitMarkdown(src)) === src` holds for canonical src, and
// `splitMarkdown(blocksToMarkdown(blocks))` returns the same block contents for
// any blocks that do not themselves contain a bare blank line.
import type { Block } from "../contract/index.ts";

const SEPARATOR = "\n\n";

/** Blocks -> one markdown document, in `order`. Never reformats a block. */
export function blocksToMarkdown(blocks: Block[]): string {
  const ordered = [...blocks].sort((a, b) => a.order - b.order);
  const body = ordered.map((b) => b.content).join(SEPARATOR);
  return body === "" ? "" : `${body}\n`;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}([-*+]|\d+[.)])(\s|$)/;
const CONTINUATION = /^(\s{2,}|\t)\S/;

function fenceCloses(line: string, marker: string): boolean {
  const m = FENCE_OPEN.exec(line);
  return m !== null && m[1]![0] === marker[0] && m[1]!.length >= marker.length;
}

/**
 * One markdown document -> block sources.
 *
 * Two rules beyond "split on blank lines", both needed by the export fixture:
 * a blank line inside a fenced block is not a boundary (mermaid fences and
 * code samples routinely contain them), and a blank line inside a list is not
 * a boundary either (a loose list is one block, so a nested list survives the
 * round trip instead of shattering into one block per item).
 */
export function splitMarkdown(source: string): string[] {
  const lines = source.replace(/\n$/, "").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (current.length > 0) blocks.push(current.join("\n"));
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (fence !== null) {
      current.push(line);
      if (fenceCloses(line, fence)) fence = null;
      continue;
    }
    const opening = FENCE_OPEN.exec(line);
    if (opening !== null) {
      current.push(line);
      fence = opening[1]!;
      continue;
    }
    if (line.trim() !== "") {
      current.push(line);
      continue;
    }

    // Blank line outside a fence: a boundary unless a list continues over it.
    const next = lines.slice(i + 1).find((l) => l.trim() !== "");
    const inList = current.length > 0 && LIST_ITEM.test(current[0]!);
    if (inList && next !== undefined && (LIST_ITEM.test(next) || CONTINUATION.test(next))) {
      current.push(line);
      continue;
    }
    flush();
  }
  flush();
  return blocks;
}
