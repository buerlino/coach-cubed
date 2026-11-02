# The agent pipeline

How coach's work runs as small packages through fresh agents: a worker in its own worktree, the deterministic checks, a
read-only audit of the diff, and a `--no-ff` merge into `phase-0`. Ported from pascaline (`../pascaline`, its
`scripts/pipeline.sh` and `docs/shifts/rules.md`) in step 4 of the [plan](restructure-plan.md); the scripts are in
[../pipeline/](../pipeline/README.md). [rules-core.md](rules-core.md) binds every agent; this file adds the pipeline's rules.
Workers read "Hard rules" and "Worker setup"; the bundle quotes "Your report" and "Definition of done" to them.

nordmu, 2026-11-01: the pipeline is built now, from pascaline's scripts directly (not from the general skill), so that
Phase 5 runs as packages, one fresh session each. A coordinating session writes the packages and their queue; packages
run autonomously, UI included, and merge on the audit; a review with nordmu follows once a prototype runs. The agents'
names and roles are nordmu's ([decisions.md](decisions.md#rules-and-docs)).

## The agents

Agent files in `.claude/agents/`. Every package names its worker in its first line.

| Agent | Role | Owns |
| --- | --- | --- |
| dirac | worker | the new app's UI: the screens of [ui-design.md](ui-design.md), the result view (video, overlay, cues, plots), import, the responsive layout, the PWA's manifest and the app shell the service worker caches |
| schrödinger | worker | the analysis core: the on-device pose engine (TF.js from source, behind one Worker interface), smoothing and the lift window, `src/diagnostics.js`, its tests, goldens and reference tracks |
| curie | worker | the phone and the platform: the Capacitor shell and its build, the service worker (offline caching, updates) and storage (OPFS), the gym recording session, every measurement on the Fairphone; the only one with adb |
| einstein | advisor | research packages and design questions: evidence, probes, a recommendation; no feature code |
| hillbert | auditor | the diff audit of every run (Read, Grep, Glob only); reviews over time on request |
| faraday | night runner | the queue overnight, summoned with "faraday, run the night": the next ready laptop package, checked against what merged, run with `pipeline/pipeline.sh <id>`, its merge recorded in the queue; stops at the gates, reports in the morning; no device, no push |

Two packages that touch the same files don't run at once. Interfaces between owners (the Worker's messages, the result
object the UI draws) are agreed in a package of their own before both sides build on them.

## Package files

A package is one concern a fresh session finishes in one run: a few hours of agent work, one branch, one merge. It lives in
`docs/packages/<id>.md` on `phase-0`, written before the run; [packages/README.md](packages/README.md) has the template.

- **Id:** a lane letter and a global number, lowercase (`e1`, `d5`, `s11`, `c10`), with an optional suffix for a split
  (`d5b`). A FIX package for an unmerged or merged branch adds `f<k>` (`e2f1`) and has no file: it runs as free text
  (below). An id is minted only after `git grep` on all branches and a look at `.coord/log.md`.
- **The queue** (the order, the gates, the status) is in [packages/README.md](packages/README.md). The coordinating
  session keeps it (at night, faraday); workers never edit it, so parallel branches don't conflict on it.
- **First line, exactly:** `` # <id>: <title> (<agent>, <sonnet|opus>, branch `wp/<agent>-<slug>`) ``, with the agent's
  name as in the table (`schrödinger` keeps its umlaut; its branches spell it `schroedinger`). The pipeline reads the
  agent, the model and the branch from it.
- **Then:** `**Why:**` (the problem, with evidence), `**Read:**` (the files and sections the worker needs, by repo path:
  the bundle includes the first 400 lines of each named file), the numbered steps, and `**Done when:**` (checkable
  lines; the audit holds the diff to them). `**Red first:** yes` when the package's new tests must fail on `phase-0`
  (every bug fix and every new behaviour with a test): the pipeline then runs the branch's new and changed test files
  on `phase-0`'s code. It copies those test files and the files the branch adds under `tests/`; every other file,
  helpers, fixtures and goldens included, stays `phase-0`'s version, so a fix made inside `tests/` shows red too. A
  branch whose tests all pass there is refused.
- **The bundle's files:** every repo path anywhere in the package counts, in alphabetical order until the 2000 lines,
  not only "Read". Name each file the worker needs (never a folder: it isn't bundled); mention a big file it needn't
  read without its full path (`src/`'s app.py), or it crowds out the rest; paths under `.claude/` aren't bundled.
- **Scope:** only what the file names. A package that needs a decision nobody made yet is not ready to run.

## The pipeline

`pipeline/pipeline.sh <id>`, from any checkout of the repo; free text with `pipeline/pipeline.sh <agent> "<task>" --id
<id>f<k> [--branch <branch>]`; the options are in the script's header. Each run:

1. **Bundle:** the package file from `phase-0`'s commit, the first 400 lines of every file it names (2000 in all), and
   this file's "Your report" and "Definition of done", written to `.tasks/<n>-<id>/spec.md`.
2. **Worker:** one fresh headless `claude -p --agent <agent>` in its own worktree `.claude/worktrees/wp-<n>-<id>` on the
   package branch from `phase-0` (or resumed from the branch's last commit, with `phase-0` merged in first), the bundle
   on stdin, no Agent tool, three hours at most. It commits small and ends with the report commit. A worker that ends
   without a commit, or says its package is missing or wrong, ends the run (NOT MERGED).
3. **The queue:** the run takes the `integ` lock, merges `phase-0` into the branch (a conflict is a resolve round for
   the worker), and runs the **checks** in the worker's worktree: `npm test`, the Python tests, the pipeline's own shell
   tests when `pipeline/` changed, red-first when the package asks for it, and the app's own tests when the diff touches
   `app/` or `src/`: `npm --prefix app test` and `npm --prefix app run test:page` (the offline headless page test),
   each only once `app/package.json` has that script. The run installs `app/node_modules` first when it is missing or
   stale (a hard-link copy of the `phase-0` worktree's, else `npm ci`), and a merge that changes
   `app/package-lock.json` refreshes the `phase-0` worktree's. A failing check whose log shows a
   missing command or module ends the run as a machine failure, never a fix round.
4. **Audit:** hillbert, fresh, Read, Grep and Glob only, gets the package, `git diff -U5 phase-0...<branch>` and the
   report, never whole files, and replies `APPROVED` or `FIX` with findings. Model: Opus when the worker ran on Opus or
   the diff touches the scoring, the pose code, the pipeline or the agents (`AUDIT_OPUS_RE` in `pipeline/lib.sh`), else
   Sonnet. A failed check or a FIX releases `integ`, gives the worker a fix round with the failing lines or the
   findings, and the run queues again: **at most two fix rounds**, then the branch stays unmerged.
5. **Merge:** still holding `integ`, `git merge --no-ff` of the audited commit into `phase-0` in its worktree. If
   `phase-0` moved meanwhile (a commit made without the lock), the run merges it in again and reruns the checks; the
   approval carries over only when the branch's own change set is unchanged, else hillbert audits again. The merge waits
   (10 minutes at most) while the `phase-0` worktree has staged changes or a git command running, and stops when it
   would overwrite an uncommitted edit there; the branch is kept for `--no-worker`. Then the worktree and the branch go.
6. **Bookkeeping:** one line per step in `.coord/log.md`, every file of a run in `.tasks/<n>-<id>/` (both in the main
   checkout, excluded from git through `.git/info/exclude`), one job counter, one dev-server port per run
   (`COACH_PORT` = 8100 + n % 100). Stdout is one line: `RESULT #<n> <id>: MERGED <commit> | NOT MERGED (<why>) |
   LIMIT`; exit 0, 1, 2 (not started) or 75 (usage limit: rerun later; the branch is kept).

**Locks** (`pipeline/devlock.sh`): `integ` (the merge queue) and `branch-<branch>` (one run per branch) are coach's;
`host-cpu` and the phone's serial are the machine's, shared with pascaline's nights. Lock order: `integ` before
`host-cpu`; a holder of `host-cpu` never waits for `integ`. An interactive session that wants to commit on `phase-0`
while runs are queued may hold `integ` too (`pipeline/devlock.sh acquire integ <name> 7200`, released after its commit).

**The history rewrite (step 2.8)** orphans every branch, so it runs only with an empty queue: no `wp/*` branch, no
`.claude/worktrees/wp-*` worktree and no run alive (`pipeline/devlock.sh status` shows no `branch-*` lock).

## Hard rules

- **Git:** the integration branch is `phase-0`. Workers commit only on their package branch, in their own worktree, each
  commit with the trailer `Co-Authored-By: Claude <Model> <noreply@anthropic.com>` of the model that ran. Never push,
  never touch `main` or the `pre-cleanup` tag, never force anything, never amend, and only `git branch -d`.
- **The old page is frozen:** never edit `INDEX_HTML` in `src/app.py`, the Movement Lab, anatomy or 3D code, except
  where the package says it fixes something that blocks the dev server.
- **Nothing goes out:** no uploads, releases, issues, emails or posts. Network only for downloads (npm, pip into the
  `.venv`, git clones of open-source projects, docs).
- **Never invent expected values:** a golden, a threshold or a measurement comes from a track, a device run or a
  documented source the test names.
- **No hanging commands:** every long command gets a timeout and never waits for input; never a background loop that
  waits on a process (`pgrep -f` matches the loop's own command line).
- **Heavy CPU work** (builds, Gradle, pose runs over videos, ViTPose) goes through `pipeline/devlock.sh slice <name>
  <cmd…>`: ten minutes per piece at most, so pascaline's night and the other runs get the CPU between pieces. A slice
  may wait 20 minutes or more for `host-cpu` while others hold it (s7 waited about 20): that is not a hang.
- **The phone belongs to curie** (below). Everyone else runs no adb; the pipeline's adb refuses them.
- **Decisions belong to nordmu** (or Noah, where [decisions.md](decisions.md) says so). Settle what the rules and the
  decisions already decide; anything else goes into your report under "Needs a decision", with your recommendation.
- If a tool call is denied, don't retry it: note it in the report and move on.

## Worker setup

- The pipeline made your worktree and branch; `COACH_PORT` is your run's dev-server port (`COACH_PORT=$COACH_PORT
  "$COACH_PY" src/app.py`, or `launchers/run_original.py --port $COACH_PORT`); `COACH_PY` is the Python with the dev
  dependencies. **Commit small and often.**
- **node_modules:** each folder with a `package-lock.json` gets a hard-link copy of the `phase-0` worktree's
  `node_modules` when that one is current; otherwise install with `npm ci --prefer-offline` yourself.
- **Shared files:** on your branch, change the docs that describe what you changed (a module's README, `tests/README.md`,
  a row of [README.md](README.md) for a new doc, a [THIRD_PARTY.md](../THIRD_PARTY.md) line for a new dependency), and
  nothing else shared: `AGENTS.md`, `CLAUDE.md`, `docs/rules-core.md`, `docs/decisions.md`, `docs/restructure-plan.md`,
  `docs/pipeline.md`, `docs/packages/` (the queue included), `.claude/` and `pipeline/` (unless your package is about the
  pipeline) get their text through your report, under "For shared files". Questions for nordmu go into the report
  under "Needs a decision", never into `docs/decisions.md`: the coordinating session files them.
- **Read by section,** never whole big files: `grep -n '^#' <file>`, then the range. Every file you read is sent again on
  every later turn.
- **When a task is done:** commit the report, then reply as the prompt asks. Nobody is waiting for messages.

## The phone

- The Fairphone 6, serial `4d42e62f`, is nordmu's personal phone (LineageOS, no Google Chrome). The tablet `HA24BZ2Y`
  belongs to other projects: never touch it.
- Only curie runs adb, and only on `4d42e62f` (the pipeline sets `ANDROID_SERIAL` and refuses other devices and
  `kill-server`); every other run gets `ANDROID_SERIAL=coach-no-device`, so adb by its full path, Gradle or Capacitor
  finds no device. Every adb command names the phone, `adb -s 4d42e62f …`: the hook `.claude/hooks/adb_guard.py`
  blocks one that doesn't, and any command naming `HA24BZ2Y`, in every session. Take the phone's lock first, `pipeline/devlock.sh acquire 4d42e62f curie-<run> 1800`: pascaline's
  nights use the same phone and the same lock. If it is busy or the phone is missing, say so in the report.
- Install only coach's own app; never touch other apps or the owner's data. Keep the phone awake with
  `pipeline/stay-awake.sh 4d42e62f` and put it back with `pipeline/stay-awake.sh 4d42e62f --restore-real`.
- Battery under 25 %: lower the brightness; under 10 %: stop. Let it cool above about 35 °C. Numbers are medians of at
  least five runs, with the device, the Android and WebView versions and the build.

## Your report

End with a commit whose message body is the report; the audit reads it with the diff. It holds:
- **Done:** what was built, item by item against the package's "Done when" lines.
- **Tests:** the counts of `npm test` and the Python tests as run, and the new tests by name. A test that passes on the
  old code is not a regression test: change it until it fails there, or list it under "Not done".
- **Numbers:** sizes, timings, measurements, each with how it was measured.
- **For shared files:** the exact text for the shared files you may not edit (Worker setup), each with its file and place.
- **Needs a decision:** anything left open, each with your recommendation first.
- **Not done:** what is missing, and why.

Then reply as the pipeline's prompt asks (at most five lines).

## Definition of done

- `npm test` and `python3 -m unittest discover -s tests -p 'test_*.py'` pass; the pipeline's shell tests too when
  `pipeline/` changed; `npm --prefix app test` and `npm --prefix app run test:page` when the diff touches `app/` or
  `src/` and the script exists.
- Every "Done when" line of the package is met, or listed under "Not done" in the report.
- New behaviour has tests; a fixed bug has a regression test that fails on `phase-0`.
- The docs that describe the change are updated in the same branch; every path stays relative; every new dependency that
  ships is open source, licence-compatible and in `THIRD_PARTY.md`.
- Every commit carries the trailer of the model that ran; the last one is the report.

## What the audit checks

Besides the package's "Done when" lines, hillbert looks for what a review tends to miss:
- **Honest verdicts:** a cue scored when the keypoints don't support it, a threshold not marked provisional, a verdict
  that hides "can't score".
- **Invented values:** a golden, a threshold or an expected number without a named source.
- **Offline and privacy:** anything fetched at run time (a CDN, a font, a model URL), anything sent anywhere, analytics.
- **Paths:** an absolute asset path or a machine path (`tests/paths.test.js` catches most, not all).
- **Licences:** a shipped dependency that is AGPL, closed or missing from `THIRD_PARTY.md`.
- **One keypoint format:** a pose model that hands anything but COCO-17 `[y, x, conf]` to `diagnostics.js`.
- **Scope:** files outside the package, the frozen old page edited, shared files edited that belong in the report.
- **Tests that pass for the wrong reason:** a test that would pass on the old code, a skipped or weakened assertion.

## What is not ported (yet)

pascaline also has night shifts (`night.sh` with a coordinator agent and an overseer), two lanes, Opus passes over merged
work, a device step after each pass, a flake census and engine builds per key. coach starts without them: one package at
a time, started by nordmu or a coordinating session. Add them when the volume of work needs them; pascaline's
`docs/shifts/rules.md` section 4 describes each.

## Lessons from pascaline, built in

Each is a guard in the scripts and a case in `pipeline/pipeline.test.sh`:
- a merge of a commit the audit never read (a worker that detached HEAD): only the audited sha merges, and only while the
  branch points at it;
- runs left behind when their pipeline was killed: every agent and check runs in a session of its own that a signal
  ends before the locks go;
- a package merged with no package file, and a worker that questioned its task and was merged anyway: both end the run;
- a comparison that compared nothing: red-first fails when no test ran;
- the CPU lock held for an hour by one job: `slice` caps a hold at ten minutes and hands the lock to a waiter;
- a check failing because the machine lacked a module, sent to the worker as a "fix": a machine failure ends the run.
