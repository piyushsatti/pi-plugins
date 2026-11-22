// src/speech — narration text to an audio file. Speech OUT.
//
// Not src/transcribe, which is the placeholder for speech IN (audio to a
// transcript). Opposite direction, and the asymmetry is about TRUST, not about
// audio: this is output nobody parses, while a transcript is untrusted text
// authored by whoever was near the microphone. Both directions are answered by
// the same service; see the dispatcher rule in CLAUDE.md, which replaced the
// old A11 prohibition on 2026-08-15.
//
// Knows nothing about HTTP, SQLite or revisions: it takes a string and a target
// path and returns where it wrote. src/server/notes.ts owns when that happens and
// what the file is called.
//
// The seam exists so the engine choice is configuration rather than a rewrite.
// `say` ships first because it is already on the machine and needs no dependency;
// a neural backend (kokoro-js was proven to load under Bun) drops in behind the
// same three-field result without anything above this module noticing.
// This file is the REGISTRY. The seam itself — the two shapes and the error —
// is ./seam.ts, which imports nothing, so the graph runs one way:
// seam <- each backend <- here. It was all in this file until a value import of
// `SpeechError` from ./kokoro.ts closed the loop; ./seam.ts says what that cost.
import { kokoroBackend } from "./kokoro.ts";
import { sayBackend } from "./say.ts";
import { SpeechError } from "./seam.ts";
import type { SpeechBackend, SpeechResult } from "./seam.ts";

// Re-exported so `src/speech` stays the one import path for everything about
// speech: no caller outside this directory names ./seam.ts.
export { SpeechError };
export type { SpeechBackend, SpeechResult };

/** Every backend that exists, by the name `AGENT_COOP_VOICE` accepts. */
export const BACKENDS: Record<string, SpeechBackend> = {
  kokoro: kokoroBackend,
  say: sayBackend,
};

/**
 * Kokoro, not `say`.
 *
 * Decided by listening (../notes/research/local-tts-for-turn-notes.md): `say` is a
 * technology generation behind, and one of the voices it advertises is not even
 * installed. Kokoro is Apache 2.0, renders at 0.4x real time, carries no
 * watermark, and is the only engine evaluated that runs IN PROCESS under Bun.
 * That last point is why it wins over the better-sounding options: every one of
 * those needs a Python runtime, and agent-coop is a single-writer process that has
 * never had a second one.
 */
export const DEFAULT_BACKEND = "kokoro";

/**
 * The backend `AGENT_COOP_VOICE` names, or the default.
 *
 * An unknown name THROWS rather than falling back. A typo that silently gave you
 * the default would be discovered as "why does this still sound like the old
 * voice", which is a question the machine can answer and the human cannot.
 */
export function backendFor(name: string | undefined = process.env.AGENT_COOP_VOICE): SpeechBackend {
  const chosen = name === undefined || name === "" ? DEFAULT_BACKEND : name;
  const backend = BACKENDS[chosen];
  if (backend === undefined) {
    throw new SpeechError(
      `unknown AGENT_COOP_VOICE ${JSON.stringify(chosen)}; known backends: ${Object.keys(BACKENDS).join(", ")}`,
    );
  }
  return backend;
}

/**
 * Narration text -> an audio file at `outPath`.
 *
 * Empty text is refused rather than producing a silent file: a play control that
 * plays nothing is worse than one that says why it cannot.
 */
export async function synthesize(
  text: string,
  outPath: string,
  backend: SpeechBackend = backendFor(),
): Promise<SpeechResult> {
  if (text.trim() === "") throw new SpeechError("nothing to speak: the narration is empty");
  if (!(await backend.available())) {
    throw new SpeechError(`speech backend ${backend.name} is not available on this machine`);
  }
  return backend.synthesize(text, outPath);
}
