"""The tool registry.

Three tools. One declarative table, bound by a single loop in server.py; a test
asserts the registry and the server's bound tools are the same set.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rag import storage, store


@dataclass(frozen=True)
class ToolSpec:
    name: str
    fn: Callable[..., Any]
    description: str


def ingest(project_root: str) -> dict[str, Any]:
    """Build or rebuild the index for one project root."""
    try:
        return store.ingest(Path(project_root))
    except storage.StoragePathError as exc:
        return {"error": str(exc), "project_root": project_root, "storage_error": True}
    except Exception as exc:  # noqa: BLE001 - the reason is the useful part of the answer
        return {"error": f"{exc.__class__.__name__}: {exc}", "project_root": project_root}


def search(project_root: str, query: str, limit: int = 8) -> dict[str, Any]:
    """Hybrid search over one project's indexed documents."""
    try:
        hits = store.search(Path(project_root), query, limit=limit)
    except storage.StoragePathError as exc:
        return {"error": str(exc), "project_root": project_root, "storage_error": True}
    return {
        "query": query,
        "count": len(hits),
        "hits": [
            {
                "source": h.source,
                "heading": h.heading_path,
                "found_by": h.found_by,
                "score": h.score,
                "text": h.text[:1200],
            }
            for h in hits
        ],
    }


def status(project_root: str) -> dict[str, Any]:
    """What is indexed for this project, and when."""
    try:
        return store.status(Path(project_root))
    except storage.StoragePathError as exc:
        return {"error": str(exc), "project_root": project_root, "storage_error": True}


REGISTRY: tuple[ToolSpec, ...] = (
    ToolSpec(
        name="ingest",
        fn=ingest,
        description=(
            "Index a project's documents for search. Give an absolute `project_root`. Reads "
            "markdown, rst and txt files under it, chunks them by heading, and writes an index "
            "into rag's own state folder for that project, outside the project. Re-running "
            "replaces the index, so it is safe to call "
            "after documents change. Returns the file and chunk counts."
        ),
    ),
    ToolSpec(
        name="search",
        fn=search,
        description=(
            "Search a project's indexed documents. Runs vector similarity and full-text search "
            "and fuses the rankings, so it handles both paraphrased questions and exact "
            "identifiers or config keys. Each hit reports which half found it. Call `ingest` "
            "first if `status` says the project is not indexed."
        ),
    ),
    ToolSpec(
        name="status",
        fn=status,
        description=(
            "Report whether a project root is indexed, how many files and chunks it holds, which "
            "embedding model was used, and when it was last built. Use this to tell a stale index "
            "from a missing one."
        ),
    ),
)
