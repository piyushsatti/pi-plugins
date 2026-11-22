// The document view's two client-local modes (MODE-1).
//
// Client-local and per-document: nothing here crosses the wire, no event carries
// it, and no server state depends on it. It exists because the two things the
// review surface is for wanted the same gesture — a click/drag inside a block
// opened that block's raw-markdown editor, which swallowed the selection before
// the comment pill ever saw it, so selecting text to comment on was impossible.
//
// `review` is the DEFAULT: select-to-comment is the primary surface, and reading
// is the common case. `edit` is entered deliberately (the toolbar switch, or "e").
export const MODE_REVIEW = "review";
export const MODE_EDIT = "edit";

/**
 * Is this event target a place where a keystroke is TEXT, not a shortcut?
 *
 * The mode shortcut is a bare letter, so it has to keep its hands off every
 * control that takes typing — the comment composers, the document-title input in
 * the session view, and CodeMirror's own contenteditable, which is not an
 * `<input>` and would otherwise eat an "e" as a mode flip mid-word.
 */
export function isTypingTarget(target) {
  if (target === null || target === undefined || target.closest === undefined) return false;
  return target.closest("input, textarea, select, [contenteditable=true], .cm-editor") !== null;
}
