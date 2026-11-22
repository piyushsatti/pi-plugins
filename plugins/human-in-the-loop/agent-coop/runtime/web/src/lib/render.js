// markdown-it, configured once and shared.
//
// One rule is overridden: the FENCE. markdown-it's default fence renderer emits
// `<pre><code>` for every fence including ```mermaid, so a diagram arrived on
// screen as a paragraph of graph syntax. Both fence kinds are decided in this
// one function because they are the same decision:
//   - ```mermaid    -> <mermaid-block source="…">, which lazy-loads mermaid and
//                      replaces itself with an SVG (components/mermaid-block.js).
//   - anything else  -> a code CONTAINER: `pre.code-block > code`, coarsely
//                      highlighted by lib/highlight.js and scrollable in its own
//                      box (app.css) so one long line cannot widen the page.
import MarkdownIt from "markdown-it";
import { escapeHtml, highlight } from "./highlight.js";

export const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/** A fence's language, lowercased, ignoring the rest of the info string
 *  (` ```js title=x ` is still js). */
export function fenceLang(info) {
  return String(info ?? "").trim().split(/\s+/)[0].toLowerCase();
}

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const lang = fenceLang(token.info);
  if (lang === "mermaid") {
    // The source travels as an escaped ATTRIBUTE and the element re-reads it, so
    // nothing here has to know how a diagram is drawn — or load the library that
    // draws it on a page that has no diagram.
    return `<mermaid-block source="${escapeHtml(token.content)}"></mermaid-block>\n`;
  }
  const langAttr = lang === "" ? "" : ` data-lang="${escapeHtml(lang)}"`;
  const codeClass = lang === "" ? "" : ` class="language-${escapeHtml(lang)}"`;
  return (
    `<pre class="code-block"${langAttr}><code${codeClass}>` +
    `${highlight(token.content, lang)}</code></pre>\n`
  );
};

/** One block's markdown -> HTML. Block granularity is the unit everywhere:
 *  comments, diffs and DOM patches are all `block_id`-keyed. */
export function renderBlock(content) {
  return md.render(content ?? "");
}
