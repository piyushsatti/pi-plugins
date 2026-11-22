#!/usr/bin/env python3
"""Where memory keeps its data. Read-only path calculations; nothing here writes.

The record store lives in ``~/.local/state/memory/`` (plugins/CONVENTIONS.md, rule 6).
``MEMORY_ROOT``, an absolute path, overrides it, so an existing store can be used in
place, for example the one the Pi Commons build kept in the old Pi data folder.
"""

from __future__ import annotations

import os
from pathlib import Path


def _absolute_path(value: str | os.PathLike[str], name: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError(f"{name} must be an absolute path: {value!r}")
    return path.resolve()


def default_root() -> Path:
    return (Path.home() / ".local" / "state" / "memory").resolve()


def memory_root() -> Path:
    override = os.environ.get("MEMORY_ROOT")
    if override is not None:
        return _absolute_path(override, "MEMORY_ROOT")
    return default_root()
