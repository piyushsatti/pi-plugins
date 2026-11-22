// The `say` backend: macOS's built-in speech synthesiser. Zero install, and on a
// machine with a Premium voice downloaded it is genuinely good.
//
// Three things here are measured rather than assumed, and each one was wrong the
// obvious way first:
//
//   FORMAT. `say -o out.m4a` alone writes uncompressed LPCM into a file named
//   .m4a — the container is inferred from the extension, the CODEC is not. The
//   result is ~10x larger and iPhone Safari will not play it. Both flags are
//   mandatory; neither is cosmetic.
//
//   THE TEXT GOES IN A FILE. A note is capped at MAX_TEXT_LEN (65_536 chars),
//   which is far past what any platform accepts as a single argv entry. `-f`
//   takes it from a file instead. Nothing is ever passed through a shell:
//   Bun.spawn takes an array, so quoting is not a concern that exists here.
//
//   THE VOICE. macOS ships a roster of old concatenative voices and downloads the
//   good ones on demand, so the default voice on a given machine may be either.
//   `preferredVoice` picks the best INSTALLED one rather than naming a favourite
//   that may not be there — asking for an absent voice does not fail, it silently
//   falls back, which is the failure mode that hides a bad default.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeechBackend, SpeechResult } from "./seam.ts";

/** AAC in an MP4 container: the pair iPhone Safari plays from an <audio> tag. */
export const SAY_FORMAT_ARGS = ["--data-format=aac", "--file-format=m4af"] as const;
export const SAY_MIME = "audio/mp4";

/**
 * Voices worth using, best first, checked against what is actually installed.
 *
 * Premium is Apple's quality tier, not a price tier — these are free downloads
 * that simply are not present by default. The list is a PREFERENCE, never a
 * requirement: an empty intersection means the system default, which always
 * works and merely sounds older.
 */
export const PREFERRED_VOICES = ["Ava (Premium)", "Zoe (Premium)", "Ava", "Allison", "Samantha"];

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, stdout, stderr };
}

/**
 * Voice names `say` knows about, from `say -v '?'`.
 *
 * The listing is `Name<pad>lang_REGION<pad># sample sentence`, and the NAME is
 * the hard part: it can contain spaces and nested brackets ("Ava (Premium)",
 * "Eddy (English (US))"). Two rules were tried and both are wrong:
 *
 *   split on whitespace      truncates every multi-word name to its first word,
 *                            so nothing matches anything installed.
 *   split on a two-space gap the columns are PADDED, not delimited — a name long
 *                            enough eats its own padding, and
 *                            "Eddy (English (US)) en_US" has exactly one space
 *                            in it. This is the bug a test caught.
 *
 * So the anchor is the language tag, which has a shape nothing else on the line
 * does. Everything before it is the name, brackets and all.
 */
const VOICE_LINE = /^(.*?)\s+([a-z]{2,3}[_-][A-Za-z]{2,})(?:\s|$)/;

export function parseVoices(listing: string): string[] {
  return listing
    .split("\n")
    .map((line) => VOICE_LINE.exec(line)?.[1]?.trim() ?? "")
    .filter((name) => name !== "");
}

/** The first preferred voice that is installed, or null for the system default. */
export function pickVoice(installed: string[], preferred: string[] = PREFERRED_VOICES): string | null {
  const have = new Set(installed);
  return preferred.find((v) => have.has(v)) ?? null;
}

/** `AGENT_COOP_SAY_VOICE` wins outright, including over "is it installed" — naming a
 *  voice explicitly is a decision, and second-guessing it would hide a typo. */
export async function preferredVoice(): Promise<string | null> {
  const named = process.env.AGENT_COOP_SAY_VOICE;
  if (named !== undefined && named !== "") return named;
  const listing = await run(["say", "-v", "?"]);
  return listing.ok ? pickVoice(parseVoices(listing.stdout)) : null;
}

/** Playing time from `afinfo`, which reports it as "estimated duration: N sec".
 *  Zero when it cannot be read: a missing duration costs the UI a label, and is
 *  never a reason to throw away audio that rendered fine. */
export function parseDurationMs(afinfoOutput: string): number {
  const m = /estimated duration:\s*([\d.]+)\s*sec/i.exec(afinfoOutput);
  return m === null ? 0 : Math.round(Number.parseFloat(m[1]!) * 1000);
}

export const sayBackend: SpeechBackend = {
  name: "say",
  ext: ".m4a",
  mime: SAY_MIME,

  async available(): Promise<boolean> {
    return (await run(["/usr/bin/which", "say"])).ok;
  },

  async synthesize(text: string, outPath: string): Promise<SpeechResult> {
    const dir = await mkdtemp(join(tmpdir(), "agent-coop-say-"));
    const input = join(dir, "narration.txt");
    try {
      await writeFile(input, text, "utf8");
      const voice = await preferredVoice();
      const cmd = [
        "say",
        ...(voice === null ? [] : ["-v", voice]),
        "-o",
        outPath,
        ...SAY_FORMAT_ARGS,
        "-f",
        input,
      ];
      const result = await run(cmd);
      if (!result.ok) {
        throw new Error(`say failed: ${result.stderr.trim() || "no output"}`);
      }
      const info = await run(["afinfo", outPath]);
      return {
        path: outPath,
        mime: SAY_MIME,
        duration_ms: info.ok ? parseDurationMs(info.stdout) : 0,
      };
    } finally {
      // The narration is already stored in the database; this copy exists only
      // for the length of one spawn.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
};
