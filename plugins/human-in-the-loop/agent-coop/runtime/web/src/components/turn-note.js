// <turn-note> — Claude's own interpretation of a turn (ui-design §Turn-diff
// view): a markdown NOTE, plus an audio NARRATION of it. Mounted where
// <turn-summary> used to sit, directly above the revision tabs.
//
// A note is ON DEMAND (src/contract/revision.ts): `turn_note`/`narration` are
// nullable and null — no note was ever asked for — is the COMMON case, not a
// failure. When there is no note this element falls back to the one-line
// `turn_summary` every revision already carries, by reusing <turn-summary>
// itself rather than re-implementing its "no summary was recorded" text: the
// two surfaces would otherwise drift apart one edit at a time.
//
// Audio is a SEPARATE concern from the note text and never gates it: the note
// lands the moment the turn closes, and the narration is rendered in the
// background afterwards (src/server/notes.ts) — a render that is slow, still
// running, or has failed must never make the note itself unreadable. Nothing
// below disables or hides `.note-body` for any audio reason.
import { api } from "../lib/api.js";
import { renderBlock } from "../lib/render.js";
import "./turn-summary.js";

/**
 * `duration_ms` -> "2 min" / "45 sec": a human length, never a raw number
 * (ui-design). Rounds to the unit a listener actually decides by — nobody
 * chooses whether to press play over a difference of milliseconds.
 * @param {number} ms
 */
export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} sec`;
  return `${Math.round(totalSeconds / 60)} min`;
}

export class TurnNote extends HTMLElement {
  connectedCallback() {
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", "Turn note");
    this.innerHTML = `
      <div class="note-pane" hidden>
        <h2>Turn note</h2>
        <div class="note-body-wrap" data-expanded="false">
          <div class="note-body"></div>
        </div>
        <button type="button" class="note-expand" aria-expanded="false" hidden>read all</button>
        <div class="note-audio">
          <button type="button" class="note-listen" disabled>Listen</button>
          <span class="note-audio-status" role="status"></span>
          <audio class="note-audio-el" preload="metadata" hidden></audio>
        </div>
      </div>
      <div class="note-fallback">
        <turn-summary></turn-summary>
        <p class="note-hint">Ask for a note in chat to get Claude's own read on this turn.</p>
      </div>`;

    this.querySelector(".note-expand").addEventListener("click", () => this.toggleExpand());
    this.querySelector(".note-listen").addEventListener("click", () => this.play());

    const audioEl = this.querySelector(".note-audio-el");
    // The ONLY client-side way to learn "the audio is already ready" on a cold
    // page load: no narration_ready frame will ever arrive for a render that
    // finished before this page opened (SSE only reports what happens WHILE a
    // stream is connected), and the ready/pending/failed split is not a fact
    // on the revision — `duration_ms` lives nowhere but that frame and this
    // element's own metadata. `preload="metadata"` asks for enough of the file
    // to answer that without pulling the whole thing down.
    audioEl.addEventListener("loadedmetadata", () => {
      // A late answer to a probe fired before a narration_failed frame landed
      // must not undo it — the file it found is a stale one, if it exists at
      // all (the server never leaves a playable file behind a failed render).
      if (this.dataset.audio === "failed") return;
      this.setAudioReady(humanDuration(audioEl.duration * 1000));
    });
    audioEl.addEventListener("error", () => {
      // Not proof of failure: a render still in progress 404s exactly the same
      // as one that never happened, and the ONLY thing allowed to claim
      // "failed" is a narration_failed frame naming a reason (src/contract/sse.ts
      // — that reason is broadcast once and kept nowhere else).
      if (this.dataset.audio === "failed" || this.dataset.audio === "ready") return;
      this.setAudioPending();
    });

    if (this.pendingRevision !== undefined) {
      const rev = this.pendingRevision;
      this.pendingRevision = undefined;
      this.setRevision(rev);
    }
  }

  /**
   * Paint one revision. The one entry point <turn-diff-view> calls, both for
   * the immediate first paint (dataset only, before the fetch lands) and again
   * once the server's stored copy is known (PI-5's rule: the dataset is a
   * first-paint convenience, the server's copy is what survives a reload).
   * @param {{ doc_id: string, revision_id: string, turn_summary: string,
   *           turn_note: string | null, narration: string | null }} rev
   */
  setRevision(rev) {
    if (!this.isConnected) {
      // connectedCallback has not run yet (custom elements upgrade lazily);
      // hold the data rather than querying a DOM that is not built yet.
      this.pendingRevision = rev;
      return;
    }
    this.docId = rev.doc_id;
    this.revisionId = rev.revision_id;
    this.querySelector("turn-summary").summary = rev.turn_summary;

    const hasNote = rev.turn_note !== null && rev.turn_note !== undefined;
    this.dataset.hasNote = String(hasNote);
    this.querySelector(".note-pane").hidden = !hasNote;
    this.querySelector(".note-fallback").hidden = hasNote;
    if (!hasNote) return;

    const body = this.querySelector(".note-body");
    body.innerHTML = renderBlock(rev.turn_note);
    // Collapsed until the reader asks otherwise: a note is Claude's own
    // interpretation, not a one-liner, and a long one must not push the diff
    // below it off a phone screen.
    const wrap = this.querySelector(".note-body-wrap");
    wrap.dataset.expanded = "false";
    const expandBtn = this.querySelector(".note-expand");
    expandBtn.hidden = false;
    expandBtn.textContent = "read all";
    expandBtn.setAttribute("aria-expanded", "false");

    // Audio starts PENDING, never "failed": on a fresh mount nothing has told
    // this element anything yet, and defaulting to "failed" would be a claim
    // this element cannot support (see the `error` listener above).
    this.setAudioPending();
    const audioEl = this.querySelector(".note-audio-el");
    // REMOVE the attribute rather than setting it to "": an empty `src`
    // resolves against the document's base URL, so the element would fetch this
    // very page and try to decode the HTML as audio. Today that branch is
    // unreachable — `note_written` carries both texts, so a row with a
    // `turn_note` always has a `narration` — but "unreachable" is a property of
    // the current contract, not of this element.
    if (rev.narration !== null && rev.narration !== undefined) {
      audioEl.src = api.narrationUrl(rev.doc_id, rev.revision_id);
    } else {
      audioEl.removeAttribute("src");
    }
  }

  toggleExpand() {
    const wrap = this.querySelector(".note-body-wrap");
    const btn = this.querySelector(".note-expand");
    const expanded = wrap.dataset.expanded === "true";
    wrap.dataset.expanded = String(!expanded);
    btn.textContent = expanded ? "read all" : "show less";
    btn.setAttribute("aria-expanded", String(!expanded));
  }

  /** Not yet known to be ready or failed — the default, and the ONLY state a
   *  page that has received no signal at all may show. */
  setAudioPending() {
    this.dataset.audio = "pending";
    const listen = this.querySelector(".note-listen");
    listen.hidden = false;
    listen.disabled = true;
    listen.textContent = "Listen";
    const status = this.querySelector(".note-audio-status");
    status.hidden = false;
    status.classList.remove("audio-failed");
    // The word IS the signal (ui-design §Accessibility): `disabled` alone is a
    // shape a colourblind reader still gets, but this sentence is what a
    // screen reader announces, so "working" is spelled out rather than implied.
    status.textContent = "audio is being prepared…";
  }

  /** Called by <turn-diff-view> for a live `narration_ready` frame naming
   *  THIS revision. @param {number} duration_ms */
  narrationReady(duration_ms) {
    this.setAudioReady(humanDuration(duration_ms));
  }

  /** @param {string} humanLength e.g. "2 min"; "" if unknown. */
  setAudioReady(humanLength) {
    this.dataset.audio = "ready";
    const listen = this.querySelector(".note-listen");
    listen.hidden = false;
    listen.disabled = false;
    listen.textContent = "Listen";
    const status = this.querySelector(".note-audio-status");
    status.hidden = humanLength === "";
    status.classList.remove("audio-failed");
    status.textContent = humanLength;
  }

  /** Called by <turn-diff-view> for a live `narration_failed` frame naming
   *  THIS revision. @param {string} reason */
  narrationFailed(reason) {
    this.dataset.audio = "failed";
    // The control is REPLACED, not merely disabled: "disabled" reads as
    // "wait", and a failed render never becomes ready on its own. The note
    // above is untouched by any of this — audio never blocks reading.
    this.querySelector(".note-listen").hidden = true;
    const status = this.querySelector(".note-audio-status");
    status.hidden = false;
    status.classList.add("audio-failed");
    status.textContent = `audio unavailable — ${reason}`;
  }

  /** Reveal native controls and start playback. The element already has its
   *  `src` (set in `setRevision`); nothing here decides the URL. */
  play() {
    const audioEl = this.querySelector(".note-audio-el");
    audioEl.hidden = false;
    audioEl.setAttribute("controls", "");
    audioEl.play?.()?.catch?.(() => {
      // A rejected play() (autoplay policy, decode failure after all) leaves
      // the native controls on screen, which is its own error surface — the
      // element is not re-hidden, so the reader is not left with nothing.
    });
  }
}

customElements.define("turn-note", TurnNote);
