#!/usr/bin/env python3
"""Start the memory MCP server from its installed copy.

The installed copy is ~/.local/share/memory/ (see install.json); this file sits in
its bin/. The uv environment is that folder's .venv, prepared by the install.json
build step. The record store is resolved by state_paths.py and never lands here.
"""

import os
import sys
from pathlib import Path

# The helper import must not leave bytecode beside the installed copy.
sys.dont_write_bytecode = True

from state_paths import memory_root

ROOT = Path(__file__).resolve().parent.parent
os.environ["MEMORY_ROOT"] = str(memory_root())
os.environ["PYTHONPATH"] = os.pathsep.join(
    value for value in (str(ROOT / "bin"), os.environ.get("PYTHONPATH")) if value
)
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
os.execvp(
    "uv",
    [
        "uv",
        "run",
        "--frozen",
        "--no-dev",
        "--project",
        str(ROOT),
        "--python",
        "3.13",
        "memory",
        *sys.argv[1:],
    ],
)
