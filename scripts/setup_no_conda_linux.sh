#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Sets up a local Python 3 venv for CPU-only execution (no Conda needed).
set -e

# Anchor execution to project root
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== [1/6] Initializing submodules ==="
git submodule update --init --recursive

echo "=== [2/6] Creating virtual environment (.venv) ==="
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi
source .venv/bin/activate
pip install --upgrade pip

echo "=== [3/6] Installing PyTorch (CPU build) ==="
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu

echo "=== [4/6] Installing dependencies & easy_ViTPose ==="
pip install -r requirements.txt
pip install -e vendor/easy_ViTPose --no-deps

echo "=== [5/6] Downloading model checkpoints ==="
if [ -f "./scripts/download_models.sh" ]; then
    chmod +x ./scripts/download_models.sh
    ./scripts/download_models.sh
else
    echo "Warning: ./scripts/download_models.sh not found, skipping."
fi

echo "=== [6/6] Verifying environment ==="
python -c "
import sys
sys.path.insert(0, '$ROOT/src')
import torch
print('torch version   :', torch.__version__)
print('CUDA/ROCm active:', torch.cuda.is_available())
import vitpose_backend
print('model available :', vitpose_backend.available())
"

echo
echo "Setup complete. To use this environment, activate it with:"
echo "    source .venv/bin/activate"
