#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# PARKED (2026-10-31, restructuring step 2.3): scripts/download_models.sh as it
# was when bar detection was parked, Grounding DINO and SAM 3 sections
# included. The live script keeps only the pose part. Unmaintained; kept so
# reviving the detectors has its download path. ROOT below is the repo root.
#
# Pulls the checkpoints the backends expect.
#
#   pose      torch/coco/vitpose-{size}-coco.pth (default sizes l + h) and
#             yolov8/yolov8s.pt, mirroring the JunkyByte/easy_ViTPose
#             HuggingFace repo's own layout under $COACH_MODEL_DIR — so the
#             src/vitpose_backend.py paths (MODEL_DIR/torch/coco/...,
#             MODEL_DIR/yolov8/...) need no translation. Always fetched.
#   equipment Grounding DINO, for src/equipment_backend.py's barbell/plate
#             prompts. ~700MB, and only the video tab's "detect bar & plates"
#             tickbox uses it, so this one is OFFERED rather than assumed.
#   sam3      SAM 3 (facebook/sam3), ~3.4GB. Text-promptable segmentation AND
#             tracking, so it can do the equipment pass with real masks and
#             frame-to-frame identity instead of independent per-frame boxes.
#             Also OFFERED. Not yet wired into equipment_backend.py — this
#             fetches the weights so the swap can be done and measured offline.
#
# Plain curl against the public resolve URLs — no huggingface_hub / auth
# needed, no reason to add a runtime dependency for a script that runs once at
# setup. That matters more for the detector than for the pose weights: without
# it, transformers would fetch the model from the hub on first use, which means
# the first video analysis on a fresh machine either stalls on a 700MB download
# or fails outright with no network. Fetching it here puts it on disk where
# equipment_backend.py looks first, and the app then runs fully offline.
#
# SAM 3 is the one exception to "no auth": facebook/sam3 is a GATED repo
# (gated: manual), so an anonymous GET returns 401 no matter how public the URL
# looks. That block sends a bearer token — $HF_TOKEN, else the one `hf auth
# login` leaves in ~/.cache/huggingface/token. The gate is per-ACCOUNT and
# granted by hand, so having a token is necessary but not sufficient: the
# account behind it must also have been approved at
# https://huggingface.co/facebook/sam3. Access is checked with a 1-byte ranged
# GET before the 3.4GB starts, so a missing or unapproved token fails in a
# second with an actionable message instead of part-way through the download.
#
# Usage:  ./scripts/download_models.sh              # pose weights, then ask about each optional model
#         COACH_SIZES="l" ./scripts/download_models.sh    # just the small pose one (~1.2GB)
#         COACH_DINO=1 ./scripts/download_models.sh    # take Grounding DINO, don't ask
#         COACH_DINO=0 ./scripts/download_models.sh    # skip Grounding DINO, don't ask
#         COACH_SAM3=1 ./scripts/download_models.sh    # take SAM 3, don't ask
#         COACH_SAM3=0 ./scripts/download_models.sh    # skip SAM 3, don't ask
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

MODEL_DIR="${COACH_MODEL_DIR:-$HOME/models/easy_vitpose}"
SIZES="${COACH_SIZES:-l h}"
HF_BASE="https://huggingface.co/JunkyByte/easy_ViTPose/resolve/main"

# Must match equipment_backend.DINO_DIR's default, or the app won't find
# what this puts on disk.
DINO_DIR="${COACH_DINO_DIR:-$HOME/models/grounding-dino-base}"
DINO_BASE="https://huggingface.co/IDEA-Research/grounding-dino-base/resolve/main"
# Everything from_pretrained() opens, and nothing else. Notably NOT
# pytorch_model.bin: the repo ships the same weights twice, as a .bin and as
# safetensors, and transformers prefers the safetensors — taking both would
# double the download for a file that would never be read.
DINO_FILES="config.json model.safetensors preprocessor_config.json \
tokenizer.json tokenizer_config.json special_tokens_map.json vocab.txt"

# Must match equipment_backend's SAM3_DIR default once SAM 3 is wired in.
SAM3_DIR="${COACH_SAM3_DIR:-$HOME/models/sam3}"
SAM3_REPO="facebook/sam3"
SAM3_BASE="https://huggingface.co/$SAM3_REPO/resolve/main"
# Same "only what from_pretrained opens" rule as above, and the same trap: the
# repo carries sam3.pt, which is these very weights in Meta's native format and
# is never read by transformers. Taking it would double a 3.4GB download.
# LICENSE comes along because this one is gated behind accepting it.
SAM3_FILES="config.json model.safetensors processor_config.json tokenizer.json \
tokenizer_config.json special_tokens_map.json merges.txt vocab.json LICENSE"

mkdir -p "$MODEL_DIR/torch/coco" "$MODEL_DIR/yolov8"

# Bearer token for the gated block only; empty for everything else, which is
# public and must keep working on a box that has never logged into HuggingFace.
AUTH_TOKEN=""

hf_token() {
	# $HF_TOKEN wins, else whatever `hf auth login` wrote. Printed, not echoed,
	# so a trailing newline in the file can't end up inside the header value.
	if [ -n "$HF_TOKEN" ]; then printf '%s' "$HF_TOKEN"; return 0; fi
	local f
	for f in "${HF_HOME:-$HOME/.cache/huggingface}/token" "$HOME/.huggingface/token"; do
		if [ -s "$f" ]; then tr -d ' \t\n\r' < "$f"; return 0; fi
	done
	return 1
}

fetch() {
	# $1 = source base URL, $2 = repo-relative path (also the on-disk layout),
	# $3 = destination root, $4 = human label. Sends $AUTH_TOKEN if one is set.
	local base="$1" rel="$2" root="$3" label="$4"
	local dest="$root/$rel"
	if [ -f "$dest" ]; then
		echo "== $label: already have $dest, skipping =="
		return
	fi
	echo "== $label -> $dest =="
	# -C - resumes a partial .part file; final mv is atomic so a killed download
	# never leaves a backend looking at a truncated checkpoint.
	local args=(-fL -C - --progress-bar)
	[ -n "$AUTH_TOKEN" ] && args+=(-H "Authorization: Bearer $AUTH_TOKEN")
	curl "${args[@]}" -o "$dest.part" "$base/$rel"
	mv "$dest.part" "$dest"
}

echo "=== pose (ViTPose + YOLOv8) ==="
for size in $SIZES; do
	fetch "$HF_BASE" "torch/coco/vitpose-$size-coco.pth" "$MODEL_DIR" "vitpose-$size-coco"
done
fetch "$HF_BASE" "yolov8/yolov8s.pt" "$MODEL_DIR" "yolov8s"

echo
echo "=== equipment (Grounding DINO) ==="
want_dino=""
if [ -f "$DINO_DIR/model.safetensors" ]; then
	echo "already have $DINO_DIR, skipping"
elif [ -n "$COACH_DINO" ]; then
	# Explicit answer from the environment — for unattended installs, where a
	# prompt would hang forever.
	[ "$COACH_DINO" != "0" ] && want_dino=1
	echo "COACH_DINO=$COACH_DINO"
elif [ -t 0 ]; then
	echo "Grounding DINO (~700MB) powers the 'detect bar & plates' overlay on the"
	echo "video tab. Without it, everything else still works; that one tickbox doesn't."
	read -r -p "download it now? [Y/n] " reply
	case "$reply" in [Nn]*) ;; *) want_dino=1 ;; esac
else
	# Non-interactive with no COACH_DINO set: skip rather than silently
	# spend 700MB of someone's bandwidth. Say so, and say how to get it.
	echo "not a terminal and COACH_DINO unset — skipping."
	echo "  get it later with:  COACH_DINO=1 ./scripts/download_models.sh"
fi

if [ -n "$want_dino" ]; then
	mkdir -p "$DINO_DIR"
	for f in $DINO_FILES; do
		fetch "$DINO_BASE" "$f" "$DINO_DIR" "grounding-dino/$f"
	done
fi

echo
echo "=== sam3 (SAM 3) ==="
want_sam3=""
if [ -f "$SAM3_DIR/model.safetensors" ]; then
	echo "already have $SAM3_DIR, skipping"
elif [ -n "$COACH_SAM3" ]; then
	[ "$COACH_SAM3" != "0" ] && want_sam3=1
	echo "COACH_SAM3=$COACH_SAM3"
elif [ -t 0 ]; then
	echo "SAM 3 (~3.4GB) is text-promptable segmentation + tracking — masks and"
	echo "frame-to-frame identity for the bar and plates, rather than per-frame boxes."
	echo "Gated: needs a HuggingFace token whose account was granted access at"
	echo "  https://huggingface.co/$SAM3_REPO"
	read -r -p "download it now? [y/N] " reply
	case "$reply" in [Yy]*) want_sam3=1 ;; esac
else
	echo "not a terminal and COACH_SAM3 unset — skipping."
	echo "  get it later with:  COACH_SAM3=1 ./scripts/download_models.sh"
fi

if [ -n "$want_sam3" ]; then
	if ! AUTH_TOKEN="$(hf_token)"; then
		echo "!! no HuggingFace token found — $SAM3_REPO is gated and can't be fetched." >&2
		echo "   set HF_TOKEN=..., or run:  hf auth login" >&2
		echo "   the token's account also needs access granted at" >&2
		echo "     https://huggingface.co/$SAM3_REPO" >&2
		exit 1
	fi
	# One ranged byte before committing to 3.4GB: distinguishes "no access" from
	# a download that dies half way through for some unrelated reason.
	code="$(curl -sSL -o /dev/null -w '%{http_code}' -r 0-0 \
		-H "Authorization: Bearer $AUTH_TOKEN" "$SAM3_BASE/config.json" || echo 000)"
	case "$code" in
		200|206)
			mkdir -p "$SAM3_DIR"
			for f in $SAM3_FILES; do
				fetch "$SAM3_BASE" "$f" "$SAM3_DIR" "sam3/$f"
			done ;;
		401|403)
			echo "!! HTTP $code — your token is valid but this account hasn't been granted" >&2
			echo "   access to $SAM3_REPO. Request it (manual approval) at" >&2
			echo "     https://huggingface.co/$SAM3_REPO" >&2
			exit 1 ;;
		*)
			echo "!! HTTP $code reaching $SAM3_REPO — network problem, not a permissions one." >&2
			exit 1 ;;
	esac
	AUTH_TOKEN=""   # never leaks into a later public fetch
fi

echo
echo "done."
echo "pose checkpoints under $MODEL_DIR:"
find "$MODEL_DIR" \( -name "*.pth" -o -name "*.pt" \) | sort
if [ -f "$DINO_DIR/model.safetensors" ]; then
	echo "grounding-dino under $DINO_DIR"
else
	echo "grounding-dino: not installed — 'detect bar & plates' will be unavailable"
fi
if [ -f "$SAM3_DIR/model.safetensors" ]; then
	echo "sam3 under $SAM3_DIR"
else
	echo "sam3: not installed (optional, not yet wired into the backend)"
fi
