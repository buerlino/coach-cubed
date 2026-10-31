#!/bin/bash
# Pulls the checkpoints the pose backend expects:
#
#   pose      torch/coco/vitpose-{size}-coco.pth (default sizes l + h) and
#             yolov8/yolov8s.pt, mirroring the JunkyByte/easy_ViTPose
#             HuggingFace repo's own layout under $COACH_MODEL_DIR — so the
#             src/vitpose_backend.py paths (MODEL_DIR/torch/coco/...,
#             MODEL_DIR/yolov8/...) need no translation.
#
# The bar and plate detectors (Grounding DINO, SAM 3) were parked on
# 2026-10-31; their download path is parked/bar-detection/download_models.sh.
#
# Plain curl against the public resolve URLs — no huggingface_hub / auth
# needed, no reason to add a runtime dependency for a script that runs once at
# setup.
#
# Usage:  ./scripts/download_models.sh                    # both pose sizes
#         COACH_SIZES="l" ./scripts/download_models.sh    # just the small pose one (~1.2GB)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

MODEL_DIR="${COACH_MODEL_DIR:-$HOME/models/easy_vitpose}"
SIZES="${COACH_SIZES:-l h}"
HF_BASE="https://huggingface.co/JunkyByte/easy_ViTPose/resolve/main"

mkdir -p "$MODEL_DIR/torch/coco" "$MODEL_DIR/yolov8"

fetch() {
	# $1 = source base URL, $2 = repo-relative path (also the on-disk layout),
	# $3 = destination root, $4 = human label.
	local base="$1" rel="$2" root="$3" label="$4"
	local dest="$root/$rel"
	if [ -f "$dest" ]; then
		echo "== $label: already have $dest, skipping =="
		return
	fi
	echo "== $label -> $dest =="
	# -C - resumes a partial .part file; final mv is atomic so a killed download
	# never leaves a backend looking at a truncated checkpoint.
	curl -fL -C - --progress-bar -o "$dest.part" "$base/$rel"
	mv "$dest.part" "$dest"
}

echo "=== pose (ViTPose + YOLOv8) ==="
for size in $SIZES; do
	fetch "$HF_BASE" "torch/coco/vitpose-$size-coco.pth" "$MODEL_DIR" "vitpose-$size-coco"
done
fetch "$HF_BASE" "yolov8/yolov8s.pt" "$MODEL_DIR" "yolov8s"

echo
echo "done."
echo "pose checkpoints under $MODEL_DIR:"
find "$MODEL_DIR" \( -name "*.pth" -o -name "*.pt" \) | sort
