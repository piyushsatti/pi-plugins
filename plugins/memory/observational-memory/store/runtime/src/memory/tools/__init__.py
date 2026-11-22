"""Four-tool MCP surface over the versioned memory store."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal

from memory import store


@dataclass(frozen=True)
class ToolSpec:
    name: str
    fn: Callable[..., Any]
    description: str


def _matches(entry: store.Entry, scope_key: str | None, status: str | None) -> bool:
    if scope_key and (
        not isinstance(entry.frontmatter, store.Frontmatter)
        or entry.frontmatter.scope.key != scope_key
    ):
        return False
    current_status = getattr(entry.frontmatter, "status", "active")
    return not status or current_status == status


def index(scope_key: str | None = None, status: str | None = None) -> dict[str, Any]:
    """Catalogue entries, optionally scoped by logical owner and lifecycle status."""
    entries, problems = store.scan()
    entries = [entry for entry in entries if _matches(entry, scope_key, status)]
    return {
        "root": str(store.root()),
        "count": len(entries),
        "entries": [
            {
                "id": entry.stable_id,
                "name": entry.name,
                "schema_version": entry.frontmatter.schema_version,
                "title": entry.title,
                "type": entry.frontmatter.type,
                "scope": entry.frontmatter.scope.model_dump(),
                "genericity": entry.frontmatter.genericity,
                "status": getattr(entry.frontmatter, "status", "active"),
                "last_updated": entry.frontmatter.last_updated.isoformat(),
                "hash": entry.content_hash,
                "summary": entry.summary,
            }
            for entry in entries
        ],
        "problems": [{"file": name, "error": error} for name, error in problems],
    }


def read(name: str, revision_hash: str | None = None) -> dict[str, Any]:
    """Read a record by stable id or filename stem, optionally at a retained revision."""
    try:
        if revision_hash:
            entry = store.load_revision(name, revision_hash)
        else:
            entries, _ = store.scan()
            matches = [entry for entry in entries if entry.name == name or entry.stable_id == name]
            if len(matches) != 1:
                return {"error": f"expected one entry for {name!r}, found {len(matches)}"}
            entry = matches[0]
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{exc.__class__.__name__}: {exc}"}
    return {
        "id": entry.stable_id,
        "name": entry.name,
        "path": str(entry.path),
        "frontmatter": entry.frontmatter.model_dump(mode="json"),
        "body": entry.body,
        "hash": entry.content_hash,
        "revisions": store.revisions(entry.stable_id) if entry.stable_id else [],
    }


def search(
    query: str,
    type: str | None = None,
    genericity: Literal["generic", "specific"] | None = None,
    scope_key: str | None = None,
    status: Literal["active", "deprecated", "tombstone"] | None = "active",
) -> dict[str, Any]:
    """Substring search with type, export-fence, logical-scope, and status filters."""
    entries, _ = store.scan()
    needle = query.casefold()
    hits = []
    for entry in entries:
        if type and entry.frontmatter.type != type:
            continue
        if genericity and entry.frontmatter.genericity != genericity:
            continue
        if not _matches(entry, scope_key, status):
            continue
        haystack = f"{entry.title}\n{entry.body}".casefold()
        if needle and needle not in haystack:
            continue
        lines = [line.strip() for line in entry.body.splitlines() if needle in line.casefold()]
        hits.append(
            {"id": entry.stable_id, "name": entry.name, "title": entry.title, "matches": lines[:5]}
        )
    return {"query": query, "count": len(hits), "hits": hits}


def write(
    slug: str,
    type: str,
    body: str,
    scope: dict[str, Any],
    provenance: list[dict[str, str]],
    genericity: Literal["generic", "specific"] = "specific",
    id: str | None = None,
    status: Literal["active", "deprecated", "tombstone"] = "active",
    created: str | None = None,
    last_updated: str | None = None,
    expected_hash: str | None = None,
) -> dict[str, Any]:
    """Create or CAS-replace a schema-3 record; scope is always explicit."""
    try:
        entry = store.save(
            slug=slug,
            type=type,
            body=body,
            scope=store.Scope(**scope),
            provenance=[store.Provenance(**item) for item in provenance],
            genericity=genericity,
            stable_id=id,
            status=status,
            created=date.fromisoformat(created) if created else None,
            last_updated=date.fromisoformat(last_updated) if last_updated else None,
            expected_hash=expected_hash,
        )
    except Exception as exc:  # noqa: BLE001
        return {"written": False, "error": f"{exc.__class__.__name__}: {exc}"}
    return {
        "written": True,
        "id": entry.stable_id,
        "name": entry.name,
        "path": str(entry.path),
        "hash": entry.content_hash,
        "frontmatter": entry.frontmatter.model_dump(mode="json"),
    }


REGISTRY: tuple[ToolSpec, ...] = (
    ToolSpec(
        "index",
        index,
        "List memory records and data-quality problems, optionally filtered by logical scope and lifecycle status.",
    ),
    ToolSpec(
        "read",
        read,
        "Read one memory record by stable id or filename stem, including its content hash and retained revisions.",
    ),
    ToolSpec(
        "search",
        search,
        "Search memory text with explicit type, genericity, logical scope, and lifecycle status filters.",
    ),
    ToolSpec(
        "write",
        write,
        "Create or compare-and-swap replace a schema-3 memory record with explicit scope and provenance.",
    ),
)
