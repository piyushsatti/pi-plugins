# alexandria: verification

| Level | Folder mode | Library server |
|---|---|---|
| V2 script tests | partial, 2026-11-17, this Mac, Python 3.13 via uv, offline: 16 passed, 5 errors | partial, 2026-11-17, this Mac, Python 3.13 via uv, offline: 138 passed, 6 failed |
| V3 loads in a harness | not run | not run |
| V4 runtime behaviour | not run | not run |

## 2026-11-17

Both environments were built with `uv sync --offline --frozen` into throwaway folders outside the repo, with `HF_HUB_OFFLINE=1`.

**Folder mode.** The five errors are the ingest and search tests in `tests/rag/test_store.py`. Their fixture needs the embedding model `minishlab/potion-base-8M`, which is not in the local cache, so it fails with `LocalEntryNotFoundError`. These five have never passed; they need one run with network.

**Graph operator, 2026-11-22.** It stays in the plugin. Its two Pi packages may run only when confined, inside the container or an OS-level sandbox; they are never installed on the bare machine. Its six tests stay "not run" until a confined run exists.

**Library server.** The six failures are in `tests/pi/alexandria/graph/test_operator_run.py` (2) and `test_operator_status.py` (4). The graph operator reads `@earendil-works/pi-agent-core` and `pi-ai` 0.85.1 from a `node_modules` folder that was not installed, so `read_json` stops with "Missing, nonregular, or oversized input". They need an npm install, which this run did not do.
