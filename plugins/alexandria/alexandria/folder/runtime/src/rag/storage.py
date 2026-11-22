"""Canonical RAG index paths and state safety checks."""

from __future__ import annotations

import os
from pathlib import Path

from state_paths import index_dir, project_dir, project_root, state_home


class StoragePathError(RuntimeError):
    """Raised when the canonical rag storage path is unsafe to use."""


def _guard_state(root: Path) -> None:
    home = state_home()
    for path in (home, home / "projects", project_dir(root)):
        if path.is_symlink():
            raise StoragePathError(f"refusing symlinked rag state: {path}")


def canonical_path(project: str | os.PathLike[str]) -> Path:
    return index_dir(project_root(project))


def _reject_symlink(path: Path) -> None:
    if path.is_symlink():
        raise StoragePathError(f"refusing symlinked RAG storage path: {path}")


def resolve_index(project: str | os.PathLike[str]) -> Path:
    """Return the only supported index location for a project."""
    root = project_root(project)
    _guard_state(root)
    canonical = canonical_path(root)
    _reject_symlink(canonical)
    return canonical
