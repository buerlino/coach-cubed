#!/bin/bash
set -e
cd "$(dirname "$0")"
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-preview.txt
printf '\nSetup complete. Open start-local-macos.command to launch.\n'
