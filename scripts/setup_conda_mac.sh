#!/bin/bash
# Builds the 'coach' conda env on macOS (Apple Silicon): python 3.12 + torch
# (MPS) + this app's deps. macOS counterpart to setup_conda_linux.sh.
#
# The Linux script installs ROCm (or CUDA) torch wheels from the pytorch index.
# On a Mac neither exists: the stock PyPI/conda torch wheel IS the Metal (MPS)
# build, so we just `pip install torch torchvision` with no index override. The
# backends pick 'mps' automatically (see vitpose_backend._select_device) and
# fall back to CPU for any op Metal doesn't implement yet
# (PYTORCH_ENABLE_MPS_FALLBACK, set at import in both backends).
#
# Unpinned on purpose (same rationale as requirements.txt): let pip resolve
# whatever the current mac torch wants. The vendored inference code isn't
# version-specific.
#
# Usage:  ./scripts/setup_conda_mac.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV=coach
source "$(conda info --base)/etc/profile.d/conda.sh"

# Same reasoning as the Linux script: keep pip's multi-GB staging off any small
# tmpfs. On macOS /tmp is real disk, but pinning it here is harmless and keeps
# the two scripts parallel.
export TMPDIR="$ROOT/.tmp"
export PIP_CACHE_DIR="$HOME/.cache/pip"
mkdir -p "$TMPDIR" "$PIP_CACHE_DIR"

echo "=== [1/5] vendor/easy_ViTPose submodule ==="
git submodule update --init --recursive

echo "=== [2/5] conda env '$ENV' (python 3.12) ==="
conda create -y -n $ENV python=3.12

echo "=== [3/5] torch (macOS / MPS wheels from PyPI) ==="
conda run -n $ENV pip install torch torchvision

echo "=== [4/5] app + easy_ViTPose deps ==="
conda run -n $ENV pip install -r requirements.txt
conda run -n $ENV pip install -e vendor/easy_ViTPose --no-deps   # code only; deps come from requirements.txt above

echo "=== [5/5] verify torch (MPS) + checkpoints where the backends expect ==="
cat > "$TMPDIR/verify.py" <<PY
import sys
sys.path.insert(0, "$ROOT/src")   # python auto-adds the script's dir (.tmp), not this one
import torch
mps = getattr(torch.backends, "mps", None)
print("torch  :", torch.__version__)
print("mps    :", bool(mps and mps.is_available()))
import vitpose_backend
print("checkpoints:", vitpose_backend.available())
print("device :", vitpose_backend.DEVICE)
import equipment_backend
print("clipseg:", equipment_backend.model_source() if equipment_backend.available()
      else "MISSING (optional — see download_models.sh)")
PY
conda run -n $ENV python "$TMPDIR/verify.py"

echo
if [ -f "${COACH_MODEL_DIR:-$HOME/models/easy_vitpose}/torch/coco/vitpose-l-coco.pth" ]; then
	echo "done. run:  ./scripts/coach_launch.sh local   (resolves the coach env via conda run)"
else
	echo "done. checkpoints missing — run:  ./scripts/download_models.sh"
fi
