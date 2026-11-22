# agent-coop: verification

One row per run. A cell says "not run" until its check actually ran. Only Claude Code is claimed. Earlier rows are carried over from the source; they were not rerun here.

| Level | Claude Code |
|---|---|
| V0 lint | pass, 2026-10-22, original machine: `python3 scripts/lint_plugins.py`, 0 errors in `agent-coop` (the Claude catalog doesn't list it yet; catalogs regenerated separately) |
| V1 native validator | pass, 2026-10-22, original machine, Claude Code 2.1.307: `claude plugin validate ./agent-coop` → "Validation passed"; one directory warning (no icon) and one advice line (no install line in the README) |
| V2 script tests | pass, 2026-10-22, original machine, Python 3.15.0: launcher tests, 10 OK (see below). The Bun runtime had no tests in the source, so none ran. |
| V2 guard tests | pass, 2026-10-28, this Mac, Bun 1.4.3: `cd runtime && BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache" bun test src/server/guard.test.ts`, 27 pass, 0 fail |
| V2 plugin tests | pass, 2026-10-28, this Mac: `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v`, 11 pass, 0 fail |
| V3 loads without install | not run |
| V4 runtime behaviour | not run |
| V5 in use | not run |

## V2, 2026-10-22

`python3 -m unittest discover -s tests -v` from `plugins/agent-coop/`: `Ran 10 tests ... OK`. HOME and the project were temp folders, and `bun` was a fake on `PATH` that prints its arguments and `AGENT_COOP_*` environment. The run covered:

- `agent-coop-mcp`, `agent-coop-up` and `agent-coop-watch` each running their entry from `~/.local/share/agent-coop/runtime`, with arguments passed through, and never a path in the plugin folder;
- the six `AGENT_COOP_*` defaults under `$CLAUDE_PROJECT_DIR/.local-state/agent-coop/`, the current-directory fallback, no `/.pi/` in any of them, preset variables winning, and `AGENT_COOP_RUNTIME`;
- refusal (exit 2, no `bun` call) for an unknown name and for a missing runtime or `node_modules`;
- `install.json` installing the three names and building the runtime with `--frozen-lockfile`;
- `.mcp.json` and `mcp.json` byte-identical and calling `$HOME/.local/bin/agent-coop-mcp`;
- skill frontmatter holding only allowed keys, and no plugin-root or `bun run …runtime/` call in either skill.

Not covered by that run: the Bun runtime itself (server, MCP shim, `up.ts`, `watch.ts`, the browser UI). Its tests weren't in the earlier source (the original Bun config preloaded a missing `tests/preload.ts`), its dependencies weren't installed, and the build step needed the npm registry. The `rsync` and `bun install` build in `install.json` was not run.

## V2, 2026-10-28, this Mac

The guard tests exercise the real guard and HTTP error response. They stub only
the contract version so the contract barrel does not load absent Zod schemas.
They cover Host checks on reads and writes, loopback and listed hosts, the URL
host fallback, and the existing write-only checks. The obsolete preload config
was removed because its target was absent. The full available runtime suite,
`cd runtime && BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache" bun test`, also passed
27 tests with no failures. No live server, browser or harness check ran. The
static snapshot was inspected, not rebuilt; see [README.md](README.md).
