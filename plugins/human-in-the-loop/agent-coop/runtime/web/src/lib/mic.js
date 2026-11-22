// Voice INPUT capture: getUserMedia -> MediaRecorder -> decode -> resample to
// 16kHz mono -> Int16 -> base64. Produces exactly the shape
// `CommentAudioSchema` wants (src/contract/comment.ts): `{ pcm_b64,
// sample_rate: 16000 }`. This module knows nothing about comments, forms, or
// submission: it is capture only. web/src/components/mic-control.js drives
// it, and that is the only thing that should import it.
//
// Why resample HERE and not on the server: `sample_rate` is pinned to
// `z.literal(16000)` on the wire on purpose (src/contract/comment.ts). A
// resampler on the server would be one more thing to maintain for a problem
// the browser is already positioned to solve with an OfflineAudioContext, and
// a wrong rate becomes a named 400 at the schema instead of a transcript that
// is quietly wrong.
//
// Why MediaRecorder -> Blob -> decodeAudioData -> OfflineAudioContext, and not
// an AudioWorklet reading raw samples as they arrive: this route is the one
// that works, unmodified, on every current desktop and mobile browser without
// a separate worklet module to ship and register. Its cost is a short
// buffering delay between `stop()` and a usable buffer, and that delay is
// exactly the ENCODING state below, not a bug to route around.

/** 16 kHz is the rate the wire carries (CLAUDE.md's voice-input gotcha) and
 *  `CommentAudioSchema` pins exactly it with `z.literal`, so there is nothing
 *  to parameterize. The measurement behind the choice is in
 *  src/transcribe/whisper.ts's header, not in CLAUDE.md. */
const SAMPLE_RATE = 16000;

/**
 * Client-side ceiling on ONE recording, so a user hits a clear auto-stop at a
 * round number instead of a raw Zod 400 from the wire's own cap after
 * they've already spoken for nearly five minutes. Derived from the wire
 * limit rather than copying its number, so the two numbers cannot silently
 * drift in only one direction: `MAX_AUDIO_B64_LEN` (src/contract/limits.ts,
 * `12 * 1024 * 1024` = 12582912 base64 chars) bounds base64 of this file's
 * 16kHz mono Int16 PCM, so the true wire ceiling in seconds is
 * `(MAX_AUDIO_B64_LEN * 3/4) / (SAMPLE_RATE * 2)` ~= 294.9s (4:54.9). This
 * module cannot import the contract (see the file header: that would pull
 * zod into the browser bundle), so if MAX_AUDIO_B64_LEN ever changes this
 * constant has to be re-derived by hand against it.
 * Set a full 25 seconds under that true ceiling, at a number a user can act
 * on ("stops at 4:30") rather than sitting right at the wire's edge where
 * the base64 encoder's own rounding could still push a borderline recording
 * over it.
 */
export const MAX_RECORDING_MS = (4 * 60 + 30) * 1000;

export const STATE = Object.freeze({
  IDLE: "idle",
  RECORDING: "recording",
  ENCODING: "encoding",
  READY: "ready",
  FAILED: "failed",
});

/**
 * Why the mic affordance would not work here, or null if it should. Exported
 * so a component can show this BEFORE the user presses anything rather than
 * only failing after a click: getUserMedia is scoped to secure contexts by
 * spec, which is exactly the phone reached over the tailnet today on plain
 * HTTP (docs/phone.md). The button has to explain itself instead of just not
 * working.
 */
export function unavailableReason() {
  if (typeof navigator === "undefined" || navigator.mediaDevices?.getUserMedia === undefined) {
    return "Microphone capture is not available in this browser.";
  }
  // `typeof` rather than a bare reference: happy-dom (and some older
  // browsers) never define the global at all, and a bare identifier lookup
  // on an undefined global throws ReferenceError where a property probe
  // would not.
  if (typeof isSecureContext !== "undefined" && !isSecureContext) {
    return "Microphone needs a secure connection (HTTPS). Plain HTTP only works on this device itself.";
  }
  if (typeof MediaRecorder === "undefined") {
    return "This browser cannot record audio.";
  }
  return null;
}

/**
 * Base64 of a large byte buffer without one `String.fromCharCode(...bytes)`
 * call: spreading the whole array onto the call stack as arguments blows it
 * once the recording is more than a few tens of thousands of samples long, a
 * couple of seconds of audio, because that spread is a stack frame per
 * element, not a loop. Chunking keeps every call small regardless of how long
 * the recording ran. Exported for direct testing.
 */
const CHUNK = 0x8000;
export function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Float32 samples in [-1, 1] (what Web Audio hands back) to Int16 PCM (what
 * the wire wants). Asymmetric scale for the same reason src/audio/wav.ts's
 * `encodePcm16Wav` uses one: int16 runs -32768..32767, so the two directions
 * need different constants or +1.0 would clip short of the range's edge.
 * Exported for direct testing.
 */
export function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * One recording's worth of state, driven by a component through `start()` /
 * `stop()` / `discard()` and read back via `.state` / `.result` / `.error`.
 * `EventTarget` rather than a callback list so a caller adds one "change"
 * listener and re-reads the instance, the same shape as every native media
 * object already uses.
 */
export class MicRecorder extends EventTarget {
  constructor() {
    super();
    const reason = unavailableReason();
    // Starting straight in FAILED when the environment cannot do this at all
    // means a component never needs a SIXTH state for "not tried yet, and
    // never going to work": it just reads `.error` the same way it would
    // after a real attempt failed.
    //
    // The `@type` here is not decoration: with `checkJs: false` (tsconfig.json)
    // TypeScript infers this field's type ONLY from the assignments it can see
    // in the constructor, so without it a `.ts` consumer would see `state` as
    // narrowed to `"idle" | "failed"` forever, and the three values `_set()`
    // assigns later would fail every comparison at the type level.
    /** @type {(typeof STATE)[keyof typeof STATE]} */
    this.state = reason === null ? STATE.IDLE : STATE.FAILED;
    this.error = reason;
    this.startedAt = null;
    this.result = null; // { pcm_b64, sample_rate } once READY
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    // Bumped by discard(). A start()/stop() pipeline still in flight when the
    // user discards checks this before ever calling `_set` again. Without it,
    // a late permission grant or a slow decode could resurrect a recording
    // the user already threw away.
    this.generation = 0;
  }

  _set(state, error = null) {
    this.state = state;
    this.error = error;
    this.dispatchEvent(new Event("change"));
  }

  /** Milliseconds since recording began, 0 outside RECORDING. A component
   *  polls this on its own timer for "how long"; nothing here ticks. */
  elapsedMs() {
    if (this.state !== STATE.RECORDING || this.startedAt === null) return 0;
    return Date.now() - this.startedAt;
  }

  /** Ask for the microphone and start capturing. Resolves once the state is
   *  RECORDING or FAILED. A caller that only wants the state can ignore the
   *  return value and read `.state` from a "change" listener instead. */
  async start() {
    const reason = unavailableReason();
    if (reason !== null) {
      this._set(STATE.FAILED, reason);
      return;
    }
    this.result = null;
    const gen = ++this.generation;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (gen !== this.generation) return; // discarded while the permission prompt was up
      this._set(STATE.FAILED, `Microphone access was refused: ${err.message ?? err}`);
      return;
    }
    if (gen !== this.generation) {
      // Discarded in the gap between asking and the browser answering: the
      // user already said no more, close the hardware and say nothing.
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;
    this.chunks = [];
    try {
      this.recorder = new MediaRecorder(this.stream);
    } catch (err) {
      this._stopTracks();
      this._set(STATE.FAILED, `Recording is not supported: ${err.message ?? err}`);
      return;
    }
    this.recorder.addEventListener("dataavailable", (ev) => {
      if (ev.data.size > 0) this.chunks.push(ev.data);
    });
    this.recorder.start();
    this.startedAt = Date.now();
    this._set(STATE.RECORDING);
  }

  /**
   * Stop capturing and encode down to 16kHz mono Int16 base64. The state walks
   * RECORDING -> ENCODING -> (READY | FAILED); every await below is guarded by
   * the generation counter so a discard() that lands mid-pipeline wins.
   */
  async stop() {
    if (this.state !== STATE.RECORDING || this.recorder === null) return;
    const gen = this.generation;
    const recorder = this.recorder;
    const stopped = new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
    });
    recorder.stop();
    await stopped;
    this._stopTracks();
    if (gen !== this.generation) return;
    this._set(STATE.ENCODING);

    try {
      const blob = new Blob(this.chunks, { type: recorder.mimeType });
      const arrayBuffer = await blob.arrayBuffer();
      // `window.X ?? window.Y`, not a bare `webkitAudioContext` reference: a
      // missing bare global throws ReferenceError, a missing property reads
      // as undefined. Safari ships the prefixed name; every other current
      // browser ships the bare one.
      const AC = window.AudioContext ?? window.webkitAudioContext;
      const decodeCtx = new AC();
      let decoded;
      try {
        decoded = await decodeCtx.decodeAudioData(arrayBuffer);
      } finally {
        await decodeCtx.close?.();
      }
      if (gen !== this.generation) return;

      const offline = new OfflineAudioContext(
        1,
        Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE)),
        SAMPLE_RATE,
      );
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start();
      const rendered = await offline.startRendering();
      if (gen !== this.generation) return;

      const pcm = floatTo16BitPCM(rendered.getChannelData(0));
      // TypedArray byte order follows the platform's native endianness, which
      // is little-endian on every browser platform in practice (x86, ARM):
      // the same assumption src/audio/wav.ts makes explicitly with
      // `setInt16(..., true)`.
      const bytes = new Uint8Array(pcm.buffer);
      this.result = { pcm_b64: bytesToBase64(bytes), sample_rate: SAMPLE_RATE };
      this._set(STATE.READY);
    } catch (err) {
      if (gen !== this.generation) return;
      this.result = null;
      this._set(STATE.FAILED, `Could not process the recording: ${err.message ?? err}`);
    }
  }

  /**
   * Throw everything away and go back to idle. Safe to call from any state,
   * including mid-pipeline: it stops the microphone hardware immediately
   * (via `_stopTracks`, before anything async), which is the part that
   * actually matters for privacy, and bumps `generation` so a `start()` or
   * `stop()` already in flight cannot land after it.
   */
  discard() {
    this.generation++;
    this._stopTracks();
    if (this.recorder !== null) {
      try {
        this.recorder.stop();
      } catch {
        // Already stopped/inactive: nothing left to do.
      }
    }
    this.recorder = null;
    this.chunks = [];
    this.result = null;
    this.startedAt = null;
    this._set(STATE.IDLE);
  }

  _stopTracks() {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }
}
