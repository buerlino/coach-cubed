#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# pipeline/lib.sh: the helpers of pipeline/pipeline.sh, sourced by it, by pipeline/gc.sh and by the tests. Ported from pascaline's
# scripts/pipeline-lib.sh; the pascaline package that introduced a rule is named in brackets, so its history can be looked up there.

LIB_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
DEVLOCK="$LIB_DIR/devlock.sh"
INTEG_BRANCH="${COACH_INTEG_BRANCH:-phase-0}"

# ---- the agents ----
# Workers run packages; the auditor reads diffs. Every name is a file in .claude/agents/.
WORKERS=(dirac schrödinger curie einstein)
AUDITOR=hillbert
is_worker() { local a; for a in "${WORKERS[@]}"; do [[ "$a" == "$1" ]] && return 0; done; return 1; }
# ascii <text>: a branch- and file-safe spelling (schrödinger → schroedinger)
ascii() { sed 's/ä/ae/g; s/ö/oe/g; s/ü/ue/g; s/Ä/Ae/g; s/Ö/Oe/g; s/Ü/Ue/g' <<<"$1"; }
# slug <text>: lowercase, [a-z0-9-] only
slug() { local s; s="$(ascii "$1")"; tr -cs 'a-z0-9' '-' <<<"${s,,}" | sed 's/^-//; s/-$//'; }

# ---- package files (docs/packages/<id>.md) ----
# An id is a letter and a number with an optional suffix (w12, w12b); a FIX package adds f<k> (w12f1) and has no file of its own.
package_shaped() { [[ "$1" =~ ^[a-z][0-9]+[a-z]?$ ]]; }
id_shaped() { [[ "$1" =~ ^[a-z][0-9]+[a-z]?(f[0-9]+)?$ ]]; }
# parse_heading <first line>: prints "<agent> <model> <branch>" for "# <id>: <title> (<agent>, <model>, branch `<branch>`)"; fails
# on any other line.
parse_heading() {
  local re='^# [a-z][0-9]+[a-z]?: .*\(([^,()]+), (sonnet|opus), branch `([^`]+)`\)[[:space:]]*$'
  [[ "$1" =~ $re ]] || return 1
  is_worker "${BASH_REMATCH[1]}" || return 1
  echo "${BASH_REMATCH[1]} ${BASH_REMATCH[2]} ${BASH_REMATCH[3]}"
}
# red_first_wanted <package file>: the package says its new tests fail on the integration branch ("**Red first:** yes").
red_first_wanted() { grep -qiE '^\*\*Red first:\*\* *yes' "$1" 2>/dev/null; }

# ---- the merge ----
# audited_head_check <worktree> <branch> <audited sha>: succeeds when refs/heads/<branch> is the audited commit; otherwise prints
# why and fails. A worker that detached HEAD and committed there leaves the branch behind the commit the audit read (pascaline A17).
audited_head_check() {
  local wt="$1" br="$2" sha="$3" tip
  tip="$(git -C "$wt" rev-parse -q --verify "refs/heads/$br^{commit}" 2>/dev/null || true)"
  [[ -n "$sha" ]] || { echo "no audited commit recorded"; return 1; }
  [[ -n "$tip" ]] || { echo "branch $br does not exist"; return 1; }
  [[ "$tip" == "$sha" ]] || { echo "branch $br is at ${tip:0:9}, the audit read ${sha:0:9}"; return 1; }
  return 0
}
# change_id <worktree> <rev>: a fingerprint of the branch's own change set (git diff <integration branch>...<rev>), stable across
# merges of the integration branch that touch other files; any change to the diff's lines or context changes it.
change_id() { git -C "$1" diff "$INTEG_BRANCH...$2" | git patch-id --stable | cut -d' ' -f1; }
# integ_busy <worktree>: prints why the integration worktree cannot take a merge now (staged changes, a commit or merge in
# progress); prints nothing when it can. Unstaged edits by an interactive session don't count: git refuses a merge that would
# overwrite them, and the merge commit never contains them.
integ_busy() {
  local gd; gd="$(git -C "$1" rev-parse --absolute-git-dir)"
  [[ ! -e "$gd/index.lock" ]] || { echo "a git command is running there (index.lock)"; return; }
  [[ ! -e "$gd/MERGE_HEAD" && ! -d "$gd/rebase-merge" && ! -d "$gd/rebase-apply" ]] || { echo "a merge or rebase is in progress there"; return; }
  git -C "$1" diff --cached --quiet || echo "it has staged changes"
}
# merge_failure_reason <worktree> <merge log>: "conflict" when git lists unmerged files, the files a merge would overwrite, or the
# log's last line (pascaline A24).
merge_failure_reason() {
  if [[ -n "$(git -C "$1" diff --name-only --diff-filter=U)" ]]; then echo conflict
  elif grep -q 'would be overwritten by merge' "$2"; then
    echo "uncommitted edits in the $INTEG_BRANCH worktree to $(awk '/would be overwritten/{on=1;next} /^Please|^Aborting/{on=0} on{gsub(/^[ \t]+/,""); printf "%s ", $0}' "$2")"
  else echo "merge failed: $(tail -n 1 "$2" | cut -c1-200)"; fi
}

# ---- the checks ----
# A bare missing module or command is the machine's; a relative one ('./x.js') is the worker's own import (pascaline A24, A34).
MACHINE_RE="command not found|node_modules (is )?missing|Cannot find module '[^./']|No module named '(numpy|cv2|torch|flask|PIL|scipy)"
machine_failure() { grep -qE "$MACHINE_RE" "$1" 2>/dev/null; }
# shell_selected: a changed file (one per line, on stdin) is one of the pipeline's scripts.
shell_selected() { grep -qE '^pipeline/'; }
# app_selected: a changed file is the app's or the shared code it scores with (src/diagnostics.js, src/track/).
app_selected() { grep -qE '^(app|src)/'; }
# has_script <package dir> <script>: its package.json defines the npm script.
has_script() { node -e 'const p = require(require("path").resolve(process.argv[1], "package.json")); process.exit(p.scripts && p.scripts[process.argv[2]] ? 0 : 1)' "$1" "$2" 2>/dev/null; }
# The paths whose diffs Opus audits even when the line names sonnet (pascaline A15): the scoring, the pose code, the pipeline itself
# and the agents. Extend it when Phase 5 adds the app's pose and scoring modules.
AUDIT_OPUS_RE='^(src/diagnostics\.js|src/pose/|src/track/|app/src/(pose|media|scoring|analysis)/|app/tools/|pipeline/|\.claude/agents/)'
# excerpt <check log>: the failing lines, capped
excerpt() {
  grep -nE '^not ok|# fail [1-9]|AssertionError|Error:|expected|actual:|FAIL|Traceback|FAILED|ERROR:' -A4 "$1" | head -n 150
  [[ -s "$1" ]] && { echo "--- tail ---"; tail -n 30 "$1"; }
}
# node_modules_stale <dir>: node_modules lacks a non-optional package of package-lock.json, or a version differs (pascaline A34).
node_modules_stale() {
  node -e '
    const fs = require("fs"), d = process.argv[1];
    let want, have;
    try { want = JSON.parse(fs.readFileSync(d + "/package-lock.json", "utf8")).packages; have = JSON.parse(fs.readFileSync(d + "/node_modules/.package-lock.json", "utf8")).packages; } catch { process.exit(0); }
    for (const [k, v] of Object.entries(want)) {
      if (!k.startsWith("node_modules/") || v.optional || v.link) continue;
      if (!(k in have)) process.exit(0);
      let got; try { got = JSON.parse(fs.readFileSync(d + "/" + k + "/package.json", "utf8")).version; } catch { process.exit(0); }
      if (v.version && got !== v.version) process.exit(0);
    }
    process.exit(1);' "$1"
}

# ---- red first (pascaline A36): a package's new tests must fail on the old code ----
# red_first <worktree> <python> <log>: runs the branch's new and changed test files (*.test.[cm]js anywhere under tests/,
# tests/test_*.py) on a scratch checkout of the integration branch. Copied over from the branch: those test files and every
# other file it adds under tests/ (a new helper, fixture or clip the tests need). A file under tests/ that the branch changes
# but is no test (tests/fixtures.js, a manifest, a golden) keeps the integration branch's version: it is part of the change,
# so a fix made there shows red too. Succeeds when at least one test fails; otherwise prints why and fails. A run that ran no
# test at all is a failure too ("compared nothing": pascaline A53's lesson). COACH_REDFIRST_NODE and COACH_REDFIRST_PY
# override the runners (tests).
red_first() {
  local wt="$1" py="$2" out="$3" scratch st f js=() pys=() added=() kept=() rc ran=0 failed=0
  while IFS=$'\t' read -r st f; do
    if [[ "$f" =~ \.test\.[cm]?js$ ]]; then js+=("$f")
    elif [[ "$f" =~ ^tests/test_[^/]*\.py$ ]]; then pys+=("$f")
    elif [[ "$st" == A ]]; then added+=("$f")
    else kept+=("$f"); fi
  done < <(git -C "$wt" -c core.quotePath=false diff --no-renames --name-status --diff-filter=AM "$INTEG_BRANCH...HEAD" -- tests/)
  if [[ ${#js[@]} -eq 0 && ${#pys[@]} -eq 0 ]]; then echo "the package says its tests fail on $INTEG_BRANCH, but the branch adds or changes no test file"; return 1; fi
  local what="the branch's ${#js[@]} JS and ${#pys[@]} Python test file(s) and the ${#added[@]} other file(s) it adds under tests/, $INTEG_BRANCH's version of everything else"
  [[ ${#kept[@]} -eq 0 ]] || what="$what (kept: ${kept[*]})"
  scratch="$(mktemp -d)"; rmdir "$scratch"
  git -C "$wt" worktree add -q --detach "$scratch" "$INTEG_BRANCH" >/dev/null 2>&1 || { echo "could not check out $INTEG_BRANCH for red-first"; return 1; }
  for f in "${js[@]}" "${pys[@]}" "${added[@]}"; do mkdir -p "$scratch/$(dirname "$f")"; git -C "$wt" show "HEAD:$f" > "$scratch/$f"; done
  echo "red-first on $INTEG_BRANCH's code with $what" > "$out"
  if [[ ${#js[@]} -gt 0 ]]; then
    rc=0; (cd "$scratch" && FORCE_COLOR=0 timeout 600 ${COACH_REDFIRST_NODE:-node --test} "${js[@]}") >> "$out" 2>&1 || rc=$?
    local t k; t="$(grep -oE '^# tests [0-9]+' "$out" | tail -n1 | grep -oE '[0-9]+' || echo 0)"; k="$(grep -oE '^# fail [0-9]+' "$out" | tail -n1 | grep -oE '[0-9]+' || echo 0)"
    ran=$((ran + t)); [[ $k -gt 0 || ( $rc -ne 0 && $t -gt 0 ) ]] && failed=1
  fi
  if [[ ${#pys[@]} -gt 0 ]]; then
    rc=0; (cd "$scratch" && timeout 600 ${COACH_REDFIRST_PY:-"$py" -m unittest} "${pys[@]}") >> "$out" 2>&1 || rc=$?
    local r; r="$(grep -oE '^Ran [0-9]+ test' "$out" | tail -n1 | grep -oE '[0-9]+' || echo 0)"
    ran=$((ran + r)); [[ $rc -ne 0 ]] && failed=1
  fi
  git -C "$wt" worktree remove --force "$scratch" >/dev/null 2>&1 || true
  if [[ $ran -eq 0 ]]; then echo "the new tests ran nothing on $INTEG_BRANCH (no test was counted; run with $what)"; return 1; fi
  if [[ $failed -eq 0 ]]; then echo "every new or changed test passes on $INTEG_BRANCH's code ($ran run, with $what), so none of them tests the change"; return 1; fi
  return 0
}

# ---- jobs apart (pascaline A47a) ----
# take_number <tasks dir>: the next job number from <tasks>/counter, read and written under one flock.
take_number() {
  local tasks="$1" fd c n
  mkdir -p "$tasks"
  exec {fd}>>"$tasks/counter.lock"
  if ! flock -w 120 "$fd"; then exec {fd}>&-; return 1; fi
  c="$(cat "$tasks/counter" 2>/dev/null || true)"; [[ "$c" =~ ^[0-9]+$ ]] || c=0
  n=$((c + 1)); echo "$n" > "$tasks/counter"; echo "$n"
  exec {fd}>&-
}
peek_number() { local c; c="$(cat "$1/counter" 2>/dev/null || true)"; [[ "$c" =~ ^[0-9]+$ ]] || c=0; echo $((c + 1)); }
# job_port <job number>: the dev-server port of a job (COACH_PORT for src/app.py, --port for the preview): 8100 + n % 100.
job_port() { echo $((8100 + $1 % 100)); }

# ---- locks ----
_lib_log() { if declare -F log >/dev/null; then log "$*"; fi; }
# lock_wait <resource> <owner> <log prefix> <wait s>: a devlock lock, waiting up to <wait s>; logs "waiting for <resource>
# (<holder>)" once, one line with the holder after COACH_LOCK_NOTE seconds (600; pascaline A58), and the wait's length.
lock_wait() {
  local res="$1" owner="$2" pre="$3" wait="$4" t0=$SECONDS holder
  "$DEVLOCK" acquire "$res" "$owner" 0 >/dev/null 2>&1 && return 0
  holder="$("$DEVLOCK" holder "$res")"
  _lib_log "$pre waiting for $res (${holder:-?})"
  # The wait runs in a session of its own and is waited for as a background job (pascaline A54f1): bash runs a trapped signal only
  # after a foreground command returns, so a foreground wait held a kill back for up to two hours.
  local pid rc=0 noted=0
  setsid "$DEVLOCK" acquire "$res" "$owner" "$wait" >/dev/null 2>&1 </dev/null &
  pid=$!
  owned_sessions+=("$pid")
  while kill -0 "$pid" 2>/dev/null; do
    if [[ $noted -eq 0 ]] && (( SECONDS - t0 >= ${COACH_LOCK_NOTE:-600} )); then
      noted=1; _lib_log "$pre $res held by $("$DEVLOCK" holder "$res"); waited $((SECONDS - t0)) s so far"
    fi
    sleep 2 & wait $! || true
  done
  wait "$pid" || rc=$?
  session_kill "$pid" || true
  owned_forget "$pid"
  if [[ $rc -eq 0 ]]; then _lib_log "$pre $res taken after a wait of $((SECONDS - t0)) s"; return 0; fi
  _lib_log "$pre $res still busy after a wait of $((SECONDS - t0)) s"; return 1
}
# integ: the merge queue (pascaline A47b). nodemods: copies out of the integration worktree's node_modules (pascaline A47bf1).
# Lock order: integ, then nodemods, then host-cpu; whoever holds a later one never waits for an earlier one.
integ_held=0; integ_owner=""; integ_t0=0
integ_take() {  # <owner> <log prefix>
  [[ $integ_held -eq 0 ]] || return 0
  lock_wait integ "$1" "$2" "${COACH_INTEG_WAIT:-7200}" || return 1
  integ_held=1; integ_owner="$1"; integ_t0=$SECONDS
}
integ_drop() { [[ $integ_held -eq 1 ]] || return 0; "$DEVLOCK" release integ "$integ_owner" >/dev/null 2>&1 || true; integ_held=0; }
nodemods_held=0; nodemods_owner=""
nodemods_take() {
  [[ $nodemods_held -eq 0 ]] || return 0
  lock_wait nodemods "$1" "$2" "${COACH_NODEMODS_WAIT:-1800}" || return 1
  nodemods_held=1; nodemods_owner="$1"
}
nodemods_drop() { [[ $nodemods_held -eq 1 ]] || return 0; "$DEVLOCK" release nodemods "$nodemods_owner" >/dev/null 2>&1 || true; nodemods_held=0; }

# ---- the pipeline owns its children (pascaline A54) ----
# GNU timeout moves itself into a process group of its own, so a signal to the pipeline never reached the checks or the agents, and
# the EXIT trap freed the locks under them. Every heavy child runs in a session of its own (setsid) that the pipeline registers; the
# TERM, HUP and INT traps and the EXIT trap call owned_kill first, which kills each whole session and waits until it is empty, and
# only then are the locks dropped. own_sh and owned_kill work in the main shell only: in $( ) or a pipe the registry is lost.
owned_sessions=()
session_alive() { ps -o stat= --sid "$1" 2>/dev/null | grep -qv '^Z'; }
# session_kill <sid>: TERM to the whole session, KILL after COACH_KILL_GRACE seconds (20), then waits (at most 10 s) until it is empty.
session_kill() {
  local sid="$1" i grace="${COACH_KILL_GRACE:-20}"
  session_alive "$sid" || return 0
  pkill -TERM -s "$sid" 2>/dev/null || true
  for ((i = 0; i < grace * 5; i++)); do session_alive "$sid" || return 0; sleep 0.2; done
  pkill -KILL -s "$sid" 2>/dev/null || true
  for ((i = 0; i < 50; i++)); do session_alive "$sid" || return 0; sleep 0.2; done
  return 1
}
owned_kill() {
  local s
  for s in "${owned_sessions[@]}"; do if session_kill "$s"; then wait "$s" 2>/dev/null || true; fi; done
  owned_sessions=()
}
owned_forget() {
  local s keep=()
  for s in "${owned_sessions[@]}"; do [[ "$s" == "$1" ]] || keep+=("$s"); done
  owned_sessions=("${keep[@]}")
}
own_traps() {
  trap 'owned_kill; exit 143' TERM
  trap 'owned_kill; exit 129' HUP
  trap 'owned_kill; exit 130' INT
}
# own_sh <script> [args...]: runs `bash -c <script> _ args...` in a session of its own and waits for it; stdin, stdout and stderr are
# the caller's. Returns its exit code; whatever the script left running is killed.
own_sh() {
  local pid rc=0
  setsid bash -c "$1" _ "${@:2}" <&0 &
  pid=$!
  owned_sessions+=("$pid")
  wait "$pid" || rc=$?
  session_kill "$pid" || true
  owned_forget "$pid"
  return $rc
}

# ---- the shell tests (pascaline A47a): `pipeline.sh selftest` and the check `shell` ----
SELFTESTS=(pipeline/pipeline.test.sh pipeline/devlock.test.sh pipeline/gc.test.sh)
# selftest_run <repo dir> <log>: runs each test clean of the pipeline's own environment; prints "PASSED", or
# "FAILED (<test>: <first failing line>)" and fails. COACH_SELFTEST_TESTS (absolute paths) overrides the list.
selftest_run() {
  local dir="$1" log="$2" t rc line
  local -a tests
  if [[ -n "${COACH_SELFTEST_TESTS:-}" ]]; then read -ra tests <<<"$COACH_SELFTEST_TESTS"; else tests=("${SELFTESTS[@]/#/$dir/}"); fi
  : > "$log"
  for t in "${tests[@]}"; do
    echo "== $t" >> "$log"; rc=0
    own_sh 'cd "$1" && shift && exec env -u COACH_LOCK_PID -u COACH_COORD -u COACH_TASKS -u COACH_SHARED_LOCKS -u COACH_PORT -u COACH_SELFTEST_TESTS -u ANDROID_SERIAL timeout -k 30 900 "$@"' "$dir" "$t" > "$log.one" 2>&1 < /dev/null || rc=$?
    cat "$log.one" >> "$log"
    if [[ $rc -ne 0 ]]; then
      line="$(grep -m1 -E '^FAIL' "$log.one" || tail -n 1 "$log.one")"; [[ $rc -ne 124 ]] || line="timed out after 900 s"
      rm -f "$log.one"; echo "FAILED (${t##*/}: $(cut -c1-200 <<<"${line:-exit $rc}"))"; return 1
    fi
  done
  rm -f "$log.one"; echo PASSED
}

# ---- a worker that questions its task (pascaline A55) ----
# task_questioned <reply file>: an "Open question" line of the reply says the worker's own task is missing or wrong (pascaline's run
# 312 asked for its bundle to be regenerated, and was merged). A "Needs a decision" question is not such a line.
TASK_SUBJECT='(my|the) (task( text| block)?|bundle|package( file)?|spec block)'
TASK_QUESTION_RE="((re-?generate|re-?send|re-?build)[^.]*(the bundle|the task|the package file|[ -]block))|($TASK_SUBJECT (is|are|was|seems( to be)?|looks|appears( to be)?) (missing|empty|incomplete|wrong|not (found|included|in the bundle)))|($TASK_SUBJECT (lacks|has no) )|(no (package|task) (file|block|text))|(cannot find (the |a )?(package|task))"
open_question_lines() {
  awk 'tolower($0) ~ /open questions?/ { on = 1; print; next } /^[[:space:]]*$/ { on = 0; next } on { print }' "$1" 2>/dev/null
}
task_questioned() { open_question_lines "$1" | grep -viE 'needs a decision' | grep -qiE "$TASK_QUESTION_RE"; }
