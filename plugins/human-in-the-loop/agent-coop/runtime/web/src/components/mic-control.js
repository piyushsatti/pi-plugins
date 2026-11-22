// <mic-control>: the microphone affordance shared by every place a text
// comment can be given: selection-layer.js's pill, and comment-panel.js's
// whole-document composer and per-comment reply composer. Voice is an INPUT
// METHOD (CLAUDE.md), not a stored artifact, so this element owns only the
// CAPTURE side. web/src/lib/mic.js does the recording and encoding, this
// element drives it and paints its state. It knows nothing about comments,
// forms, or submission: a host reads `.audioPayload` at submit time and
// calls `.reset()` after a successful send, exactly the way it reads a
// textarea's `.value` and clears it.
//
// Built once and used three times rather than copy-pasted: all three
// composers get the same five states, the same accessibility treatment, and
// one place to fix either.
import { MAX_RECORDING_MS, MicRecorder, STATE } from "../lib/mic.js";

/** "0:07", minutes:seconds, floored not rounded: a counter that rounds up
 *  would read "0:04" for a recording three seconds old. Decorative only
 *  (`aria-hidden`, see render() below): the announced state lives in
 *  `.mic-status`, not here, so this never fires a second live-region update
 *  every quarter second. */
function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * The sentence a screen reader gets for each state (ui-design §Accessibility,
 * "the word IS the signal": see turn-note.js's own comment on the same
 * rule). IDLE has no entry: nothing has happened yet, so there is nothing to
 * announce, and FAILED reads `.error` instead of a fixed string because the
 * reason is the whole point of that state. RECORDING names the auto-stop
 * cap up front, in words, rather than letting the user discover it as a raw
 * 400 after the fact (function declarations hoist, so calling
 * `formatElapsed` here before its own declaration below is safe).
 */
const STATUS_TEXT = {
  [STATE.RECORDING]: `Recording. Press Stop when you're done. Stops automatically at ${formatElapsed(MAX_RECORDING_MS)}.`,
  [STATE.ENCODING]: "Processing the recording…",
  [STATE.READY]: "Voice recorded. It will be sent with your comment.",
};

export class MicControl extends HTMLElement {
  connectedCallback() {
    this.setAttribute("role", "group");
    this.setAttribute("aria-label", "Voice comment");
    // Plain words, no icon: every other control in this codebase (save,
    // cancel, resolve, Listen, read all…) is a text button, never a glyph,
    // and matching that is what "the word IS the signal" means here too.
    this.innerHTML = `
      <button type="button" class="mic-record">Record</button>
      <button type="button" class="mic-stop" hidden>Stop recording</button>
      <button type="button" class="mic-discard" hidden>Discard recording</button>
      <span class="mic-status" role="status"></span>
      <span class="mic-timer" aria-hidden="true"></span>`;

    this.recorder = new MicRecorder();
    this.onChange = () => this.render();
    this.recorder.addEventListener("change", this.onChange);

    this.querySelector(".mic-record").addEventListener("click", () => this.recorder.start());
    this.querySelector(".mic-stop").addEventListener("click", () => this.recorder.stop());
    this.querySelector(".mic-discard").addEventListener("click", () => this.recorder.discard());

    this.render();
  }

  disconnectedCallback() {
    this.recorder.removeEventListener("change", this.onChange);
    this.stopTimer();
    // A control leaving the page (its host form unmounting, a view switch)
    // must not leave the microphone hot behind it.
    this.recorder.discard();
  }

  /** The finished recording, ready to ride along on a submit. Null in every
   *  other state, so a caller never has to ask "is this actually done"
   *  itself: it just checks whether this is null. */
  get audioPayload() {
    return this.recorder.state === STATE.READY ? this.recorder.result : null;
  }

  /**
   * Whether this control could still contribute audio to the comment being
   * submitted: already finished (READY) or still working on it
   * (RECORDING/ENCODING). False only in IDLE (nothing was ever attempted)
   * and FAILED (an attempt did not produce audio), the two states where a
   * submit falls back to typed text alone rather than treating this as a
   * reason to wait. A host reads this alongside `audioPayload` to refuse a
   * submit only when NEITHER typed text nor a recording exists at all,
   * rather than refusing whenever the textarea happens to be empty.
   */
  get hasRecording() {
    const state = this.recorder.state;
    return state === STATE.RECORDING || state === STATE.ENCODING || state === STATE.READY;
  }

  /**
   * Finish whatever the recorder is doing before a caller reads
   * `audioPayload`. A submit made while still RECORDING stops the recorder
   * and waits for the encode to finish; a submit made while ENCODING (Stop
   * was already pressed) just waits for it. Both leave the recorder READY
   * or FAILED, the two states `audioPayload`/`hasRecording` already treat as
   * finished. A no-op in every other state, so a host can call this
   * unconditionally before every submit.
   */
  async settle() {
    if (this.recorder.state === STATE.RECORDING) {
      // MicRecorder.stop()'s own promise walks RECORDING -> ENCODING ->
      // (READY | FAILED) and does not resolve until that walk is done, so
      // awaiting it here already waits for the whole encode.
      await this.recorder.stop();
      return;
    }
    if (this.recorder.state !== STATE.ENCODING) return;
    // Stop was already pressed by the user and the encode is mid-flight:
    // there is no promise to await here, so wait on the next "change" that
    // actually leaves ENCODING.
    await new Promise((resolve) => {
      const onChange = () => {
        if (this.recorder.state === STATE.ENCODING) return;
        this.recorder.removeEventListener("change", onChange);
        resolve();
      };
      this.recorder.addEventListener("change", onChange);
    });
  }

  /** Back to idle for the next comment. Safe to call from any state: it
   *  always stops the microphone if one is still open (MicRecorder.discard),
   *  which is why every successful send calls this even when there was
   *  nothing ready to attach. */
  reset() {
    this.recorder.discard();
  }

  render() {
    const state = this.recorder.state;
    // On the host element, mirroring turn-note.js's `dataset.audio`: a hook
    // for CSS and for a test to read without parsing a sentence.
    this.dataset.state = state;

    const record = this.querySelector(".mic-record");
    const stop = this.querySelector(".mic-stop");
    const discard = this.querySelector(".mic-discard");
    const status = this.querySelector(".mic-status");
    const timer = this.querySelector(".mic-timer");

    record.hidden = state === STATE.RECORDING || state === STATE.ENCODING || state === STATE.READY;
    stop.hidden = state !== STATE.RECORDING;
    discard.hidden = state !== STATE.RECORDING && state !== STATE.READY;
    // FAILED has no entry in STATUS_TEXT, so this falls through to the
    // recorder's own `.error`: the reason IS the state's message. Every
    // other state but IDLE has a fixed sentence; IDLE gets the empty string,
    // which is correct, since nothing has happened yet.
    status.textContent = STATUS_TEXT[state] ?? this.recorder.error ?? "";

    if (state === STATE.RECORDING) {
      this.startTimer();
    } else {
      this.stopTimer();
      timer.hidden = true;
      timer.textContent = "";
    }
  }

  startTimer() {
    if (this.timerId !== undefined) return;
    const timer = this.querySelector(".mic-timer");
    timer.hidden = false;
    const tick = () => {
      const elapsed = this.recorder.elapsedMs();
      // Nothing bounds recording length on the wire's own terms until this
      // fires: MAX_AUDIO_B64_LEN (src/contract/limits.ts) is a hard 400,
      // and without a client-side stop the user only learns the cap exists
      // by hitting it. `stop()` here is fire-and-forget: it drives a state
      // change to ENCODING, and render()'s own STATE.RECORDING check is
      // what calls stopTimer() and clears this interval.
      if (elapsed >= MAX_RECORDING_MS) {
        this.recorder.stop();
        return;
      }
      timer.textContent = formatElapsed(elapsed);
    };
    tick();
    this.timerId = setInterval(tick, 250);
  }

  stopTimer() {
    if (this.timerId === undefined) return;
    clearInterval(this.timerId);
    this.timerId = undefined;
  }
}

customElements.define("mic-control", MicControl);
