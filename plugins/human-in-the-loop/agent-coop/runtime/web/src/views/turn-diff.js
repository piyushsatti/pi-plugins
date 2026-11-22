// <turn-diff-view> — the trust signal (ui-design G3, §Turn-diff view).
//
// Inline-annotated rendered HTML, never a monospace unified patch: every block
// renders the way it reads in the document, with its change class stated in
// words next to it.
//
// Nothing here decides WHAT changed. `GET /api/diff` answers that — which
// blocks (structurally, from two reconstructions) and which words inside a
// modified one — and this view paints the answer. That is the same division as
// the selection layer's `rendered_offsets`: the client is not allowed to work
// out what moved.
import { ACTORS, CHANGE_KINDS, DIFF_BASES } from "../contract.gen.js";
import { ACTOR_USER, CHANGE_UNCHANGED } from "../lib/enums.js";
import { api } from "../lib/api.js";
import { renderBlock } from "../lib/render.js";
import "../components/turn-note.js";

/**
 * How each change class is announced. The tag text is the accessible signal:
 * ui-design §Accessibility forbids colour being the only one, so every wash
 * below is paired with a word AND a glyph, and the word is what a screen
 * reader and a colourblind reader both get.
 */
export const CHANGE_LABELS = {
  added: { glyph: "+", word: "added" },
  removed: { glyph: "−", word: "removed" },
  modified: { glyph: "~", word: "modified" },
  moved: { glyph: "↕", word: "moved" },
  unchanged: { glyph: "", word: "unchanged" },
};

/**
 * Who a change belongs to, in words (PI-1). The diff spans everything since the
 * user's last submit, so it can contain the user's own later edits alongside
 * Claude's — and "muted" is a visual signal only, which ui-design
 * §Accessibility does not accept on its own. The word is what carries it.
 */
export const AUTHOR_LABELS = { claude: "by Claude", user: "by you" };

/** What the diff is against, from `TurnDiff.base` — stated on screen rather
 *  than assumed, because the base is no longer "the previous revision". */
export const BASE_LABELS = {
  last_submit: "since you last submitted",
  document_added: "since this document was added",
  explicit: "between two revisions",
};

/**
 * Every label map above is keyed by a contract enum, so every one is checked
 * against it here (B2/CQ5). These are the three the diff screen paints, and a
 * value the contract grew that this view has no words for would otherwise show
 * up as an empty tag or a raw identifier — the accessibility rule above says the
 * word IS the signal, so a missing word is a broken screen, not a cosmetic gap.
 */
for (const [name, values, labels] of [
  ["ChangeKind", CHANGE_KINDS, CHANGE_LABELS],
  ["Actor", ACTORS, AUTHOR_LABELS],
  ["DiffBase", DIFF_BASES, BASE_LABELS],
]) {
  for (const value of values) {
    if (labels[value] === undefined) {
      throw new Error(`${name} value ${value} has no label in web/src/views/turn-diff.js`);
    }
  }
}

/** Changes worth showing, in reading order: unchanged blocks render plainly,
 *  removed ones sit where they were removed from. */
export function isChanged(change) {
  return change !== CHANGE_UNCHANGED;
}

/**
 * Word ops from the server -> a DOM fragment of `<ins>`/`<del>`/text.
 * Pure apart from needing a document, so it is testable on its own.
 */
export function renderWordDiff(doc, words) {
  const frag = doc.createDocumentFragment();
  for (const { op, text } of words ?? []) {
    if (op === "equal") {
      frag.appendChild(doc.createTextNode(text));
      continue;
    }
    // <ins>/<del> carry the meaning in the element itself: underline and
    // strike-through are their default rendering, so the signal survives with
    // the stylesheet switched off entirely.
    const el = doc.createElement(op === "insert" ? "ins" : "del");
    el.className = op === "insert" ? "diff-add" : "diff-del";
    el.textContent = text;
    frag.appendChild(el);
  }
  return frag;
}

export class TurnDiffView extends HTMLElement {
  /** See <document-view>: `ready` is the awaitable the DOM does not give us. */
  connectedCallback() {
    this.ready = this.load();
  }

  async load() {
    const doc_id = this.dataset.docId;
    this.innerHTML = `
      <doc-toolbar>
        <a href="/session/${this.dataset.sessionId}/doc/${doc_id}" data-route>&larr; back to document</a>
        <h1>What changed this turn</h1>
        <span class="diff-base" role="note"></span>
        <span class="diff-legend" role="note"></span>
      </doc-toolbar>
      <turn-note></turn-note>
      <nav class="revision-list" aria-label="Past turns" hidden></nav>
      <div class="diff-pane" role="region" aria-label="Turn diff"></div>
      <section class="turn-threads" hidden>
        <h2>Comment replies this turn</h2>
        <ul class="thread-list"></ul>
      </section>`;
    // The dataset summary is the SSE frame's copy, shown immediately so the
    // screen is not blank while the fetch is in flight. The server's stored copy
    // replaces it below, which is the whole point of PI-5: after a reload there
    // is no SSE frame to have carried anything. Neither `turn_note` nor
    // `narration` travel on that frame (contract-design's `revision_created`
    // carries `turn_summary` only), so this first paint always shows the
    // no-note fallback — correct for the common case, and upgraded below the
    // instant the real read answers.
    //
    // Held on the instance (not re-read from the dataset) because a live
    // `note_written` frame in onSse below must repaint the panel without
    // clobbering the summary: that frame carries the note, not the summary,
    // and the two are set together by <turn-note>'s one entry point.
    this.currentTurnSummary = this.dataset.turnSummary ?? "";
    this.querySelector("turn-note").setRevision({
      doc_id,
      revision_id: this.dataset.to ?? "",
      turn_summary: this.currentTurnSummary,
      turn_note: null,
      narration: null,
    });

    try {
      const [result, list] = await Promise.all([
        api.diff(doc_id, this.dataset.from || undefined, this.dataset.to || undefined),
        api.revisions(doc_id),
      ]);
      this.querySelector(".diff-base").textContent = BASE_LABELS[result.base] ?? "";
      this.paint(result.diff);
      this.paintThreads(result.threads);
      this.paintRevisions(list.revisions);
    } catch (err) {
      this.dispatchEvent(new CustomEvent("agent-coop-error", { bubbles: true, detail: err }));
    }
  }

  /**
   * SSE arrives here from <agent-coop-app>, same seam as <document-view>.onSse.
   * `narration_ready`/`narration_failed`/`note_written` are the only three
   * frames this view reacts to (src/contract/sse.ts). Everything else that
   * could change this document's revisions (`revision_created`) only ever
   * fires for a NEW turn, and that always moves the user off this URL rather
   * than updating it in place.
   *
   * `note_written` is the fix for the defect that motivated this handler
   * change: Claude auto-navigates the user here the instant it snapshots, and
   * the note is written afterwards, so a page already open on this diff used
   * to show no note until an unprompted reload. `setRevision` repaints the
   * panel from whichever state it is currently in, INCLUDING a note already
   * on screen: a second `note_written` for the same revision is a documented
   * legal rewrite, and this is the same call the fetched-copy path already
   * makes, so painting over an existing note is not a special case.
   *
   * Filtered on both `doc_id` and `revision_id`: a render, or a note, kicked
   * off for a turn the user has since navigated away from, or for a
   * document this view is not open on at all, must not reach for a
   * `<turn-note>` that either is not there or is not the one being described.
   */
  onSse(name, data) {
    if (data.doc_id !== this.dataset.docId || data.revision_id !== this.currentRevisionId) return;
    if (name === "narration_ready") {
      this.querySelector("turn-note").narrationReady(data.duration_ms);
    } else if (name === "narration_failed") {
      this.querySelector("turn-note").narrationFailed(data.reason);
    } else if (name === "note_written") {
      this.querySelector("turn-note").setRevision({
        doc_id: data.doc_id,
        revision_id: data.revision_id,
        turn_summary: this.currentTurnSummary,
        turn_note: data.note,
        narration: data.narration,
      });
    }
  }

  /**
   * The turn picker (PI-5). Every past turn is a link back into this same view
   * with a different `to`, so a diff is re-openable instead of view-once.
   *
   * The stored summary for the turn being VIEWED wins over the one handed in on
   * the dataset: after a reload the dataset carries nothing, and the server's
   * copy is the one that outlives the page.
   *
   * One revision means no picker at all rather than a picker with one entry —
   * the same rule as the document switcher.
   */
  paintRevisions(revisions) {
    const nav = this.querySelector(".revision-list");
    nav.textContent = "";
    const current = this.dataset.to || revisions[0]?.revision_id;
    // Read by `onSse` below to tell a narration frame for the turn on screen
    // apart from one for a turn the user has since navigated away from.
    this.currentRevisionId = current;

    const viewing = revisions.find((r) => r.revision_id === current);
    if (viewing !== undefined) {
      // Read by onSse's `note_written` branch, so a note landing live after
      // this point repaints without reverting the summary to the pre-fetch
      // dataset copy above.
      this.currentTurnSummary = viewing.turn_summary;
      this.querySelector("turn-note").setRevision({
        doc_id: this.dataset.docId,
        revision_id: viewing.revision_id,
        turn_summary: viewing.turn_summary,
        turn_note: viewing.turn_note,
        narration: viewing.narration,
      });
    }

    nav.hidden = revisions.length < 2;
    if (nav.hidden) return;
    for (const [i, rev] of revisions.entries()) {
      // Numbered from the oldest, so "turn 1" is the first turn there ever was
      // and stays turn 1 when a newer one lands. The list is newest-first.
      const label = `turn ${revisions.length - i}`;
      if (rev.revision_id === current) {
        const here = document.createElement("span");
        here.className = "revision-tab";
        here.dataset.revisionId = rev.revision_id;
        here.setAttribute("aria-current", "page");
        here.textContent = label;
        nav.appendChild(here);
        continue;
      }
      const link = document.createElement("a");
      link.className = "revision-tab";
      link.dataset.revisionId = rev.revision_id;
      link.dataset.route = "";
      link.href =
        `/session/${this.dataset.sessionId}/doc/${this.dataset.docId}` +
        `/diff/${encodeURIComponent(rev.revision_id)}`;
      link.textContent = label;
      // The summary is the only thing that says which turn this was; a bare
      // number is a picker the user has to guess at.
      link.title = rev.turn_summary;
      nav.appendChild(link);
    }
  }

  /**
   * Comment threads with activity this turn (PI-7).
   *
   * Claude's replies used to live only in the document view's drawer, so the diff
   * screen answered "what changed" while the answers to the user's own comments
   * sat on another screen. No reply is labelled with an author: the reply seam
   * authenticates none (src/contract/comment.ts §CommentThread), and a "by
   * Claude" badge would be a claim the code cannot support.
   */
  paintThreads(threads) {
    const section = this.querySelector(".turn-threads");
    const list = section.querySelector(".thread-list");
    list.textContent = "";
    section.hidden = (threads ?? []).length === 0;
    if (section.hidden) return;

    for (const thread of threads) {
      const li = document.createElement("li");
      li.className = "thread";
      li.dataset.commentId = thread.root.comment_id;

      const scope = document.createElement("p");
      scope.className = "meta";
      scope.textContent =
        thread.root.anchor === null ? "whole document" : "on selection";
      li.appendChild(scope);

      if (thread.root.anchor !== null) {
        const quote = document.createElement("blockquote");
        quote.textContent = thread.root.anchor.quoted_text;
        li.appendChild(quote);
      }

      const body = document.createElement("p");
      body.className = "body";
      body.textContent = thread.root.text;
      li.appendChild(body);

      if (thread.replies.length > 0) {
        const ul = document.createElement("ul");
        ul.className = "replies";
        for (const reply of thread.replies) {
          const r = document.createElement("li");
          r.className = "reply";
          r.dataset.commentId = reply.comment_id;
          r.textContent = reply.text;
          ul.appendChild(r);
        }
        li.appendChild(ul);
      }
      list.appendChild(li);
    }
  }

  paint(diff) {
    const pane = this.querySelector(".diff-pane");
    pane.textContent = "";
    const counts = { added: 0, removed: 0, modified: 0, moved: 0 };
    let mine = 0;
    for (const change of diff.changes) {
      if (change.change in counts) counts[change.change]++;
      if (isChanged(change.change) && change.author === ACTOR_USER) mine++;
      pane.appendChild(this.changeNode(change));
    }
    const summary = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(", ");
    this.querySelector(".diff-legend").textContent =
      summary === ""
        ? "nothing changed in this document"
        : mine === 0
          ? summary
          : `${summary} · ${mine} by you`;
  }

  changeNode(change) {
    const el = document.createElement("article");
    el.className = "diff-block";
    el.dataset.change = change.change;
    el.dataset.blockId = change.block_id;
    // Absent `author` means the server computed no attribution (an explicit
    // revision-to-revision diff), so the attribute is absent too — never
    // defaulted to one of the two actors.
    if (change.author !== undefined && change.author !== null) el.dataset.author = change.author;

    if (isChanged(change.change)) el.appendChild(this.tagNode(change.change, change.author));

    const body = document.createElement("div");
    body.className = "diff-body";
    if (change.change === "removed") {
      // Collapsed by default, expandable (ui-design): removed text should not
      // push the document the user is actually reading off the screen.
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `removed block — ${firstLine(change.from.content)}`;
      const del = document.createElement("del");
      del.className = "diff-del";
      del.innerHTML = renderBlock(change.from.content);
      details.append(summary, del);
      body.appendChild(details);
    } else {
      // Everything else renders its CURRENT content, normally.
      const rendered = document.createElement("div");
      rendered.className = "diff-rendered";
      rendered.innerHTML = renderBlock(change.to.content);
      body.appendChild(rendered);
    }

    if (change.change === "modified") {
      const words = document.createElement("p");
      words.className = "word-diff";
      words.setAttribute("aria-label", "Word-level changes in this block");
      words.appendChild(renderWordDiff(document, change.words));
      body.appendChild(words);
    }
    el.appendChild(body);
    return el;
  }

  tagNode(change, author) {
    const { glyph, word } = CHANGE_LABELS[change] ?? { glyph: "?", word: change };
    const tag = document.createElement("span");
    tag.className = "change-tag";
    tag.dataset.change = change;
    const who = AUTHOR_LABELS[author];
    tag.textContent = `${glyph} ${word}${who === undefined ? "" : ` · ${who}`}`.trim();
    return tag;
  }
}

function firstLine(content) {
  const line = content.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

customElements.define("turn-diff-view", TurnDiffView);
