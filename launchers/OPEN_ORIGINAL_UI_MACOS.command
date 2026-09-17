#!/bin/bash
# Lives in launchers/; .venv and requirements-preview.txt live at the repo
# root one level up, so this must cd there before invoking anything relative.
cd "$(dirname "$0")/.."
if [ -x .venv/bin/python ]; then
  .venv/bin/python launchers/run_original.py
else
  python3 launchers/run_original.py
fi
