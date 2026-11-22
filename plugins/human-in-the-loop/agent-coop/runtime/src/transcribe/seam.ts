// What a transcribe backend IS: the shape it speaks in and the one error it
// raises. NOTHING HERE IMPORTS ANYTHING, not even from src/contract. Same
// discipline as src/speech/seam.ts, which is where both this file's shape and
// this file's reason for existing come from. READ THAT FILE'S HEADER FIRST.
//
// Short version of it, restated for this directory: index.ts holds the
// REGISTRY and imports ./whisper.ts for BACKENDS. If ./whisper.ts ever
// imported a VALUE back out of index.ts (an error class, say), the two files
// would form a cycle, and an invisible one: every existing importer reaches
// index.ts first, so the modules initialise in the order that happens to
// work and the whole suite passes, right up until some future caller reaches
// ./whisper.ts first and gets "Cannot access '...' before initialization" at
// a line that is not wrong. 780 tests did not catch that shape in src/speech.
// This file is what stops it recurring here: a TYPE import in a cycle is
// free (erased before anything runs), a VALUE import in one is a time bomb,
// and the file that imports nothing cannot be the value side of a cycle.
//
// WHY THE BACKEND TAKES SAMPLES, NEVER A PATH. agent-coop never writes the user's
// voice anywhere durable, that promise is the whole feature (see the header
// on ./whisper.ts and the voice-input gotcha in CLAUDE.md, which is where the
// promise is actually written; the attachment dispatcher rule is a separate
// surface and says nothing about this one). A
// `transcribe(path: string)` signature would invite exactly the storage this
// design exists to avoid: a path is an invitation to keep the file around a
// little longer, to log it, to pass it somewhere else, and the interface
// itself would have stopped saying any of that was wrong. Taking SAMPLES
// keeps the only file a backend may ever create a TEMPORARY one that backend
// alone owns the lifetime of. whisper-cli happens to read a file rather than
// a pipe, so ./whisper.ts still writes one, but it is that backend's own tmp
// file, deleted in the same call that made it, never a path the caller chose
// or gets to reuse.

export type TranscriptResult = {
  /** The words. Untrusted text authored by whoever was near the microphone,
   *  same standing as any other user input once it lands (CLAUDE.md). */
  text: string;
  /** Wall time the transcription took, for a log line, not for the UI. */
  ms: number;
};

export type TranscribeBackend = {
  /** Names the engine in a log line and in a failure reason. */
  readonly name: string;
  /**
   * Optional: remove whatever this backend left behind on a previous run that
   * ended without unwinding, and answer with what it removed.
   *
   * Optional because it is a property of HOW a backend works rather than of
   * what it does. ./whisper.ts writes the user's voice to a temp file, so a
   * process killed mid-transcription leaves that file with no `finally` able
   * to reach it; a future backend that posts bytes to an HTTP service writes
   * nothing locally and simply omits this. The boot sequence calls it through
   * `?.()` for exactly that reason.
   *
   * It is on the backend and not in the server for the same reason `signal`
   * is: only the code that chose the path knows which files are its own to
   * delete, and deleting by pattern from anywhere else is how a sweep
   * eventually removes something it did not create.
   */
  sweep?(): Promise<string[]>;
  /** Is this backend usable on this machine right now? Checked before use so
   *  a missing binary or model is a named refusal rather than a spawn error
   *  nobody was positioned to catch. */
  available(): Promise<boolean>;
  /**
   * SAMPLES in, text out. Never a path in either direction, see the header
   * above for why.
   *
   * `opts.signal` is how a caller gives up on a call already in flight, and
   * it belongs on THIS interface rather than being the caller's problem to
   * solve by racing a timer against the returned promise. ./whisper.ts is the
   * reason why: it writes the user's voice to a temporary WAV file before it
   * can spawn anything, and only the code holding that file's path and that
   * subprocess's handle can promise to remove one and kill the other. A
   * caller that merely stops awaiting the promise, the shape this used to be,
   * abandons both: the temp file is never reached by any `finally` because
   * the backend's own call is still running, unaware anyone stopped
   * listening, and the subprocess keeps a model resident until it finishes or
   * the machine reboots. A backend takes the signal so it is the one thing in
   * a position to honor it.
   */
  transcribe(pcm: Int16Array, sampleRate: number, opts?: { signal?: AbortSignal }): Promise<TranscriptResult>;
};

export class TranscribeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscribeError";
  }
}
