// What a speech backend IS: the two shapes it speaks in, and the one error it
// raises. Nothing here imports a backend, and that is the entire point.
//
// WHY THIS FILE EXISTS. It was all in index.ts, which also holds the REGISTRY,
// so index.ts imported ./kokoro.ts for `BACKENDS` while ./kokoro.ts imported
// `SpeechError` back out of index.ts as a VALUE. A cycle, and an invisible one:
// every existing importer reaches index.ts first, so the modules initialised in
// the order that happens to work and 780 tests passed. Enter through
// ./kokoro.ts instead, which any future module doing so is entitled to, and
// it dies at load with `Cannot access 'kokoroBackend' before initialization`,
// pointing at index.ts:51, a line that is not wrong.
//
// ./say.ts had the same import and never broke, because it takes only TYPES,
// which are erased before anything runs. That is the distinction to keep in
// mind rather than a rule about which file may import which: a `import type` in
// a cycle is free, a value import in one is a time bomb.
//
// index.ts re-exports all three, so no import site anywhere else changed.

export type SpeechResult = {
  /** Where the audio landed. The caller chose it; this is an echo, not a decision. */
  path: string;
  /** Content type for the route that serves it, and the same string the backend
   *  publishes as `mime`. The route reads it off the backend rather than off a
   *  render, because it has to answer for a file rendered in an earlier process. */
  mime: string;
  /** Playing time, so the UI can say "2 min" before anyone presses play. */
  duration_ms: number;
};

export type SpeechBackend = {
  /** Names the engine in a log line and in a failure reason. */
  readonly name: string;
  /**
   * The container this backend writes, as a file extension and a content type.
   *
   * They live on the BACKEND and not as a constant somewhere above it because
   * they are a property of the engine, not of agent-coop: `say` emits AAC in MP4,
   * kokoro-js emits WAV, and a future backend will emit something else again.
   * A single `NARRATION_MIME` constant was right only while there was one
   * backend, and would have served a WAV file labelled as MP4 the moment there
   * were two.
   */
  readonly ext: string;
  readonly mime: string;
  /** Is this backend usable on this machine right now? Checked before use so an
   *  absent engine is a named refusal rather than a spawn error nobody expected. */
  available(): Promise<boolean>;
  synthesize(text: string, outPath: string): Promise<SpeechResult>;
};

export class SpeechError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechError";
  }
}
