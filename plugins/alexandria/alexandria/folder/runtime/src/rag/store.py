"""The per-project index: LanceDB on disk, hybrid retrieval.

One store per project root, under `~/.local/state/rag/projects/<name>-<hash>/index/`.
Disk-based on purpose: the index must not compete with vLLM for unified memory.

Retrieval runs the vector and full-text sides separately and fuses the two ranked
lists with reciprocal rank fusion. LanceDB can do `query_type="hybrid"` in one call,
but only when an embedding function is registered on the table so it can embed the
query itself. Doing it in two explicit steps keeps the embedding model in one module
and makes each half separately testable, which matters because the two halves fail
differently: vectors miss exact identifiers, full text misses paraphrase.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import lancedb
import pyarrow as pa
from lancedb.index import FTS

from rag import chunk, embed, storage

TABLE = "chunks"

#: Files worth indexing. Prose and structured notes, not source code: code is what
#: the LSP and grep are for, and mixing it in dilutes every query.
DEFAULT_GLOBS = ("**/*.md", "**/*.markdown", "**/*.rst", "**/*.txt")

DEFAULT_EXCLUDES = (
    ".git",
    ".rag",
    ".pi",
    ".venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    "worktrees",
    "dist",
    "build",
)

#: Standard RRF constant. Damps the influence of the top rank so one list cannot
#: dominate the other purely by being confident.
RRF_K = 60


@dataclass(frozen=True)
class Hit:
    source: str
    heading_path: str
    text: str
    score: float
    found_by: str


def store_path(project_root: Path) -> Path:
    return storage.resolve_index(project_root)


def _schema(dim: int) -> pa.Schema:
    return pa.schema(
        [
            pa.field("vector", pa.list_(pa.float32(), dim)),
            pa.field("text", pa.string()),
            pa.field("source", pa.string()),
            pa.field("heading_path", pa.string()),
            pa.field("ordinal", pa.int32()),
        ]
    )


def _is_excluded(path: Path, root: Path) -> bool:
    return any(part in DEFAULT_EXCLUDES for part in path.relative_to(root).parts)


def discover(project_root: Path, globs: tuple[str, ...] = DEFAULT_GLOBS) -> list[Path]:
    root = Path(project_root).expanduser().resolve()
    seen: set[Path] = set()
    for pattern in globs:
        for path in root.glob(pattern):
            if path.is_file() and not _is_excluded(path, root):
                seen.add(path)
    return sorted(seen)


def ingest(project_root: Path, globs: tuple[str, ...] = DEFAULT_GLOBS) -> dict:
    """(Re)build the index for one project. Replaces the table rather than appending.

    Replacing is what makes re-running safe: an append would silently double every
    chunk, and a stale-chunk reaper is more machinery than a small corpus needs.
    """
    root = Path(project_root).expanduser().resolve()
    files = discover(root, globs)

    chunks: list[chunk.Chunk] = []
    for path in files:
        chunks.extend(chunk.split_file(path, relative_to=root))

    started = time.monotonic()
    database = lancedb.connect(store_path(root))
    dim = embed.dimensions()

    if not chunks:
        database.create_table(TABLE, schema=_schema(dim), mode="overwrite")
        return {
            "project_root": str(root),
            "files": len(files),
            "chunks": 0,
            "model": embed.model_name(),
            "seconds": round(time.monotonic() - started, 2),
        }

    vectors = embed.encode([c.indexed_text for c in chunks])
    rows = [
        {
            "vector": vectors[i].tolist(),
            "text": c.text,
            "source": c.source,
            "heading_path": c.heading_path,
            "ordinal": c.ordinal,
        }
        for i, c in enumerate(chunks)
    ]
    table = database.create_table(TABLE, data=rows, schema=_schema(dim), mode="overwrite")
    # stem/stop-words on: queries are natural language as often as identifiers.
    # with_position enables phrase queries, which cost index size but make an exact
    # multi-word config key findable as a phrase rather than as loose tokens.
    table.create_index("text", config=FTS(with_position=True), replace=True)

    return {
        "project_root": str(root),
        "files": len(files),
        "chunks": len(chunks),
        "model": embed.model_name(),
        "seconds": round(time.monotonic() - started, 2),
    }


def _open(project_root: Path):
    path = store_path(project_root)
    if not path.exists():
        return None
    database = lancedb.connect(path)
    # .tables, not the response itself: list_tables() returns a paginated
    # ListTablesResponse, so `TABLE not in response` is always true and would make
    # every store look unindexed. One table here, so the page token is not needed.
    if TABLE not in database.list_tables().tables:
        return None
    return database.open_table(TABLE)


def _rows_to_hits(rows: list[dict], found_by: str) -> list[tuple[str, dict]]:
    out = []
    for row in rows:
        key = f"{row['source']}#{row['ordinal']}"
        out.append((key, {**row, "found_by": found_by}))
    return out


def search(project_root: Path, query: str, limit: int = 8) -> list[Hit]:
    """Vector and full-text, fused. Either half may return nothing; that is not an error."""
    table = _open(project_root)
    if table is None:
        return []

    depth = max(limit * 4, 20)

    vector_rows: list[dict] = []
    try:
        vector = embed.encode([query])[0].tolist()
        vector_rows = table.search(vector).limit(depth).to_list()
    except Exception:  # noqa: BLE001 - one half failing must not take the other down
        vector_rows = []

    text_rows: list[dict] = []
    try:
        text_rows = table.search(query, query_type="fts").limit(depth).to_list()
    except Exception:  # noqa: BLE001 - no FTS index, or a query the parser rejects
        text_rows = []

    ranked: dict[str, dict] = {}
    scores: dict[str, float] = {}
    found: dict[str, set[str]] = {}

    for rows, label in ((vector_rows, "vector"), (text_rows, "text")):
        for rank, (key, row) in enumerate(_rows_to_hits(rows, label)):
            scores[key] = scores.get(key, 0.0) + 1.0 / (RRF_K + rank + 1)
            ranked.setdefault(key, row)
            found.setdefault(key, set()).add(label)

    ordered = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:limit]
    return [
        Hit(
            source=ranked[key]["source"],
            heading_path=ranked[key]["heading_path"],
            text=ranked[key]["text"],
            score=round(score, 6),
            found_by="+".join(sorted(found[key])),
        )
        for key, score in ordered
    ]


def status(project_root: Path) -> dict:
    root = Path(project_root).expanduser().resolve()
    table = _open(root)
    if table is None:
        return {
            "project_root": str(root),
            "index": str(store_path(root)),
            "indexed": False,
            "chunks": 0,
            "hint": "run ingest for this project root",
        }
    rows = table.to_arrow()
    sources = sorted({str(s) for s in rows.column("source").to_pylist()})
    path = store_path(root)
    newest = max((p.stat().st_mtime for p in path.rglob("*") if p.is_file()), default=0.0)
    return {
        "project_root": str(root),
        "index": str(path),
        "indexed": True,
        "chunks": rows.num_rows,
        "files": len(sources),
        "sources": sources[:50],
        "model": embed.model_name(),
        "indexed_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(newest))
        if newest
        else None,
    }
