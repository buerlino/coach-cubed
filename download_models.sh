#!/bin/bash
# Pulls the checkpoints vitpose_backend.py expects: torch/coco/vitpose-{size}-coco.pth
# (default sizes l + h) and yolov8/yolov8s.pt, mirroring the JunkyByte/easy_ViTPose
# HuggingFace repo's own layout under $COACH_MODEL_DIR — so the vitpose_backend.py
# paths (MODEL_DIR/torch/coco/..., MODEL_DIR/yolov8/...) need no translation.
# Plain curl against the public resolve URLs — no huggingface_hub / auth needed,
# no reason to add a runtime dependency for a script that runs once at setup.
#
# Usage:  ./download_models.sh            # sizes: l h (~3.7GB)
#         COACH_SIZES="l" ./download_models.sh   # just the small one (~1.2GB)
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

MODEL_DIR="${COACH_MODEL_DIR:-$HOME/models/easy_vitpose}"
SIZES="${COACH_SIZES:-l h}"
HF_BASE="https://huggingface.co/JunkyByte/easy_ViTPose/resolve/main"

mkdir -p "$MODEL_DIR/torch/coco" "$MODEL_DIR/yolov8"

fetch() {
	# $1 = repo-relative path (also the layout under MODEL_DIR), $2 = human label
	local rel="$1" label="$2"
	local dest="$MODEL_DIR/$rel"
	if [ -f "$dest" ]; then
		echo "== $label: already have $dest, skipping =="
		return
	fi
	echo "== $label -> $dest =="
	# -C - resumes a partial .part file; final mv is atomic so a killed download
	# never leaves vitpose_backend.py looking at a truncated checkpoint.
	curl -fL -C - --progress-bar -o "$dest.part" "$HF_BASE/$rel"
	mv "$dest.part" "$dest"
}

for size in $SIZES; do
	fetch "torch/coco/vitpose-$size-coco.pth" "vitpose-$size-coco"
done
fetch "yolov8/yolov8s.pt" "yolov8s"

echo
echo "done. checkpoints under $MODEL_DIR:"
find "$MODEL_DIR" -name "*.pth" -o -name "*.pt" | sort
