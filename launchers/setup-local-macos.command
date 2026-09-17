#!/bin/bash
set -e
# Lives in launchers/; .venv and requirements-preview.txt belong at the repo
# root one level up, so this must cd there before creating/using either.
cd "$(dirname "$0")/.."
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-preview.txt
printf '\nSetup complete. Open launchers/start-local-macos.command to launch.\n'
