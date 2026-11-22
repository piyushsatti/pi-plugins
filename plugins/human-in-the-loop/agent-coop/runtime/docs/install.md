# Install

- Two commands after a clone: `bun install`, then `bun run scripts/up.ts`. The
  server builds the web bundle itself before it opens the socket.
- **Runtime state lives outside the repo.** `data/`, `artifacts/` and `history/`
  are created as *siblings* of the repo directory, not inside it. Clone
  accordingly.
- Claude Code is required for the half of agent-coop that makes Claude act. The web UI
  alone works without it, but nothing will answer your submits.
- First Claude Code session in this repo prompts you to approve `.mcp.json`.
  Decline it and the `agent_coop_*` tools are absent.

## Prerequisites

| Thing | Why | Check |
|---|---|---|
| Bun 1.3 or newer | the only runtime; `bun.lock` is a Bun 1.3-format lockfile (`configVersion`) | `bun --version` |
| Claude Code | hosts the `agent_coop_*` MCP tools, the `/agent-coop` skill, and the Monitor tool that arms the waker | `claude --version` |
| macOS or Linux | the server is spawned detached (`Bun.spawn`, `detached: true`, `scripts/up.ts`); nothing is tested on Windows | |
| git | to clone | |
| Tailscale | optional, only to reach the UI from a phone. See [phone.md](phone.md) | |

No database to install: SQLite is built into Bun. Voice input for comments needs
`whisper-cli` and two model files, all three optional (see below); without them
typed comments still work.

## Voice input for comments

The user speaks a comment instead of typing it, in any of the three places a
text comment can be given. Audio rides with the submit and is transcribed on
the server before anything is appended to the log; the recording itself is
never persisted. This feature has a hard requirement: `whisper-cli`
(whisper.cpp) plus two model files. Without them the feature refuses by name;
typed comments are unaffected.

```
brew install whisper-cpp
```

Two model files, which go in `<data>/models/` by default (see
[Where agent-coop puts its files](#where-agent-coop-puts-its-files) above for what
`<data>` resolves to):

| File | Size | From |
|---|---|---|
| `ggml-large-v3-turbo-q5_0.bin` | 574 MB | [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) |
| `ggml-silero-v6.2.0.bin` | 885 KB | [huggingface.co/ggml-org/whisper-vad](https://huggingface.co/ggml-org/whisper-vad) |

Four environment variables, all optional (`src/transcribe/whisper.ts` and
`src/transcribe/index.ts` are the source of truth for names and defaults):

| Variable | Overrides | Default |
|---|---|---|
| `AGENT_COOP_WHISPER_BIN` | the `whisper-cli` binary | `whisper-cli` resolved against `PATH` |
| `AGENT_COOP_WHISPER_MODEL` | the whisper model path | `<data>/models/ggml-large-v3-turbo-q5_0.bin` |
| `AGENT_COOP_WHISPER_VAD` | the Silero VAD model path | `<data>/models/ggml-silero-v6.2.0.bin` |
| `AGENT_COOP_TRANSCRIBE` | which transcribe backend runs | `whisper`, the only one that exists |

Missing binary or either model file is a named refusal (`transcribe_failed`),
never a silent fallback.

## Clone and install

```
git clone <this repo> agent-coop
cd agent-coop
bun install
```

`bun install` pulls Yjs, zod, markdown-it, mermaid, CodeMirror, the MCP SDK and
esbuild (`package.json`). Nothing is vendored and nothing is fetched at runtime.

## Where agent-coop puts its files

Agent Coop keeps no runtime state inside the repo. Three directories sit **beside**
the repo directory, and `src/server/paths.ts` is the one place that decides
where.

```
<container>/
  agent-coop/            the repo you cloned
  data/            agent-coop.sqlite, server.log
    narration/     turn-note audio, a cache
  artifacts/       exports land here
  history/         database backups, capped at MAX_BACKUPS
```

| Directory | Constant | Override |
|---|---|---|
| `data/` | `DATA_DIR`, `DB_PATH` | `AGENT_COOP_DATA_DIR`, `AGENT_COOP_DB` |
| `data/narration/` | `NARRATION_DIR` | `AGENT_COOP_NARRATION_DIR` |
| `artifacts/` | `ARTIFACTS_DIR` | `AGENT_COOP_ARTIFACTS_DIR` |
| `history/` | `BACKUP_DIR` | `AGENT_COOP_BACKUP_DIR` |

`data/narration/` is the one directory here that holds nothing you can lose.
Every file in it re-renders from `revision.narration`, so deleting it is always
safe and it is not worth backing up.

Cloning into `~/src/agent-coop` therefore creates `~/src/data`, `~/src/artifacts` and
`~/src/history`. Clone into a directory of its own if that is not what you want.

### The worktree depth rule

`containerPath` in `src/server/paths.ts` decides the depth from the **path**, not
from what happens to exist.

| Repo root looks like | Container is | Because |
|---|---|---|
| `<container>/agent-coop` | one level up | ordinary checkout |
| `<container>/worktrees/<branch>` | two levels up | a git worktree, so the repo's parent is `worktrees/` |

The rule is textual: a repo root whose parent directory is literally named
`worktrees` is treated as a worktree. It throws rather than guessing when the
layout says one depth and the only existing directory is at the other, naming
both paths and the `AGENT_COOP_*_DIR` override in the message. The alternative was
worse: an earlier version probed for the directory and fell back a level, so a
first run from a worktree created `worktrees/data` and split the database in two,
with an empty session list as the only symptom.

The constants resolve at module load, so an ambiguous layout throws on `import`
rather than on the first request that touched the database.

## Approving `.mcp.json`

`.mcp.json` registers one stdio MCP server named `agent-coop`, running
`bun run ${CLAUDE_PROJECT_DIR:-.}/src/mcp/index.ts`. Claude Code asks for
approval the first time you open a session in this repo.

- Approve it, or the ten `agent_coop_*` tools do not exist and `/agent-coop` cannot work.
- It names **no port and no URL**. The shim's `baseUrl()` reads `AGENT_COOP_URL` or
  `AGENT_COOP_PORT` from the inherited environment, or falls back to its own default
  (`src/mcp/index.ts`), so the port is written in one place.
- Run the shim with `bun run` only. `bun build --compile` breaks the MCP SDK's
  subpath imports.

The `/agent-coop` skill lives at `.claude/skills/agent-coop/SKILL.md`. A `SKILL.md` outside
`.claude/skills/` is never loaded, so it stays there.

## Choosing the narration voice

`AGENT_COOP_VOICE` names the speech backend. Nothing else about agent-coop changes with it.

| Value | Engine | Container | Needs |
|---|---|---|---|
| unset, or `kokoro` | Kokoro-82M through `kokoro-js`, voice `af_heart` | 16-bit PCM WAV | nothing; it is a dependency and runs in the server process |
| `say` | macOS `say`, best installed voice from `PREFERRED_VOICES` | AAC in MP4 | macOS |

The first render of a process downloads the Kokoro weights (about 90 MB, once)
and loads the model, so it is slower than every render after it. Renders happen
in the background and report over SSE, so a slow first one delays the audio and
never the note.

A backend is a four-field object (`name`, `ext`, `mime`, and `synthesize`)
registered in `BACKENDS` in `src/speech/index.ts`. `ext` and `mime` live on the
backend rather than above it because the container is the engine's property, not
agent-coop's: the cache filename and the `Content-Type` are both read off whichever
backend is selected. Adding a third engine is a file in `src/speech/` and a line
in that record; no route, contract, or browser code knows which one is running.

An unknown `AGENT_COOP_VOICE` is refused by name at startup rather than falling back
to the default, because a typo that silently reverted the voice would surface as
"why does this still sound like the old one".

## Verify

```
bun test
bun run scripts/up.ts
```

| Step | Expect |
|---|---|
| `bun test` | all tests pass; the suite covers contract, engine, server, mcp, scripts, skill and web |
| `bun run scripts/up.ts` | `started agent-coop`, optionally `created session s-…`, then a URL |
| open the URL | the session view, listing one document titled `Untitled` |
| `bun run scripts/dev.ts` | the same server in the foreground, with a watching rebuild of `web/dist` |

`bun test` never touches a real browser: every DOM test drives happy-dom, and a
build has shipped with a headline gesture unreachable, a save button dead after
one use, and typed text silently erased while `bun test` stayed green the whole
time. `bun run qa` (`tests/qa/render-qa.ts`) is the check that would have caught
those: a real Playwright browser against a real server, screenshotted at
1280px and 390px, asserting mermaid actually draws, the page never scrolls
sideways, and (when whisper-cli plus its ~574 MB model are on this machine)
that a recorded voice comment lands carrying its transcript. Run it after any
change that touches rendering, the comment/selection UI, voice input, or the
turn-diff/turn-note screens; its own header comment is the fuller account.
Missing the voice models is not a failure: the pass prints and counts a SKIP
naming exactly what it could not check, rather than pretending to cover ground
it didn't reach.

`up.ts` prints its result as one JSON object with `--json` (`base_url`,
`session_id`, `url`, `started`, `created`).

## When it fails

| Message | Means | Do |
|---|---|---|
| `server did not answer on http://localhost:<port>` | the spawned server died on boot | read `data/server.log`, which the error names |
| `unknown session <id>` | `--session` names an id that does not exist | drop the flag, or use one from the session list |
| `cannot create a session while agent-coop is running` | a new session was needed but the server holds the database as single writer | stop the server, or open an existing session with `--session <id>` |
| `agent-coop expected data/ at …` | the container layout is ambiguous | move the stray directory, or set `AGENT_COOP_DATA_DIR` |

Never work around these by opening `agent-coop.sqlite` yourself. The server is the only
writer; a second one corrupts the turn state machine.

## Reset

```
bun run scripts/db-reset.ts
```

It takes its path from `src/server/paths.ts`, so `AGENT_COOP_DB` names the same file
the server opens. Backups in `history/` are untouched.

---

Next: [usage.md](usage.md) for a working session, [how-it-works.md](how-it-works.md)
for what is underneath, [security.md](security.md) before exposing anything.
