#!/bin/bash
cd "$(dirname "$0")"
if [ -x .venv/bin/python ]; then
  .venv/bin/python run_original.py
else
  python3 run_original.py
fi
