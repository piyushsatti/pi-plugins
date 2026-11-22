# chirp: verification

Earlier platform and playback results are in [docs/verification.md](docs/verification.md).

| Level | Codex | Claude Code |
|---|---|---|
| V0 lint | pass, 2026-11-19, this Mac: `python3 scripts/lint_plugins.py` → 9 plugins, 0 errors, 0 warnings (was 3 chirp hook-layout errors on 2026-11-17) | same run |
| V2 script tests | pass, 2026-11-17, this Mac: `PYTHONPATH=src python3 -m unittest discover -s tests`, 23 tests OK (re-run 2026-11-19 after the hook split, still 23 OK); `ruff check`, `ruff format --check`, `shellcheck` and `bash -n` clean | same run |
| V3 loads in a harness | not run from this repo | not run from this repo |

## 2026-11-17

One test, `test_cli_defaults_to_portaudio_output`, failed before this move: it cleared the environment, so a device saved on the machine running the tests leaked in. It now sets `CHIRP_DATA_DIR` to an empty temporary folder and passes.

## 2026-11-19, hook layout

The hooks moved from `hooks/hooks.json` to `hooks/claude.json` and `hooks/codex.json`, named by the manifests, and both call `~/.local/bin/chirp-hook`, the launcher `install.sh` and `install.json` put there. In a throwaway HOME, the launcher was installed and the exact `command` string from `hooks/claude.json` was run with `sh -c`, `env -i`, Stop input with no speech marker: it printed the `decision: block` JSON and exited 0. Chirp's package was supplied by `PYTHONPATH` in that run, standing in for the runtime venv, which was not built. Not run inside Claude Code or Codex.
