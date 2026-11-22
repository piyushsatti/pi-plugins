// mapRenderedOffsetToSource — ui-design.md §Selection-comment layer, step 3.
//
// The ONE position-mapping function in the whole stack, and it lives entirely
// server-side: the client only ever reports "which block, which rendered
// offsets". There is no client-side counterpart to keep in sync.
//
// Method: markdown-it parses the block source into its inline token stream.
// The token stream is authoritative for the RENDERED text (markup markers are
// not tokens, entities arrive already decoded in `text` tokens). The index is
// then the alignment of that rendered string back onto the source string,
// scanning forward and consuming an HTML entity whole when it decodes to the
// rendered character. Markup markers (`**`, backticks, `[`, `](url)`) and
// escape backslashes are the source characters the scan steps over, so a
// rendered offset can never land inside a marker or inside a decoded entity.
//
// Selection start and end are mapped by two independent calls; there is no
// range transform.
import MarkdownIt from "markdown-it";

const md = new MarkdownIt();

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** If an HTML entity starts at `i`, its decoded value and source length. */
function entityAt(src: string, i: number): { value: string; length: number } | null {
  if (src[i] !== "&") return null;
  const end = src.indexOf(";", i + 1);
  if (end < 0 || end - i > 12) return null;
  const body = src.slice(i + 1, end);
  if (body.startsWith("#")) {
    const code = body[1] === "x" || body[1] === "X"
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    if (Number.isNaN(code)) return null;
    return { value: String.fromCodePoint(code), length: end - i + 1 };
  }
  const value = NAMED_ENTITIES[body];
  return value === undefined ? null : { value, length: end - i + 1 };
}

/**
 * The rendered text of one block, derived from markdown-it's token stream —
 * exactly the characters a DOM selection inside the rendered block can cover.
 */
export function renderedText(blockSource: string): string {
  const segments: string[] = [];
  for (const token of md.parse(blockSource, {})) {
    if (token.type !== "inline") continue;
    let out = "";
    for (const child of token.children ?? []) {
      switch (child.type) {
        case "text":
        case "code_inline":
          out += child.content;
          break;
        case "softbreak":
        case "hardbreak":
          out += "\n";
          break;
        case "image":
          out += child.content; // alt text is what renders as characters
          break;
        default:
          break; // *_open / *_close / html_inline contribute no characters
      }
    }
    segments.push(out);
  }
  return segments.join("\n");
}

/**
 * The scan: for each rendered character, where its source representation
 * starts and where it ends. Both are needed because a selection's two
 * endpoints want different answers at the same rendered position — a caret
 * BEFORE a character wants the start of that character's source, a caret
 * AFTER one wants the end of the previous character's source, and between
 * them sits the markup (`**`, `](href)`) that belongs to neither.
 */
function scan(blockSource: string): { starts: number[]; ends: number[]; rendered: string } {
  const rendered = renderedText(blockSource);
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  // Code units, not code points: DOM selection offsets are UTF-16 offsets.
  for (let k = 0; k < rendered.length; k++) {
    const ch = rendered[k]!;
    let found = -1;
    let consumed = 0;
    while (i < blockSource.length) {
      const ent = entityAt(blockSource, i);
      if (ent !== null && ent.value === ch) {
        found = i;
        consumed = ent.length;
        break;
      }
      if (blockSource[i] === ch) {
        found = i;
        consumed = 1;
        break;
      }
      i++; // a markup marker, an escape backslash, or link/href machinery
    }
    if (found < 0) {
      starts.push(blockSource.length);
      ends.push(blockSource.length);
      i = blockSource.length;
    } else {
      starts.push(found);
      i = found + consumed;
      ends.push(i);
    }
  }
  return { starts, ends, rendered };
}

/**
 * `index[k]` is the source offset of rendered character `k`. Length is
 * `renderedText(blockSource).length + 1`; the final entry is the source offset
 * just past the last rendered character.
 */
export function buildOffsetIndex(blockSource: string): number[] {
  const { starts, ends } = scan(blockSource);
  return [...starts, ends.length === 0 ? 0 : ends[ends.length - 1]!];
}

/**
 * Map one rendered-text offset within a block to the offset in that block's
 * raw markdown source. `kind` says which side of the character the caret is
 * on: a selection's two endpoints are two independent calls through this same
 * function, `"start"` then `"end"`, never a single range transform.
 *
 * Out-of-range offsets clamp rather than throw: a stale client selection must
 * not 500 the comment endpoint.
 */
export function mapRenderedOffsetToSource(
  blockSource: string,
  renderedOffset: number,
  kind: "start" | "end" = "start",
): number {
  const { starts, ends } = scan(blockSource);
  const n = starts.length;
  if (n === 0) return 0;
  const k = Math.max(0, Math.min(renderedOffset, n));
  if (kind === "end") return k === 0 ? starts[0]! : ends[k - 1]!;
  return k === n ? ends[n - 1]! : starts[k]!;
}

/**
 * The inverse: one SOURCE offset back to a rendered-text offset, over the same
 * scan. Needed to paint an existing comment's `<mark>` — the anchor resolves
 * to a source position inside the block's Yjs text, and the browser can only
 * address rendered characters (ui-design §Selection-comment layer: the client
 * never decodes `relative_position` and never re-matches `quoted_text`).
 *
 * A source offset that lands inside markup (`**`, `](href)`) has no rendered
 * character of its own, so it maps to the nearest rendered boundary outside
 * the markup — the same rule that keeps a rendered offset from ever landing
 * inside a marker.
 */
export function mapSourceOffsetToRendered(
  blockSource: string,
  sourceOffset: number,
  kind: "start" | "end" = "start",
): number {
  const { starts, ends } = scan(blockSource);
  if (kind === "end") {
    let k = 0;
    while (k < ends.length && ends[k]! <= sourceOffset) k++;
    return k;
  }
  let k = 0;
  while (k < starts.length && starts[k]! < sourceOffset) k++;
  return k;
}
