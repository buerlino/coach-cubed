#!/usr/bin/env bash
# Fetches MoveNet SinglePose Thunder v4's TF.js weights into app/models/
# (gitignored), checked against their SHA-256: Google's upload on Kaggle,
# the spike's pinned source (spike/pose-bench/fetch-models.sh), licence
# Apache-2.0 (THIRD_PARTY.md, "In the new app").
#   app/tools/fetch-models.sh
# The archive is kept in the cache outside the repo ($XDG_CACHE_HOME/coach/
# downloads/, by default ~/.cache/coach/downloads/), so a second run fetches
# nothing; app/models/movenet-thunder-4/ holds only model.json and its shards,
# which assemble.mjs copies into dist/.
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}"
[[ "$CACHE" = /* ]] || CACHE="$HOME/.cache"
DL="$CACHE/coach/downloads"
mkdir -p "$DL"

# The unpacking folder sits in app/models/ (the same filesystem, so the final
# mv is a rename), which assemble.mjs copies whole into dist/: whatever stops
# the script (tar or a full disk under set -e, a signal) removes it.
tmp=""
trap '[[ -z "$tmp" ]] || rm -rf -- "$tmp"' EXIT
trap 'exit 1' HUP INT TERM

# name | url | sha256 of the archive
MODELS=(
  "movenet-thunder-4|https://www.kaggle.com/api/v1/models/google/movenet/tfJs/singlepose-thunder/4/download|9ab8399bc82cd3c5cc0b61ea3b397512b73dde920590ac869872637eff97e522"
)

for row in "${MODELS[@]}"; do
  IFS='|' read -r name url sha <<<"$row"
  tgz="$DL/$name.tgz"
  if [[ ! -f "$tgz" ]]; then
    echo "fetching $name"
    curl -fsSL --retry 3 --max-time 600 -o "$tgz.part" "$url"
    mv "$tgz.part" "$tgz"
  fi
  got=$(sha256sum "$tgz" | cut -d' ' -f1)
  if [[ "$got" != "$sha" ]]; then
    echo "SHA-256 MISMATCH for $name: $got, expected $sha (the archive stays at $tgz)" >&2
    exit 1
  fi
  echo "$name.tgz  $(stat -c %s "$tgz") bytes  sha256 ok"
  dest="$APP/models/$name"
  # Unpacked again on every run (12 MB, under a second), so app/models/
  # always matches the checked archive: into a new empty folder first, and
  # only model.json and its .bin shards, flat, are taken.
  mkdir -p "$APP/models"
  tmp="$(mktemp -d "$APP/models/.$name.XXXXXX")"
  tar -xzf "$tgz" --no-same-owner --no-same-permissions -C "$tmp"
  mapfile -t files < <(cd "$tmp" && find . -type f | sed 's|^\./||' | sort)
  for f in "${files[@]}"; do
    [[ "$f" == model.json || "$f" =~ ^group[0-9]+-shard[0-9]+of[0-9]+\.bin$ ]] || {
      echo "unexpected file in $name.tgz: $f" >&2; exit 1; }
  done
  [[ -f "$tmp/model.json" ]] || { echo "$name.tgz has no model.json" >&2; exit 1; }
  if [[ -d "$dest" ]]; then rm -r -- "$dest"; fi
  mv "$tmp" "$dest"
  tmp=""
  chmod 755 "$dest"; chmod 644 "$dest"/*
  echo "  -> app/models/$name/ ${files[*]}"
done
