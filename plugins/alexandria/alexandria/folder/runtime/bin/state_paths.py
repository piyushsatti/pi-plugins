#!/usr/bin/env python3
"""Where rag keeps its data. Read-only path calculations; nothing here writes.

Data lives in ``~/.local/state/rag/`` (plugins/CONVENTIONS.md, rule 6), never in the
project. Each project gets its own folder, ``projects/<name>-<hash>/``, keyed by the
project's resolved absolute path. ``RAG_STATE_DIR``, an absolute path, replaces
``~/.local/state/rag``.
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _absolute_path(value: str | os.PathLike[str], name: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError(f"{name} must be an absolute path: {value!r}")
    return path.resolve()


def state_home() -> Path:
    override = os.environ.get("RAG_STATE_DIR")
    if override is not None:
        return _absolute_path(override, "RAG_STATE_DIR")
    return (Path.home() / ".local" / "state" / "rag").resolve()


def project_root(value: str | os.PathLike[str]) -> Path:
    return _absolute_path(value, "project_root")


def project_key(root: str | os.PathLike[str]) -> str:
    """A stable folder name for one project: readable name plus a path hash."""
    resolved = project_root(root)
    digest = hashlib.sha256(str(resolved).encode()).hexdigest()[:16]
    name = _UNSAFE.sub("-", resolved.name).strip(".-") or "root"
    return f"{name[:48]}-{digest}"


def project_dir(root: str | os.PathLike[str]) -> Path:
    return state_home() / "projects" / project_key(root)


def index_dir(root: str | os.PathLike[str]) -> Path:
    return project_dir(root) / "index"
