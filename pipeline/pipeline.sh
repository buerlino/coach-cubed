#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# pipeline/pipeline.sh: one work package, end to end, with fresh headless agents and a small context (docs/pipeline.md).
# Ported from pascaline's scripts/pipeline.sh: its package run, merge queue and guards, without its nights, lanes, passes, device
# steps and engine builds.
#
#   pipeline/pipeline.sh <id> [options]                       a package: docs/packages/<id>.md on the integration branch names the
#                                                             agent, the model and the branch in its first line
#   pipeline/pipeline.sh <agent> "<task text>" --id <id> [options]
#                                                             free text, for a FIX package (w12f1) or a small job
#       --branch B          branch (default: the package heading's, or wp/<agent>-<id>)
#       --model M           worker model: sonnet or opus (default: the heading's, else sonnet); --effort E (default high)
#       --audit-model M     hillbert's model: auto (default: opus when the worker runs on opus or the diff touches AUDIT_OPUS_RE in
#                           pipeline/lib.sh, else sonnet), sonnet or opus. auto is a floor: such a diff gets opus even when sonnet
#                           is named (logged)
#       --no-worker         review only: the branch exists (made by hand or by an earlier run); it goes straight to the queue
#       --checks LIST       auto (default), none, or a comma list of npm,py,shell,redfirst,app,page
#       --no-merge          stop after the audit and print the merge command
#       --dry-run           print the bundle and the plan; start no agent, make no worktree, take no number
#   pipeline/pipeline.sh selftest                             the pipeline's own shell tests
#
# Lifecycle: bundle → worker (fresh headless `claude -p --agent <agent>` in its own worktree from the integration branch, phase-0)
# → the merge queue: the run takes the integ lock, merges the integration branch into its branch (a conflict is a resolve round for
# the worker), runs the checks and hillbert's audit of `git diff -U5 phase-0...<branch>` against the package, and on APPROVED merges
# the audited commit with `git merge --no-ff`. A failed check or a FIX releases integ, the worker gets a fix round outside the
# queue, and the run queues again: at most two fix rounds, then the branch stays unmerged. If phase-0 moved meanwhile (a commit made
# without integ), the run merges it in again and reruns the checks; the approval carries over only when the branch's change set is
# unchanged (change_id), else hillbert audits again.
# Bookkeeping: one line per step in .coord/log.md, every file of a run in .tasks/<nnn>-<id>/, both in the main checkout (git-ignored
# through .git/info/exclude). Stdout gets one line, on every exit:
#   RESULT #<n> <id>: MERGED <commit> | NOT MERGED (<why>) | LIMIT | DRY RUN ...      or   RESULT -: NOT STARTED (<why>)
# Exit 0 merged (or dry run), 1 not merged, 2 not started or failed early, 75 usage limit.
# Environment: COACH_INTEG_BRANCH (phase-0), COACH_COORD, COACH_TASKS, COACH_PY (the Python with the dev dependencies; default the
# main checkout's .venv), COACH_PHONE (the phone's adb serial, 4d42e62f), COACH_CLAUDE (the claude binary; tests use a stub).
set -euo pipefail
export COACH_LOCK_PID=$$   # locks taken here record this pid, so a dead run's locks are broken by the next taker
self_dir="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# shellcheck source=pipeline/lib.sh
source "$self_dir/lib.sh"
own_traps

main="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
cd "$main"
coord="${COACH_COORD:-$main/.coord}"
tasks="${COACH_TASKS:-$main/.tasks}"
mkdir -p "$coord" "$tasks/archive"
# The bookkeeping stays out of every branch's status without touching any branch's .gitignore.
excl="$(git rev-parse --git-common-dir)/info/exclude"; mkdir -p "$(dirname "$excl")"
for p in /.coord/ /.tasks/; do grep -qxF "$p" "$excl" 2>/dev/null || echo "$p" >> "$excl"; done
py="${COACH_PY:-$main/.venv/bin/python}"; [[ -x "$py" ]] || py="$(command -v python3)"
phone="${COACH_PHONE:-4d42e62f}"
claude_bin="${COACH_CLAUDE:-claude}"
export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0
claude_common=(--permission-mode auto --output-format text --no-session-persistence)
worker_tools=(--disallowedTools Agent)
# shellcheck disable=SC2054  # one comma-separated argument for --allowedTools
audit_tools=(--allowedTools Read,Grep,Glob --disallowedTools Bash,Edit,Write,Agent,NotebookEdit)

log() { [[ ! -s "$coord/log.md" || -z "$(tail -c1 "$coord/log.md")" ]] || echo >> "$coord/log.md"; printf -- '- %s %s\n' "$(date '+%F %H:%M')" "$*" >> "$coord/log.md"; }
runlog() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" >> "$run/run.log"; }
runno=""; id=""; dry=0
die() {
  echo "pipeline: $*" >&2
  if [[ -n "$runno" ]]; then log "pipeline #$runno $id: NOT MERGED ($*)"; echo "RESULT #$runno $id: NOT MERGED ($*)"
  else [[ $dry -eq 1 ]] || log "pipeline: NOT STARTED ($*)"; echo "RESULT -: NOT STARTED ($*)"; fi
  exit 2
}

# The worktree where the integration branch is checked out (never switch branches in the main checkout).
integ="$(git worktree list --porcelain | awk -v b="refs/heads/$INTEG_BRANCH" '/^worktree /{w=$2} $0=="branch "b{print w}')"
if [[ -z "$integ" ]]; then
  git show-ref --verify --quiet "refs/heads/$INTEG_BRANCH" || die "no branch $INTEG_BRANCH"
  integ="$main/.claude/worktrees/$INTEG_BRANCH"; git worktree add "$integ" "$INTEG_BRANCH" >/dev/null
fi
in_queue=0
queue_leave() {
  [[ $in_queue -eq 1 ]] || { integ_drop; return 0; }
  in_queue=0; integ_drop
  log "pipeline #$n $id: integ released after $((SECONDS - integ_t0)) s in the queue"
}

# ---------- selftest ----------
if [[ "${1:-}" == selftest ]]; then
  out="$tasks/selftest-$(date +%F-%H%M%S).log"; t0=$SECONDS
  selftest_run "$(cd "$self_dir/.." && pwd)" "$out" > "$out.res" || true; r="$(cat "$out.res")"  # not $( ): own_sh needs the main shell
  log "pipeline selftest: $r ($((SECONDS - t0)) s; $out)"
  echo "RESULT selftest: $r"; [[ "$r" == PASSED ]] && exit 0 || exit 1
fi

# ---------- a package ----------
[[ $# -ge 1 ]] || die "usage: pipeline.sh <id> [options] | pipeline.sh <agent> \"<task>\" --id <id> [options]"
agent=""; task="$1"; shift
if is_worker "$task"; then agent="$task"; [[ $# -ge 1 ]] || die "usage: pipeline.sh $agent \"<task>\" --id <id>"; task="$1"; shift; fi
branch=""; model=""; effort="high"; audit_model="auto"; checks="auto"; merge=1; nowork=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) branch="$2"; shift 2;; --id) id="$2"; shift 2;; --model) model="$2"; shift 2;;
    --effort) effort="$2"; shift 2;; --audit-model) audit_model="$2"; shift 2;; --checks) checks="$2"; shift 2;;
    --no-merge) merge=0; shift;; --no-worker) nowork=1; shift;; --dry-run) dry=1; shift;; *) die "unknown option $1";;
  esac
done
[[ -z "$model" || "$model" == sonnet || "$model" == opus ]] || die "--model is sonnet or opus, not $model"
[[ "$audit_model" == auto || "$audit_model" == sonnet || "$audit_model" == opus ]] || die "--audit-model is auto, sonnet or opus"

# The package and the docs come from the integration branch's commit, never from its worktree (which may be mid-edit).
ifile() { [[ "$(git cat-file -t "$INTEG_BRANCH:$1" 2>/dev/null)" == blob ]]; }
spec_file="$(mktemp)"; rules_file="$(mktemp)"; trap 'rm -f "$spec_file" "$rules_file"' EXIT
git show "$INTEG_BRANCH:docs/pipeline.md" > "$rules_file" 2>/dev/null || true
if package_shaped "$task" && [[ -z "$agent" || -z "$id" || "$id" == "$task" ]]; then
  id="$task"; pkg="docs/packages/$id.md"
  ifile "$pkg" || die "package $id has no package file $pkg on $INTEG_BRANCH"
  git show "$INTEG_BRANCH:$pkg" > "$spec_file"
  heading="$(head -n1 "$spec_file")"
  parsed="$(parse_heading "$heading")" || die "package $id: the first line of $pkg is not '# $id: <title> (<agent>, <sonnet|opus>, branch \`<branch>\`)': $heading"
  read -r h_agent h_model h_branch <<<"$parsed"
  [[ -n "$agent" ]] || agent="$h_agent"; [[ -n "$model" ]] || model="$h_model"; [[ -n "$branch" ]] || branch="$h_branch"
else
  [[ -n "$agent" ]] || die "'$task' is neither a package id nor an agent (${WORKERS[*]})"
  [[ -n "$id" ]] || die "free text needs --id <id> (a FIX package: w12f1)"
  id_shaped "$id" || die "id $id is not a package id or a FIX id (w12, w12b, w12f1)"
  # pascaline A55: a package's own id needs its file (its run 312 took a package's id with free text and merged with no package).
  if package_shaped "$id"; then die "$id is a package id: run it as 'pipeline.sh $id', from docs/packages/$id.md"; fi
  printf '%s\n' "$task" > "$spec_file"
fi
model="${model:-sonnet}"
[[ -n "$branch" ]] || branch="wp/$(slug "$agent")-$id"
git check-ref-format "refs/heads/$branch" || die "branch name $branch is not valid"
[[ "$branch" != "$INTEG_BRANCH" && "$branch" != main ]] || die "branch $branch is not a package branch"

# One run per branch (pascaline A47a): the lock branch-<branch>, held to the end; a dead run's lock is broken by the next run.
branch_lock="branch-${branch//\//-}"; branch_locked=0
cleanup() {
  owned_kill; nodemods_drop; queue_leave; rm -f "$spec_file" "$rules_file"
  [[ $branch_locked -eq 0 ]] || "$DEVLOCK" release "$branch_lock" "pipeline-$$" >/dev/null 2>&1 || true
}
trap cleanup EXIT
if [[ $dry -eq 0 ]]; then
  if [[ $nowork -eq 1 ]]; then git show-ref --verify --quiet "refs/heads/$branch" || die "--no-worker: branch $branch does not exist"; fi
  "$DEVLOCK" acquire "$branch_lock" "pipeline-$$" 0 >/dev/null 2>&1 || die "branch $branch is in use by another run ($("$DEVLOCK" holder "$branch_lock"))"
  branch_locked=1
fi

if [[ $dry -eq 1 ]]; then n="$(peek_number "$tasks")"; run="$(mktemp -d)"
else n="$(take_number "$tasks")" || die "the counter lock is busy"; run="$tasks/$(printf '%03d' "$n")-$id"; fi
mkdir -p "$run"
[[ $dry -eq 1 ]] || echo $$ > "$run/pid"  # gc leaves a run whose pid lives alone
export COACH_PORT; COACH_PORT="$(job_port "$n")"
export COACH_PY="$py"

# The bundle: the package, the files it names (the first 400 lines each, 2000 in all), the report format and the definition of done.
bundle="$run/spec.md"
section() { awk -v h="$1" 'index($0, h) == 1 {p=1; next} p && /^## / {p=0} p' "$rules_file"; }
{
  echo "# Pipeline run $n: $id for $agent on branch $branch"
  echo; echo "## Task"; cat "$spec_file"
  echo; echo "## Files the task names (the first 400 lines each, from $INTEG_BRANCH; read more yourself, by section, when you need it)"
  total=0
  { grep -oE '\b[A-Za-z0-9_][A-Za-z0-9_./-]*\.(js|mjs|cjs|ts|py|sh|md|json|html|css|yaml|yml)\b' "$spec_file" || true; } | sort -u |
  while read -r f; do
    case "$f" in docs/packages/*|*package-lock.json|docs/decisions.md|docs/restructure-plan.md|docs/pipeline.md|docs/rules-core.md) continue;; esac
    ifile "$f" || continue
    [[ $total -lt 2000 ]] || { echo "(more files omitted: the bundle's cap is reached)"; break; }
    lines=$(git show "$INTEG_BRANCH:$f" | wc -l); echo; echo "### $f ($lines lines)"; echo '````'; { git show "$INTEG_BRANCH:$f" || true; } | head -n 400; echo '````'
    total=$((total + (lines < 400 ? lines : 400)))
  done
  echo; echo "## Your report (docs/pipeline.md)"; section "## Your report"
  echo; echo "## Definition of done (docs/pipeline.md)"; section "## Definition of done"
} > "$bundle"
{ echo "## Acceptance criteria (the package)"; cat "$spec_file"; echo; echo "## Definition of done (docs/pipeline.md)"; section "## Definition of done"; } > "$run/criteria.md"

no_wait="Never start a background loop that waits on a process (pgrep -f matches the loop's own command line, so it never ends); run every check in the foreground with a timeout."
phone_rule="You may not run adb: the phone belongs to curie."
[[ "$agent" != curie ]] || phone_rule="The phone is yours: name it in every adb command, adb -s $phone ... (a hook blocks a bare adb); take its lock first with pipeline/devlock.sh acquire $phone curie-$n 1800 and release it when you are done; never touch another device."
worker_prompt="You are $agent in pipeline run $n for package $id. The task bundle is on stdin (also at $bundle). You work in your own worktree on branch $branch from $INTEG_BRANCH; never switch branches, never commit anywhere else, never push. Read docs/pipeline.md sections \"Hard rules\" and \"Worker setup\" and docs/rules-core.md first, then work only from the bundle: read further files by section when the task needs them, and keep your context small. Run npm test and the Python tests while you work; the pipeline runs every check afterwards. Heavy CPU work (builds, pose runs over videos) goes through pipeline/devlock.sh slice, ten minutes at most per piece. $phone_rule Commit small, each commit with the Co-Authored-By trailer of your model, and end with the report commit the bundle describes. $no_wait Reply in at most five lines: last commit, done or not done, open questions."

wt="$main/.claude/worktrees/wp-$(printf '%03d' "$n")-$id"
want_checks() {
  case "$checks" in
    none) echo "";;
    auto) local list="npm,py" ch=""
          [[ ! -d "$wt" ]] || ch="$(git -C "$wt" diff --name-only "$INTEG_BRANCH...HEAD")"
          if shell_selected <<<"$ch"; then list="$list,shell"; fi
          # the app's own tests, each once app/package.json has its script (d3 adds test, c21 test:page)
          if app_selected <<<"$ch"; then
            has_script "$wt/app" test && list="$list,app"
            has_script "$wt/app" test:page && list="$list,page"
          fi
          red_first_wanted "$spec_file" && list="$list,redfirst"
          echo "$list";;
    *) echo "$checks";;
  esac
}
if [[ $dry -eq 1 ]]; then
  echo "DRY RUN: pipeline run $n, package $id, agent $agent ($model, effort $effort), branch $branch"
  echo "integration branch: $INTEG_BRANCH, worktree $integ"; echo "worker worktree: $wt"
  echo "COACH_PORT=$COACH_PORT COACH_PY=$py$([[ "$agent" == curie ]] && echo " ANDROID_SERIAL=$phone (adb limited to it)" || echo " ANDROID_SERIAL=coach-no-device (adb refused: the phone is curie's)")"
  echo "checks: $(want_checks)$([[ "$checks" == auto ]] && echo ' (+ shell when the diff touches pipeline/; + app, page when it touches app/ or src/ and app/package.json has test, test:page)')"
  echo "audit: $AUDITOR, model $audit_model (auto: opus when the worker runs on opus or the diff matches $AUDIT_OPUS_RE)"
  echo "locks: $branch_lock for the whole run; integ in the queue (waits up to ${COACH_INTEG_WAIT:-7200} s)"
  echo "merge: $([[ $merge -eq 1 ]] && echo "git -C $integ merge --no-ff <the audited sha>" || echo "none (--no-merge)")"
  [[ $nowork -eq 0 ]] || echo "no worker (--no-worker): the branch goes straight to the queue"
  echo "--- bundle ($(wc -l < "$bundle") lines) ---"; cat "$bundle"
  rm -rf "$run"; echo "RESULT #$n $id: DRY RUN (nothing started)"; exit 0
fi

runno="$n"
log "pipeline #$n $id ($agent, $model, effort $effort) on $branch: started; COACH_PORT $COACH_PORT; run $run"
runlog "start $id $agent $model $branch"

# The worker's worktree, fresh from the integration branch or resumed from the branch's last commit.
resumed=0
if git show-ref --verify --quiet "refs/heads/$branch"; then
  existing="$(git worktree list --porcelain | awk -v b="refs/heads/$branch" '/^worktree /{w=$2} $0=="branch "b{print w}')"
  if [[ -n "$existing" ]]; then wt="$existing"; else git worktree add "$wt" "$branch" >/dev/null 2>&1 || die "could not check out $branch in $wt"; fi
  runlog "resume $branch in $wt"; resumed=1
else
  git worktree add "$wt" -b "$branch" "$INTEG_BRANCH" >/dev/null 2>&1 || die "could not make the worktree $wt"
fi

# node_modules: a hard-link copy of the integration worktree's, for every folder with a package-lock.json that has a fresh one there
# (pascaline A24, A34); a folder without one is the worker's to install.
setup_node_modules() {
  local lock d
  while IFS= read -r lock; do
    d="$(dirname "$lock")"; [[ "$d" != parked/* ]] || continue
    [[ ! -e "$wt/$d/node_modules" && -d "$integ/$d/node_modules" ]] || continue
    node_modules_stale "$integ/$d" && { runlog "node_modules of $integ/$d are stale: not copied"; continue; }
    nodemods_take "pipeline-$n" "pipeline #$n $id:" || die "nodemods lock busy (node_modules)"
    rm -rf "$wt/$d/node_modules.tmp.$$"
    if cp -al "$integ/$d/node_modules" "$wt/$d/node_modules.tmp.$$"; then mv -T "$wt/$d/node_modules.tmp.$$" "$wt/$d/node_modules"; runlog "node_modules copied into $d"
    else rm -rf "$wt/$d/node_modules.tmp.$$"; runlog "node_modules copy into $d failed"; fi
    nodemods_drop
  done < <(git -C "$wt" ls-files '*package-lock.json' 'package-lock.json')
}
setup_node_modules

# adb: curie gets a wrapper that allows only the phone; everyone else gets one that refuses.
mkdir -p "$run/bin"
real_adb="$(command -v adb || true)"
if [[ "$agent" == curie && -n "$real_adb" ]]; then
  cat > "$run/bin/adb" <<EOF
#!/bin/sh
# the pipeline's adb for curie: only $phone, and nothing that disturbs the adb server other projects use
case "\$1" in
  kill-server|reconnect|disconnect|connect|tcpip|usb|root|unroot|reboot|remount|disable-verity|-d|-e|-t|-H|-P|-L) echo "adb \$1: not allowed in a coach run" >&2; exit 1;;
  -s) [ "\$2" = "$phone" ] || { echo "adb: only $phone (this is \$2)" >&2; exit 1; }; exec "$real_adb" "\$@";;
  devices|version|help|start-server) exec "$real_adb" "\$@";;
  *) exec "$real_adb" -s "$phone" "\$@";;
esac
EOF
  export ANDROID_SERIAL="$phone"
else
  printf '#!/bin/sh\necho "adb: the phone belongs to curie; say what you need measured in your report" >&2\nexit 1\n' > "$run/bin/adb"
  # A serial no device has, not an unset one: adb called by its full path, or by Gradle or Capacitor, then finds no
  # device instead of the only one attached, which at night is pascaline's tablet.
  export ANDROID_SERIAL=coach-no-device
fi
chmod +x "$run/bin/adb"; export PATH="$run/bin:$PATH"

# Run one headless agent; exit 75 on a usage limit.
run_agent() {  # <name> <log> <agent> <model> <effort> <stdin file> <prompt> [tool options...]
  local name="$1" out="$2" ag="$3" mdl="$4" eff="$5" input="$6" prompt="$7"; shift 7
  local rc=0
  own_sh 'cd "$1" && shift && timeout -k 60 10800 "$@"' "$wt" "$claude_bin" -p --agent "$ag" --model "$mdl" --effort "$eff" "${claude_common[@]}" "$@" -n "$name" "$prompt" < "$input" > "$out" 2> "$out.err" || rc=$?
  if [[ $rc -ne 0 ]] && grep -qiE 'usage limit|rate limit|429|overloaded' "$out" "$out.err"; then
    log "pipeline #$n $id: LIMIT during $name (claude exit $rc); branch $branch kept"; echo "RESULT #$n $id: LIMIT"; exit 75
  fi
  runlog "$name: claude exit $rc; reply: $(tail -n 3 "$out" | tr '\n' ' ' | cut -c1-200)"
}

# The deterministic checks; a failure's excerpt goes to $run/fail-<round>.txt.
run_checks() {  # <round>
  local round="$1" list name rc out why
  list="$(want_checks)"; [[ -n "$list" ]] || { runlog "checks: none"; return 0; }
  : > "$run/fail-$round.txt"
  for name in ${list//,/ }; do
    out="$run/check-$round-$name.log"; rc=0; why=""
    case "$name" in
      npm)      own_sh 'cd "$1" && FORCE_COLOR=0 NO_COLOR=1 timeout 900 npm test' "$wt" > "$out" 2>&1 < /dev/null || rc=1;;
      py)       own_sh 'cd "$1" && timeout 900 "$2" -m unittest discover -s tests -p "test_*.py"' "$wt" "$py" > "$out" 2>&1 < /dev/null || rc=1;;
      shell)    local sr; selftest_run "$wt" "$out.full" > "$out.sr" || rc=1; sr="$(cat "$out.sr")"
                { grep -E '^FAIL' "$out.full" | head -n 40 || true; echo "selftest: $sr (full output: $out.full)"; } > "$out";;
      redfirst) red_first "$wt" "$py" "$out" > "$out.why" || { rc=1; why="$(cat "$out.why")"; echo "red-first: $why" >> "$out"; };;
      app)      own_sh 'cd "$1" && FORCE_COLOR=0 NO_COLOR=1 timeout 1800 npm --prefix app test' "$wt" > "$out" 2>&1 < /dev/null || rc=1;;
      page)     own_sh 'cd "$1" && FORCE_COLOR=0 NO_COLOR=1 timeout 1800 npm --prefix app run test:page' "$wt" > "$out" 2>&1 < /dev/null || rc=1;;
      *) die "unknown check $name";;
    esac
    if [[ $rc -ne 0 ]]; then
      if [[ "$name" != shell && "$name" != redfirst ]] && machine_failure "$out"; then
        local mline; mline="$(grep -m1 -E "$MACHINE_RE" "$out" | cut -c1-160)"
        queue_leave; log "pipeline #$n $id: NOT MERGED (machine: $name: $mline); branch $branch kept"
        echo "RESULT #$n $id: NOT MERGED (machine: $name: $mline; worktree $wt kept; see $out)"; exit 1
      fi
      { [[ -z "$why" ]] || echo "red-first failed: $why"; echo "## $name failed (full log: $out)"; excerpt "$out"; echo; } >> "$run/fail-$round.txt"
      runlog "check $name: FAILED"; return 1
    fi
    runlog "check $name: ok"
  done
}

# hillbert's model: auto is opus for an opus worker or a diff in AUDIT_OPUS_RE, else sonnet; auto is a floor (pascaline A15).
resolve_audit_model() {
  local why=""
  if [[ "$model" == opus ]]; then why="the worker runs on opus"
  elif git -C "$wt" diff --name-only "$INTEG_BRANCH...HEAD" | grep -qE "$AUDIT_OPUS_RE"; then why="the diff touches scoring, pose, the pipeline or the agents"; fi
  if [[ "$audit_model" == opus ]]; then echo opus
  elif [[ -n "$why" ]]; then
    [[ "$audit_model" == auto ]] || log "pipeline #$n $id: audit model raised to opus: $why (the line said $audit_model)"
    echo opus
  else echo sonnet; fi
}

# Bring the integration branch into the branch; a conflict is a resolve round for the worker (pascaline A38).
rounds=0; resolves=0; merge_conflicts=0
merge_integ() {
  merge_conflicts=0
  git -C "$wt" merge-base --is-ancestor "$INTEG_BRANCH" HEAD && return 0
  log "pipeline #$n $id: merging $INTEG_BRANCH into $branch"
  if ! git -C "$wt" merge --no-edit "$INTEG_BRANCH" > "$run/premerge.log" 2>&1; then
    local conflicts r; conflicts="$(git -C "$wt" diff --name-only --diff-filter=U)"
    if [[ -z "$conflicts" ]]; then
      git -C "$wt" merge --abort >/dev/null 2>&1 || true
      die "merging $INTEG_BRANCH into $branch failed without conflicts: $(tail -n 1 "$run/premerge.log")"
    fi
    resolves=$((resolves + 1)); r="$run/resolve-$resolves"
    { echo "## merging $INTEG_BRANCH into $branch conflicts in:"; echo "$conflicts"; echo
      while IFS= read -r f; do echo "### $f"; grep -nE '^(<<<<<<<|=======|>>>>>>>)' "$wt/$f" | head -n 40; done <<<"$conflicts"; } > "$r.txt"
    merge_conflicts=1
    run_agent "resolve-$n-$resolves" "$r.log" "$agent" "$model" "$effort" "$r.txt" "You are $agent on branch $branch in your own worktree; a merge of $INTEG_BRANCH is in progress with conflicts (the files and the conflict markers are on stdin) for package $id. Resolve every conflict keeping both sides' intent, git add the files and finish the merge with git commit (and your model's Co-Authored-By trailer). Run npm test. Reply in at most three lines." "${worker_tools[@]}"
    if git -C "$wt" rev-parse -q --verify MERGE_HEAD >/dev/null || [[ -n "$(git -C "$wt" diff --name-only --diff-filter=U)" ]]; then
      git -C "$wt" merge --abort >/dev/null 2>&1 || true
      die "conflicts merging $INTEG_BRANCH into $branch not resolved (files: $(tr '\n' ' ' <<<"$conflicts"); worktree $wt kept)"
    fi
    log "pipeline #$n $id: conflicts with $INTEG_BRANCH resolved by $agent"
  fi
}

stop_questioned() {  # <reply file>
  task_questioned "$1" || return 0
  log "pipeline #$n $id: NOT MERGED (the worker questioned its task); branch $branch kept"
  echo "RESULT #$n $id: NOT MERGED (the worker questioned its task; branch $branch, worktree $wt kept; reply: $(open_question_lines "$1" | grep -iE "$TASK_QUESTION_RE" | head -n 1 | cut -c1-120))"; exit 1
}
if [[ $nowork -eq 0 ]]; then
  [[ $resumed -eq 0 ]] || merge_integ  # a resumed branch gets today's integration branch first
  run_agent "wp-$n-$(slug "$agent")" "$run/worker-0.log" "$agent" "$model" "$effort" "$bundle" "$worker_prompt" "${worker_tools[@]}"
  log "pipeline #$n $id: worker done, $(git -C "$wt" log -1 --format=%h) — $(tail -n 1 "$run/worker-0.log" | cut -c1-120)"
  stop_questioned "$run/worker-0.log"
fi
if [[ -z "$(git -C "$wt" log --oneline "$INTEG_BRANCH..HEAD")" ]]; then
  log "pipeline #$n $id: NOT MERGED (no commits on $branch)"; echo "RESULT #$n $id: NOT MERGED (no commits; worktree $wt kept)"; exit 1
fi

# The merge queue (pascaline A47b): while a run holds integ nothing else merges into the integration branch, so the checks and the
# audit read the branch with today's integration branch merged in, and that is what merges.
queue_stop() {  # <why>: leaves the queue and ends the run; the branch and the worktree are kept
  queue_leave; log "pipeline #$n $id: NOT MERGED ($1); branch $branch kept"
  echo "RESULT #$n $id: NOT MERGED ($1; branch $branch, worktree $wt kept)"; exit 1
}
first_entry=1
queue_enter() {
  if [[ $in_queue -eq 0 ]]; then
    log "pipeline #$n $id: in the queue (round $rounds)"
    integ_take "pipeline-$n" "pipeline #$n $id:" || queue_stop "integ lock busy for ${COACH_INTEG_WAIT:-7200} s"
    in_queue=1
  fi
  merge_integ
  [[ $nowork -eq 0 || $first_entry -eq 0 ]] || rounds=$merge_conflicts  # review only: its first resolve round is a fix round
  first_entry=0
  queue_node_modules
}
# queue_node_modules: in the queue, after the merge of the integration branch: app/node_modules is current for the checks. A missing
# or stale one becomes a hard-link copy of the integration worktree's when that one is current for the same lock file, else gets
# npm ci in the run's worktree. A failing npm ci is a machine failure, never a fix round (pascaline A34).
queue_node_modules() {
  local d=app t0=$SECONDS
  [[ -f "$wt/$d/package-lock.json" ]] || return 0
  [[ -d "$wt/$d/node_modules" ]] && ! node_modules_stale "$wt/$d" && return 0
  if [[ -d "$integ/$d/node_modules" ]] && cmp -s "$wt/$d/package-lock.json" "$integ/$d/package-lock.json" && ! node_modules_stale "$integ/$d"; then
    nodemods_take "pipeline-$n" "pipeline #$n $id:" || queue_stop "nodemods lock busy (node_modules)"
    rm -rf "$wt/$d/node_modules.old.$$" "$wt/$d/node_modules.tmp.$$"
    cp -al "$integ/$d/node_modules" "$wt/$d/node_modules.tmp.$$" || { nodemods_drop; queue_stop "machine: could not copy $d/node_modules"; }
    [[ ! -e "$wt/$d/node_modules" ]] || mv -T "$wt/$d/node_modules" "$wt/$d/node_modules.old.$$"
    mv -T "$wt/$d/node_modules.tmp.$$" "$wt/$d/node_modules"; rm -rf "$wt/$d/node_modules.old.$$"
    nodemods_drop; runlog "$d/node_modules copied from $integ ($((SECONDS - t0)) s)"; return 0
  fi
  own_sh 'cd "$1" && timeout 1800 npm ci --prefer-offline --no-audit --no-fund' "$wt/$d" > "$run/npm-ci.log" 2>&1 < /dev/null \
    || queue_stop "machine: npm ci in $wt/$d failed; see $run/npm-ci.log"
  log "pipeline #$n $id: npm ci in the run's $d ($((SECONDS - t0)) s)"
}
# wait_integ_ready: the integration worktree takes no merge while it has staged changes or a git command runs there (an
# interactive session committing); wait up to COACH_READY_WAIT seconds (600) for it.
wait_integ_ready() {
  local t0=$SECONDS why noted=0
  while why="$(integ_busy "$integ")"; [[ -n "$why" ]]; do
    [[ $noted -eq 1 ]] || { log "pipeline #$n $id: waiting for the $INTEG_BRANCH worktree: $why"; noted=1; }
    (( SECONDS - t0 < ${COACH_READY_WAIT:-600} )) || queue_stop "the $INTEG_BRANCH worktree stayed busy for ${COACH_READY_WAIT:-600} s: $why"
    sleep 5
  done
}

verdict=""; audited=""; approved_cid=""; catchups=0
while :; do
  queue_enter
  if ! run_checks "$rounds"; then
    log "pipeline #$n $id: checks failed (round $rounds): $(grep -m1 '^## ' "$run/fail-$rounds.txt" | cut -c4-)"
    reason="the checks failed"; feedback="$run/fail-$rounds.txt"
  else
    log "pipeline #$n $id: checks passed (round $rounds)"
    head="$(git -C "$wt" rev-parse HEAD)"; cid="$(change_id "$wt" "$head")"
    if [[ -n "$approved_cid" && "$cid" == "$approved_cid" ]]; then
      audited="$head"; verdict=APPROVED
      log "pipeline #$n $id: approval carried over to ${head:0:9}: the change set is the one $AUDITOR approved"
    else
      audited="$head"; runlog "audit $rounds reads $audited"
      git -C "$wt" diff -U5 "$INTEG_BRANCH...$audited" > "$run/audit-$rounds.diff"
      { cat "$run/criteria.md"; echo; echo "## Diff (git diff -U5 $INTEG_BRANCH...$audited, the HEAD of $branch, $(wc -l < "$run/audit-$rounds.diff") lines)"; cat "$run/audit-$rounds.diff"
        echo; echo "## The worker's report (git log -1 $audited)"; git -C "$wt" log -1 --format=%B "$audited"; } > "$run/audit-$rounds.in"
      audit_prompt="AUDIT pipeline run $n, package $id, branch $branch. On stdin: the acceptance criteria, the diff against $INTEG_BRANCH (the deterministic checks passed) and the worker's report. Judge the diff against the criteria, docs/rules-core.md and the audit list in docs/pipeline.md; read other files only to check a claim in the diff. Reply with the single word APPROVED on the first line, or FIX on the first line followed by at most five findings, each with file:line, the concrete failure and the fix. Nothing else."
      run_agent "audit-$n-$rounds" "$run/audit-$rounds.log" "$AUDITOR" "$(resolve_audit_model)" high "$run/audit-$rounds.in" "$audit_prompt" "${audit_tools[@]}"
      verdict="$(grep -m1 -oE '^(APPROVED|FIX)' "$run/audit-$rounds.log" || true)"
      if [[ "$verdict" == APPROVED ]]; then log "pipeline #$n $id: audit APPROVED (round $rounds)"; approved_cid="$cid"
      else log "pipeline #$n $id: audit ${verdict:-unclear} (round $rounds): $(grep -vE '^(FIX|APPROVED)?$' "$run/audit-$rounds.log" | head -n 1 | cut -c1-120)"; fi
    fi
    if [[ "$verdict" == APPROVED ]]; then
      wait_integ_ready
      git merge-base --is-ancestor "$INTEG_BRANCH" "$audited" && break
      # The integration branch moved while the run held integ: a commit made without the lock. Merge it in and check again.
      catchups=$((catchups + 1))
      [[ $catchups -le 3 ]] || queue_stop "$INTEG_BRANCH kept moving during the merge (three catch-ups)"
      log "pipeline #$n $id: $INTEG_BRANCH moved during the run; merging it in again (catch-up $catchups)"
      continue
    fi
    reason="the audit asked for fixes"; feedback="$run/audit-$rounds.log"; approved_cid=""
  fi
  queue_leave  # a failed check or a FIX: the fix round runs outside the queue
  if [[ $rounds -ge 2 ]]; then
    log "pipeline #$n $id: NOT MERGED after two fix rounds; branch $branch kept at $(git -C "$wt" log -1 --format=%h)"
    echo "RESULT #$n $id: NOT MERGED ($reason twice; branch $branch, worktree $wt kept; see $run)"; exit 1
  fi
  rounds=$((rounds + 1))
  { echo "# Fix round $rounds for pipeline run $n ($id): $reason"; echo; cat "$feedback"; echo; echo "# The task bundle"; cat "$bundle"; } > "$run/fix-$rounds.in"
  fix_prompt="You are $agent on branch $branch in your own worktree, fix round $rounds of 2 for package $id: $reason. On stdin: the failing output or the audit's findings, then the task bundle. Fix the cause (not the test), add the regression test where one is missing, run the failing check yourself, commit with your model's Co-Authored-By trailer, amend nothing, and update the report (a new commit whose body is the whole report). $no_wait Reply in at most five lines: last commit, what you fixed, anything you could not fix."
  run_agent "fix-$n-$rounds" "$run/fix-$rounds.log" "$agent" "$model" "$effort" "$run/fix-$rounds.in" "$fix_prompt" "${worker_tools[@]}"
  log "pipeline #$n $id: fix round $rounds done, $(git -C "$wt" log -1 --format=%h)"
  stop_questioned "$run/fix-$rounds.log"
done

# Still in the queue: merge only the audited commit, only while the branch points at it (pascaline A17).
if ! why="$(audited_head_check "$wt" "$branch" "$audited")"; then
  queue_stop "the branch is not the audited HEAD: $why"
fi
if [[ $merge -eq 0 ]]; then
  queue_leave; log "pipeline #$n $id: APPROVED, not merged (--no-merge)"
  echo "RESULT #$n $id: APPROVED, not merged (--no-merge); merge: git -C $integ merge --no-ff $audited"; exit 0
fi
if git -C "$integ" merge --no-ff -m "Merge $branch: $id (pipeline run $n)" "$audited" > "$run/merge.log" 2>&1; then
  mc="$(git -C "$integ" rev-parse --short HEAD)"
  # only the pipeline's own worktree goes; a worktree made by hand (--no-worker on it) stays, and with it the branch
  if [[ "$wt" == "$main/.claude/worktrees/wp-"* ]]; then
    git worktree remove --force "$wt" >/dev/null 2>&1 || true
    git -C "$integ" branch -d "$branch" >/dev/null 2>&1 || true
  fi
  # The integration worktree's app/node_modules follows its lock file, so the next run can copy it (still holding integ).
  if [[ -f "$integ/app/package-lock.json" ]] && { [[ ! -d "$integ/app/node_modules" ]] || node_modules_stale "$integ/app"; }; then
    if nodemods_take "pipeline-$n" "pipeline #$n $id:"; then
      own_sh 'cd "$1" && timeout 1800 npm ci --prefer-offline --no-audit --no-fund' "$integ/app" > "$run/npm-ci-integ.log" 2>&1 < /dev/null \
        && log "pipeline #$n $id: npm ci in the $INTEG_BRANCH worktree's app/ after the merge" \
        || log "pipeline #$n $id: npm ci in the $INTEG_BRANCH worktree's app/ FAILED (see $run/npm-ci-integ.log); the next run installs its own"
      nodemods_drop
    fi
  fi
  queue_leave
  log "pipeline #$n $id: MERGED $mc (audited ${audited:0:9})"
  result="RESULT #$n $id: MERGED $mc"; rc=0
else
  why="$(merge_failure_reason "$integ" "$run/merge.log")"
  git -C "$integ" merge --abort >/dev/null 2>&1 || true
  [[ "$why" != conflict ]] || why="merge conflict"
  queue_leave
  log "pipeline #$n $id: NOT MERGED ($why); branch $branch kept"
  result="RESULT #$n $id: NOT MERGED ($why; branch $branch, worktree $wt kept; retry with --no-worker)"; rc=1
fi
# Garbage collection after every third run.
if (( n % 3 == 0 )); then "$self_dir/gc.sh" --apply >> "$run/run.log" 2>&1 || log "pipeline #$n: gc failed (see $run/run.log)"; fi
echo "$result"; exit $rc
