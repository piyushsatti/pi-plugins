// PCM16 WAV encoding, moved here from src/speech/kokoro.ts because it now has
// TWO consumers: speech OUT (src/speech/kokoro.ts, writing a rendered
// narration) and speech IN (src/transcribe, framing captured microphone
// samples for whisper). A WAV encoder is not a fact about narration or about
// transcription specifically, it is a fact about the file format, so it
// belongs in one place rather than being reached for across a sibling
// backend that happens to have written one first.
//
// Only the HEADER is shared (writeWavHeader below), not the sample-writing
// loop. encodePcm16Wav takes Float32 samples and must clamp and scale them, a
// model can and does emit values slightly outside [-1, 1]. encodeInt16Wav
// takes samples the caller already quantised to Int16 (the browser captures
// at Int16 natively), and routing those through the float path would cost a
// conversion for no gain: there is nothing to clamp, an Int16 sample is
// already in range.

/** Header size in bytes, and the two bytes each 16-bit sample costs. */
const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

/**
 * Writes the canonical 44-byte PCM WAV header, format tag 1.
 *
 * Tag 1 is the one every decoder that has ever existed reads. `sampleCount`
 * is a count of SAMPLES, not bytes, so both callers can pass their array's
 * `.length` directly without doing the multiplication themselves twice.
 */
function writeWavHeader(view: DataView, sampleRate: number, sampleCount: number): void {
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  const dataBytes = sampleCount * BYTES_PER_SAMPLE;
  ascii(0, "RIFF");
  view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true); // everything after this field
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk length, always 16 for PCM
  view.setUint16(20, 1, true); // 1 = PCM, tag 1: the whole point of this module
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate, mono
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
}

/**
 * Mono 16-bit PCM WAV from FLOAT32 samples in [-1, 1] (speech out).
 *
 * Written by hand rather than by a library's own encoder. kokoro-js's
 * `save()` calls transformers.js's `encodeWAV`, which emits `setFloat32`
 * under format tag 3 (IEEE float). Nothing about that is wrong, and it
 * decodes fine on this machine, but format tag 1 is the one every decoder
 * that has ever existed reads, and it is HALF THE BYTES: the same fourteen
 * seconds is 1.36 MB as float and 680 KB as int16. For speech going to a
 * phone over a tailnet, int16 costs nothing audible and answers the
 * compatibility question before anyone has to ask it.
 *
 * Samples are CLAMPED before scaling. A model can and does emit values
 * slightly outside [-1, 1]; without the clamp those wrap through the int16
 * range and a loud syllable becomes a click at full amplitude.
 */
export function encodePcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new ArrayBuffer(WAV_HEADER_BYTES + samples.length * BYTES_PER_SAMPLE);
  const view = new DataView(bytes);
  writeWavHeader(view, sampleRate, samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    // Asymmetric on purpose: int16 runs -32768..32767, so the two directions
    // scale by different constants. One constant for both clips at +1.0.
    view.setInt16(WAV_HEADER_BYTES + i * BYTES_PER_SAMPLE, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(bytes);
}

/**
 * Mono 16-bit PCM WAV from samples the caller already quantised to Int16
 * (speech in, src/transcribe): the browser sends Int16 samples already, and
 * round-tripping them through encodePcm16Wav (divide by 32768 to reach
 * Float32, then multiply straight back) would lose nothing but would cost a
 * conversion neither side needs. An Int16 sample is written as-is: it is
 * already in range, so there is no clamp here.
 */
export function encodeInt16Wav(samples: Int16Array, sampleRate: number): Uint8Array {
  const bytes = new ArrayBuffer(WAV_HEADER_BYTES + samples.length * BYTES_PER_SAMPLE);
  const view = new DataView(bytes);
  writeWavHeader(view, sampleRate, samples.length);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(WAV_HEADER_BYTES + i * BYTES_PER_SAMPLE, samples[i]!, true);
  }
  return new Uint8Array(bytes);
}
