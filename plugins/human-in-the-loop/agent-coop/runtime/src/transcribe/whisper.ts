// whisper.cpp, via `whisper-cli`, spawned as a subprocess.
//
// THIS WHOLE FILE IS TEMPORARY. Say so here because unmarked scaffolding
// becomes permanent by being forgotten. Speech is becoming a separate HTTP
// service (decided 2026-08-15, CLAUDE.md), the engine and its models moving
// out of this repo entirely, and speech IN answers the same question speech
// OUT already does: see src/speech/index.ts's header for the argument in
// full. Expect this file to be replaced by an HTTP call to that service.
// What makes that a SWAP rather than a rewrite is ./seam.ts: `transcribe()`
// takes samples in and text out no matter which side of a network call
// answers, so nothing above src/transcribe/ changes when this file goes away.
//
// Numbers below are MEASURED on the machine this was built on, not assumed:
// 20.8 seconds of speech transcribes in 0.98s wall including
// model load, using ggml-large-v3-turbo-q5_0 with Silero VAD and non-speech-
// token suppression. Cold page cache cost 7.91s against 0.33s warm, hence
// `warm()` below.
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeInt16Wav } from "../audio/wav.ts";
// The layout rule only, called lazily. See defaultDataDir below for why this
// import is not the thing the NARRATION_DIR lesson warns about.
import { containerPath } from "../server/paths.ts";
import { TranscribeError, type TranscribeBackend, type TranscriptResult } from "./seam.ts";

/**
 * Every path below is resolved through a FUNCTION, read fresh on every call,
 * never a module-level constant computed once at import time. Two separate
 * reasons force that, not one:
 *
 *   - src/transcribe must not depend on src/server (server depends on
 *     transcribe, never the reverse). This file used to import `DATA_DIR`
 *     from src/server/paths.ts and build these paths from it at module load,
 *     which meant merely IMPORTING anything in src/transcribe ran that
 *     module's own container-layout resolution as a side effect, `bun test`
 *     included. CLAUDE.md already records the identical shape of defect for
 *     `NARRATION_DIR` (src/server/notes.ts reading the module constant
 *     directly instead of taking a directory from its caller): a value
 *     resolved the moment a module loads instead of the moment it is
 *     actually needed. This is that fix applied one layer earlier, by
 *     removing the cross-directory import outright rather than deferring it.
 *   - tests/transcribe/test_whisper.test.ts drives this backend with a
 *     different stub binary per test case, all in the same `bun test`
 *     process. A module-level constant is computed once, on whichever test
 *     file happens to import this module first, and every later test's
 *     `process.env.AGENT_COOP_WHISPER_BIN` change would be talking to a value
 *     already frozen from the first import.
 */
function whisperBin(): string {
  return process.env.AGENT_COOP_WHISPER_BIN ?? "whisper-cli";
}

/**
 * Where the model files default to when neither AGENT_COOP_WHISPER_MODEL nor
 * AGENT_COOP_WHISPER_VAD names one explicitly.
 *
 * CORRECTION, and the reason this is spelled out at length. This used to hand
 * -roll the walk as `join(repoRoot, "..", "data")` on the argument that
 * src/server/paths.ts's `containerPath` was overkill here, since a wrong model
 * path only produces a named refusal rather than a split database. The
 * argument was fine and the code was wrong: one directory up is right for the
 * repo checkout and wrong for a worktree, where the container is TWO up and
 * the parent is `worktrees/`. Measured on this machine, from
 * `worktrees/turn-notes`, it looked in `worktrees/data`, found nothing, and
 * `available()` answered false with the models sitting in place. The feature
 * was entirely dead and the only symptom was a refusal that named a path
 * nobody reads.
 *
 * `containerPath` is pure, exported, and src/server/paths.ts says in as many
 * words that it is exported for callers that want the layout rule without the
 * module-load consequence. That is this caller. Calling it LAZILY is what
 * matters, and is the actual content of the NARRATION_DIR lesson in CLAUDE.md:
 * the defect there was a constant resolved at import time binding the live
 * data directory into every process, `bun test` included, not the import
 * itself. A function called per invocation binds nothing.
 */
function defaultDataDir(): string {
  return process.env.AGENT_COOP_DATA_DIR ?? containerPath(join(import.meta.dir, "..", ".."), "data", "AGENT_COOP_DATA_DIR");
}

function whisperModel(): string {
  return process.env.AGENT_COOP_WHISPER_MODEL ?? join(defaultDataDir(), "models", "ggml-large-v3-turbo-q5_0.bin");
}

function whisperVad(): string {
  return process.env.AGENT_COOP_WHISPER_VAD ?? join(defaultDataDir(), "models", "ggml-silero-v6.2.0.bin");
}

/**
 * The flags that matter, all verified working on this machine.
 *
 *   -nt    no timestamps. The wire wants a comment body, not a transcript
 *          with time codes baked into it.
 *   -np    no progress prints. stdout IS the transcript, so a progress line
 *          mixed into it would land in a comment as text.
 *   -l en  language pinned. Auto-detect is a pass this feature has no time
 *          budget for, and no other language is in scope.
 *   --vad  Silero VAD. MANDATORY, not a tuning knob: measured on this
 *          machine, five seconds of pure silence and five seconds of room
 *          tone both transcribe as real words ("you", "[BLANK_AUDIO]")
 *          without it, and as an empty string with it. An empty comment
 *          is obviously wrong, a confidently wrong one is worse.
 *   -sns   suppress non-speech tokens: coughs, breaths, [MUSIC] and similar
 *          landing as junk in the transcript.
 *
 * `-m`, `-f` and `-vm` are not in this list because each names a PATH decided
 * per call (the model, the temp WAV, the VAD model), not a fixed flag.
 */
const WHISPER_FLAGS = ["-nt", "-np", "-l", "en", "--vad", "-sns"] as const;

/**
 * 16 kHz mono: what whisper-cli reads directly (no ffmpeg needed, and none
 * may be used, it is GPL-3.0-or-later against this project's MIT) and what
 * CommentAudioSchema pins on the wire with `z.literal(16000)`
 * (src/contract/comment.ts). Not imported from a shared constant: the two
 * are not free to diverge from each other, they are both simply 16000.
 */
const SAMPLE_RATE = 16_000;

/**
 * mkdtemp's own prefix for a per-call temp directory, and the same prefix
 * `sweepStaleTempDirs` (bottom of this file) matches to find ones a PRIOR
 * process left behind. One constant, not two literals, so the two can never
 * drift apart and a sweep silently stop finding what mkdtemp actually
 * creates.
 */
const TEMP_DIR_PREFIX = "agent-coop-whisper-";

/**
 * whisper-cli's own diagnosis when it cannot decode the audio at all,
 * verified against the real binary: a 44-byte header-only WAV (zero samples)
 * exits 0, prints nothing to stdout, and prints exactly this to stderr. The
 * exit code alone says "success" in that case, so this string is the only
 * signal a total read failure ever gives, and it is checked regardless of
 * exit code for that reason, not only when `code !== 0`.
 */
const WHISPER_READ_FAILURE_SIGNATURE = "failed to read the frames of the audio data";

/**
 * Longest error string this backend will construct from whisper-cli's
 * stderr. A genuine crash (a corrupt model file, an out-of-memory kill) dumps
 * a full native backtrace to stderr, sometimes tens of thousands of
 * characters, and src/server/routes/write.ts sends a TranscribeError's whole
 * message to the browser as the reason a comment failed. A backtrace is not
 * a message anyone asked to read; `summarizeStderr` below keeps whisper-cli's
 * own first line, which is where its diagnosis lives, and drops the rest.
 */
const STDERR_SUMMARY_MAX = 500;

/** whisper-cli's own diagnosis is always its first line of stderr; everything
 *  after that in a real crash is a backtrace. Caps the kept line too, in case
 *  even the first line is unreasonably long. */
function summarizeStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed === "") return "no output";
  const firstLine = trimmed.split("\n", 1)[0] ?? "";
  const kept = firstLine.length > STDERR_SUMMARY_MAX ? `${firstLine.slice(0, STDERR_SUMMARY_MAX)} (line truncated)` : firstLine;
  const droppedChars = trimmed.length - firstLine.length;
  return droppedChars > 0 ? `${kept} (plus ${droppedChars} more characters from whisper-cli, dropped)` : kept;
}

/**
 * Grace period between the first, polite signal an abort sends and the one
 * that cannot be refused. Verified against a real stub that installs its own
 * SIGTERM handler and never exits: without escalation, the child, the temp
 * WAV, and this call's own promise were all still there at 25 seconds,
 * unbounded, because `finally` cannot run while `run()` has not returned.
 * SIGKILL cannot be caught, blocked, or ignored on POSIX, so it is the only
 * signal this file can rely on to actually end a process that chooses not to
 * cooperate. Two seconds is generous for a well-behaved process to unwind
 * (flush output, remove its own files) and still small next to
 * TRANSCRIBE_TIMEOUT_MS (30 seconds, src/server/context.ts; not imported
 * here, see this file's own header on why src/transcribe never depends on
 * src/server), so escalating never becomes the slow part of an
 * already-bounded call.
 */
const ABORT_KILL_GRACE_MS = 2_000;

/**
 * How much longer `run()` below waits for stdout/stderr to reach EOF once
 * the process it spawned has already exited, before giving up on them. Not
 * zero: an exited process's own output is already sitting in the kernel
 * pipe buffer, so draining the rest takes microseconds, not milliseconds.
 * Not unbounded: nothing legitimate keeps a pipe open after the process
 * that owned it is gone. Verified against a real stub whose grandchild
 * inherited the output descriptors without redirecting them away: the
 * equivalent of the old unbounded `new Response(stream).text()` stayed
 * pending for 169 seconds after the direct child had already exited, ending
 * only when the orphan was killed by hand. The identical stub with the
 * grandchild's output redirected away settled in 407ms, which is why this
 * bound can be short: the mechanism is the inherited pipe, not how long real
 * transcription work takes (that time is spent BEFORE the process exits,
 * which this bound does not touch).
 */
const PIPE_DRAIN_GRACE_MS = 500;

type KillSignal = "SIGTERM" | "SIGKILL";

/**
 * Signals the whole process group `proc` leads, not merely `proc` itself.
 * `run()` below spawns with `detached: true` (POSIX `setsid()`), which makes
 * `proc.pid` the group id too, so `-proc.pid` reaches every process in it.
 * whisper-cli itself spawns nothing today, but a wrapper script easily
 * could, and before this fix, whatever it spawned inherited the group and
 * never received a signal at all, no matter how the direct child was
 * killed: only `proc.kill()` ran. Falls back to signalling just the direct
 * child when group semantics are unavailable (Windows has no negative-pid
 * convention) or refused (a permission error): a partial kill still beats
 * none.
 */
function killGroup(proc: { pid: number; kill(signal?: number | KillSignal): void }, sig: KillSignal): void {
  try {
    process.kill(-proc.pid, sig);
  } catch {
    try {
      proc.kill(sig);
    } catch {
      // Already gone; nothing left to signal.
    }
  }
}

/**
 * Wires an abort to `proc`: SIGTERM immediately, SIGKILL ABORT_KILL_GRACE_MS
 * later if the group is still around. Returns a disposer `run()` must call
 * once it is done with `proc`, however the call ended, so a run that
 * finishes on its own before any abort does not leave a timer or listener
 * behind.
 *
 * Bun's own `signal` spawn option was deliberately not used for this: it
 * sends exactly one killSignal to the direct child alone, with no
 * escalation, which is DEFECT 1 (no escalation) and half of DEFECT 3 (child
 * only, never the group) in a single setting. Owning the wiring here is
 * what makes both fixable.
 */
function wireAbort(
  proc: { pid: number; kill(signal?: number | KillSignal): void },
  signal: AbortSignal | undefined,
): () => void {
  if (signal === undefined) return () => {};
  let escalateTimer: ReturnType<typeof setTimeout> | undefined;
  function onAbort() {
    killGroup(proc, "SIGTERM");
    escalateTimer = setTimeout(() => killGroup(proc, "SIGKILL"), ABORT_KILL_GRACE_MS);
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
    if (escalateTimer !== undefined) clearTimeout(escalateTimer);
  };
}

/**
 * Reads `stream` to completion, UNLESS `giveUpAfter` resolves first, in
 * which case it stops waiting and returns whatever was already read.
 *
 * This is DEFECT 2's fix: the old code awaited `new Response(proc.stdout).text()`
 * directly, which waits for the pipe's WRITE END to close, not for the
 * process this file actually cares about to exit. A descendant that
 * inherited the same descriptor kept that promise pending long after the
 * tracked process was already gone (see PIPE_DRAIN_GRACE_MS above for the
 * measured repro). `drained: false` on the way out is also DEFECT 3's
 * "report it" signal: a pipe still open past `giveUpAfter` IS a
 * still-alive descendant, detected without this file ever needing to know
 * its pid.
 */
async function drainWithDeadline(
  stream: ReadableStream<Uint8Array> | null,
  giveUpAfter: Promise<unknown>,
): Promise<{ text: string; drained: boolean }> {
  if (stream === null) return { text: "", drained: true };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const giveUp = giveUpAfter.then(() => "give-up" as const);
  let text = "";
  try {
    while (true) {
      const next = await Promise.race([reader.read(), giveUp]);
      if (next === "give-up") return { text, drained: false };
      if (next.done) return { text, drained: true };
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    // Releases this function's OWN reader lock, so at least this side is
    // not holding the stream open on the way out. This cannot force
    // whatever else has the pipe's write end to let go, only stop this
    // function waiting on it.
    reader.cancel().catch(() => {});
  }
}

async function run(
  cmd: string[],
  signal: AbortSignal | undefined,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", detached: true });
  const disposeAbortWiring = wireAbort(proc, signal);
  try {
    // Not gated on `signal`: even an un-aborted, normally-completing call
    // must not hang forever on a pipe a descendant is holding open (DEFECT
    // 2), so this deadline is unconditional, derived only from the tracked
    // process's own exit.
    const giveUpAfter = proc.exited.then(() => Bun.sleep(PIPE_DRAIN_GRACE_MS));
    const [stdoutResult, stderrResult] = await Promise.all([
      drainWithDeadline(proc.stdout, giveUpAfter),
      drainWithDeadline(proc.stderr, giveUpAfter),
    ]);
    // Already settled by the time both drains above have: `giveUpAfter`
    // itself is derived from `proc.exited`, so this read is instant.
    const code = await proc.exited;
    if (!stdoutResult.drained || !stderrResult.drained) {
      // DEFECT 3's "report it": `proc` is confirmed dead by this point, so
      // a pipe still open PIPE_DRAIN_GRACE_MS later can only mean something
      // ELSE still holds it, a descendant this file never had a handle to
      // and therefore never signalled even after the group kill above.
      // There is no general, portable way from here to find or kill that
      // process; reporting it is what stops the gap being silent instead of
      // what closes it.
      console.error(
        `agent-coop-whisper: ${cmd[0]} (pid ${proc.pid}) exited but its output pipe did not close within ` +
          `${PIPE_DRAIN_GRACE_MS}ms of it doing so; a descendant is likely still running and holding it open.`,
      );
    }
    return { ok: code === 0, stdout: stdoutResult.text, stderr: stderrResult.text };
  } finally {
    disposeAbortWiring();
  }
}

/** A bare command name resolves against PATH, a path someone set explicitly
 *  via AGENT_COOP_WHISPER_BIN is checked directly. The same distinction the `which`
 *  command itself makes. */
async function binaryFound(): Promise<boolean> {
  const bin = whisperBin();
  if (bin.includes("/")) return Bun.file(bin).exists();
  return Bun.which(bin) !== null;
}

/**
 * Why `available()` is false, or null when whisper-cli and both models are
 * present. A string here rather than a bare boolean is what makes the
 * refusal REPORTABLE, matching how src/speech/kokoro.ts and src/speech/say.ts
 * both check proactively rather than letting a caller find out via a failed
 * spawn. This backend has THREE things that can be silently absent (the
 * binary, the model, the VAD model), one more than either of those, so the
 * check has three steps instead of one.
 */
async function unavailableReason(): Promise<string | null> {
  if (!(await binaryFound())) return `whisper-cli not found (AGENT_COOP_WHISPER_BIN=${whisperBin()})`;
  const model = whisperModel();
  if (!(await Bun.file(model).exists())) return `whisper model missing: ${model}`;
  const vad = whisperVad();
  if (!(await Bun.file(vad).exists())) return `whisper VAD model missing: ${vad}`;
  return null;
}

export const whisperBackend: TranscribeBackend = {
  name: "whisper",

  async available(): Promise<boolean> {
    return (await unavailableReason()) === null;
  },

  /** Removes `agent-coop-whisper-*` directories a previous process left behind. See
   *  `sweepStaleTempDirs` at the bottom of this file for what "stale" means
   *  and why the age bound is what it is. */
  async sweep(): Promise<string[]> {
    return sweepStaleTempDirs();
  },

  async transcribe(
    pcm: Int16Array,
    sampleRate: number,
    opts?: { signal?: AbortSignal },
  ): Promise<TranscriptResult> {
    const reason = await unavailableReason();
    if (reason !== null) throw new TranscribeError(reason);

    // CommentAudioSchema already pins 16000 on the wire, so nothing arriving
    // over HTTP can reach this. It is checked anyway because a backend is
    // callable from anywhere, the boot warm-up included, and the failure it
    // guards is silent rather than loud: whisper-cli reads the rate out of the
    // WAV header this file writes, so a wrong rate is a transcript of speech
    // played at the wrong speed, not an error anyone would trace back here.
    if (sampleRate !== SAMPLE_RATE) {
      throw new TranscribeError(`whisper needs ${SAMPLE_RATE} Hz audio, got ${sampleRate}`);
    }

    // Refuse before spawning rather than let whisper-cli discover it: a
    // header-only WAV (zero samples) is exactly the input that produces the
    // exit-0 silent-failure this file otherwise has to detect after the
    // fact (WHISPER_READ_FAILURE_SIGNATURE below). Catching it here also
    // means no temp file and no subprocess are created for input that was
    // never going to transcribe to anything.
    if (pcm.length === 0) throw new TranscribeError("no audio samples to transcribe");

    const dir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
    const wavPath = join(dir, "capture.wav");
    const started = performance.now();
    try {
      await Bun.write(wavPath, encodeInt16Wav(pcm, sampleRate));
      const result = await run(
        [
          whisperBin(),
          "-m",
          whisperModel(),
          "-f",
          wavPath,
          ...WHISPER_FLAGS,
          "-vm",
          whisperVad(),
        ],
        opts?.signal,
      );
      // Checked before `result.ok`, and regardless of it: `controller.abort()`
      // sets this synchronously the moment it is called, so if it is set here
      // the caller gave up on this call, and whatever `run` returned (a kill
      // can still leave `code` looking like anything) is not a result to
      // report as either a transcript or a whisper-cli failure. It is an
      // abort, the one outcome this `finally` below still cleans up after,
      // same as every other path.
      if (opts?.signal?.aborted === true) {
        throw new TranscribeError("transcription aborted");
      }
      if (result.stderr.includes(WHISPER_READ_FAILURE_SIGNATURE)) {
        throw new TranscribeError(`whisper-cli could not read the audio: ${summarizeStderr(result.stderr)}`);
      }
      if (!result.ok) {
        throw new TranscribeError(`whisper-cli failed: ${summarizeStderr(result.stderr)}`);
      }
      // whisper-cli with -nt still emits a leading space (its own token-join
      // convention) and a trailing newline, neither belongs in a comment body.
      return { text: result.stdout.trim(), ms: Math.round(performance.now() - started) };
    } finally {
      // This is the user's VOICE, and the feature promised not to keep it
      // (CLAUDE.md's voice-input gotcha, which is where that promise is
      // written, and the header on ./seam.ts; NOT the attachment dispatcher
      // rule, which CLAUDE.md says is a separate surface and no evidence
      // about this one). The WAV
      // above is the only durable trace it ever had. Deleting it here matters
      // more than the equivalent cleanup in src/speech/say.ts, which only
      // ever discards a copy of TEXT already committed safely elsewhere. This
      // runs in `finally` so every path out of this function, success,
      // whisper-cli failure, or an abort via `opts.signal`, cleans up the
      // same way. Before `opts.signal` existed, this `finally` still ran
      // eventually, but only once an abandoned call resolved on its own
      // schedule: the timeout race that used to live in
      // src/server/routes/write.ts discarded the result without ever asking
      // the call to stop, so a whisper-cli that was merely slow leaked its
      // temp file and subprocess for however long it took to finish, and one
      // that was genuinely wedged never reached this line at all. Asking is
      // what `opts.signal` adds.
      //
      // What "asking" actually guarantees changed with `run()` above.
      // Asking used to mean "send SIGTERM and wait": that only reaches this
      // `finally` at all if the child actually honours SIGTERM, and a real
      // stub that installs its own handler and ignores it proved this line
      // could go unreached indefinitely (25 seconds and still alive, the
      // WAV still on disk, this `finally` still waiting). `run()` now
      // escalates to SIGKILL after a bounded grace period, which cannot be
      // caught or ignored, so this `finally` is now guaranteed to run for
      // the DIRECT child within ABORT_KILL_GRACE_MS of an abort, whether or
      // not that child cooperates. It is NOT a guarantee about every
      // descendant: one that escaped the process group entirely (rather
      // than merely inheriting it) is outside what a group signal can
      // reach, and `run()` reports that case (a pipe still open after the
      // tracked process has exited) rather than claiming it too.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
};

/**
 * There is deliberately no `warm()` here.
 *
 * There was one, exported and bounded by its own timeout, and it never had a
 * production caller: `serve()`'s boot warm-up (`warmTranscribeOnBoot`,
 * src/server/index.ts) calls `backend.transcribe(...)` against the generic
 * TranscribeBackend it was handed, so that injecting a fake backend warms the
 * fake rather than silently spawning this one. That is the correct shape, and
 * it left this file's `warm()` as a second entry point doing the same job for
 * one backend only.
 *
 * Warming a model is not whisper-specific, and the bound on it belongs beside
 * the request bound it is a sibling of, so both now live at the boot site:
 * WARM_TIMEOUT_MS in src/server/context.ts, applied through the `signal` this
 * backend already honors. Silence is a safe warm-up input only because VAD is
 * on, see WHISPER_FLAGS above, so a warm run reliably gets back an empty
 * transcript rather than a hallucinated one.
 */

/**
 * How old a `agent-coop-whisper-*` directory must be before `sweepStaleTempDirs`
 * below will remove it unasked. Ten times TRANSCRIBE_TIMEOUT_MS (30 seconds,
 * src/server/context.ts, not imported here for the same cross-directory
 * reason as ABORT_KILL_GRACE_MS above): no legitimate transcription in this
 * codebase, `warm()`'s own call included, can still be using its temp
 * directory past that bound, whichever process started it, so anything
 * older is unambiguously a leak and never a directory a SIBLING agent-coop server
 * is actively reading from. That second case is not hypothetical: this
 * project's own worktree-first workflow means more than one `bun run dev`
 * can be live on the same machine, sharing the same OS temp directory, at
 * once.
 */
const STALE_TEMP_DIR_AGE_MS = 10 * 30_000;

/**
 * Deletes every `agent-coop-whisper-*` directory under `baseDir` that is older
 * than STALE_TEMP_DIR_AGE_MS. Exists because this file's own `finally` (the
 * one place a temp WAV is normally deleted) cannot run when the WHOLE agent-coop
 * process is killed before it gets the chance to, which no per-call fix in
 * `run()` above can reach: the found case was a server killed mid-warm-up,
 * leaving behind exactly `warm()`'s own silent buffer (1600 samples, a
 * 44-byte WAV header, 3244 bytes). mkdtemp already gives every call a
 * uniquely named directory, so nothing here can collide with one THIS
 * process is about to create; the age check is what stops it colliding with
 * one a DIFFERENT, still-running process created moments ago (see
 * STALE_TEMP_DIR_AGE_MS above).
 *
 * `baseDir` defaults to the real OS temp directory, for whoever wires this
 * into a boot sequence. Best-effort throughout: a directory listing that
 * fails, or one entry that cannot be removed, never throws past this
 * function. A sweep is a nicety a caller should never have to handle
 * failing.
 *
 * DECIDED, NOT WIRED IN: this function is deliberately not called from
 * anywhere else in this file. `warm()` above has no production caller
 * itself (see its own comment), and the actual boot entry point
 * (`options.warmTranscribeOnBoot` in src/server/index.ts) is outside this
 * task's file scope (src/transcribe/ only). Calling this automatically from
 * `transcribe()` or `warm()` was considered and rejected for a sharper
 * reason than scope: it would run for real, against the real OS temp
 * directory, the moment `bun test` or any manual run of this backend
 * executes in a session that still has an old `agent-coop-whisper-*` directory
 * sitting there, deleting it as a side effect of running tests rather than
 * of anything resembling a boot. A fixed, reused directory for `warm()`
 * specifically (the other option raised) was rejected too: it would not
 * have prevented the leak that was actually found (a hard kill leaves a
 * file behind whether its directory name is fixed or random), and it would
 * do nothing for a REAL transcription killed the same way, only for
 * a warm-up's own leak. A general sweep, run once at boot, covers both.
 *
 * It is reached through the backend's optional `sweep` (see the seam) rather
 * than imported directly by the boot sequence, so that a backend keeping no
 * local files simply does not implement it and the caller does not have to
 * know which kind it was given.
 */
export async function sweepStaleTempDirs(baseDir: string = tmpdir()): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - STALE_TEMP_DIR_AGE_MS;
  const swept: string[] = [];
  for (const name of entries) {
    if (!name.startsWith(TEMP_DIR_PREFIX)) continue;
    const path = join(baseDir, name);
    try {
      const info = await stat(path);
      if (info.mtimeMs > cutoff) continue; // young enough to still be live
      await rm(path, { recursive: true, force: true });
      swept.push(name);
    } catch {
      // Gone already, a permission problem, or a race with whoever owns
      // it; leave it for the next boot to try again.
    }
  }
  return swept;
}
