#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Tests for pipeline/devlock.sh: coach's own locks are shared by every worktree, the machine's (host-cpu, a phone) live in the shared
# directory, stale locks break, and a slice hands host-cpu to a waiter. Touches nothing outside its temp dir.
#   Run: pipeline/devlock.test.sh
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/devlock.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
unset COACH_COORD COACH_SHARED_LOCKS COACH_LOCK_PID
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$T/main/pipeline"
cp "$SRC" "$T/main/pipeline/devlock.sh"
git -C "$T/main" init -q -b main
git -C "$T/main" add pipeline/devlock.sh
git -C "$T/main" -c user.name=t -c user.email=t@example.org commit -q -m init
git -C "$T/main" worktree add -q "$T/wt" -b side
export COACH_SHARED_LOCKS="$T/shared"
M="$T/main/pipeline/devlock.sh"; W="$T/wt/pipeline/devlock.sh"

# 1. integ taken in a worktree is the main checkout's; host-cpu goes to the shared directory
"$W" acquire integ run-1 >/dev/null
[[ -d "$T/main/.coord/locks/integ" && ! -e "$T/wt/.coord" ]] || fail "integ is not in the main checkout's .coord"
"$W" acquire host-cpu run-1 >/dev/null
[[ -d "$T/shared/host-cpu" && ! -d "$T/main/.coord/locks/host-cpu" ]] || fail "host-cpu is not in the shared directory"
"$W" acquire 4d42e62f curie-1 >/dev/null
[[ -d "$T/shared/4d42e62f" ]] || fail "the phone's lock is not in the shared directory"
grep -q 'integ (coach): run-1' <<<"$("$M" status)" || fail "status misses integ: $("$M" status)"
grep -q 'host-cpu (machine): run-1' <<<"$("$M" status)" || fail "status misses host-cpu"
[[ "$("$M" holder host-cpu)" == run-1 ]] || fail "holder: $("$M" holder host-cpu)"
[[ -z "$("$M" holder nothing)" ]] || fail "holder of a free lock is not empty"

# 2. busy for others; only the owner releases
if "$M" acquire integ other 0 2>/dev/null; then fail "a second acquire of integ succeeded"; fi
if "$M" release host-cpu other 2>/dev/null; then fail "the wrong owner released host-cpu"; fi
"$M" release integ run-1 >/dev/null; "$M" release host-cpu run-1 >/dev/null; "$M" release 4d42e62f curie-1 >/dev/null
grep -q 'no locks held' <<<"$("$M" status)" || fail "locks left after release: $("$M" status)"

# 3. a lock records its pid only when the caller opts in; one whose pid is gone breaks at the next acquire
sleep 300 & live=$!
COACH_LOCK_PID=$$ "$M" acquire r1 me >/dev/null
[[ -f "$T/shared/r1/pid" ]] || fail "acquire with COACH_LOCK_PID writes no pid"
"$M" release r1 me >/dev/null
"$M" acquire r0 me >/dev/null; [[ ! -f "$T/shared/r0/pid" ]] || fail "acquire without COACH_LOCK_PID writes a pid"; "$M" release r0 me >/dev/null
mkdir -p "$T/shared/r2"; echo ghost > "$T/shared/r2/owner"; echo "$live" > "$T/shared/r2/pid"; hostname > "$T/shared/r2/host"
if "$M" acquire r2 new 0 2>/dev/null; then fail "a lock with a live pid was broken"; fi
kill "$live"; wait "$live" 2>/dev/null || true
out="$("$M" acquire r2 new 0 2>&1)" || fail "a lock with a dead pid was not broken: $out"
grep -q "broke stale lock r2 (pid $live gone)" <<<"$out" || fail "no stale-lock line: $out"
mkdir -p "$T/shared/r3"; echo old > "$T/shared/r3/owner"
if "$M" acquire r3 new 0 2>/dev/null; then fail "a lock without a pid was broken"; fi

# 4. COACH_COORD moves coach's locks (tests use it)
COACH_COORD="$T/private" "$M" acquire integ me >/dev/null
[[ -d "$T/private/locks/integ" ]] || fail "COACH_COORD ignored"

# 5. slice: runs the command under host-cpu, releases it, returns the command's exit code, stops it at the limit
"$M" slice s1 true || fail "slice true failed"
[[ ! -d "$T/shared/host-cpu" ]] || fail "slice left host-cpu held"
set +e; "$M" slice s2 sh -c 'exit 7' 2>/dev/null; r=$?; set -e
[[ $r -eq 7 ]] || fail "slice did not return the command's exit code: $r"
set +e; COACH_SLICE_MAX=1 "$M" slice s3 sleep 5 2>/dev/null; r=$?; set -e
[[ $r -eq 124 ]] || fail "slice did not stop a command at its limit: $r"
[[ ! -d "$T/shared/host-cpu" ]] || fail "a stopped slice left host-cpu held"
# a waiter gets host-cpu between two slices
"$M" acquire host-cpu holder >/dev/null
( "$M" acquire host-cpu waiter 30 >/dev/null; echo got > "$T/waiter"; sleep 1; "$M" release host-cpu waiter >/dev/null ) &
wp=$!
sleep 1; "$M" release host-cpu holder >/dev/null
wait "$wp"
[[ -f "$T/waiter" ]] || fail "the waiter never got host-cpu"
echo "devlock.test.sh: all passed"
