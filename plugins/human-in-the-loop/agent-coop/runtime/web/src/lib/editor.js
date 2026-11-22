// CodeMirror 6 glue for the block-level in-place toggle (ui-design §Rendered-
// vs-edit mode). One block, one instance, mounted on demand and destroyed on
// commit — never one instance per block up front (ui-design §Performance).
//
// This module knows CodeMirror and nothing else: no fetch, no block_id, no
// turn state. The toggle state machine (which block is open, when a commit
// fires, what it posts) lives in views/document.js, so swapping the editor
// would touch this file alone.
// Only the three CodeMirror packages the repo already depends on
// (@codemirror/state, /view, /lang-markdown). @codemirror/commands is
// deliberately not added: core CM6 already handles typing, deletion and
// newlines through beforeinput, and a block of markdown does not need a
// command set (ui-design G6, minimal dependency footprint).
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

/**
 * Mount one editor into `host`.
 *
 * @param {{ host: HTMLElement, doc: string,
 *           onCommit: (next: string) => void, onCancel: () => void }} opts
 * @returns {{ value: () => string, focus: () => void, destroy: () => void }}
 */
export function mountEditor({ host, doc, onCommit, onCancel }) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown(),
        EditorView.lineWrapping,
        keymap.of([
          // Commit and cancel are reachable without a mouse (ui-design
          // §Accessibility): click-away is not the only way out.
          { key: "Mod-Enter", run: () => (onCommit(view.state.doc.toString()), true) },
          { key: "Escape", run: () => (onCancel(), true) },
        ]),
      ],
    }),
    parent: host,
  });
  return {
    value: () => view.state.doc.toString(),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
