#!/usr/bin/env bash
# Download a YouTube video/playlist and extract one clip per weightlifting
# attempt (grip to lockout). See README.md for details.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
REQ_FILE="$SCRIPT_DIR/requirements.txt"
TEMPLATES_DIR="$SCRIPT_DIR/templates"

usage() {
  cat <<'EOF'
Usage: ./clip.sh <youtube-url> [options]
       ./clip.sh --local <video-or-dir> [options]

Downloads a YouTube video or playlist (best video quality, no audio needed)
and extracts one clip per weightlifting attempt, from the lifter taking the
bar through the top/lockout position, into Clips/<session>/ next to the
downloaded videos.

Options:
  -o, --out DIR               Output directory (default: ./downloads)
  --local PATH                Skip downloading; process this local video file,
                               or every video file in this directory, instead
                               of a URL
  --cookies-from-browser NAME  Pass browser cookies to yt-dlp (e.g. firefox),
                               useful if YouTube responds with a bot check
  --workers N                  Parallel ffmpeg workers for cutting (default: 8)
  --delete-source              Delete each downloaded video after its clips
                               are cut (default: keep the source video)
  --review                     Also save contact-sheet PNGs per session so you
                               can eyeball the results before trusting them
  -h, --help                    Show this help
EOF
}

URL=""; LOCAL=""; OUT="./downloads"; COOKIES=""; WORKERS=8; DELETE_SOURCE=0; REVIEW=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out) OUT="$2"; shift 2 ;;
    --local) LOCAL="$2"; shift 2 ;;
    --cookies-from-browser) COOKIES="$2"; shift 2 ;;
    --workers) WORKERS="$2"; shift 2 ;;
    --delete-source) DELETE_SOURCE=1; shift ;;
    --review) REVIEW=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) if [ -z "$URL" ]; then URL="$1"; fi; shift ;;
  esac
done
if [ -z "$URL" ] && [ -z "$LOCAL" ]; then usage; exit 1; fi

# --- system dependencies -----------------------------------------------
for c in ffmpeg ffprobe python3; do
  if ! command -v "$c" >/dev/null 2>&1; then
    echo "error: '$c' is required but not found on PATH." >&2
    echo "Install it with your system package manager (e.g. 'sudo dnf install ffmpeg' or 'sudo apt install ffmpeg') and re-run." >&2
    exit 1
  fi
done

# --- first-run python env setup -----------------------------------------
if [ ! -d "$VENV_DIR" ]; then
  echo "[setup] creating Python environment in $VENV_DIR ..."
  python3 -m venv "$VENV_DIR"
fi
HASH_FILE="$VENV_DIR/.requirements.sha256"
NEW_HASH="$(sha256sum "$REQ_FILE" | cut -d' ' -f1)"
if [ ! -f "$HASH_FILE" ] || [ "$(cat "$HASH_FILE" 2>/dev/null)" != "$NEW_HASH" ]; then
  echo "[setup] installing/updating dependencies from requirements.txt ..."
  "$VENV_DIR/bin/pip" install -q --upgrade pip
  "$VENV_DIR/bin/pip" install -q -r "$REQ_FILE"
  echo "$NEW_HASH" > "$HASH_FILE"
fi
PY="$VENV_DIR/bin/python"
YTDLP="$VENV_DIR/bin/yt-dlp"

mkdir -p "$OUT"

# --- gather the list of videos to process --------------------------------
VIDEOS=()
if [ -n "$LOCAL" ]; then
  if [ -d "$LOCAL" ]; then
    while IFS= read -r -d '' f; do VIDEOS+=("$f"); done < <(find "$LOCAL" -maxdepth 1 -type f \( -iname '*.mp4' -o -iname '*.webm' -o -iname '*.mkv' \) -print0 | sort -z)
  else
    VIDEOS+=("$LOCAL")
  fi
else
  echo "[download] fetching from $URL ..."
  COOKIE_ARGS=()
  if [ -n "$COOKIES" ]; then COOKIE_ARGS=(--cookies-from-browser "$COOKIES"); fi
  set +e
  "$YTDLP" -f bestvideo --yes-playlist --continue --no-overwrites --newline \
    "${COOKIE_ARGS[@]}" \
    -o "$OUT/%(playlist_title,title)s/%(playlist_index)02d - %(title)s [%(id)s].%(ext)s" \
    "$URL"
  YT_STATUS=$?
  set -e
  if [ $YT_STATUS -ne 0 ]; then
    echo "[download] warning: yt-dlp reported errors (exit $YT_STATUS)." >&2
    echo "  If items failed with 'Sign in to confirm you're not a bot', re-run with" >&2
    echo "  --cookies-from-browser firefox (or your browser). Continuing with whatever downloaded." >&2
  fi
  while IFS= read -r -d '' f; do VIDEOS+=("$f"); done < <(find "$OUT" -type f \( -iname '*.mp4' -o -iname '*.webm' -o -iname '*.mkv' \) -print0 | sort -z)
fi

if [ ${#VIDEOS[@]} -eq 0 ]; then
  echo "No video files found to process." >&2
  exit 1
fi
echo "[process] ${#VIDEOS[@]} video(s) to process"

# --- run the detect+cut pipeline on each video ---------------------------
REVIEW_FLAG=(); if [ "$REVIEW" -eq 1 ]; then REVIEW_FLAG=(--review); fi
for VIDEO in "${VIDEOS[@]}"; do
  BASE="$(basename "$VIDEO")"
  SESSION="$(echo "${BASE%.*}" | sed -E 's/ *\[[A-Za-z0-9_-]{6,}\]$//; s/^[0-9]+ - //' | tr -s ' ' '_' | tr -cd 'A-Za-z0-9_-')"
  [ -z "$SESSION" ] && SESSION="video"
  "$PY" "$SCRIPT_DIR/src/pipeline.py" "$VIDEO" \
    --outdir "$OUT" --session "$SESSION" --templates "$TEMPLATES_DIR" \
    --workers "$WORKERS" "${REVIEW_FLAG[@]}"
  if [ "$DELETE_SOURCE" -eq 1 ]; then
    echo "[cleanup] deleting source $VIDEO"
    rm -f "$VIDEO"
  fi
done

echo "[done] clips are in $OUT/Clips/"
find "$OUT/Clips" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | while read -r d; do
  n=$(find "$d" -name '*.mp4' | wc -l)
  echo "  $(basename "$d"): $n clips"
done
