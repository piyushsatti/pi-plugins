#!/usr/bin/env python3
"""Start the rag MCP server from its installed copy.

The installed copy is ~/.local/share/rag/ (see install.json); this file sits in its
bin/. The uv environment is that folder's .venv, prepared by the install.json build
step. Indexes are resolved by state_paths.py and never land here.
"""

import os
import shutil
import sys
from pathlib import Path

# The helper path must not leave bytecode beside the installed copy.
sys.dont_write_bytecode = True

root = Path(__file__).resolve().parents[1]
uv = shutil.which("uv")
if uv is None:
    print("rag requires uv and Python 3.13 on PATH.", file=sys.stderr)
    raise SystemExit(1)
python_path = os.pathsep.join(
    value for value in (str(root / "bin"), os.environ.get("PYTHONPATH")) if value
)
env = dict(os.environ, PYTHONPATH=python_path, PYTHONDONTWRITEBYTECODE="1")
os.execvpe(
    uv,
    [
        uv,
        "run",
        "--frozen",
        "--no-dev",
        "--project",
        str(root),
        "--python",
        "3.13",
        "rag",
        *sys.argv[1:],
    ],
    env,
)
