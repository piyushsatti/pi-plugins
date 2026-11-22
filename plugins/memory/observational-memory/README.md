# observational-memory

Observational memory beside compaction. As a session runs, an observer model reads the transcript and writes short, rated, timestamped observations, each citing the transcript lines behind it. A reflector distils durable reflections from them, and a dropper retires the ones that are safe to retire. After each compaction, observational-memory adds the notes to the context, after the harness's own summary. The `recall` tool returns the exact transcript lines behind any note's id.

It is a port of [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) (commit `022da5e`) to plain hooks, and replaces an earlier Claude Code mod. The model and every deviation are in [SPEC.md](SPEC.md).

## Pieces

- `bin/observational-memory` is one Python 3 script, standard library only, installed to `~/.local/bin/observational-memory` by `install.json`. Hooks and the MCP server call that installed copy.
- `hooks/claude.json`, `hooks/codex.json` and `hooks/cursor.json` are named by their manifests.
- `opencode/observational-memory.js` is an OpenCode 2 plugin (a default export with an `id` and `setup`, no dependencies), installed to `~/.config/opencode/plugins/observational-memory.js` by `install.json`, where OpenCode loads it on its own. It sends each turn's messages to `observational-memory hook opencode stop`, adds the notes to compactions through `hook opencode compacting`, and registers the `recall` tool, so OpenCode needs no MCP entry. OpenCode 1.x plugins have a different shape and are not supported.
- `.mcp.json` and `mcp.json` are identical. Each registers the server `observational-memory`, which runs `"$HOME/.local/bin/observational-memory" recall-mcp` through `sh -c`, so `$HOME` expands the same in every harness.
- `commands/` holds `/observational-memory:status`, `/observational-memory:view`, `/observational-memory:on`, `/observational-memory:off` and `/observational-memory:mode` for Claude Code and Cursor, answered by the prompt hook.
- `skills/observational-memory/` tells the agent about the notes and `recall`. In Codex it is also how the user reaches observational-memory.
- Data lives in `~/.local/state/observational-memory/`: `config.json`, and per session `<harness>/<session>.jsonl` (the ledger), `.state.json` and `.lock`, OpenCode's transcript mirrors in `opencode/transcripts/<session>.jsonl`, plus `hooks.log` and `observational-memory.log`. All of it is owner-only.

## Optional parts

Two more parts ship in this folder. Both are off until you turn them on, and observational-memory behaves the same without them.

| Part | Folder | Turn on | Does |
|---|---|---|---|
| Handoff | `handoff/`, `commands/handoff.md` | run `/observational-memory:handoff` | Before a task change or a compaction, walks every open thread with the user, then writes one handoff file per live thread. `handoff/inject.py` can reload them at the next session start; it is not registered as a hook, so wire it yourself if you want that. Settings are in `handoff/handoff.yaml`; a `handoff.yaml` in the plugin data folder overrides it. The environment variables still carry the older `SMARTCOMPACT_` prefix. |
| Record store | `store/` | install it with `store/install.json`, then add the entry in `store/mcp.json.example` to `.mcp.json` | A second MCP server, `memory`, for durable, scoped memory records with provenance: `index`, `read`, `search` and `write` (compare-and-swap). Records live in `~/.local/state/memory/`. Needs `uv` and Python 3.13. |

## Harness support

| Harness | Works | Reduced | Missing |
|---|---|---|---|
| Claude Code | Async Stop observer; PreCompact catch-up; notes after the summary through SessionStart `compact`; `/observational-memory:` commands; SubagentStop per-subagent notes (`/observational-memory:mode agents both`); `recall`; `observational-memory statusline` segment for cc-status | Notes are added after the native summary, never in its place; SessionStart waits up to 30 s for the catch-up | om.tsx's `observational-memory` mode (notes instead of the summary); the in-footer O/C/X gauges; proactive compaction |
| Codex | Verified on Codex 0.163.0 (V4, old observer command): Stop observer; PreCompact catch-up; notes after the compaction through SessionStart `compact`; `recall`; the skill | The plugin's hooks run only after you trust them in `/hooks`. There are no commands: the TUI rejects `/observational-memory:…`, and Codex lists `commands/` as skills, which run `observational-memory status --harness codex` and the like. The rollout format is unstable, so parsing may break on a Codex update | Statusline; slash commands; SubagentStop untested |
| Cursor | stop observer; preCompact catch-up; `/observational-memory:` commands through beforeSubmitPrompt; `recall`; the skill | No post-compaction hook: the notes go in on the next postToolUse, once, so a turn without a tool call gets none (untested); the transcript format is undocumented | Statusline; a reliable post-compaction injection point |
| OpenCode 2 | Turn-end observer (`session.execution.succeeded`); compaction catch-up, then the notes go **into** the compaction's input, so OpenCode's own summary carries them with their ids; `recall` as a plugin tool; reflector and dropper | The transcript is a mirror the plugin writes from `ctx.session.context`, so turns from before the plugin was installed, or from a server without it, are never observed; whether the notes survive depends on the summary model following the instruction to copy them (it did in the run on record); the observer is `claude -p` or `codex exec` when either is installed, and only otherwise OpenCode's default model through `opencode run --standalone`, where each call adds a session to OpenCode's list | Slash commands (run `observational-memory status --harness opencode`); statusline; subagent child sessions are routed by `parentID` (with `agents both`, a child's turn ends and its own compactions go to the parent's ledger, and nothing is added to the child's compaction), which is untested |

Claude Code, Codex and OpenCode ran the old observer commands end to end (V3 and V4). The 2026.10.28 observer commands are not yet re-verified at V3/V4. Cursor has not run it inside the harness yet. The dropper has not been verified inside any harness. Subagent capture, automatic compaction, Cursor injection and OpenCode restart recovery remain unverified inside the harness; the reflector has run only in OpenCode. See [VERIFIED.md](VERIFIED.md).

## Settings

Edit `~/.local/state/observational-memory/config.json`; keys left out keep their defaults (SPEC.md lists them). For example:

```json
{"model": "sonnet", "observe_after_tokens": 10000}
```

`model_command.<harness>` is the headless command that answers the observer, with the prompt on stdin; `{model}` in it becomes `model`. It runs with `OBSERVATIONAL_MEMORY_CHILD=1`, so its own session fires no observational-memory hooks. For Cursor and OpenCode the default is the Claude Code command if `claude` is installed, else the Codex one; OpenCode falls back to `["opencode", "run", "--standalone"]` with OpenCode's default model only when neither is installed. Set `model_command.opencode` to that command plus `"-m", "provider/model"` to pick an OpenCode model (`{model}` defaults to the Claude name `sonnet`, which OpenCode may not have).

The transcript is untrusted text. Claude defaults use `--tools "" --restricted --strict-mcp-config --no-session-persistence --disable-slash-commands` to turn off built-in tools, user instructions, MCP servers, plugin hooks, skills, slash commands and session persistence. Codex defaults use `--ignore-user-config --ignore-rules --disable shell_tool`, keep `--sandbox read-only`, and use `--ephemeral`. Codex auth still comes from `CODEX_HOME`. Local Codex 0.164.0 lists `shell_tool` as a stable feature; disabling it has not been checked in a live observer call. These flags do not establish that every Codex tool is unavailable. User-set `model_command` overrides stay unchanged and control their own isolation.

Every entry's message text is clipped to `message_chars` (default 16,000), with `…` marking the cut. Recall still returns the original transcript. Failed observer calls back off for 60 then 120 seconds per stream; forced catch-ups bypass the delay. A third failure at the same watermark skips only that chunk and logs the loss.

Turning main memory back on skips the caller to its current end and marks every other ledger for a skip at its next hook. Re-enabling agents records a cutoff time in each existing session. Streams that began before it skip to their current end once; streams that began afterward are observed in full. Claude and Codex use the first entry's ISO timestamp, and OpenCode uses `time.created` in epoch milliseconds. Without a timestamp, as in Cursor JSONL, only files last modified before the cutoff are skipped. Each stream is decided once. Workers reload their stream's mode after taking the session lock and return without a model call or ledger write when it is off.

## Shell

```
observational-memory status [--harness h --session s]  gauges and counts (default: the newest ledger)
observational-memory view [full]                        the notes a compaction would add; full lists dropped ones
observational-memory mode [main|agents] both|off        show or set the mode (global)
   [--harness h [--session s]]                         turning main on: the caller reads on from here; other ledgers skip at their next hook
observational-memory observe --harness h --session s --transcript p [--force]
observational-memory recall <id>                         the recall tool once
observational-memory reflect                            run the reflector and dropper now
observational-memory inject                             print the rendered notes
```

## Tests

From this folder: `python3 -m unittest discover -s tests`. The model is `tests/fake_model.py`, hook stdin comes from `tests/fixtures/`, transcripts are synthetic, and HOME is a temp folder.

The optional parts have their own tests: `python3 -m unittest discover -s handoff/tests -t handoff` for handoff, and, from `store/`, `uv run --project runtime python -m pytest -c runtime/pyproject.toml --rootdir . tests` for the record store.
