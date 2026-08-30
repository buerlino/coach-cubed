#!/bin/bash
# Builds the 'coach' conda env: python 3.12 + ROCm torch + this app's deps.
# Mirrors tecna/setup_conda_linux.sh (same box, same GPU, same reasoning) but
# a separate env — coach's dependency set is much smaller than tecna's and
# there's no reason to couple their upgrade cycles.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

ENV=coach
source "$(conda info --base)/etc/profile.d/conda.sh"

# Same /tmp-is-tmpfs gotcha as tecna: point pip's staging dir at real disk so a
# multi-GB wheel (torch) doesn't blow the RAM-backed /tmp quota.
export TMPDIR="$ROOT/.tmp"
export PIP_CACHE_DIR="$HOME/.cache/pip"
mkdir -p "$TMPDIR" "$PIP_CACHE_DIR"

echo "=== [1/4] conda env '$ENV' (python 3.12) ==="
conda create -y -n $ENV python=3.12

echo "=== [2/4] torch (ROCm 7.1 wheels) ==="
conda run -n $ENV pip install \
  --index-url https://download.pytorch.org/whl/rocm7.1 \
  "torch==2.13.0+rocm7.1" "torchvision==0.28.0+rocm7.1"

echo "=== [3/4] app + easy_ViTPose deps ==="
conda run -n $ENV pip install -r requirements.txt
conda run -n $ENV pip install -e vendor/easy_ViTPose --no-deps   # code only; deps come from requirements.txt above

echo "=== [4/4] verify ROCm torch + the checkpoints are where vitpose_backend.py expects ==="
cat > "$TMPDIR/verify.py" <<PY
import sys
sys.path.insert(0, "$ROOT")   # python auto-adds the *script's* dir (.tmp), not this one
import torch
assert torch.version.hip, f"NOT a ROCm build: {torch.__version__}"
print("torch  :", torch.__version__, "hip", torch.version.hip)
print("gpu    :", torch.cuda.get_device_name(0))
import vitpose_backend
print("checkpoints:", vitpose_backend.available())
print("device :", vitpose_backend.DEVICE)
PY
conda run -n $ENV python "$TMPDIR/verify.py"

echo
echo "done. run:  ./run_coach.sh"
