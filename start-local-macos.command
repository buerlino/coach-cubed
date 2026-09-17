#!/bin/bash
cd "$(dirname "$0")"
if [ -x .venv/bin/python ]; then
  .venv/bin/python run_local.py
else
  python3 run_local.py
fi
