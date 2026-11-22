// Kokoro-82M through kokoro-js. The default backend (src/speech/index.ts).
//
// The only engine evaluated that runs IN PROCESS: no Python, no subprocess, no
// second runtime for the single-writer server to supervise. Everything that
// sounded better than this needed a Python interpreter, which is a boundary
// agent-coop does not have and will not gain by accident
// (../notes/research/local-tts-for-turn-notes.md, R6).
//
// It writes WAV, not AAC. Converting would mean shelling out to `afconvert`,
// which would put the macOS-only dependency back that moving off `say` removed.
// A 30-second note is about 1.4 MB as WAV against 130 KB as AAC; over a tailnet
// to a phone that is still nothing, and every browser plays WAV from an <audio>
// tag. If that trade ever stops holding, it changes here and nowhere else.
import { encodePcm16Wav } from "../audio/wav.ts";
import { SpeechError, type SpeechBackend, type SpeechResult } from "./seam.ts";

/**
 * af_heart, chosen by listening rather than by grade.
 *
 * Kokoro publishes a grade per voice that tracks hours of training data, and
 * af_heart is the only A. It was also the pick on the five-sentence ladder,
 * including the two sentences carrying function names, which is the test that
 * separated these engines.
 */
export const KOKORO_VOICE = "af_heart";

/** The ONNX build. `q8` was measured at 0.4x real time; the unquantised build
 *  is larger and was not faster on this machine. */
export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_DTYPE = "q8";

export const KOKORO_EXT = ".wav";
export const KOKORO_MIME = "audio/wav";

/**
 * The model is loaded ONCE and reused.
 *
 * Loading costs a few hundred milliseconds and a few hundred megabytes, and a
 * note can arrive at any time, so paying that per render would dominate the
 * render itself. Held as a promise rather than an instance so two notes
 * arriving together share one load instead of racing two.
 */
let loading: Promise<KokoroLike> | null = null;

/** The slice of kokoro-js this module uses. Declared here rather than imported
 *  as a type so the dependency stays a runtime one: nothing typechecks against
 *  kokoro-js, so a missing install is a clear runtime refusal from
 *  `available()` rather than a compile error in an unrelated file. */
type KokoroLike = {
  generate(text: string, opts: { voice: string }): Promise<{
    audio: Float32Array;
    sampling_rate: number;
  }>;
};

// The WAV encoder itself lives in src/audio/wav.ts now (encodePcm16Wav,
// imported above). It moved out once src/transcribe needed the identical
// header to frame captured microphone samples for whisper: at that point two
// backends were each reaching for a WAV header, and a shared function belongs
// in one place rather than being kept here for a second consumer to reach
// across this sibling directory for. The tag-1-vs-tag-3 reasoning and the
// clamp both moved with it; read them there.

async function load(): Promise<KokoroLike> {
  loading ??= (async () => {
    const { KokoroTTS } = await import("kokoro-js");
    return (await KokoroTTS.from_pretrained(KOKORO_MODEL, {
      dtype: KOKORO_DTYPE,
      device: "cpu",
    })) as unknown as KokoroLike;
  })();
  return loading;
}

/** Reset the cached model. Tests only; production loads once per process. */
export function resetKokoro(): void {
  loading = null;
}

export const kokoroBackend: SpeechBackend = {
  name: "kokoro",
  ext: KOKORO_EXT,
  mime: KOKORO_MIME,

  /**
   * True when kokoro-js resolves. It is a real dependency in package.json, so
   * this is false only when node_modules is incomplete, which is exactly the
   * case worth reporting by name instead of as an import crash inside a render
   * nobody is positioned to catch (src/server/notes.ts never throws).
   */
  async available(): Promise<boolean> {
    try {
      await import("kokoro-js");
      return true;
    } catch {
      return false;
    }
  },

  async synthesize(text: string, outPath: string): Promise<SpeechResult> {
    const tts = await load();
    const audio = await tts.generate(text, { voice: KOKORO_VOICE });
    const rate = audio.sampling_rate;
    // Checked BEFORE the file is written, not after: the rate goes into the WAV
    // header, so a bad one produces a file that plays at the wrong speed rather
    // than one that fails to play. A wrong answer is worse than no answer here.
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new SpeechError(`kokoro returned an unusable sampling rate ${String(rate)}`);
    }
    await Bun.write(outPath, encodePcm16Wav(audio.audio, rate));
    const samples = audio.audio.length;
    return {
      path: outPath,
      mime: KOKORO_MIME,
      // Measured from the samples, never guessed from the word count: the
      // duration is what the UI shows before anyone presses play.
      duration_ms: Math.round((samples / rate) * 1000),
    };
  },
};
