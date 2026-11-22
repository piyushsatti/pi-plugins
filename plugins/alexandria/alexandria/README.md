# alexandria

Search your own documents from an agent. Two parts, one plugin:

| Part | Folder | Registered by default | Does |
|---|---|---|---|
| Folder mode | `folder/` | yes, as MCP server `folder` | Indexes project folders you name and searches them, hybrid full text plus vectors. Tools: `ingest`, `search`, `status`. Everything stays on the machine. |
| Library server | `server/` | no; see `library.mcp.json.example` | Serves one committed revision of a Markdown library, with provenance checks, over stdio or as a hosted Streamable HTTP service behind OAuth. |

Folder mode is the former `rag` plugin, moved here unchanged apart from its install folder. The two engines are still separate code: folder mode uses `minishlab/potion-base-8M` embeddings and its own store, and the library server uses LanceDB with `BAAI/bge-small-en-v1.5`. Merging them is later work.

## Folder mode

Install copies `folder/runtime/` to `~/.local/share/alexandria-folder/` (see `folder/install.json`), then runs the build step it names:

```bash
uv sync --frozen --no-dev --python 3.13 --project ~/.local/share/alexandria-folder
```

`.mcp.json` and `mcp.json` start the installed launcher. Indexes live under `~/.local/state/rag/projects/<name>-<hash>/index/`, never in the project; `RAG_STATE_DIR` overrides that. The embedding model is fetched from the Hugging Face hub on first use. See [folder/docs/stdout.md](folder/docs/stdout.md) for the stdout guard.

## Library server

The server's own [README](server/README.md) and [getting started](server/docs/getting-started.md) cover building an index, preparing a data block and deploying. To connect an agent, copy one entry from `library.mcp.json.example` into this plugin's `.mcp.json` (or your harness's own MCP settings): `library` runs a local install against a data block, and `library-hosted` points at a deployed server's URL.

## Harness support

| Harness | Manifest | Works | Missing |
|---|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | MCP server `folder` from `.mcp.json` | library server is opt-in |
| Codex | `.codex-plugin/plugin.json` | MCP server `folder` from `.mcp.json` | library server is opt-in |
| Cursor | `.cursor-plugin/plugin.json` | MCP server `folder` from `mcp.json` | library server is opt-in |

None of this has run inside a harness yet.

## Tests

```bash
cd folder && uv run --project runtime python -m pytest -c runtime/pyproject.toml --rootdir . tests
cd server && uv run python -m pytest
```

See [VERIFIED.md](VERIFIED.md) for the last results.
