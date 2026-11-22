# ordinator: verification

Levels are defined in the [verification ladder](../../../CONVENTIONS.md#verification-ladder). A row is recorded only when its check actually ran.

| Level | Claude Code | Codex | Cursor |
|---|---|---|---|
| V0 lint | pass, 2026-10-22, a Mac: `python3 scripts/lint_plugins.py` → 5 plugins, 0 errors, 0 warnings (catalogs included) | same run | same run |
| V1 native validator | pass, 2026-10-22, a Mac, Claude Code 2.1.307: `claude plugin validate` | no validator found; lint checks the documented fields | no validator found; lint checks the documented fields |
| V2 script tests | pass (runs 1, 2) | fleet-row functions pass (run 2); workflow not applicable | fleet-row functions pass (run 2); workflow not applicable |
| V3 loads without install | not run | not run | not run |
| V4 runtime behaviour | not run | not run | not run |
| V5 in use | not run | not run | not run |

## Runs

| # | Level | Date | Machine | Harness version | Command | Result |
|---|---|---|---|---|---|---|
| 1 | V2 | 2026-10-22 | a Mac | none (no harness involved); Node v26.12.0 | `node --test tests/ticket-pr.test.mjs` from `plugins/ordinator/` | 9 tests, 9 pass, 0 fail; no network |
| 2 | V2 | 2026-10-28 | this Mac | none (no harness involved); Node v26.12.0; /bin/bash 3.2.57 | `node --test tests/*.test.mjs` from this folder | 16 tests, 16 pass, 0 fail; no network |

Run 1 exercises `workflows/ticket-pr.js` against a mock agent. That's the Claude Workflow tool's script, so it counts for Claude Code only.

Run 2 includes the same nine workflow tests and seven fleet-row function tests. The latter use system awk through `/usr/bin:/bin`. Before the fix, all seven failed with macOS sed's "invalid command code" error. They check replacement and deletion without launching a session, including literal `#`, `&` and backslashes and preservation of unrelated bytes and final newlines. These shell functions do not depend on a harness; this does not verify native plugin loading or full launches and resumes.

Not covered by any run:
- Full launches and resumes and the other executable behaviour have no tests. `ordinator-lint-agent agents/*.md` (printed `OK`) and `bash -n` on the four shell scripts were also run, as sanity checks outside the ladder.
- `ordinator-window-check --file <missing>` printed `unknown` with exit 4, as written.
- The `internal/` pm and tm tests weren't run. They need the Claude mod engine's `claude-code/testing` module.
