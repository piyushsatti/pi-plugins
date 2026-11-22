#!/usr/bin/env bash
set -eu

# Run from a checkout, the sibling src/ wins. Installed as ~/.local/bin/chirp-hook, there is
# no sibling src/ and the runtime's own installed copy of chirp answers.
plugin_root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
if [ -d "${plugin_root}/src/chirp" ]; then
  export PYTHONPATH="${plugin_root}/src${PYTHONPATH:+:${PYTHONPATH}}"
fi
chirp_data="${CHIRP_DATA_DIR:-${XDG_DATA_HOME:-${HOME}/.local/share}/chirp}"
exec "${CHIRP_PYTHON:-${chirp_data}/venv/bin/python}" -m chirp hook
