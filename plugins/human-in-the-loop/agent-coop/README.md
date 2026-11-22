# agent-coop

A shared document-review surface. The user edits documents and leaves comments in a browser UI, then submits; Claude is woken by that submit, pulls the batch, applies edits, answers comments and records a one-line summary. A SQLite event log is the source of truth, and one server process is its only writer. Claude reaches it through the `agent_coop_*` MCP tools as a client.

- [skills/agent-coop/SKILL.md](skills/agent-coop/SKILL.md): open a session, arm the waker, and what to do on each wake-up.
- [skills/narrate/SKILL.md](skills/narrate/SKILL.md): store a written note and a spoken narration on a closed turn.
- [runtime/](runtime/): the Bun runtime (server, MCP shim, engine, scripts, browser sources and the built `static/` snapshot). Its own [README](runtime/README.md) and [docs](runtime/docs/) are adapted from the upstream documentation. The MIT [LICENSE](runtime/LICENSE) is unchanged.

It installs as `agent-coop@pi`. MIT.

## Harness support

The source targeted Claude Code only and declared nothing unsupported. Its components are two skills and one MCP server.

| Harness | What works | Reduced | Missing |
|---|---|---|---|
| Claude Code | Both skills (`/agent-coop:agent-coop`, `/agent-coop:narrate`), the `agent-coop` MCP server (`agent_coop_*` tools, through `agent-coop-mcp`), `agent-coop-up` to start the server and print the session URL, and `agent-coop-watch` under the Monitor tool as the waker. | Nothing. | Nothing. |

**Codex and Cursor aren't claimed.** Both read skills and MCP natively, so the files would load. What neither has is Claude Code's Monitor tool, and agent-coop's wake-up contract depends on it: `agent-coop-watch` prints one line per submit, and only Monitor turns that line into a new turn. Cursor was never a target, and the same gap applies to it. Without Monitor the skill falls back to asking the user to type a message after each submit, which works but drops agent-coop's main feature, so claiming them is left open. Adding Cursor would mean a `.cursor-plugin/plugin.json` with `"mcpServers": "./mcp.json"` and `"skills": "./skills/"`, plus Cursor rows here.

Nothing has been checked in a live harness yet; see [VERIFIED.md](VERIFIED.md).

## Install

Nothing runs from the plugin folder. The MCP config and the skill call three installed commands, all copies of one launcher, [bin/agent-coop](bin/agent-coop), which picks what to run by the name it was called with:

| Command | Runs | Used by |
|---|---|---|
| `~/.local/bin/agent-coop-mcp` | `bun run runtime/src/mcp/index.ts` | `.mcp.json` and `mcp.json` (byte-identical): `sh -c 'exec "$HOME/.local/bin/agent-coop-mcp"'` |
| `~/.local/bin/agent-coop-up` | `bun run runtime/scripts/up.ts "$@"` | the `agent-coop` skill, step 1 |
| `~/.local/bin/agent-coop-watch` | `bun run runtime/scripts/watch.ts "$@"` | the `agent-coop` skill, step 2, under Monitor |

`runtime` there is the installed copy at `~/.local/share/agent-coop/runtime` (`AGENT_COOP_RUNTIME` overrides it). `install.json` has:

- three `files` entries copying `bin/agent-coop` to those three names, mode 0755;
- one `builds` entry, run by hand from this folder, which needs Bun and network access to the npm registry once:

  ```sh
  mkdir -p ~/.local/share/agent-coop/runtime \
    && rsync -a --delete --exclude node_modules/ --exclude web/dist/ runtime/ ~/.local/share/agent-coop/runtime/ \
    && bun install --cwd ~/.local/share/agent-coop/runtime --frozen-lockfile
  ```

  It copies the runtime out of the checkout and installs its dependencies from `bun.lock`. `--delete` keeps the copy in step with the source; it never reaches project data, which lives in each project. Re-run it after every update to `runtime/`. `/mcp` reconnects a running session to the new copy.

The launcher refuses with exit 2, and says why, if the runtime or its `node_modules` is missing.

**Behaviour carried over.** The server listens on `localhost:4317` (`AGENT_COOP_PORT`), and one server serves one database at a time: `agent-coop-up` in a second project finds the first project's server already running and opens that project's sessions. On each start, `scripts/dev.ts` rebuilds `web/dist/` inside the installed runtime; the server itself serves the tracked `static/` snapshot (`AGENT_COOP_STATIC_DIR`).

**Static snapshot.** `runtime/scripts/build.ts` builds the UI from `runtime/web/src/` into `runtime/web/dist/`, not `runtime/static/`. From `runtime/`, rebuilding needs `bun install`, then `bun run build`. Updating the served snapshot also needs copying the build output into `static/`. The snapshot was not rebuilt here: dependencies are absent and network access is unavailable. On 2026-10-28, `static/app.js` was dated October 23, while `static/app.js.map` was dated October 22. The map embeds older versions of seven current sources, including `web/src/app.js`, `web/src/views/document.js` and `web/src/components/comment-panel.js`.

## Data: `<project>/.local-state/agent-coop/`

Agent Coop's data is per project. The launcher sets these unless they are already set:

| Variable | Default |
|---|---|
| `AGENT_COOP_DB` | `<project>/.local-state/agent-coop/agent-coop.sqlite` |
| `AGENT_COOP_DATA_DIR` | `<project>/.local-state/agent-coop/data` (includes `server.log`) |
| `AGENT_COOP_NARRATION_DIR` | `<project>/.local-state/agent-coop/data/narration` |
| `AGENT_COOP_BACKUP_DIR` | `<project>/.local-state/agent-coop/history` |
| `AGENT_COOP_ARTIFACTS_DIR` | `<project>/.local-state/agent-coop/artifacts` (exports) |
| `AGENT_COOP_STATIC_DIR` | `~/.local/share/agent-coop/runtime/static` |

`<project>` is `$CLAUDE_PROJECT_DIR`, or the current directory without it.

The launcher sets these variables for the server and the scripts alike, so both agree on the project folder. Add `.local-state/` to the project's ignore file.

## Tests

```sh
python3 -m unittest discover -s tests
```

Run from this folder. [tests/test_launcher.py](tests/test_launcher.py) checks the launcher with a fake `bun` on `PATH`, plus `install.json`, the two MCP files, the skills' frontmatter and documentation links. It needs no Bun, no dependencies and no network.

From `runtime/`, run `bun test src/server/guard.test.ts` for the request guard, or `bun test` for all available runtime tests. The guard tests use only local modules and Bun's test runner; they stub the contract version to avoid loading absent schema dependencies. The source's other runtime tests were not carried over. The obsolete config that preloaded the missing `tests/preload.ts` has been removed. The server, MCP shim and browser UI have not been tested live here.
