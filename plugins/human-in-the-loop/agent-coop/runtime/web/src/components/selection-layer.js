// <selection-comments> — the selection-comment layer (ui-design §Selection-
// comment layer).
//
// Its whole job is "which rendered characters, in which block". It computes
// RENDERED-text offsets inside one block and posts `CommentCreateRaw`; it never
// parses markdown, never computes a source offset, never decodes or compares
// `relative_position`, and never re-matches `quoted_text` to find a position.
//
// The reverse direction — where an existing comment's highlight sits NOW — is
// not the client's arithmetic either: the server returns `rendered_offsets` on
// every `Comment` (src/server/anchors.ts), recomputed from Yjs on each read,
// and this component only paints them. That is what makes a highlight survive
// a Claude edit to the same block: the offsets move server-side, the mark
// follows, and nothing here guesses.
//
// Since PI-6 both ends are server-resolved, so the mark's LENGTH tracks the edit
// too — and when the run cannot be resolved the server says `detached` and this
// component paints nothing. There is no code path here that draws a highlight
// from anything other than an `attached` comment's `rendered_offsets`.
import { api } from "../lib/api.js";
import { deliveryControl, deliveryOf, resetDelivery } from "../lib/delivery.js";
import { ANCHOR_ATTACHED, STATUS_RESOLVED } from "../lib/enums.js";
import { MODE_EDIT } from "../lib/modes.js";
import "./mic-control.js"; // registers <mic-control>, used in the pill form below

/**
 * Rendered-text offset of a (node, offset) point relative to `root`.
 * Pure DOM arithmetic: walk a range from the start of the block to the point
 * and measure its text. Exported for direct testing.
 */
export function offsetWithin(root, node, offset) {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** The block element a selection sits in, or null if it spans blocks / none. */
export function blockOfSelection(selection, root) {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = closestBlock(range.startContainer, root);
  const end = closestBlock(range.endContainer, root);
  if (start === null || start !== end) return null; // one block only
  return start;
}

function closestBlock(node, root) {
  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (el !== null && el !== root) {
    if (el.classList?.contains("block")) return el;
    el = el.parentElement;
  }
  return null;
}

/** Every text node under `root`, in document order. */
function textNodes(root) {
  const out = [];
  const walk = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) out.push(n);
  return out;
}

/** Unwrap the marks matching `selector`, leaving the rendered HTML intact. */
function unwrapMarks(blockEl, selector) {
  if (blockEl === null || blockEl === undefined) return;
  for (const mark of [...blockEl.querySelectorAll(selector)]) {
    const parent = mark.parentNode;
    while (mark.firstChild !== null) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
  blockEl.normalize();
}

/** Drop every highlight this component owns. Only ever a prelude to repainting
 *  all of them from the authoritative list — never a rollback. */
export function clearMarks(blockEl) {
  unwrapMarks(blockEl, "mark[data-comment-id]");
}

/**
 * Drop only the optimistic highlight (CQ4).
 *
 * This is what a FAILED save rolls back, and it has to be narrower than
 * `clearMarks`: the block may already carry the marks of other comments, painted
 * from the server's own `rendered_offsets`, and those did not fail — they are not
 * this write's to erase. The old rollback called `clearMarks`, so one rejected
 * comment silently wiped every highlight in the block until something else
 * happened to trigger a repaint.
 */
export function clearPendingMarks(blockEl) {
  unwrapMarks(blockEl, "mark[data-pending]");
}

/**
 * Wrap `[start, end)` of a block's rendered text in `<mark>`. Offsets are
 * rendered-text offsets — the same coordinate system the DOM selection reports
 * and the server answers in — so no markdown is involved on this side at all.
 * A range crossing inline element boundaries yields one mark per text node,
 * which is what the HTML tree allows; the last one is returned.
 */
export function markRange(blockEl, start, end, attrs = {}) {
  if (blockEl === null || blockEl === undefined || !(end > start)) return null;
  const spans = [];
  let seen = 0;
  for (const node of textNodes(blockEl)) {
    const from = seen;
    const to = seen + node.length;
    seen = to;
    if (to <= start || from >= end) continue;
    spans.push({
      node,
      localStart: Math.max(start, from) - from,
      localEnd: Math.min(end, to) - from,
    });
  }
  let painted = null;
  // Reverse order: splitting a later node cannot disturb an earlier offset.
  for (const span of spans.reverse()) {
    let target = span.node;
    if (span.localEnd < target.length) target.splitText(span.localEnd);
    if (span.localStart > 0) target = target.splitText(span.localStart);
    const mark = blockEl.ownerDocument.createElement("mark");
    for (const [k, v] of Object.entries(attrs)) mark.setAttribute(k, v);
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
    painted = mark;
  }
  return painted;
}

/**
 * Repaint one block's highlights from the authoritative comment list.
 *
 * OPEN QUESTION, recorded here because the evidence contradicts itself and the
 * next person to touch this deserves both halves rather than a clean story.
 *
 * This function rebuilds the DOM under whatever the user is currently doing. It
 * runs on every `comment_added` frame, which in normal use means whenever Claude
 * comments while a person is reading, and `clearMarks` below unwraps every mark,
 * calls `normalize()`, and then `markRange` re-splits the text nodes. A drag in
 * progress across an overlapping highlight is therefore a live selection whose
 * boundary nodes are being replaced underneath it.
 *
 * On 2026-08-16 a browser probe reported that as a real defect, with a quoted
 * before and after: the user dragged "ock one with plenty of words to select a"
 * and the server stored "select a", with `anchor_state` still reading
 * `attached`. That is the same failure SHAPE as the PI-6 work above, the right
 * number of the wrong words, which is what made it credible.
 *
 * A second, independent probe on the same pre-fix code could not reproduce it.
 * Real mouse down, move and up across an existing highlight, interrupted
 * mid-gesture by a real `comment_added` frame, stored the full dragged text
 * correctly in Chromium 151. A deferral guard was written and then deliberately
 * removed, because a guard on a live input gesture is not free: its first
 * implementation latched on a bare `mousedown` and broke eight tests, since this
 * repo's own click-away helper fires `mousedown` with no matching `mouseup`.
 *
 * So: not reproduced, and not closed either. Failing to reproduce is weaker
 * evidence than reproducing. If a truncated anchor is ever reported, this is the
 * first place to look, and the shape that was rejected on cost rather than on
 * merit was "coalesce the repaint and flush it on mouseup or a timeout". Two
 * other shapes were considered and are worse: skipping only the overlapping
 * marks leaves a mixed set because `normalize()` works on the whole block, and
 * saving and restoring the Range does not obviously help, because the browser's
 * drag-continuation anchor is a separate mechanism from the Range and is not
 * specified. That last point is reasoned and was never measured.
 *
 * Untested everywhere that matters most: Safari on a phone, where selection is a
 * long press and a handle drag rather than a mouse gesture, and where this
 * component has no touch handler at all.
 */
export function paintBlockMarks(blockEl, comments) {
  clearMarks(blockEl);
  const block_id = blockEl.dataset.blockId;
  for (const c of comments) {
    if (c.anchor === null || c.anchor.block_id !== block_id) continue;
    // `attached` is the ONLY state that may be painted (PI-6). Written as an
    // allow-list rather than as "not orphaned", because the failure this guards
    // is precisely a state the client did not know about being drawn as a
    // confident highlight over the wrong words.
    if (c.status === STATUS_RESOLVED || c.anchor_state !== ANCHOR_ATTACHED) continue;
    const offsets = c.rendered_offsets;
    if (offsets === null || offsets === undefined) continue;
    markRange(blockEl, offsets[0], offsets[1], {
      "data-comment-id": c.comment_id,
      "data-delivery": c.delivery,
      tabindex: "0",
      role: "button",
      "aria-label": `Comment: ${c.text}`,
    });
  }
}

export class SelectionComments extends HTMLElement {
  connectedCallback() {
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Selection comments");
    this.pill = document.createElement("div");
    this.pill.className = "selection-pill";
    this.pill.hidden = true;
    this.pill.innerHTML = `
      <button type="button" class="pill-btn">+ comment</button>
      <form class="pill-form" hidden>
        <textarea rows="2" aria-label="Comment on the selected text"></textarea>
        <mic-control></mic-control>
        <div class="row">
          <button type="submit">save</button>
          <button type="button" class="pill-cancel">cancel</button>
          <span class="pill-status" role="status"></span>
        </div>
      </form>`;
    const form = this.pill.querySelector(".pill-form");
    form.insertBefore(deliveryControl("Delivery"), form.querySelector(".row"));
    this.appendChild(this.pill);

    this.pending = null;
    // True for the duration of save()'s request. Read by captureSelection()
    // and show() so a selection landing while a save is still in flight
    // (server-side transcription can take seconds) does not wipe the form
    // out from under it.
    this.saving = false;
    this.onUp = () => this.captureSelection();
    document.addEventListener("mouseup", this.onUp);
    document.addEventListener("keyup", this.onUp);

    this.pill.querySelector(".pill-btn").addEventListener("click", () => {
      this.pill.querySelector(".pill-btn").hidden = true;
      form.hidden = false;
      form.querySelector("textarea").focus();
    });
    this.pill.querySelector(".pill-cancel").addEventListener("click", () => {
      // Cancel discards the recording too, not just the text: leaving it
      // running would keep the microphone hot with nothing left that will
      // ever send it.
      this.pill.querySelector("mic-control")?.reset();
      this.hide();
    });
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.pendingSave = this.save();
    });

    // Clicking (or entering) a highlight is the jump the other way round:
    // mark -> the panel row that owns it.
    this.onMarkActivate = (ev) => {
      if (ev.type === "keydown" && ev.key !== "Enter" && ev.key !== " ") return;
      const mark = ev.target.closest?.("mark[data-comment-id]");
      if (mark === null || mark === undefined) return;
      this.dispatchEvent(
        new CustomEvent("comment-focus", {
          bubbles: true,
          detail: { comment_id: mark.dataset.commentId },
        }),
      );
    };
    this.root?.addEventListener("click", this.onMarkActivate);
    this.root?.addEventListener("keydown", this.onMarkActivate);
  }

  disconnectedCallback() {
    document.removeEventListener("mouseup", this.onUp);
    document.removeEventListener("keyup", this.onUp);
  }

  /** The rendered pane this overlay covers. */
  get root() {
    return this.closest("[data-rendered-pane]") ?? this.parentElement;
  }

  /**
   * Is the comment affordance off right now? (MODE-1.)
   *
   * Read from the host view's `data-mode` rather than held here, so there is one
   * copy of the mode and it cannot go stale: in edit mode a selection belongs to
   * the editor about to open over it, and a pill offering to comment on it is
   * the wrong offer. A host that has no mode at all (any other embedder) is not
   * suppressed.
   */
  get suppressed() {
    return this.closest("[data-mode]")?.dataset.mode === MODE_EDIT;
  }

  /** Repaint every block from the authoritative comment list. A block that is
   *  currently open in CodeMirror is skipped: its DOM belongs to the editor,
   *  and splitting text nodes inside it would corrupt the instance. */
  paint(comments) {
    for (const blockEl of this.root.querySelectorAll(".block")) {
      if (blockEl.dataset.editing !== undefined) continue;
      paintBlockMarks(blockEl, comments);
    }
  }

  captureSelection() {
    // A save can now run for seconds (server-side transcription), and
    // mouseup/keyup fire on every document click, not just ones aimed at
    // this control: without this guard a selection landing mid-save calls
    // show() and wipes the in-flight text, delivery choice, and recording.
    if (this.saving) return;
    if (this.suppressed) {
      this.hide();
      return;
    }
    const selection = document.getSelection();
    const block = blockOfSelection(selection, this.root);
    if (block === null) {
      // A selection that collapsed while the composer is open is the user
      // clicking into the textarea — do not yank the form away underneath.
      if (this.pill?.querySelector(".pill-form")?.hidden !== false) this.hide();
      return;
    }
    const range = selection.getRangeAt(0);
    this.pending = {
      block_id: block.dataset.blockId,
      rendered_offsets: [
        offsetWithin(block, range.startContainer, range.startOffset),
        offsetWithin(block, range.endContainer, range.endOffset),
      ],
      quoted_text: selection.toString(),
    };
    this.show(block);
  }

  show(block) {
    // Defensive against being called while THIS pill's own save() is still
    // in flight (not just from captureSelection above, but any future
    // caller): a save owns the form until it settles, and overwriting its
    // text/recording out from under it is the exact shape CRITICAL 2 was.
    if (this.saving) return;
    this.pill.hidden = false;
    this.pill.querySelector(".pill-btn").hidden = false;
    const form = this.pill.querySelector(".pill-form");
    form.hidden = true;
    form.querySelector("textarea").value = "";
    // A fresh selection is a fresh comment: a recording left over from an
    // abandoned attempt on different text must not silently ride along on
    // this one. Same reasoning as the textarea reset one line up.
    this.pill.querySelector("mic-control")?.reset();
    resetDelivery(this.pill);
    // Every later selection reuses this one pill (built once in
    // connectedCallback), so nothing here should trust that a previous
    // save() left the button enabled or the status line empty: force both,
    // rather than relying solely on save()'s own `finally`.
    const submitBtn = form.querySelector("button[type=submit]");
    if (submitBtn !== null) submitBtn.disabled = false;
    const status = form.querySelector(".pill-status");
    if (status !== null) status.textContent = "";
    const box = block.getBoundingClientRect();
    const own = this.root.getBoundingClientRect();
    this.pill.style.top = `${box.bottom - own.top}px`;
  }

  hide() {
    if (this.pill !== undefined) this.pill.hidden = true;
    this.pending = null;
  }

  /**
   * Optimistic write (ui-design §State management): the highlight appears
   * immediately, then is reconciled against the server's answer, which carries
   * the authoritative `rendered_offsets`, so the optimistic mark is thrown
   * away rather than trusted. A rejected write rolls the highlight back and
   * toasts loudly; there is no retry queue.
   *
   * The FORM itself is a separate rollback from the highlight (added for
   * voice input): it used to close the moment save() was called,
   * which meant a rejected write had already thrown the typed text away with
   * nothing on screen to retry. It now stays open, disabled, until the
   * request settles, closing only on success, so a failure costs a retry,
   * never the words or a finished recording.
   */
  async save() {
    if (this.pending === null) return;
    const form = this.pill.querySelector(".pill-form");
    const textarea = form.querySelector("textarea");
    const mic = form.querySelector("mic-control");
    const text = textarea.value.trim();
    // "Say something or type something": a voice-only comment has no typed
    // text and must still send, so the refusal checks BOTH being absent,
    // never text alone (the textarea's `required` attribute is gone for the
    // same reason: an HTML attribute cannot see the recorder). `hasRecording`
    // covers RECORDING/ENCODING/READY, so a submit made mid-recording falls
    // through to `settle()` below instead of being refused here.
    if (text === "" && !(mic?.hasRecording ?? false)) return;

    const submitBtn = form.querySelector("button[type=submit]");
    const status = form.querySelector(".pill-status");
    submitBtn.disabled = true;
    // Guards captureSelection/show: a mouseup/keyup or a fresh selection
    // landing while this request is in flight must not wipe it out.
    this.saving = true;
    const pending = this.pending;
    // Same reasoning as comment-panel.js's reply()/addGlobal(): a voice send
    // blocks on server-side transcription for seconds while the box stays
    // editable, so success clears only what was actually sent.
    const sentValue = textarea.value;
    const blockEl = this.root.querySelector(`[data-block-id="${CSS.escape(pending.block_id)}"]`);
    try {
      // A submit made while still RECORDING or ENCODING finishes the
      // recording and sends it, rather than silently posting text-only.
      await mic?.settle();
      const audio = mic?.audioPayload ?? null;
      if (text === "" && audio === null) {
        // The recording never produced usable audio (denied, or failed
        // while settling) and there was no typed text either: nothing to
        // send. mic-control's own status region already says why.
        return;
      }
      const delivery = deliveryOf(this.pill);
      const body = { doc_id: this.dataset.docId, ...pending, text, delivery, audio };
      // A typed-only comment posts fast enough that silence is fine; a voice
      // one now waits on server-side transcription before the event is even
      // appended (the server transcribes before anything is appended,
      // CLAUDE.md), long enough that silence would read as broken rather
      // than working.
      status.textContent = audio !== null ? "Transcribing your voice comment…" : "";

      markRange(
        blockEl,
        Math.min(...pending.rendered_offsets),
        Math.max(...pending.rendered_offsets),
        { "data-comment-id": "pending", "data-pending": "" },
      );
      const { comment } = await api.createSelectionComment(body);
      // The optimistic mark has served its purpose; the real one arrives with the
      // repaint the event below triggers, at the server's own offsets.
      clearPendingMarks(blockEl);
      mic?.reset();
      // Only clear and hide what was actually sent. If the box changed while
      // this was in flight, the new text is the user's: leave the pill open
      // with it rather than hiding it, which used to carry the words into a
      // hidden form the next selection's show() would silently wipe.
      if (textarea.value === sentValue) {
        this.pending = null;
        this.hide();
      }
      this.dispatchEvent(new CustomEvent("comment-created", { bubbles: true, detail: comment }));
    } catch (err) {
      // Rollback is exactly the optimistic highlight and nothing else (CQ4):
      // the other comments on this block did not fail. The form is left
      // exactly as the user had it: text, delivery choice, and a ready
      // recording all still there for a retry.
      clearPendingMarks(blockEl);
      this.dispatchEvent(new CustomEvent("agent-coop-error", { bubbles: true, detail: err }));
    } finally {
      // Always, not just on failure: the success path used to never
      // re-enable this (CRITICAL: show() didn't either, and the pill is
      // built once in connectedCallback and reused), so after one
      // successful anchored comment the form was permanently dead until a
      // reload. Clearing status here is also what stops "Transcribing your
      // voice comment…" persisting into the next selection.
      submitBtn.disabled = false;
      status.textContent = "";
      this.saving = false;
    }
  }
}

customElements.define("selection-comments", SelectionComments);
