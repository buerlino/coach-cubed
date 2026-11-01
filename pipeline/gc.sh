#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# pipeline/gc.sh: tidies the pipeline's bookkeeping; pipeline.sh runs it after every third run, or run it by hand. Without --apply it
# only lists what it would do. It moves, never deletes, and never touches a tracked file, a branch or a worktree.
#
#   pipeline/gc.sh [--apply]
#
# - A finished run (.tasks/NNN-<id>/ whose pid is not alive and whose branch is gone, so it merged or was given up) moves to
#   .tasks/archive/<date>/. A run whose branch still exists stays: its worktree waits for a --no-worker rerun or for nordmu.
# - Selftest logs older than 2 days move there too.
# - It lists the worktrees under .claude/worktrees/wp-* whose branch is gone (left by a crash) for removal by hand.
set -euo pipefail
apply=0; [[ "${1:-}" == --apply ]] && apply=1
main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"; cd "$main"
tasks="${COACH_TASKS:-$main/.tasks}"
today="$(date +%F)"; arch="$tasks/archive/$today"
act() { if [[ $apply -eq 1 ]]; then "$@"; else echo "would: $*"; fi; }
mkdir -p "$tasks"
echo "# gc $today ($([[ $apply -eq 1 ]] && echo applied || echo dry run))"
for d in "$tasks"/[0-9][0-9][0-9]-*/; do
  [[ -d "$d" ]] || continue
  d="${d%/}"
  rp="$(cat "$d/pid" 2>/dev/null || true)"
  if [[ "$rp" =~ ^[1-9][0-9]*$ ]] && kill -0 "$rp" 2>/dev/null; then echo "- kept $d (its run, pid $rp, is alive)"; continue; fi
  b="$(head -n1 "$d/spec.md" 2>/dev/null | grep -oE 'on branch [^ ]+$' | cut -d' ' -f3 || true)"
  if [[ -n "$b" ]] && git show-ref --verify --quiet "refs/heads/$b"; then echo "- kept $d (branch $b exists)"; continue; fi
  act mkdir -p "$arch"; act mv "$d" "$arch/"; echo "- archived $d (branch ${b:-?} gone)"
done
while IFS= read -r f; do
  [[ -n "$f" ]] || continue; act mkdir -p "$arch"; act mv "$f" "$arch/"; echo "- archived $f (older than 2 days)"
done < <(find "$tasks" -maxdepth 1 -name 'selftest-*' -mtime +2 2>/dev/null | sort)
while IFS= read -r line; do
  w="${line%% *}"; b="${line#* }"
  [[ "$w" == "$main/.claude/worktrees/wp-"* ]] || continue
  git show-ref --verify --quiet "refs/heads/$b" || echo "- stale worktree $w (branch $b gone): git worktree remove $w"
done < <(git worktree list --porcelain | awk '/^worktree /{w=$2} /^branch /{sub("refs/heads/","",$2); print w" "$2}')
