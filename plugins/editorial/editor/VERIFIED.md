# editor: verification

| Level | Claude Code | Codex | Cursor |
|---|---|---|---|
| V2 script tests | pass, 2026-11-17, this Mac, system Python 3: `python3 -m unittest discover -s tests`, 7 tests OK; `ruff check` and `ruff format --check` clean | same run | same run |
| V3 loads in a harness | not run | not run | not run |
| V4 runtime behaviour | not run | not run | not run |

`scripts/check.py` was also run on this plugin's own rulebook, skills and agent: no findings.
