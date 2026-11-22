// Code-fence syntax highlighting, in about sixty lines and with no dependency.
//
// The choice: a real highlighter (highlight.js, shiki, prism) is 100KB+ of
// grammar for a review surface whose fences are mostly short snippets, and
// ui-design §Build forbids vendoring one. So this is a deliberately COARSE
// lexer — comments, strings, numbers, a shared keyword set — which is enough
// for a code block to read as code, and it never guesses at a grammar it does
// not have: a language it does not know gets escaped text and no spans at all.
// If real per-language grammars are ever wanted, they belong in a lazy chunk
// like mermaid's, not in the first byte the page loads.
//
// Everything that leaves this module is HTML-escaped here, at the one place the
// raw block text becomes markup. `md.render` never sees a fence body (the fence
// rule in render.js calls this instead), so nothing else escapes it.

/** `&<>"` -> entities. The one escape in web/: render.js imports it too. */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Languages whose line comments start with `#`. */
const HASH_COMMENT = new Set([
  "sh", "bash", "zsh", "shell", "console", "python", "py", "ruby", "rb",
  "yaml", "yml", "toml", "ini", "conf", "dockerfile", "makefile", "make", "r",
]);

/** Languages whose line comments start with `//` (and blocks with `/* … *\/`). */
const SLASH_COMMENT = new Set([
  "js", "javascript", "mjs", "cjs", "ts", "typescript", "jsx", "tsx", "json",
  "jsonc", "json5", "c", "h", "cpp", "cs", "java", "kotlin", "kt", "swift",
  "go", "rust", "rs", "php", "scala", "dart", "css", "scss", "less", "sql",
]);

/**
 * Keywords worth marking in ANY of the languages above.
 *
 * Deliberately language-agnostic and short: a per-language list is a grammar,
 * and a grammar is the thing this module is not. A word here that a given
 * language does not reserve is still, in every case, a word that reads as one.
 */
const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue",
  "def", "default", "elif", "else", "enum", "export", "extends", "false",
  "final", "finally", "fn", "for", "from", "func", "function", "if", "impl",
  "import", "in", "interface", "let", "match", "new", "nil", "none", "not",
  "null", "or", "package", "pass", "private", "public", "return", "select",
  "static", "struct", "switch", "throw", "trait", "true", "try", "type",
  "typedef", "undefined", "var", "void", "while", "with", "yield",
]);

/** Is this fence's language one this module claims to understand? */
export function isHighlightable(lang) {
  return HASH_COMMENT.has(lang) || SLASH_COMMENT.has(lang);
}

/**
 * One regex, alternatives in PRIORITY order, so the competition between token
 * kinds is decided by position rather than by running several passes over the
 * same text: a `#` inside a string is string, a keyword inside a comment is
 * comment. Built per language family because the comment syntax is the only
 * thing that differs.
 */
function lexer(lang) {
  const comment = HASH_COMMENT.has(lang) ? "#[^\\n]*" : "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/";
  return new RegExp(
    `(?<comment>${comment})` +
      "|(?<string>\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'|`(?:\\\\.|[^`\\\\])*`)" +
      "|(?<number>\\b\\d[\\d_]*(?:\\.\\d+)?\\b)" +
      "|(?<word>[A-Za-z_$][A-Za-z0-9_$]*)",
    "g",
  );
}

/**
 * Escaped HTML for one fence body, with `<span class="tok-*">` around the
 * tokens it recognised. Never returns unescaped text on any path, including the
 * unknown-language one.
 */
export function highlight(code, lang) {
  const source = String(code ?? "");
  if (!isHighlightable(lang)) return escapeHtml(source);

  let out = "";
  let last = 0;
  for (const m of source.matchAll(lexer(lang))) {
    const kind = m.groups.comment !== undefined
      ? "comment"
      : m.groups.string !== undefined
        ? "string"
        : m.groups.number !== undefined
          ? "number"
          : KEYWORDS.has(m[0])
            ? "keyword"
            : null;
    if (kind === null) continue; // an ordinary identifier: plain text
    out += escapeHtml(source.slice(last, m.index));
    out += `<span class="tok-${kind}">${escapeHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(source.slice(last));
}
