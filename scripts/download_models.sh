#!/bin/bash
# Pulls the checkpoints the backends expect.
#
#   pose      torch/coco/vitpose-{size}-coco.pth (default sizes l + h) and
#             yolov8/yolov8s.pt, mirroring the JunkyByte/easy_ViTPose
#             HuggingFace repo's own layout under $COACH_MODEL_DIR — so the
#             src/vitpose_backend.py paths (MODEL_DIR/torch/coco/...,
#             MODEL_DIR/yolov8/...) need no translation. Always fetched.
#   equipment CLIPSeg, for src/equipment_backend.py's barbell/plate prompts.
#             ~600MB, and only the video tab's "detect bar & plates" tickbox
#             uses it, so this one is OFFERED rather than assumed.
#
# Plain curl against the public resolve URLs — no huggingface_hub / auth
# needed, no reason to add a runtime dependency for a script that runs once at
# setup. That matters more for CLIPSeg than for the pose weights: without it,
# transformers would fetch the model from the hub on first use, which means the
# first video analysis on a fresh machine either stalls on a 600MB download or
# fails outright with no network. Fetching it here puts it on disk where
# equipment_backend.py looks first, and the app then runs fully offline.
#
# Usage:  ./scripts/download_models.sh              # pose weights, then ask about CLIPSeg
#         COACH_SIZES="l" ./scripts/download_models.sh    # just the small pose one (~1.2GB)
#         COACH_CLIPSEG=1 ./scripts/download_models.sh    # take CLIPSeg, don't ask
#         COACH_CLIPSEG=0 ./scripts/download_models.sh    # skip CLIPSeg, don't ask
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

MODEL_DIR="${COACH_MODEL_DIR:-$HOME/models/easy_vitpose}"
SIZES="${COACH_SIZES:-l h}"
HF_BASE="https://huggingface.co/JunkyByte/easy_ViTPose/resolve/main"

# Must match equipment_backend.CLIPSEG_DIR's default, or the app won't find
# what this puts on disk.
CLIPSEG_DIR="${COACH_CLIPSEG_DIR:-$HOME/models/clipseg-rd64-refined}"
CLIPSEG_BASE="https://huggingface.co/CIDAS/clipseg-rd64-refined/resolve/main"
# Everything from_pretrained() opens, and nothing else. Notably NOT
# pytorch_model.bin: the repo ships the same weights twice, as a .bin and as
# safetensors, and transformers prefers the safetensors — taking both would
# double the download for a file that would never be read.
CLIPSEG_FILES="config.json model.safetensors preprocessor_config.json \
tokenizer_config.json special_tokens_map.json vocab.json merges.txt"

mkdir -p "$MODEL_DIR/torch/coco" "$MODEL_DIR/yolov8"

fetch() {
	# $1 = source base URL, $2 = repo-relative path (also the on-disk layout),
	# $3 = destination root, $4 = human label
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
echo "=== equipment (CLIPSeg) ==="
want_clipseg=""
if [ -f "$CLIPSEG_DIR/model.safetensors" ]; then
	echo "already have $CLIPSEG_DIR, skipping"
elif [ -n "$COACH_CLIPSEG" ]; then
	# Explicit answer from the environment — for unattended installs, where a
	# prompt would hang forever.
	[ "$COACH_CLIPSEG" != "0" ] && want_clipseg=1
	echo "COACH_CLIPSEG=$COACH_CLIPSEG"
elif [ -t 0 ]; then
	echo "CLIPSeg (~600MB) powers the 'detect bar & plates' overlay on the video"
	echo "tab. Without it, everything else still works; that one tickbox doesn't."
	read -r -p "download it now? [Y/n] " reply
	case "$reply" in [Nn]*) ;; *) want_clipseg=1 ;; esac
else
	# Non-interactive with no COACH_CLIPSEG set: skip rather than silently
	# spend 600MB of someone's bandwidth. Say so, and say how to get it.
	echo "not a terminal and COACH_CLIPSEG unset — skipping."
	echo "  get it later with:  COACH_CLIPSEG=1 ./scripts/download_models.sh"
fi

if [ -n "$want_clipseg" ]; then
	mkdir -p "$CLIPSEG_DIR"
	for f in $CLIPSEG_FILES; do
		fetch "$CLIPSEG_BASE" "$f" "$CLIPSEG_DIR" "clipseg/$f"
	done
fi

echo
echo "done."
echo "pose checkpoints under $MODEL_DIR:"
find "$MODEL_DIR" \( -name "*.pth" -o -name "*.pt" \) | sort
if [ -f "$CLIPSEG_DIR/model.safetensors" ]; then
	echo "clipseg under $CLIPSEG_DIR"
else
	echo "clipseg: not installed — 'detect bar & plates' will be unavailable"
fi
