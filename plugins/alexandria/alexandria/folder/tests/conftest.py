"""Run the tests against the runtime copy in ../runtime, as the installed copy runs it.

The launcher puts runtime/bin on PYTHONPATH so the server can import its path
helper; this does the same for the test process and for servers it spawns.
"""

import os
import sys
from pathlib import Path

RUNTIME = Path(__file__).resolve().parents[1] / "runtime"
for folder in (RUNTIME / "bin", RUNTIME / "src"):
    if str(folder) not in sys.path:
        sys.path.insert(0, str(folder))
os.environ["PYTHONPATH"] = os.pathsep.join(
    value
    for value in (str(RUNTIME / "bin"), str(RUNTIME / "src"), os.environ.get("PYTHONPATH"))
    if value
)
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

# Indexes go to a throwaway state folder, never ~/.local/state/rag.
import tempfile  # noqa: E402

os.environ.setdefault("RAG_STATE_DIR", tempfile.mkdtemp(prefix="rag-state-"))
