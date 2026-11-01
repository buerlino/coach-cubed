#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Tests for pipeline/pipeline.sh and pipeline/lib.sh. No real agent starts: each case builds a throwaway repo (a main checkout, a
# phase-0 worktree, a package file) with a stub claude whose behaviour the case picks, runs the real script there and checks its
# RESULT line, the log and the repo. Touches nothing outside its temp dir.   Run: pipeline/pipeline.test.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"
cleanup() { for w in "$T"/*/main; do [[ -d "$w" ]] && git -C "$w" worktree prune 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT
unset COACH_COORD COACH_TASKS COACH_SHARED_LOCKS COACH_LOCK_PID COACH_PORT COACH_PY COACH_CLAUDE ANDROID_SERIAL COACH_INTEG_BRANCH
export COACH_KILL_GRACE=1 COACH_READY_WAIT=2
fails=0
fail() { echo "FAIL: $*" >&2; fails=$((fails + 1)); }

# sandbox <name>: a repo in $T/<name>: main (on main), integ (the phase-0 worktree), the scripts under test, two packages,
# a stub claude and a stub python. Prints its path.
sandbox() {
  local sb="$T/$1" m
  m="$sb/main"; mkdir -p "$m/pipeline" "$m/docs/packages" "$m/tests" "$sb/bin"
  cp "$here"/*.sh "$m/pipeline/"
  cat > "$m/docs/pipeline.md" <<'EOF'
# Pipeline
## Your report
REPORT-FORMAT
## Definition of done
DONE-WHEN
## Something else
EOF
  printf '# w1: a feature (dirac, sonnet, branch `wp/dirac-w1`)\n**Done when:** feature.txt exists.\n' > "$m/docs/packages/w1.md"
  printf '# w2: a phone job (curie, sonnet, branch `wp/curie-w2`)\n**Done when:** adb.\n' > "$m/docs/packages/w2.md"
  printf '# w3: bad heading\n' > "$m/docs/packages/w3.md"
  printf '{ "name": "sb", "private": true, "scripts": { "test": "node --test" } }\n' > "$m/package.json"
  printf "const test = require('node:test'); test('ok', () => {});\n" > "$m/tests/ok.test.js"
  echo base > "$m/shared.txt"
  git -C "$m" init -q -b main; git -C "$m" config user.name t; git -C "$m" config user.email t@example.org
  git -C "$m" add -A; git -C "$m" commit -qm base; git -C "$m" branch phase-0
  git -C "$m" worktree add -q "$sb/integ" phase-0
  printf '#!/bin/sh\nexit 0\n' > "$sb/bin/py"; chmod +x "$sb/bin/py"
  cat > "$sb/bin/claude" <<'EOF'
#!/usr/bin/env bash
# stub claude: the role from --agent, the behaviour from $SB/mode, the audit's verdict from $SB/audit
agent=""; prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    --agent) agent="$2"; shift 2;;
    --model|--effort|--permission-mode|--output-format|-n|--allowedTools|--disallowedTools) shift 2;;
    -p|--no-session-persistence) shift;;
    *) prompt="$1"; shift;;
  esac
done
cat > /dev/null
echo "$agent|$PWD|${prompt:0:30}" >> "$SB/calls"
mode="$(cat "$SB/mode" 2>/dev/null || true)"
commit() { git add -A; git commit -qm "$1" -m "Done: $1"; }
if [ "$agent" = hillbert ]; then
  if [ -f "$SB/move-integ" ] && [ ! -f "$SB/moved" ]; then
    touch "$SB/moved"; echo x > "$SB/integ/unrelated.txt"; git -C "$SB/integ" add unrelated.txt; git -C "$SB/integ" commit -qm unrelated
  fi
  v="$(cat "$SB/audit" 2>/dev/null || echo APPROVED)"; echo "$v"; [ "$v" = APPROVED ] || echo "shared.txt:2 the feature is wrong; fix it"
  exit 0
fi
case "$mode" in
  limit) echo "Claude AI usage limit reached"; exit 1;;
  nocommit) echo "done; nothing to change";;
  question) printf 'Done: nothing.\nOpen questions:\n- The package file is missing its Done when block: regenerate the bundle with the block.\n';;
  sleep) sleep 317;;
  app) mkdir -p app/tests
       printf '{ "name": "app", "version": "0.0.0", "private": true, "scripts": { "test": "node --test" } }\n' > app/package.json
       printf '{ "name": "app", "version": "0.0.0", "lockfileVersion": 3, "requires": true, "packages": { "": { "name": "app", "version": "0.0.0" } } }\n' > app/package-lock.json
       printf "const test = require('node:test'); test('app ok', () => {});\n" > app/tests/a.test.js
       commit "w1: the app's first test";;
  adb) { adb devices; echo "rc=$?"; adb -s HA24BZ2Y shell true; echo "rc=$?"; adb kill-server; echo "rc=$?"; adb shell true; echo "rc=$?"; } > "$SB/adb.out" 2>&1
       echo "phone" >> shared.txt; commit "w2: phone";;
  badtest)
    case "$prompt" in
      *"fix round"*) printf "const test = require('node:test'); test('fixed', () => {});\n" > tests/bad.test.js; commit "fix the test";;
      *) echo feature >> shared.txt
         printf "const test = require('node:test'); const a = require('node:assert'); test('bad', () => a.equal(1, 2));\n" > tests/bad.test.js
         commit "feature with a failing test";;
    esac;;
  *) echo "feature $RANDOM" >> shared.txt; commit "feature";;
esac
echo "last commit $(git rev-parse --short HEAD 2>/dev/null), done"
EOF
  chmod +x "$sb/bin/claude"
  echo "$sb"
}
# pl <sandbox> <args...>: runs the sandbox's pipeline.sh from its main checkout; stdout to $sb/out, the exit code to $sb/rc
pl() {
  local sb="$1"; shift
  (cd "$sb/main" && SB="$sb" PATH="$sb/bin:$PATH" COACH_COORD="$sb/coord" COACH_TASKS="$sb/tasks" COACH_SHARED_LOCKS="$sb/shared" \
     COACH_CLAUDE="$sb/bin/claude" COACH_PY="$sb/bin/py" "$sb/main/pipeline/pipeline.sh" "$@") > "$sb/out" 2> "$sb/err"
  echo $? > "$sb/rc"
}
rc() { cat "$1/rc"; }
out() { cat "$1/out"; }
calls() { local c; c="$(grep -c "^$2|" "$1/calls" 2>/dev/null)"; echo "${c:-0}"; }
parents() { git -C "$1/main" rev-list --parents -n1 "$2" | wc -w; }

# 1. the dry run reads the heading; bad ids and headings never start
sb="$(sandbox dry)"
pl "$sb" w1 --dry-run
[[ "$(rc "$sb")" -eq 0 ]] || fail "dry run: exit $(rc "$sb"): $(cat "$sb/err")"
grep -q '^DRY RUN: pipeline run 1, package w1, agent dirac (sonnet, effort high), branch wp/dirac-w1' "$sb/out" || fail "dry run: no plan line: $(head -n1 "$sb/out")"
grep -q 'REPORT-FORMAT' "$sb/out" && grep -q 'DONE-WHEN' "$sb/out" || fail "dry run: the bundle lacks the report format or the definition of done"
grep -q 'Something else' "$sb/out" && fail "dry run: the bundle takes docs/pipeline.md sections it should not"
[[ ! -e "$sb/tasks/counter" ]] || fail "dry run: took a run number"
pl "$sb" w2 --dry-run; grep -q 'ANDROID_SERIAL=4d42e62f' "$sb/out" || fail "dry run: curie's run does not get the phone"
pl "$sb" w1 --dry-run; grep -q 'adb refused' "$sb/out" || fail "dry run: dirac's run is not refused adb"
pl "$sb" w9 --dry-run
[[ "$(rc "$sb")" -eq 2 ]] && grep -q 'RESULT -: NOT STARTED (package w9 has no package file' "$sb/out" || fail "unknown package: $(out "$sb")"
pl "$sb" w3 --dry-run
[[ "$(rc "$sb")" -eq 2 ]] && grep -q 'first line of docs/packages/w3.md' "$sb/out" || fail "bad heading: $(out "$sb")"
pl "$sb" dirac "do something" --id w1 --dry-run
[[ "$(rc "$sb")" -eq 2 ]] || fail "free text under a package's id starts (pascaline A55): $(out "$sb")"
pl "$sb" dirac "fix it" --id w1f1 --dry-run
[[ "$(rc "$sb")" -eq 0 ]] && grep -q 'branch wp/dirac-w1f1' "$sb/out" || fail "a FIX id with free text: $(out "$sb")"
pl "$sb" hillbert "x" --id w1f1 --dry-run
[[ "$(rc "$sb")" -eq 2 ]] || fail "the auditor is started as a worker"

# 2. the happy path: worker, checks, audit, a --no-ff merge of the audited commit; worktree and branch gone
sb="$(sandbox happy)"
pl "$sb" w1
[[ "$(rc "$sb")" -eq 0 ]] && grep -qE '^RESULT #1 w1: MERGED [0-9a-f]+$' "$sb/out" || fail "happy: $(out "$sb") $(tail -n 3 "$sb/err")"
[[ "$(parents "$sb" phase-0)" -eq 3 ]] || fail "happy: phase-0's tip is not a merge commit"
git -C "$sb/main" show-ref --verify --quiet refs/heads/wp/dirac-w1 && fail "happy: the branch is still there"
[[ ! -d "$sb/main/.claude/worktrees/wp-001-w1" ]] || fail "happy: the worktree is still there"
grep -q 'feature' "$sb/integ/shared.txt" || fail "happy: the phase-0 worktree lacks the change"
grep -q 'pipeline #1 w1: MERGED' "$sb/coord/log.md" || fail "happy: no MERGED log line"
grep -q 'integ released after' "$sb/coord/log.md" || fail "happy: integ not released"
[[ -z "$(ls "$sb/coord/locks" 2>/dev/null)" ]] || fail "happy: locks left: $(ls "$sb/coord/locks")"
grep -qxF /.coord/ "$sb/main/.git/info/exclude" || fail "happy: .coord is not excluded"
[[ "$(calls "$sb" hillbert)" -eq 1 && "$(calls "$sb" dirac)" -eq 1 ]] || fail "happy: calls $(cat "$sb/calls")"

# 3. the audit says FIX every time: two fix rounds, then NOT MERGED with the branch kept
sb="$(sandbox fix)"; echo FIX > "$sb/audit"
pl "$sb" w1
[[ "$(rc "$sb")" -eq 1 ]] && grep -q 'NOT MERGED (the audit asked for fixes twice' "$sb/out" || fail "fix: $(out "$sb")"
[[ "$(calls "$sb" hillbert)" -eq 3 && "$(calls "$sb" dirac)" -eq 3 ]] || fail "fix: expected 3 audits and 3 worker calls: $(cat "$sb/calls")"
git -C "$sb/main" show-ref --verify --quiet refs/heads/wp/dirac-w1 || fail "fix: the branch was deleted"
[[ "$(parents "$sb" phase-0)" -eq 1 ]] || fail "fix: phase-0 got a merge"

# 4. a failing check gets a fix round with the failing lines; the fixed branch merges
sb="$(sandbox checks)"; echo badtest > "$sb/mode"
pl "$sb" w1
[[ "$(rc "$sb")" -eq 0 ]] || fail "checks: $(out "$sb")"
grep -q 'checks failed (round 0): npm failed' "$sb/coord/log.md" || fail "checks: no failed-check line: $(cat "$sb/coord/log.md")"
grep -q "not ok\|# fail 1" "$sb/tasks/001-w1/fix-1.in" || fail "checks: the fix round did not get the failing lines"

# 5. no commits; a questioned task; a usage limit
sb="$(sandbox nocommit)"; echo nocommit > "$sb/mode"
pl "$sb" w1; grep -q 'NOT MERGED (no commits' "$sb/out" || fail "nocommit: $(out "$sb")"
[[ "$(calls "$sb" hillbert)" -eq 0 ]] || fail "nocommit: audited anyway"
sb="$(sandbox question)"; echo question > "$sb/mode"
pl "$sb" w1; grep -q 'NOT MERGED (the worker questioned its task' "$sb/out" || fail "question: $(out "$sb")"
sb="$(sandbox limit)"; echo limit > "$sb/mode"
pl "$sb" w1; [[ "$(rc "$sb")" -eq 75 ]] && grep -q '^RESULT #1 w1: LIMIT$' "$sb/out" || fail "limit: exit $(rc "$sb"): $(out "$sb")"

# 6. phase-0 moves during the audit (a commit made without integ): merged in again, checks rerun, the approval carries over
sb="$(sandbox moved)"; touch "$sb/move-integ"
pl "$sb" w1
[[ "$(rc "$sb")" -eq 0 ]] || fail "moved: $(out "$sb")"
grep -q 'phase-0 moved during the run; merging it in again (catch-up 1)' "$sb/coord/log.md" || fail "moved: no catch-up line"
grep -q 'approval carried over' "$sb/coord/log.md" || fail "moved: the approval did not carry over"
[[ "$(calls "$sb" hillbert)" -eq 1 ]] || fail "moved: audited again although the change set is the same"
[[ -f "$sb/integ/unrelated.txt" ]] && grep -q feature "$sb/integ/shared.txt" || fail "moved: phase-0 lacks one of the two changes"

# 7. the phase-0 worktree: an unstaged edit to a file the merge changes stops the merge; staged changes make the run wait, then stop
sb="$(sandbox dirty)"; echo local-edit >> "$sb/integ/shared.txt"
pl "$sb" w1
[[ "$(rc "$sb")" -eq 1 ]] && grep -q 'NOT MERGED (uncommitted edits in the phase-0 worktree to shared.txt' "$sb/out" || fail "dirty: $(out "$sb")"
grep -q 'local-edit' "$sb/integ/shared.txt" || fail "dirty: the local edit was lost"
git -C "$sb/integ" checkout -q shared.txt
pl "$sb" w1 --no-worker
[[ "$(rc "$sb")" -eq 0 ]] || fail "dirty: the --no-worker rerun did not merge: $(out "$sb")"
sb="$(sandbox staged)"; echo s > "$sb/integ/staged.txt"; git -C "$sb/integ" add staged.txt
pl "$sb" w1
grep -q 'NOT MERGED (the phase-0 worktree stayed busy for 2 s: it has staged changes' "$sb/out" || fail "staged: $(out "$sb")"
git -C "$sb/integ" diff --cached --quiet && fail "staged: the staged change was touched"

# 8. one run per branch: a second run on a held branch never starts
sb="$(sandbox lock)"; mkdir -p "$sb/coord/locks/branch-wp-dirac-w1"; echo other > "$sb/coord/locks/branch-wp-dirac-w1/owner"
pl "$sb" w1
[[ "$(rc "$sb")" -eq 2 ]] && grep -q 'NOT STARTED (branch wp/dirac-w1 is in use by another run (other))' "$sb/out" || fail "lock: $(out "$sb")"

# 9. adb: curie only reaches the phone, and never kill-server; everyone else is refused
sb="$(sandbox adb)"; echo adb > "$sb/mode"
printf '#!/bin/sh\necho "real-adb $*"\n' > "$sb/bin/adb"; chmod +x "$sb/bin/adb"
pl "$sb" w2
a="$(cat "$sb/adb.out" 2>/dev/null)"
grep -q '^real-adb devices$' <<<"$a" && grep -q 'only 4d42e62f (this is HA24BZ2Y)' <<<"$a" && grep -q 'kill-server: not allowed' <<<"$a" \
  && grep -q '^real-adb -s 4d42e62f shell true$' <<<"$a" || fail "adb for curie: $a"
pl "$sb" w1
grep -q 'the phone belongs to curie' "$sb/adb.out" && ! grep -q real-adb "$sb/adb.out" || fail "adb for dirac: $(cat "$sb/adb.out")"

# 10. a TERM to the pipeline ends the agent's whole session before the locks go (pascaline A54)
sb="$(sandbox kill)"; echo sleep > "$sb/mode"
(cd "$sb/main" && SB="$sb" PATH="$sb/bin:$PATH" COACH_COORD="$sb/coord" COACH_TASKS="$sb/tasks" COACH_SHARED_LOCKS="$sb/shared" \
   COACH_CLAUDE="$sb/bin/claude" COACH_PY="$sb/bin/py" exec "$sb/main/pipeline/pipeline.sh" w1) > "$sb/out" 2>&1 &
p=$!
for _ in $(seq 50); do grep -q '^dirac|' "$sb/calls" 2>/dev/null && break; sleep 0.2; done
sleep 0.5; kill -TERM "$p"; wait "$p"; r=$?
[[ $r -eq 143 ]] || fail "kill: exit $r"
sleep 0.5
ps -eo args | grep -qx 'sleep 317' && fail "kill: the agent's child outlived the pipeline"
[[ ! -d "$sb/coord/locks/branch-wp-dirac-w1" ]] || fail "kill: the branch lock is left"

# 10b. a diff in app/ runs the app's own test script once it exists; test:page only when it exists; app/node_modules installed
sb="$(sandbox app)"; echo app > "$sb/mode"
pl "$sb" w1
[[ "$(rc "$sb")" -eq 0 ]] || fail "app: $(out "$sb") $(tail -n 3 "$sb/err")"
grep -q 'check app: ok' "$sb/tasks/001-w1/run.log" || fail "app: the app's tests did not run: $(cat "$sb/tasks/001-w1/run.log")"
grep -q 'check page' "$sb/tasks/001-w1/run.log" && fail "app: test:page ran without its script"
grep -q 'npm ci in the run.s app' "$sb/coord/log.md" || fail "app: app/node_modules was not installed before the checks"
grep -q "npm ci in the phase-0 worktree's app/ after the merge" "$sb/coord/log.md" || fail "app: the phase-0 worktree's app/node_modules was not refreshed"
pl "$sb" w1 --dry-run; grep -q '^checks: npm,py ' "$sb/out" || fail "app: dry run: $(grep '^checks' "$sb/out")"

# 11. lib: audited_head_check, change_id, integ_busy, machine_failure, task_questioned, parse_heading, red_first
# shellcheck source=pipeline/lib.sh
source "$here/lib.sh"
g="$T/lib"; mkdir -p "$g"; git -C "$g" init -q -b phase-0; git -C "$g" config user.name t; git -C "$g" config user.email t@example.org
printf 'a\nb\nc\nd\ne\nf\ng\nh\n' > "$g/f"; echo y > "$g/other"; git -C "$g" add -A; git -C "$g" commit -qm base
git -C "$g" checkout -qb wp/x; sed -i 's/^b$/B/' "$g/f"; git -C "$g" commit -qam change; tip="$(git -C "$g" rev-parse HEAD)"
audited_head_check "$g" wp/x "$tip" >/dev/null || fail "audited_head_check refuses the branch at the audited sha"
o="$(audited_head_check "$g" wp/x 0000000000000000000000000000000000000000)" && fail "audited_head_check passes another sha"
grep -q 'the audit read 000000000' <<<"$o" || fail "audited_head_check gives no reason: $o"
id1="$(change_id "$g" HEAD)"
git -C "$g" checkout -q phase-0; echo z >> "$g/other"; git -C "$g" commit -qam other; git -C "$g" checkout -q wp/x; git -C "$g" merge -q --no-edit phase-0 >/dev/null 2>&1
[[ "$(change_id "$g" HEAD)" == "$id1" ]] || fail "change_id changes when phase-0 changes another file"
git -C "$g" checkout -q phase-0; sed -i 's/^e$/E/' "$g/f"; git -C "$g" commit -qam near; git -C "$g" checkout -q wp/x; git -C "$g" merge -q --no-edit phase-0 >/dev/null 2>&1
[[ "$(change_id "$g" HEAD)" != "$id1" ]] || fail "change_id stays when phase-0 changes the diff's context"
[[ -z "$(integ_busy "$g")" ]] || fail "integ_busy on a clean worktree: $(integ_busy "$g")"
echo q >> "$g/other"; [[ -z "$(integ_busy "$g")" ]] || fail "integ_busy counts an unstaged edit"
git -C "$g" add other; [[ "$(integ_busy "$g")" == "it has staged changes" ]] || fail "integ_busy misses a staged change"
git -C "$g" reset -q --hard
printf 'sh: 1: esbuild: command not found\n' > "$T/m1"; printf "Error: Cannot find module './x.js'\n" > "$T/m2"; printf 'not ok 1 - x\n' > "$T/m3"
machine_failure "$T/m1" || fail "'command not found' is not a machine failure"
machine_failure "$T/m2" && fail "a relative missing module is a machine failure"
machine_failure "$T/m3" && fail "a failing test is a machine failure"
printf 'Last commit abc.\nOpen questions:\n- The bundle is missing the Steps block.\n' > "$T/q1"
printf 'Last commit abc.\nOpen questions:\n- Needs a decision: is 20 s the right replay length?\n' > "$T/q2"
task_questioned "$T/q1" || fail "task_questioned misses a missing bundle block"
task_questioned "$T/q2" && fail "task_questioned takes a question for nordmu as a questioned task"
[[ "$(parse_heading '# w4: the result view (dirac, opus, branch `wp/dirac-result`)')" == "dirac opus wp/dirac-result" ]] || fail "parse_heading: dirac"
[[ "$(parse_heading '# w5: pose (schrödinger, sonnet, branch `wp/schroedinger-pose`)')" == "schrödinger sonnet wp/schroedinger-pose" ]] || fail "parse_heading: schrödinger"
parse_heading '# w6: audit (hillbert, opus, branch `wp/x`)' >/dev/null && fail "parse_heading takes the auditor as a worker"
[[ "$(slug 'schrödinger')" == schroedinger ]] || fail "slug: $(slug schrödinger)"
h="$T/hs"; mkdir -p "$h"; printf '{ "scripts": { "test": "x" } }\n' > "$h/package.json"
has_script "$h" test || fail "has_script misses a script"; has_script "$h" test:page && fail "has_script finds a missing script"
has_script "$T/nowhere" test && fail "has_script passes without a package.json"
app_selected <<<"src/diagnostics.js" || fail "app_selected misses src/"; app_selected <<<"docs/x.md" && fail "app_selected takes docs/"
r="$T/red"; mkdir -p "$r/tests"; git -C "$r" init -q -b phase-0; git -C "$r" config user.name t; git -C "$r" config user.email t@example.org
echo 'module.exports = () => 1;' > "$r/f.js"; git -C "$r" add -A; git -C "$r" commit -qm base
git -C "$r" checkout -qb wp/red; echo 'module.exports = () => 2;' > "$r/f.js"
printf "const test = require('node:test'); const a = require('node:assert'); test('two', () => a.equal(require('../f.js')(), 2));\n" > "$r/tests/f.test.js"
git -C "$r" add -A; git -C "$r" commit -qm red
red_first "$r" python3 "$T/red.log" > "$T/red.why" || fail "red_first: a test that fails on phase-0 is refused: $(cat "$T/red.why")"
git -C "$r" checkout -qb wp/green phase-0; mkdir -p "$r/tests"
printf "const test = require('node:test'); test('always', () => {});\n" > "$r/tests/g.test.js"; git -C "$r" add -A; git -C "$r" commit -qm green
red_first "$r" python3 "$T/green.log" > "$T/green.why" && fail "red_first: a test that passes on phase-0 passes"
grep -q 'every new or changed test passes' "$T/green.why" || fail "red_first: no reason for green: $(cat "$T/green.why")"
git -C "$r" checkout -qb wp/none phase-0; echo x > "$r/note.txt"; git -C "$r" add -A; git -C "$r" commit -qm none
red_first "$r" python3 "$T/none.log" > "$T/none.why" && fail "red_first: a branch without tests passes"
[[ -z "$(git -C "$r" worktree list | sed -n 2p)" ]] || fail "red_first leaves its scratch worktree"

if [[ $fails -gt 0 ]]; then echo "pipeline.test.sh: $fails failure(s)"; exit 1; fi
echo "pipeline.test.sh: all passed"
