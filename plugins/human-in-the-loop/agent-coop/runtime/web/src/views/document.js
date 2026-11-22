// <document-view> (route: /session/:id/doc/:docId) — the review surface.
//
// Rendered by default (ui-design G1: reading must not be slower than reading),
// with a BLOCK-LEVEL in-place toggle: clicking one rendered block swaps that
// block, and only that block, for a CodeMirror 6 instance on its raw markdown;
// clicking away commits one `user_edit` and the block goes back to rendered
// HTML. There is never more than one editor alive (ui-design §Performance), and
// even in edit mode the other 95% of the page stays rendered.
//
// WHICH interactions reach that toggle is decided by the view's client-local
// MODE (MODE-1, web/src/lib/modes.js): in `review` — the default — a click is a
// selection and the comment pill gets it; in `edit` a click opens the block.
// Nothing about the mode crosses the wire.
//
// Everything positional is server-owned. This view holds the block contents it
// was given, the comment list it was given, and the session state it was told;
// it computes no offsets, no anchors and no diff.
import { api } from "../lib/api.js";
import { mountEditor } from "../lib/editor.js";
import { STATE_USER_EDITING, STATUS_RESOLVED } from "../lib/enums.js";
import { isTypingTarget, MODE_EDIT, MODE_REVIEW } from "../lib/modes.js";
import { renderBlock } from "../lib/render.js";
import "../components/selection-layer.js";
import "../components/comment-panel.js";

/** What an empty block says instead of nothing (ENTRY-1, QA-BLANK-DOC). */
export const EMPTY_BLOCK_PLACEHOLDER = "Start writing…";

/**
 * Render one block's markdown INTO an element — and give an empty one something
 * to see.
 *
 * A new session opens on a document whose one block is empty (`STARTER_BLOCKS`),
 * and `renderBlock("")` is the empty string, so the first thing agent-coop ever showed
 * a user was a blank page with no visible target. The block was clickable the
 * whole time; nothing said so. The placeholder is real DOM rather than a CSS
 * `::before`, so it is announced, and it is stamped `data-empty` so the
 * stylesheet can give the block an outline as well as words.
 *
 * The placeholder is never content: `this.blocks` still holds "", the editor
 * still opens on "", and nothing is sent when the user clicks away without
 * typing.
 */
export function paintBlock(el, content) {
  const empty = (content ?? "").trim() === "";
  if (empty) {
    el.dataset.empty = "";
    el.innerHTML = "";
    const hint = document.createElement("p");
    hint.className = "block-placeholder";
    hint.textContent = EMPTY_BLOCK_PLACEHOLDER;
    el.appendChild(hint);
    return;
  }
  delete el.dataset.empty;
  el.innerHTML = renderBlock(content);
}

/**
 * Tell a block what activating it does RIGHT NOW.
 *
 * A block is only a button in edit mode. In review mode a click does not open
 * it, so `role="button"` and "Edit this block" would be a promise to a screen
 * reader that the view does not keep — the same lie the mode exists to remove.
 * It stays `tabindex="0"` in both, because a keyboard user has to be able to
 * land in the text to select it.
 */
export function applyBlockMode(el, mode) {
  if (mode === MODE_EDIT) {
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", "Edit this block");
    return;
  }
  el.removeAttribute("role");
  el.removeAttribute("aria-label");
}

export class DocumentView extends HTMLElement {
  /** `ready` resolves when the first load has painted. The DOM never awaits
   *  connectedCallback, so anything that needs the loaded view (tests, deep
   *  links) awaits this instead. */
  connectedCallback() {
    this.sessionId = this.dataset.sessionId;
    this.docId = this.dataset.docId;
    this.blocks = [];
    this.comments = [];
    /** The one live editor: `{ block_id, blockEl, handle, before }` or null. */
    this.editor = null;
    this.innerHTML = `
      <doc-toolbar>
        <a href="/session/${this.sessionId}" data-route>&larr; session</a>
        <h1 class="doc-title"></h1>
        <nav class="doc-switch" aria-label="Documents in this session"></nav>
        <span class="state-banner" role="status"></span>
        <!-- MODE-1. Two words, not an icon: which of the two things a click
             does is the least guessable thing on this surface. aria-pressed is
             the state, and the pressed one is edit. (No backticks in here: this
             whole toolbar is a template literal.) -->
        <button type="button" class="mode-toggle" aria-pressed="false"
                aria-label="Edit mode" title="Review / edit mode (e)">
          <span class="mode-opt" data-mode-opt="review">Review</span>
          <span class="mode-opt" data-mode-opt="edit">Edit</span>
        </button>
        <button type="button" class="drawer-toggle" aria-expanded="true"
                aria-controls="comments-drawer">Comments</button>
        <button type="button" class="export">Export</button>
        <button type="button" class="submit">Submit for review</button>
        <!-- Disabled until load() reports the real state: a live escape hatch
             before we know whether there is anything to escape can only 409. -->
        <button type="button" class="cancel-turn" disabled>Take it back</button>
        <output class="export-path" role="status"></output>
      </doc-toolbar>
      <main>
        <div class="rendered-pane" data-rendered-pane>
          <selection-comments data-doc-id="${this.docId}"></selection-comments>
          <div class="blocks"></div>
        </div>
        <global-comments id="comments-drawer"></global-comments>
      </main>`;

    this.blocksEl = this.querySelector(".blocks");
    this.layer = this.querySelector("selection-comments");
    this.panel = this.querySelector("global-comments");
    this.panel.docId = this.docId;
    this.dataset.drawer = "open";

    this.querySelector(".submit").addEventListener("click", () => {
      this.pendingSubmit = this.submit();
    });
    this.querySelector(".cancel-turn").addEventListener("click", () => {
      this.pendingCancel = this.cancelTurn();
    });
    this.querySelector(".mode-toggle").addEventListener("click", () => {
      this.setMode(this.dataset.mode === MODE_EDIT ? MODE_REVIEW : MODE_EDIT);
    });
    this.querySelector(".drawer-toggle").addEventListener("click", () => this.toggleDrawer());
    this.querySelector(".export").addEventListener("click", () => {
      this.pendingExport = this.export();
    });
    this.addEventListener("drawer-close", () => this.toggleDrawer(false));

    // Comment traffic: the layer creates them, the panel lists them, this view
    // owns the single authoritative list both read from.
    this.addEventListener("comment-created", (ev) => {
      this.upsertComment(ev.detail);
    });
    this.addEventListener("comment-jump", (ev) => this.jumpToAnchor(ev.detail));
    this.addEventListener("comment-focus", (ev) => this.panel.focusComment(ev.detail.comment_id));

    // The toggle. A click inside a block opens it; a click anywhere else is
    // the click-away that commits (ui-design §Rendered-vs-edit mode).
    this.blocksEl.addEventListener("click", (ev) => {
      if (ev.target.closest("mark[data-comment-id]") !== null) return; // that is a jump
      const blockEl = ev.target.closest(".block");
      if (blockEl === null || blockEl.dataset.editing !== undefined) return;
      this.pendingEdit = this.openBlock(blockEl);
    });
    this.blocksEl.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || ev.target.closest("mark[data-comment-id]") !== null) return;
      const blockEl = ev.target.closest(".block");
      if (blockEl === null || blockEl.dataset.editing !== undefined) return;
      ev.preventDefault();
      this.pendingEdit = this.openBlock(blockEl);
    });
    this.onOutside = (ev) => {
      if (this.editor === null) return;
      if (this.editor.blockEl.contains(ev.target)) return;
      this.pendingEdit = this.closeEditor(true);
    };
    document.addEventListener("mousedown", this.onOutside);
    document.addEventListener("focusin", this.onOutside);

    // Keyboard (MODE-1). "e" flips the mode, but never while the keystroke is
    // text — see `isTypingTarget`. Escape is two things in a fixed order: it
    // closes an open editor WITHOUT committing (the editor's own keymap says the
    // same, and `closeEditor` is idempotent), and when there is none it is the
    // way back to review, so the user is never stranded in edit mode.
    this.onKey = (ev) => {
      if (ev.key === "Escape") {
        if (this.editor !== null) {
          this.pendingEdit = this.closeEditor(false);
          return;
        }
        this.setMode(MODE_REVIEW);
        return;
      }
      if (ev.key !== "e" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (isTypingTarget(ev.target)) return;
      this.setMode(this.dataset.mode === MODE_EDIT ? MODE_REVIEW : MODE_EDIT);
    };
    document.addEventListener("keydown", this.onKey);

    // Review until the user says otherwise, before any load has answered.
    this.setMode(MODE_REVIEW);
    this.ready = this.load();
  }

  disconnectedCallback() {
    document.removeEventListener("mousedown", this.onOutside);
    document.removeEventListener("focusin", this.onOutside);
    document.removeEventListener("keydown", this.onKey);
    this.editor?.handle.destroy();
    this.editor = null;
  }

  async load() {
    // Every load opens in review (MODE-1). A document switch builds a new view
    // and so lands here; so does `cancelTurn`, where review is the state the
    // turn lock left the view in anyway.
    this.setMode(MODE_REVIEW);
    // A load reads the session too, so it takes a generation like any other
    // reader (see refreshDocSwitch): a refresh already in flight must not paint
    // its older list over this one's.
    const generation = (this.docsGeneration = (this.docsGeneration ?? 0) + 1);
    try {
      const [{ doc, blocks }, { comments }, { session, docs }] = await Promise.all([
        api.doc(this.docId),
        api.comments(this.docId, true), // resolved included: the drawer sections them
        api.session(this.sessionId),
      ]);
      this.querySelector(".doc-title").textContent = doc.title;
      if (generation === this.docsGeneration) this.renderDocSwitch(docs);
      this.blocks = blocks;
      this.comments = comments;
      this.renderBlocks(blocks);
      this.panel.setComments(comments);
      this.layer.paint(comments);
      // A doc opened mid-turn must show the lock immediately, not wait for the
      // next state_changed frame.
      this.setState(session.state);
    } catch (err) {
      this.dispatchEvent(new CustomEvent("agent-coop-error", { bubbles: true, detail: err }));
    }
  }

  // --- rendering ------------------------------------------------------------

  /**
   * The session's other documents, as links (A1, PI-2). A session can hold more
   * than one document, and until now the only way between two of them was back
   * out to the session list. The doc being read is marked `aria-current` and is
   * not a link — a control that navigates to where you already are is a lie.
   *
   * One document means no switcher at all rather than a switcher with one entry.
   */
  renderDocSwitch(docs) {
    const nav = this.querySelector(".doc-switch");
    nav.textContent = "";
    nav.hidden = docs.length < 2;
    if (nav.hidden) return;
    for (const doc of docs) {
      if (doc.id === this.docId) {
        const here = document.createElement("span");
        here.className = "doc-tab";
        here.setAttribute("aria-current", "page");
        here.textContent = doc.title;
        nav.appendChild(here);
        continue;
      }
      const link = document.createElement("a");
      link.className = "doc-tab";
      link.href = `/session/${this.sessionId}/doc/${doc.id}`;
      link.dataset.route = "";
      link.textContent = doc.title;
      nav.appendChild(link);
    }
  }

  contentOf(block_id) {
    return this.blocks.find((b) => b.block_id === block_id)?.content ?? "";
  }

  renderBlocks(blocks) {
    this.blocksEl.textContent = "";
    for (const block of [...blocks].sort((a, b) => a.order - b.order)) {
      this.blocksEl.appendChild(this.blockNode(block));
    }
  }

  blockNode(block) {
    const el = document.createElement("article");
    el.className = "block";
    el.dataset.blockId = block.block_id;
    el.dataset.order = String(block.order);
    // Keyboard-reachable, and it announces what activating it does in the mode
    // it is actually in (ui-design §Accessibility, MODE-1).
    el.setAttribute("tabindex", "0");
    applyBlockMode(el, this.dataset.mode);
    paintBlock(el, block.content);
    return el;
  }

  blockEl(block_id) {
    return this.blocksEl.querySelector(`[data-block-id="${CSS.escape(block_id)}"]`);
  }

  /** Re-render one block from raw markdown and repaint its highlights. */
  repaintBlock(block_id, content) {
    const el = this.blockEl(block_id);
    if (el === null) return;
    paintBlock(el, content);
    this.layer.paint(this.comments);
  }

  // --- the block toggle -----------------------------------------------------

  /** Open one block for editing, committing whatever was open before it. */
  async openBlock(blockEl) {
    // Two gates, and they are different things. The MODE is the user's own
    // choice about what a click means here (MODE-1) — in review a click is a
    // selection, which is the only way a comment gets made.
    if (this.dataset.mode !== MODE_EDIT) return;
    // The turn STATE is the engine's: block edits are the only thing the submit
    // gate locks (ui-design §Submit gate UX); comments stay writable, which is
    // why the panel is untouched.
    if (this.dataset.state !== STATE_USER_EDITING) return;
    const block_id = blockEl.dataset.blockId;
    if (this.editor !== null) {
      if (this.editor.block_id === block_id) return;
      await this.closeEditor(true);
    }
    const before = this.contentOf(block_id);
    const host = document.createElement("div");
    host.className = "block-editor";
    blockEl.replaceChildren(host);
    blockEl.dataset.editing = "";
    blockEl.removeAttribute("role"); // it IS the editor now, not a button to one
    const handle = mountEditor({
      host,
      doc: before,
      onCommit: () => {
        this.pendingEdit = this.closeEditor(true);
      },
      onCancel: () => {
        this.pendingEdit = this.closeEditor(false);
      },
    });
    this.editor = { block_id, blockEl, handle, before };
    handle.focus();
  }

  /**
   * Tear the one editor down. `commit` false is Escape — the block goes back to
   * exactly what it was and nothing is sent.
   *
   * Exactly one `user_edit` per close, and none at all when the text did not
   * change: `this.editor` is cleared BEFORE the await, so the click-away
   * listener, a second click and the keymap cannot each fire their own commit.
   */
  async closeEditor(commit) {
    const ed = this.editor;
    if (ed === null) return;
    this.editor = null;

    const next = ed.handle.value();
    ed.handle.destroy();
    delete ed.blockEl.dataset.editing;
    // Back to whatever the mode says it is now — which may be review, because
    // leaving edit mode is one of the things that closes an editor.
    applyBlockMode(ed.blockEl, this.dataset.mode);

    if (!commit || next === ed.before) {
      this.repaintBlock(ed.block_id, ed.before);
      return;
    }

    // Optimistic (ui-design §State management): the rendered block updates now,
    // and is reconciled against the server's authoritative blocks below.
    this.setContent(ed.block_id, next);
    this.repaintBlock(ed.block_id, next);
    try {
      const { blocks } = await api.patchBlocks(this.docId, [
        { op: "replace", block_id: ed.block_id, content: next },
      ]);
      this.blocks = blocks;
      this.repaintBlock(ed.block_id, this.contentOf(ed.block_id));
      // The edit may have moved every anchor in the block; the server is the
      // only thing that knows where they went.
      await this.refreshComments();
    } catch (err) {
      // Loud rollback, no retry queue: a rejected edit un-happens on screen.
      this.setContent(ed.block_id, ed.before);
      this.repaintBlock(ed.block_id, ed.before);
      this.dispatchEvent(new CustomEvent("agent-coop-error", { bubbles: true, detail: err }));
    }
  }

  setContent(block_id, content) {
    const block = this.blocks.find((b) => b.block_id === block_id);
    if (block !== undefined) block.content = content;
  }

  // --- comments -------------------------------------------------------------

  upsertComment(comment) {
    const i = this.comments.findIndex((c) => c.comment_id === comment.comment_id);
    if (i === -1) this.comments.push(comment);
    else this.comments[i] = comment;
    this.panel.upsert(comment);
    this.layer.paint(this.comments);
  }

  async refreshComments() {
    try {
      const { comments } = await api.comments(this.docId, true);
      this.comments = comments;
      this.panel.setComments(comments);
      this.layer.paint(comments);
    } catch {
      // A failed refresh leaves the last good list on screen; the next SSE
      // frame or reload corrects it.
    }
  }

  /**
   * Re-read the session's document list and repaint the switcher.
   *
   * Guarded by a generation counter, because `doc_added` frames arrive in bursts
   * and two of these can be in flight at once: the responses are not ordered, so
   * the OLDER one can land last and paint a switcher that is missing the document
   * whose frame triggered the newer call. The symptom is a tab that appears and
   * then vanishes, corrected only by a reload.
   *
   * The rule is "last request wins, not last response": a response is painted
   * only if no later request was started while it was in flight. Every path that
   * re-reads the session has to go through this — `load()` is exempt only because
   * it is the first paint and nothing precedes it.
   */
  async refreshDocSwitch() {
    const generation = (this.docsGeneration = (this.docsGeneration ?? 0) + 1);
    try {
      const { docs } = await api.session(this.sessionId);
      if (generation !== this.docsGeneration) return; // a newer read is authoritative
      this.renderDocSwitch(docs);
    } catch {
      // The switcher keeps the last good list; the next load corrects it.
    }
  }

  jumpToAnchor({ comment_id, block_id }) {
    const mark = this.blocksEl.querySelector(`mark[data-comment-id="${CSS.escape(comment_id)}"]`);
    const target = mark ?? this.blockEl(block_id);
    if (target === null || target === undefined) return;
    target.scrollIntoView?.({ block: "center" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1200);
  }

  // --- review / edit mode (MODE-1) -----------------------------------------

  /**
   * Put the view in one mode, and make every surface that depends on it agree.
   *
   * The mode is stamped as `data-mode` on the view root and nowhere else: the
   * stylesheet keys off that one attribute (which segment is lit, the dimmed
   * highlights), `openBlock` reads it, and the selection layer reads it off its
   * nearest ancestor rather than being told twice.
   *
   * A locked turn OVERRULES the argument. Block edits 409 in SUBMITTED and
   * CLAUDE_TURN whatever this view believes, so offering edit mode there would
   * be the UI promising something the engine refuses; the toggle goes disabled
   * and the mode is review. When the lock lifts the toggle comes back, but the
   * mode does NOT: reopening straight into an editor is the swallowed-selection
   * bug all over again, so the user asks for edit or it does not happen.
   */
  setMode(mode) {
    const locked = this.dataset.state !== undefined && this.dataset.state !== STATE_USER_EDITING;
    const next = locked ? MODE_REVIEW : mode;
    this.dataset.mode = next;

    const toggle = this.querySelector(".mode-toggle");
    toggle.setAttribute("aria-pressed", String(next === MODE_EDIT));
    toggle.disabled = locked;

    for (const el of this.blocksEl.querySelectorAll(".block")) {
      if (el.dataset.editing === undefined) applyBlockMode(el, next);
    }
    if (next === MODE_EDIT) {
      // A selection made on the way in is for editing, not for commenting.
      this.layer.hide();
    } else if (this.editor !== null) {
      // Leaving edit mode commits what is open, the same as clicking away.
      this.pendingEdit = this.closeEditor(true);
    }
  }

  toggleDrawer(force) {
    const open = force ?? this.dataset.drawer !== "open";
    this.dataset.drawer = open ? "open" : "closed";
    this.querySelector(".drawer-toggle").setAttribute("aria-expanded", String(open));
  }

  // --- server-pushed state --------------------------------------------------

  /** SSE arrives here from <agent-coop-app>; patch by block_id, nothing else. */
  onSse(name, data) {
    if (name === "state_changed" && data.session_id === this.sessionId) {
      this.setState(data.to);
    } else if (name === "comment_added" && data.doc_id === this.docId) {
      this.upsertComment(data);
    } else if (name === "comment_resolved") {
      this.panel.markResolved(data.comment_id, data.resolved_by);
      const c = this.comments.find((x) => x.comment_id === data.comment_id);
      if (c !== undefined) {
        c.status = STATUS_RESOLVED;
        c.resolved_by = data.resolved_by;
        this.layer.paint(this.comments);
      }
    } else if (name === "apply_progress" && data.doc_id === this.docId) {
      this.pendingPatch = this.patchBlock(data.block_id);
    } else if (name === "doc_added" && data.session_id === this.sessionId) {
      // A document joined the session under us; the switcher is now wrong.
      this.pendingDocs = this.refreshDocSwitch();
    }
  }

  /** One block changed under us: re-fetch the doc and swap that node only. */
  async patchBlock(block_id) {
    let blocks;
    try {
      ({ blocks } = await api.doc(this.docId));
    } catch {
      return;
    }
    this.blocks = blocks;
    const block = blocks.find((b) => b.block_id === block_id);
    const existing = this.blockEl(block_id);
    if (block === undefined) {
      existing?.remove();
    } else if (existing === null) {
      this.renderBlocks(blocks);
    } else {
      existing.replaceWith(this.blockNode(block));
    }
    // Claude's edit moved the anchors in that block; re-read where they are
    // now rather than leaving stale highlights (or guessing).
    await this.refreshComments();
  }

  setState(state) {
    this.dataset.state = state;
    const banner = this.querySelector(".state-banner");
    const locked = state !== STATE_USER_EDITING;
    banner.textContent = locked ? `waiting on Claude (${state})` : "";
    // Comments stay writable through the lock; only doc-block edits are gated.
    this.querySelector(".submit").disabled = locked;
    // The escape hatch is the exact inverse of submit (PI-4): it is the only
    // control that is live precisely when the document is not. Disabled rather
    // than hidden, so the user can see that taking it back is a thing that
    // exists before they need it.
    this.querySelector(".cancel-turn").disabled = !locked;
    for (const el of this.blocksEl.querySelectorAll(".block")) {
      el.setAttribute("aria-disabled", String(locked));
    }
    if (locked && this.editor !== null) this.pendingEdit = this.closeEditor(true);
    // The mode is re-applied rather than re-chosen: `setMode` is the one place
    // that knows a locked turn forces review and disables the switch (MODE-1).
    this.setMode(this.dataset.mode ?? MODE_REVIEW);
  }

  /**
   * Export the document (A8, ui-design §Export UX). Allowed in any state — an
   * export reads, it does not write the document — and the landed path stays
   * on screen as a small persistent label rather than a toast that vanishes
   * before the user has read where the file went.
   */
  async export() {
    const label = this.querySelector(".export-path");
    label.textContent = "exporting...";
    try {
      const { path } = await api.exportDoc(this.docId);
      label.textContent = `exported to ${path}`;
      label.title = path;
    } catch (err) {
      label.textContent = "";
      this.dispatchEvent(new CustomEvent("agent-coop-error", { bubbles: true, detail: err }));
    }
  }

  async submit() {
    try {
      // A block still open when submit is pressed is a real edit; commit it
      // before the gate closes rather than dropping it.
      await this.closeEditor(true);
      const result = await api.submit(this.sessionId);
      this.setState(result.state);
    } catch (err) {
      this.dispatchEvent(new CustomEvent("agent-coop-error", { bubbles: true, detail: err }));
    }
  }

  /**
   * Take the document back from a turn (PI-4).
   *
   * The blocks reopen because the state reopens them — the same `setState` the
   * SSE frame drives — and nothing is undone: whatever Claude already applied is
   * on screen and stays there. The state comes from the server's answer rather
   * than being assumed, so a refused cancel leaves the banner telling the truth.
   *
   * The document is re-read afterwards because a cancelled CLAUDE_TURN may have
   * left blocks this view never saw an `apply_progress` frame for.
   */
  async cancelTurn() {
    try {
      const result = await api.cancel(this.sessionId);
      this.setState(result.state);
      await this.load();
    } catch (err) {
      this.dispatchEvent(new CustomEvent("agent-coop-error", { bubbles: true, detail: err }));
    }
  }
}

customElements.define("document-view", DocumentView);
