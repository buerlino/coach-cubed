#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Tests for pipeline/gc.sh: a finished run whose branch is gone moves to the archive; a live run and a run whose branch exists stay;
# a dry run moves nothing. Touches nothing outside its temp dir.   Run: pipeline/gc.test.sh
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gc.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
m="$T/main"; mkdir -p "$m/pipeline"; cp "$SRC" "$m/pipeline/gc.sh"
git -C "$m" init -q -b main; git -C "$m" -c user.name=t -c user.email=t@example.org commit -q --allow-empty -m init
git -C "$m" branch wp/dirac-w2
export COACH_TASKS="$T/tasks"
mk() { mkdir -p "$COACH_TASKS/$1"; echo "# Pipeline run 1: x for dirac on branch $2" > "$COACH_TASKS/$1/spec.md"; echo "${3:-999999}" > "$COACH_TASKS/$1/pid"; }
mk 001-w1 wp/dirac-w1          # merged: branch gone, pid dead
mk 002-w2 wp/dirac-w2          # not merged: branch kept
sleep 300 & live=$!; mk 003-w3 wp/dirac-w3 "$live"   # running
out="$(cd "$m" && pipeline/gc.sh)"
[[ -d "$COACH_TASKS/001-w1" ]] || fail "the dry run moved a run"
grep -q 'would: mv' <<<"$out" || fail "the dry run does not say what it would move: $out"
(cd "$m" && pipeline/gc.sh --apply) >/dev/null
[[ -d "$COACH_TASKS/archive/$(date +%F)/001-w1" && ! -d "$COACH_TASKS/001-w1" ]] || fail "the merged run was not archived"
[[ -d "$COACH_TASKS/002-w2" ]] || fail "a run whose branch exists was archived"
[[ -d "$COACH_TASKS/003-w3" ]] || fail "a live run was archived"
kill "$live"; wait "$live" 2>/dev/null || true
echo "gc.test.sh: all passed"
