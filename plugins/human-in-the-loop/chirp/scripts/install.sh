#!/usr/bin/env bash
# Install Chirp's user-local runtime; the plugin itself comes from the pi marketplace.
set -euo pipefail

plugin_root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
chirp_data="${CHIRP_DATA_DIR:-${XDG_DATA_HOME:-${HOME}/.local/share}/chirp}"
runtime="${chirp_data}/venv"
install_root="${chirp_data}/plugin"
mode="${1:-codex}"
case "$mode" in
  codex|runtime) ;;
  *) printf '%s\n' 'Usage: bash scripts/install.sh [codex|runtime]' >&2; exit 2 ;;
esac

if [ ! -x "${runtime}/bin/python" ]; then
  "${CHIRP_PYTHON:-python3}" -m venv "$runtime"
fi
"${runtime}/bin/python" -m pip install --disable-pip-version-check "$plugin_root"
mkdir -p "${HOME}/.local/bin"
install -m 0755 "${plugin_root}/scripts/stop.sh" "${HOME}/.local/bin/chirp-hook"
mkdir -p "${chirp_data}/voices"
"${runtime}/bin/python" -m piper.download_voices \
  --download-dir "${chirp_data}/voices" en_US-ljspeech-medium

"${runtime}/bin/python" - "$plugin_root" "$install_root" <<'PY'
from pathlib import Path
import shutil
import sys

source, target = map(Path, sys.argv[1:])
target.mkdir(parents=True, exist_ok=True)
for name in ("src", "hooks", "scripts", ".codex-plugin", ".claude-plugin", "docs"):
    shutil.copytree(source / name, target / name, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
for name in ("README.md", "pyproject.toml", "MANIFEST.in", "LICENSE"):
    shutil.copy2(source / name, target / name)
PY

if [ "$mode" = codex ]; then
  printf '%s\n' 'Chirp runtime installed. Add the pi marketplace to Codex, install chirp@pi, then start a fresh session and review /hooks.'
else
  printf '%s\n' "Chirp runtime installed. Claude: claude --plugin-dir ${install_root}"
fi
