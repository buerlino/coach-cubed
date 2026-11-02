#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Exclusive locks for shared resources (the merge queue, heavy host CPU use, the phone). Ported from pascaline's tools/devlock.sh.
#
#   pipeline/devlock.sh acquire <resource> <owner> [wait_seconds]   # exit 0 = you hold it, 1 = busy
#   pipeline/devlock.sh release <resource> <owner>
#   pipeline/devlock.sh status
#   pipeline/devlock.sh holder <resource>  # the owner of a held lock, or nothing
#   pipeline/devlock.sh break <resource>   # by hand only, for a lock whose owner is gone
#   pipeline/devlock.sh slice <name> <cmd...>
#       one piece of a long job: host-cpu for <name>, <cmd> under timeout COACH_SLICE_MAX (600 s), host-cpu released after;
#       exit = cmd's (124 = over the limit, 1 = host-cpu busy for COACH_SLICE_WAIT, 1800 s). Nobody holds host-cpu longer than
#       10 minutes at a time: a longer job is a loop of slices, so a waiting job gets the lock between them.
#
# Two places hold locks (directories: mkdir is atomic):
# - coach's own (integ, nodemods, branch-<branch>) in the main checkout's .coord/locks, shared by every git worktree;
# - every other resource (host-cpu, an adb serial) is the machine's: COACH_SHARED_LOCKS, by default pascaline's
#   .coord/locks next to this repo when it exists, so a coach job and a pascaline night never hold the CPU or the phone at once.
# COACH_COORD overrides the main checkout's .coord (and then both places, unless COACH_SHARED_LOCKS is set).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The main checkout's .coord from any worktree: `git rev-parse --git-common-dir` is its .git.
COMMON="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [[ -n "$COMMON" ]]; then MAIN_REPO="$(dirname "$COMMON")"; else MAIN_REPO="$REPO"; fi
LOCAL="${COACH_COORD:-$MAIN_REPO/.coord}/locks"
if [[ -n "${COACH_SHARED_LOCKS:-}" ]]; then SHARED="$COACH_SHARED_LOCKS"
elif [[ -z "${COACH_COORD:-}" && -d "$MAIN_REPO/../pascaline/.coord/locks" ]]; then SHARED="$(cd "$MAIN_REPO/../pascaline/.coord/locks" && pwd)"
else SHARED="$LOCAL"; fi
mkdir -p "$LOCAL" "$SHARED"
# locks_of <resource>: the directory that holds its lock
locks_of() { case "$1" in integ|nodemods|branch-*) echo "$LOCAL";; *) echo "$SHARED";; esac; }
cmd="${1:?usage: devlock.sh acquire|release|status|holder|break|slice ...}"

case "$cmd" in
  acquire)
    res="${2:?resource}" owner="${3:?owner}" wait="${4:-0}" start=$SECONDS
    LOCKS="$(locks_of "$res")"
    while ! mkdir "$LOCKS/$res" 2>/dev/null; do
      # A lock whose recorded pid is gone on this host is broken; one without a pid only by hand. Breakers take a guard,
      # re-read the pid inside it and move the lock aside, so two waiters that saw the same dead pid never delete a lock
      # another waiter has just taken (pascaline A35).
      lpid="$(cat "$LOCKS/$res/pid" 2>/dev/null || true)"; lhost="$(cat "$LOCKS/$res/host" 2>/dev/null || true)"
      if [[ "$lpid" =~ ^[1-9][0-9]*$ && "$lhost" == "$(hostname)" ]] && ! kill -0 "$lpid" 2>/dev/null \
         && mkdir "$LOCKS/.breaking-$res" 2>/dev/null; then
        if [[ "$(cat "$LOCKS/$res/pid" 2>/dev/null || true)" == "$lpid" ]] && mv "$LOCKS/$res" "$LOCKS/.stale-$res.$$" 2>/dev/null; then
          rm -rf "${LOCKS:?}/.stale-$res.$$"
          echo "broke stale lock $res (pid $lpid gone)" >&2
        fi
        rmdir "$LOCKS/.breaking-$res" 2>/dev/null || true
        continue
      fi
      if (( SECONDS - start >= wait )); then
        echo "busy: $res held by $(cat "$LOCKS/$res/owner" 2>/dev/null || echo '?')" >&2
        exit 1
      fi
      # A waiter leaves a marker (its pid) while it polls, so a `slice` that just released the lock hands it over (pascaline A58).
      if [[ -z "${wmark:-}" ]]; then wmark="$LOCKS/.waiting-$res.$$"; : > "$wmark"; trap 'rm -f "$wmark"' EXIT; fi
      sleep 5
    done
    [[ -z "${wmark:-}" ]] || { rm -f "$wmark"; wmark=""; }
    printf '%s\n' "$owner" > "$LOCKS/$res/owner"
    date -Iseconds > "$LOCKS/$res/since"
    # A pid is recorded only when the caller opts in with COACH_LOCK_PID=<its own long-lived pid> (the pipeline exports $$);
    # an agent's or an interactive shell's call comes from a short-lived shell, so it records none.
    hpid="${COACH_LOCK_PID:-0}"
    if [[ "$hpid" =~ ^[1-9][0-9]*$ ]]; then hostname > "$LOCKS/$res/host"; echo "$hpid" > "$LOCKS/$res/pid"; fi
    echo "acquired $res for $owner"
    ;;
  release)
    res="${2:?resource}" owner="${3:?owner}"
    LOCKS="$(locks_of "$res")"
    holder="$(cat "$LOCKS/$res/owner" 2>/dev/null || true)"
    [[ "$holder" == "$owner" ]] || { echo "not releasing $res: held by '${holder:-nobody}', not $owner" >&2; exit 1; }
    rm -rf "${LOCKS:?}/$res"
    echo "released $res"
    ;;
  holder)
    res="${2:?resource}"
    cat "$(locks_of "$res")/$res/owner" 2>/dev/null || true
    ;;
  status)
    shopt -s nullglob
    any=0
    for dir in "$LOCAL" "$SHARED"; do
      [[ "$dir" != "$SHARED" || "$SHARED" != "$LOCAL" ]] || continue
      where="coach"; [[ "$dir" == "$LOCAL" ]] || where="machine"
      for d in "$dir"/*/; do
        any=1; r="$(basename "$d")"
        echo "$r ($where): $(cat "$d/owner" 2>/dev/null) since $(cat "$d/since" 2>/dev/null)$([[ -f "$d/pid" ]] && echo ", pid $(cat "$d/pid") on $(cat "$d/host" 2>/dev/null)")"
      done
    done
    (( any )) || echo "no locks held"
    ;;
  break)
    res="${2:?resource}"
    LOCKS="$(locks_of "$res")"
    rm -rf "${LOCKS:?}/$res"
    echo "broke lock $res"
    ;;
  slice)
    name="${2:?name}"; shift 2
    (( $# )) || { echo "usage: devlock.sh slice <name> <cmd...>" >&2; exit 2; }
    max="${COACH_SLICE_MAX:-600}"; swait="${COACH_SLICE_WAIT:-1800}"; self="$(readlink -f "${BASH_SOURCE[0]}")"
    LOCKS="$(locks_of host-cpu)"
    COACH_LOCK_PID=$$ "$self" acquire host-cpu "$name" "$swait" >&2 || exit 1
    cp=""; rc=0
    # After the release a live waiter (marker .waiting-host-cpu.<pid>) gets the lock before this slice returns: waiters poll every
    # 5 s, so a loop of slices would take it back within milliseconds. Wait (at most 12 s) until someone holds it.
    handoff() {
      local m w=0 any=0
      for m in "$LOCKS"/.waiting-host-cpu.*; do [[ -e "$m" ]] && kill -0 "${m##*.}" 2>/dev/null && any=1; done
      (( any )) || return 0
      while [[ ! -d "$LOCKS/host-cpu" ]] && (( w < 120 )); do sleep 0.1; w=$((w + 1)); done
    }
    trap '[[ -z "$cp" ]] || { kill -TERM "$cp" 2>/dev/null; wait "$cp" 2>/dev/null || true; }; "$self" release host-cpu "$name" >&2 || true; handoff' EXIT
    trap 'exit 143' TERM HUP INT
    timeout -k 30 "$max" "$@" <&0 & cp=$!   # <&0: a background job would get /dev/null; the job may read a pipe
    wait "$cp" || rc=$?
    cp=""
    if [[ $rc -eq 124 ]]; then echo "slice $name: '$1' ran over $max s and was stopped; host-cpu is released; continue in the next slice" >&2; fi
    exit "$rc"
    ;;
  *) echo "unknown command $cmd" >&2; exit 2 ;;
esac
