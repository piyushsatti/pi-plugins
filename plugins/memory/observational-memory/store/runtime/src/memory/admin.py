"""Read-only administrative commands for the canonical store."""

from __future__ import annotations

import argparse
import json
import uuid
from pathlib import Path

from memory import store


def migration_preview(directory: Path, scope_key: str | None = None) -> dict:
    """Describe schema-2 to schema-3 conversion without changing source bytes."""
    entries, problems = store.scan(directory)
    records = []
    candidates = []
    for entry in entries:
        if entry.frontmatter.schema_version == 3:
            records.append({"name": entry.name, "disposition": "already-v3", "id": entry.stable_id})
            continue
        match = store.FILENAME_PATTERN.fullmatch(entry.path.name)
        if not match:
            records.append(
                {
                    "name": entry.name,
                    "disposition": "review",
                    "reason": "noncanonical legacy filename; slug requires human choice",
                    "source_hash": entry.content_hash,
                }
            )
            continue
        resolved_scope = scope_key
        if (
            resolved_scope is None
            and entry.frontmatter.scope.depth == 0
            and entry.frontmatter.scope.role == "home"
        ):
            resolved_scope = "home"
        if not resolved_scope:
            records.append(
                {
                    "name": entry.name,
                    "disposition": "review",
                    "reason": "unresolved scope.key; semantic ownership requires human mapping",
                    "source_hash": entry.content_hash,
                }
            )
            continue
        stable_id = "mem-" + str(
            uuid.uuid5(uuid.NAMESPACE_URL, f"memory-v2:{entry.name}:{entry.content_hash}")
        )
        normalized = {
            "name": entry.name,
            "disposition": "proposed",
            "record": {
                "schema_version": 3,
                "id": stable_id,
                "created": entry.frontmatter.created.isoformat(),
                "type": entry.frontmatter.type,
                "slug": match.group("slug"),
                "scope": {
                    "key": resolved_scope,
                    "depth": entry.frontmatter.scope.depth,
                    "role": entry.frontmatter.scope.role,
                },
                "genericity": entry.frontmatter.genericity,
                "last_updated": entry.frontmatter.last_updated.isoformat(),
                "provenance": [
                    {
                        "adapter": "memory-v2",
                        "source_ref": entry.name,
                        "hash": entry.content_hash,
                    }
                ],
                "status": "active",
                "body": entry.body,
            },
            "expected_hash": entry.content_hash,
        }
        records.append(normalized)
        candidates.append(
            {
                "operation_id": f"migrate-{stable_id}",
                "action": "upsert",
                "source_schema_version": 2,
                "source_precondition": {
                    "path": str(entry.path.resolve()),
                    "hash": entry.content_hash,
                },
                "expected_hash": entry.content_hash,
                "record": normalized["record"],
                "projections": [],
            }
        )
    manifest_id = "memory-v2-" + str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            "|".join(candidate["operation_id"] for candidate in candidates),
        )
    )
    return {
        "schema_version": 1,
        "mode": "preview-only",
        "source_root": str(directory),
        "records": records,
        "problems": [{"file": name, "error": error} for name, error in problems],
        "manifest": {
            "schema_version": 1,
            "manifest_id": manifest_id,
            "approved": False,
            "candidates": candidates,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(prog="memory-admin")
    sub = parser.add_subparsers(dest="command", required=True)
    preview = sub.add_parser("migration-preview")
    preview.add_argument("--root", type=Path, default=store.root())
    preview.add_argument("--scope-key")
    args = parser.parse_args()
    print(json.dumps(migration_preview(args.root, args.scope_key), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
