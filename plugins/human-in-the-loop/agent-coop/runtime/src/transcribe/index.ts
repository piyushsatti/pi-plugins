// src/transcribe, audio to a transcript. Speech IN.
//
// Not src/speech, which is speech OUT (narration text to an audio file).
// Opposite direction, and the asymmetry between them is about TRUST, not
// about audio: narration is output nobody parses, a transcript is untrusted
// text authored by whoever was near the microphone and gets no special
// standing once it lands in a comment. See the dispatcher rule in CLAUDE.md,
// which replaced the old A11 prohibition on 2026-08-15, and src/speech's own
// header, which makes the same argument for the other direction.
//
// This file is the REGISTRY, mirroring src/speech/index.ts on purpose and for
// the identical reason: the types and the error live in ./seam.ts, which
// imports nothing, so the graph runs one way, seam <- each backend <- here,
// and cannot form the value-import cycle documented on src/speech/seam.ts
// (which is where the full story of why that split matters lives). Read that
// file if this one's shape looks like it could be simplified back into one.
import { whisperBackend } from "./whisper.ts";
import { TranscribeError } from "./seam.ts";
import type { TranscribeBackend, TranscriptResult } from "./seam.ts";

// Re-exported so `src/transcribe` stays the one import path for everything
// about transcription: no caller outside this directory names ./seam.ts.
export { TranscribeError };
export type { TranscribeBackend, TranscriptResult };

/** Every backend that exists, by the name `AGENT_COOP_TRANSCRIBE` accepts. */
export const BACKENDS: Record<string, TranscribeBackend> = {
  whisper: whisperBackend,
};

/**
 * whisper, the only backend so far. See src/transcribe/whisper.ts's header
 * for why the file it lives in is temporary: this default is expected to
 * point at an HTTP-backed engine once the speech service exists, and nothing
 * outside this directory has to change when it does.
 */
export const DEFAULT_BACKEND = "whisper";

/**
 * The backend `AGENT_COOP_TRANSCRIBE` names, or the default.
 *
 * An unknown name THROWS rather than falling back, matching `backendFor` in
 * src/speech/index.ts for the identical reason: a silent fallback to the
 * default turns a typo into "why did this stop understanding what I said",
 * a question the machine can answer and a human cannot.
 */
export function backendFor(name: string | undefined = process.env.AGENT_COOP_TRANSCRIBE): TranscribeBackend {
  const chosen = name === undefined || name === "" ? DEFAULT_BACKEND : name;
  const backend = BACKENDS[chosen];
  if (backend === undefined) {
    throw new TranscribeError(
      `unknown AGENT_COOP_TRANSCRIBE ${JSON.stringify(chosen)}; known backends: ${Object.keys(BACKENDS).join(", ")}`,
    );
  }
  return backend;
}
