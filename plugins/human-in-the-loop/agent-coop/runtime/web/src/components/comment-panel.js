// <global-comments> — the doc-scoped comments drawer (ui-design §Global
// comments panel). Slide-out, listing every comment on the document in one
// flat list: global comments and selection comments together, replies nested
// under their parent by `parent_id`, orphans in their own tagged section, and
// resolved comments collapsed into a section of their own.
//
// Three rules this file exists to hold:
//   - Every comment carries a resolve control, regardless of author (COV-F4).
//     There is no author check anywhere below, deliberately.
//   - Comments stay writable while the session is SUBMITTED or CLAUDE_TURN —
//     the drawer is never disabled by session state; only block edits are.
//   - A reply is a new row (`comment_reply`), never a mutation of the parent.
import { api } from "../lib/api.js";
import { deliveryControl, deliveryOf, resetDelivery } from "../lib/delivery.js";
import {
  ANCHOR_ATTACHED,
  ANCHOR_ORPHANED,
  DELIVERY_INTERRUPT,
  STATUS_RESOLVED,
} from "../lib/enums.js";
import "./mic-control.js"; // registers <mic-control>, used in both composers below

/**
 * The two ways an anchor stops pointing at words, each named on screen (PI-6).
 * They are separate strings because they are separate facts, and a reader who
 * only ever sees one message cannot tell which happened.
 */
export const ORPHAN_TAG = "anchor lost: the block is gone";
export const DETACHED_TAG = "anchor detached: the quoted words are no longer there";

/** The tag for a comment whose anchor no longer resolves to a run of text. */
export function unanchoredTag(comment) {
  return comment.anchor_state === ANCHOR_ORPHANED ? ORPHAN_TAG : DETACHED_TAG;
}

export class GlobalComments extends HTMLElement {
  connectedCallback() {
    this.comments = [];
    this.setAttribute("role", "complementary");
    this.setAttribute("aria-label", "Comments");
    this.innerHTML = `
      <header class="drawer-head">
        <h2>Comments</h2>
        <button type="button" class="drawer-close" aria-label="Close comments">&times;</button>
      </header>
      <form class="global-composer">
        <textarea rows="3" aria-label="Whole-document comment"
                  placeholder="Comment on the whole document"></textarea>
        <mic-control></mic-control>
        <div class="row">
          <button type="submit">add comment</button>
          <span class="composer-status" role="status"></span>
        </div>
      </form>
      <ul class="comment-list open-list" aria-label="Open comments"></ul>
      <section class="orphaned" hidden>
        <h3>Anchor lost</h3>
        <ul class="comment-list orphan-list"></ul>
      </section>
      <details class="resolved-section">
        <summary>Resolved (<span class="resolved-count">0</span>)</summary>
        <ul class="comment-list resolved-list"></ul>
      </details>`;

    const composer = this.querySelector(".global-composer");
    composer.insertBefore(deliveryControl("Delivery"), composer.querySelector(".row"));
    composer.addEventListener("submit", (ev) => {
      ev.preventDefault();
      this.pendingAdd = this.addGlobal();
    });
    this.querySelector(".drawer-close").addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("drawer-close", { bubbles: true }));
    });
  }

  set docId(id) {
    this.dataset.docId = id;
  }

  setComments(list) {
    this.comments = [...list];
    this.paint();
  }

  upsert(comment) {
    const i = this.comments.findIndex((c) => c.comment_id === comment.comment_id);
    if (i === -1) this.comments.push(comment);
    else this.comments[i] = comment;
    this.paint();
  }

  markResolved(comment_id, resolved_by) {
    const c = this.comments.find((x) => x.comment_id === comment_id);
    if (c === undefined) return;
    c.status = STATUS_RESOLVED;
    c.resolved_by = resolved_by;
    this.paint();
  }

  /** Scroll a row into view and flash it — the panel end of jump-to-anchor. */
  focusComment(comment_id) {
    const row = this.querySelector(`[data-comment-id="${CSS.escape(comment_id)}"]`);
    if (row === null) return;
    row.closest("details")?.setAttribute("open", "");
    row.scrollIntoView?.({ block: "nearest" });
    row.classList.add("flash");
    setTimeout(() => row.classList.remove("flash"), 1200);
  }

  paint() {
    const open = this.querySelector(".open-list");
    const orphans = this.querySelector(".orphan-list");
    const resolved = this.querySelector(".resolved-list");

    // A reply composer holding either a live recording OR unsent typed text
    // must survive this repaint. For a recording: removing its <mic-control>
    // from the DOM fires disconnectedCallback -> discard(), which stops the
    // microphone. For typed text: a fresh row's textarea starts empty, so a
    // rebuild silently drops whatever the user had half-written. paint()
    // runs on every incoming comment frame over SSE, so without either half
    // of this an UNRELATED comment arriving killed an in-progress recording
    // mid-sentence, or erased a reply nobody had sent yet. Find every
    // top-level row holding either BEFORE anything is torn down, keyed by
    // the root comment_id (a reply-to-a-reply's composer lives several
    // `<li>`s deep, but paint() only rebuilds at the top level, so that
    // whole row must be left alone, not just the innermost `<li>`).
    const preserved = new Map();
    for (const replyForm of this.querySelectorAll(".reply-composer")) {
      const mic = replyForm.querySelector("mic-control");
      const textarea = replyForm.querySelector("textarea");
      const hasUnsentText = (textarea?.value ?? "").trim() !== "";
      if (!(mic?.hasRecording ?? false) && !hasUnsentText) continue;
      const li = replyForm.closest("li[data-comment-id]");
      if (li === null) continue;
      const root = topRow(li);
      preserved.set(root.dataset.commentId, root);
    }
    for (const list of [open, orphans, resolved]) {
      for (const li of [...list.children]) {
        if (!preserved.has(li.dataset.commentId)) li.remove();
      }
    }

    const children = new Map();
    for (const c of this.comments) {
      const parent = c.parent_id ?? null;
      if (parent === null) continue;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(c);
    }

    for (const c of this.comments) {
      if ((c.parent_id ?? null) !== null) continue; // rendered under its parent
      if (preserved.has(c.comment_id)) continue; // left exactly as it was: a recording or unsent text in progress
      const row = this.row(c, children.get(c.comment_id) ?? []);
      if (c.status === STATUS_RESOLVED) resolved.appendChild(row);
      else if (isUnanchored(c)) orphans.appendChild(row);
      else open.appendChild(row);
    }

    this.querySelector(".orphaned").hidden = orphans.children.length === 0;
    this.querySelector(".resolved-count").textContent = String(resolved.children.length);
  }

  row(comment, replies) {
    const li = document.createElement("li");
    const unanchored = isUnanchored(comment);
    li.className = `comment ${comment.status}${unanchored ? " orphaned" : ""}`;
    li.dataset.commentId = comment.comment_id;
    li.dataset.delivery = comment.delivery;
    // On the element, so a reader (and a test) can tell detached from orphaned
    // without parsing the tag sentence.
    if (comment.anchor !== null) li.dataset.anchorState = comment.anchor_state;

    const meta = document.createElement("div");
    meta.className = "meta";
    const scope = comment.anchor === null ? "whole document" : "on selection";
    meta.textContent =
      `${scope} · ${comment.delivery === DELIVERY_INTERRUPT ? `⚑ ${DELIVERY_INTERRUPT}` : comment.delivery}` +
      (comment.status === STATUS_RESOLVED ? ` · resolved by ${comment.resolved_by}` : "");
    li.appendChild(meta);

    if (unanchored) {
      const tag = document.createElement("p");
      tag.className = "orphan-tag";
      tag.textContent = unanchoredTag(comment);
      li.appendChild(tag);
    }

    if (comment.anchor !== null) {
      const quote = document.createElement("blockquote");
      quote.textContent = comment.anchor.quoted_text;
      li.appendChild(quote);
    }

    const body = document.createElement("p");
    body.className = "body";
    body.textContent = comment.text;
    li.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "row actions";

    // Jump-to-anchor: only meaningful while the anchor still resolves to a run.
    if (comment.anchor !== null && !unanchored) {
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "jump";
      jump.textContent = "jump to anchor";
      jump.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent("comment-jump", {
            bubbles: true,
            detail: { comment_id: comment.comment_id, block_id: comment.anchor.block_id },
          }),
        );
      });
      actions.appendChild(jump);
    }

    // COV-F4: present on every comment, every author, every session state.
    if (comment.status !== STATUS_RESOLVED) {
      const resolve = document.createElement("button");
      resolve.type = "button";
      resolve.className = "resolve";
      resolve.textContent = "resolve";
      resolve.setAttribute("aria-label", `Resolve comment: ${comment.text}`);
      resolve.addEventListener("click", () => {
        this.pendingResolve = this.resolve(comment.comment_id);
      });
      actions.appendChild(resolve);
    }
    li.appendChild(actions);

    if (comment.status !== STATUS_RESOLVED) {
      const reply = document.createElement("form");
      reply.className = "reply-composer";
      reply.innerHTML = `
        <textarea rows="1" aria-label="Reply to this comment" placeholder="reply…"></textarea>
        <mic-control></mic-control>
        <button type="submit">reply</button>
        <span class="reply-status" role="status"></span>`;
      reply.addEventListener("submit", (ev) => {
        ev.preventDefault();
        this.pendingReply = this.reply(comment.comment_id, reply);
      });
      li.appendChild(reply);
    }

    if (replies.length > 0) {
      const ul = document.createElement("ul");
      ul.className = "replies";
      for (const r of replies) ul.appendChild(this.row(r, []));
      li.appendChild(ul);
    }
    return li;
  }

  async resolve(comment_id) {
    try {
      const { comment } = await api.resolveComment(comment_id);
      this.upsert(comment);
    } catch (err) {
      this.dispatchEvent(new CustomEvent("agent-coop-error", { bubbles: true, detail: err }));
    }
  }

  /**
   * A reply is a NEW comment row, never a mutation of the parent (see the
   * file header). The form's own reset is deferred to a successful response
   * for the same reason `addGlobal` below defers its: cleared eagerly, a
   * refused reply took the typed text and any ready recording down with it,
   * leaving nothing on screen to retry.
   */
  async reply(parent_id, form) {
    const textarea = form.querySelector("textarea");
    const mic = form.querySelector("mic-control");
    const text = textarea.value.trim();
    // "Say something or type something": refuse only when NEITHER typed
    // text nor a recording (in progress or finished) exists. `hasRecording`
    // covers RECORDING/ENCODING/READY, so a submit mid-recording falls
    // through to `settle()` below instead of being refused here.
    if (text === "" && !(mic?.hasRecording ?? false)) return;
    const submitBtn = form.querySelector("button[type=submit]");
    const status = form.querySelector(".reply-status");
    submitBtn.disabled = true;
    // Captured before the request goes out: a voice send blocks on
    // server-side transcription for seconds while the box stays editable
    // (only the submit button is disabled), so what gets cleared on success
    // is "what was actually sent", never "whatever is in the box when the
    // response lands". A typed comment's version of this window is
    // milliseconds; a voice one's is long enough to type into.
    const sentValue = textarea.value;
    try {
      // A submit made while still RECORDING or ENCODING finishes the
      // recording and sends it, rather than silently posting text-only.
      await mic?.settle();
      const audio = mic?.audioPayload ?? null;
      if (text === "" && audio === null) return; // nothing recorded, nothing typed
      status.textContent = audio !== null ? "Transcribing your voice comment…" : "";
      const { comment } = await api.replyComment(parent_id, text, audio);
      // Only clear what was actually sent. If the box changed while this was
      // in flight, the new text is the user's, not this request's, and must
      // survive (paint()'s widened preservation guard is what keeps it on
      // screen through the repaint `upsert` below triggers).
      if (textarea.value === sentValue) textarea.value = "";
      mic?.reset();
      this.upsert(comment);
    } catch (err) {
      this.dispatchEvent(new CustomEvent("agent-coop-error", { bubbles: true, detail: err }));
    } finally {
      // `this.upsert` above repaints the whole list, which replaces this very
      // `form` element: disabling it again on the success path would touch a
      // node nothing points at any more. Harmless either way, so no branch.
      submitBtn.disabled = false;
      status.textContent = "";
    }
  }

  /**
   * Whole-document comment (A4). Cleared only on success, same reasoning as
   * `reply` above: an eager clear used to mean a refused post lost the typed
   * text before the user ever saw it fail.
   */
  async addGlobal() {
    const composer = this.querySelector(".global-composer");
    const textarea = composer.querySelector("textarea");
    const mic = composer.querySelector("mic-control");
    const text = textarea.value.trim();
    // "Say something or type something": refuse only when NEITHER typed
    // text nor a recording (in progress or finished) exists.
    if (text === "" && !(mic?.hasRecording ?? false)) return;
    const submitBtn = composer.querySelector("button[type=submit]");
    const status = composer.querySelector(".composer-status");
    submitBtn.disabled = true;
    // Same reasoning as reply()'s sentValue: a voice send blocks on
    // server-side transcription for seconds while the box stays editable,
    // so clear only what this request actually sent.
    const sentValue = textarea.value;
    try {
      // A submit made while still RECORDING or ENCODING finishes the
      // recording and sends it, rather than silently posting text-only.
      await mic?.settle();
      const audio = mic?.audioPayload ?? null;
      if (text === "" && audio === null) return; // nothing recorded, nothing typed
      const delivery = deliveryOf(composer);
      // Same wait as the selection pill's: a voice comment now transcribes
      // server-side before the event is appended (CLAUDE.md), long enough that
      // this needs its own word.
      status.textContent = audio !== null ? "Transcribing your voice comment…" : "";
      const { comment } = await api.createGlobalComment({
        doc_id: this.dataset.docId,
        text,
        delivery,
        audio,
      });
      // If the box changed while the request was in flight, the new text is
      // the user's and must survive rather than being cleared alongside it.
      if (textarea.value === sentValue) textarea.value = "";
      resetDelivery(composer);
      mic?.reset();
      this.upsert(comment);
    } catch (err) {
      this.dispatchEvent(new CustomEvent("agent-coop-error", { bubbles: true, detail: err }));
    } finally {
      submitBtn.disabled = false;
      status.textContent = "";
    }
  }
}

/**
 * "This comment no longer points at words" = anything the server did not call
 * `attached`. The client never decides this itself, and it deliberately does not
 * enumerate the failure values: a future fourth state must not fall through to
 * being treated as a healthy anchor.
 */
function isUnanchored(comment) {
  return comment.anchor !== null && comment.anchor_state !== ANCHOR_ATTACHED;
}

/** The outermost `<li data-comment-id>` containing `li`, itself if it is
 *  already top-level. paint() only rebuilds at that granularity, so
 *  preserving a nested reply's row across a repaint means preserving its
 *  whole top-level ancestor, not just the `<li>` immediately around it. */
function topRow(li) {
  const parent = li.parentElement?.closest("li[data-comment-id]") ?? null;
  return parent === null ? li : topRow(parent);
}

customElements.define("global-comments", GlobalComments);
