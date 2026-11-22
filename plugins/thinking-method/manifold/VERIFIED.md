# manifold: verification

Levels are defined in the [verification ladder](../../../CONVENTIONS.md#verification-ladder). A row is recorded only when its check actually ran.

| Level | Claude Code | Codex | Cursor |
|---|---|---|---|
| V0 lint | pass for manifold (run 2) | same run | same run |
| V1 native validator | not run | no validator found; lint checks the documented fields | no validator found; lint checks the documented fields |
| V2 script tests | pass (run 1) | pass (run 1) | pass (run 1) |
| V3 loads without install | not run | not run | not run |
| V4 runtime behaviour | not run | not run | not run |
| V5 in use | not run | not run | not run |

## Runs

| # | Level | Date | Machine | Harness version | Command | Result |
|---|---|---|---|---|---|---|
| 1 | V2 | 2026-10-22 | a Mac | none (no harness involved); Python 3.15.0 | `python3 -m unittest discover -s tests` from `plugins/manifold/` | 9 tests, OK; no network |
| 2 | V0 | 2026-10-22 | a Mac | none | `python3 scripts/lint_plugins.py` from the repo root | pass for manifold: 0 errors, 0 warnings. The catalogs don't list it yet, reported as catalog errors; they are regenerated separately. |

Run 1 covers `manifold-spaces` (root, list, latest and checkpoint; the default root under `~/.local/state/manifold/`; refusal of relative, repository-contained and symlinked roots and of path traversal; empty content and blocked storage), with `MANIFOLD_STATE` or `HOME` pointed at a temporary folder. One case runs the helper through its `env -S python3 -I` shebang. It also checks the package: nine skills, roles and lenses, all 39 reference hashes and the licence hash, frontmatter, and every Markdown link. The helper has no harness-specific input, so the one run stands for each claimed harness.

Not covered: the earlier build's check that the references reproduce from the vendor snapshot (`scripts/manifold-references.ts --check`) needs `packages/plugins/` and wasn't re-run here. No harness was asked to run a skill.
