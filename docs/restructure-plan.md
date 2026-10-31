# Restructuring plan

How coach goes from two months of growth without a clear goal to a first
release. This file holds the plan, its status, the decisions taken so far and
the open questions. Rewrite it in place as steps finish (git keeps the
history). Once `docs/decisions.md` exists (step 2.1), the decisions move there.

## Next session starts here

- **Current step:** Phase 2, step 2.1 (the docs skeleton). Phases 0 and 1 and
  step 2.0 are done.
- **In flight:** nothing. The Phase 3 spike can start in parallel; its baseline
  scripts are in `spike/phone-baseline/` (now pointing at `src/pose/`).
- **Waiting on Noah:** answers to questions 1, 2 and 5 (the message went out
  on 2026-10-31).
- **Test baseline:** 68 JS and 5 Python tests since step 2.0.
- **Don't touch:** `main`, the `pre-cleanup` tag, `.caddy/`, and the tablet
  `HA24BZ2Y` (it belongs to other projects' night shifts; the Fairphone 6
  `4d42e62f` is coach's test phone, always via `adb -s`).
- **Read first:** this file, then [map.md](map.md) (especially "Hidden
  couplings"), then AGENTS.md.

## Goal

Release **0.1.0**: an Android app (iOS possibly as a PWA) that works entirely
offline. Pose inference runs on the phone, with no server compute for
analysing videos. 0.1.0 covers a narrow core, and everything else waits for
later releases.

## Decisions so far

- 2026-10-31, Noah: nordmu may restructure the repo for a while; Noah resumes
  work afterwards.
- 2026-10-31, nordmu: offline is a hard requirement, so no server compute.
- 2026-10-31, nordmu: nordmu names the core, from the map (step 1.3).
  Everything outside it is parked, not deleted.
- 2026-10-31, nordmu: cleanup first, then a small pipeline ported from
  pascaline (not APODroid). The pipeline waits for fixes to pascaline's own
  pipeline and for the skill nordmu is extracting from it.
- 2026-10-31, nordmu: restructuring happens on branch `phase-0` (worktree
  `.claude/worktrees/phase-0`). `main` stays at tag `pre-cleanup` until the end of
  the window (step 2.8).
- 2026-10-31, nordmu: until the pipeline exists, the Claude Code session
  coordinates. Read-only work fans out to parallel agents. Writing work goes
  to one agent per area (Opus 5.5, high effort), each in its own worktree, and
  the session reviews the diff and runs the tests before merging into
  `phase-0`.

- 2026-10-31, nordmu: **the core of 0.1.0 is the lift analysis pipeline**:
  video, on-device pose, `diagnostics.js`, plots and verdicts (map areas 1–3).
  3D, bar detection, anatomy, the Movement Lab and the train tab are parked.
- 2026-10-31, nordmu: 0.1.0 analyses the **lateral raise**, plus the **snatch
  if the Phase 3 spike passes** (otherwise the snatch moves to 0.2).
- 2026-10-31, nordmu: `clipper/` goes back to its own repo; `report/` stays
  here as a parked research folder.
- 2026-10-31, nordmu: the core's in-browser pose lives in `src/pose/`. Parked
  areas go to `parked/<area>/` at the root, moved with `git mv` and unwired
  from the app. Their tests move with them and leave `npm test`, which then
  guards only the core; each parking commit records the new count.

## Open questions

| # | Question | Who | Recommendation |
| --- | --- | --- | --- |
| 1 | License | Noah | GPL-3.0-or-later. AGPL-3.0 only if Noah wants to stop others from hosting coach as a web service: for an offline app its network clause (§13) rarely applies. Every author whose code stays must agree (noah, nordmu, Nicola Walker, JMLuner); the map shows whose code is in the core. |
| 2 | Where the Android 0.1.0 is published | Noah | Play Store, F-Droid, an APK on GitHub, or a PWA link. Needed before step 3.5, because the shell depends on it. |
| 3 | Test phones | nordmu, Noah | Answered in part (nordmu, 2026-10-31): nordmu's Fairphone 6 (`4d42e62f`; LineageOS, no Google Chrome). A stock Android phone with Chrome and Google's WebView is still missing; an iPhone too, if iOS matters. |
| 4 | The squat, image and clean & jerk tabs: park them, or keep them hidden in the core? | nordmu | Park squat and image (no core diagnostics). Keep clean & jerk's code but hide its tab until it has more than one cue. |
| 5 | `.auth_password` is an unsalted SHA-256 hash of the old login password, with a scheme "identical to tecna". Is that password used anywhere else? | Noah | Change it wherever it's used. The file leaves the history in step 2.8 either way. |
| 6 | How long the window lasts | Noah | Step 2.8 (history rewrite) has to finish before Noah resumes. |

## Rules for the window

- All work happens in the `phase-0` worktree. `main` is not touched.
- [AGENTS.md](../AGENTS.md) still binds. Its §4 says to stop and ask before a
  change that can break the deploy: during the window nordmu is the one to ask
  (Noah gave the go).
- Every move follows AGENTS.md §2: grep the whole repo for the old name, then
  run `npm test` and `python3 -m unittest discover -s tests -p 'test_*.py'`.
- Park, don't delete, until step 2.8.
- Nothing is pushed, and no history is rewritten, without nordmu's explicit OK.
- Baseline on 2026-10-31 at `62b2cee`: 66 of 66 JS tests and 3 of 3 Python
  tests pass. After step 2.0: 68 and 5 (new tests for the 33→17 mapping and
  the preview's routes).

## Findings that shape the plan (2026-10-31)

- **Server pose doesn't fit a phone.** It runs ViTPose-L/H (about 1.2 / 2.5 GB)
  plus YOLOv8s on a workstation GPU, and outputs COCO-17 keypoints. YOLOv8 (via
  the ultralytics package) is AGPL-3.0.
- **The diagnostics are portable.** `src/diagnostics.js` already runs in the
  browser on COCO-17 keypoints and works as it is.
- **The frontend is trapped in Python.** It lives inside `src/app.py` as one
  ~3,600-line string (`INDEX_HTML`). Only its inline 3D viewer is tested.
- **A hidden coupling.** `launchers/run_local.py` and `src/local_depth.py` read
  app.py's *source text* with `ast`. Splitting app.py or renaming its functions
  silently breaks the local preview.
- **Two skeletons.** The server path uses COCO-17. The Movement Lab
  (`src/squat/`) uses MediaPipe BlazePose-33, from the deprecated legacy
  package.
- **Legal and hygiene.**
  - There is no LICENSE.
  - `.auth_password` was committed on 2026-09-01; nothing in the repo reads it.
  - Test and report videos include YouTube broadcast footage, and a named
    athlete with her measured limb lengths.
- **Unreviewed pushes.** Contributors pushed straight to `main`; one cleanup
  commit deleted TODO.md, which had to be restored.
- **On the Fairphone 6**
  ([map.md, Phone test](map.md#phone-test-2026-10-31)):
  - WebGPU, including `shader-f16`, and WebCodecs work in Brave and inside a
    Capacitor WebView (153).
  - The existing MediaPipe prototype runs; `<video>` seeking, not the model,
    takes most of the time.
  - Its tracks give the same diagnostic verdicts as ViTPose-L on the lateral
    raise (7 of 8 scored verdicts), but not on the snatch (0 of 4, on two
    front or oblique clips; model, sample rate and camera angle are all open
    explanations).

## Packaging, in short

Whatever the shell, the code becomes one static, offline web app (no Flask),
with the pose model behind one async interface in a Web Worker (like
pascaline's `MathEngine`). The options:

- **PWA only:** the fastest route. Works in Android Chrome, and in iOS Safari,
  which has WebGPU since Safari 26. No store listing.
- **Capacitor** (pascaline's route):
  - produces an APK with the models inside;
  - runs in Android WebView, where full WebGPU is unconfirmed (Chromium ships
    WebGPU compatibility mode to WebView in M146);
  - fallback: a native inference plugin;
  - F-Droid dislikes binary model files.
- **TWA:** the PWA in the Play Store, running in real Chrome.
- **A native rewrite:** no. It would mean rewriting the diagnostics and the UI.

Lean: PWA plus Capacitor, so pascaline's build and release work carries over.
The spike's WebView numbers (Phase 3) decide.

## Phases

`[x]` done, `[~]` in progress, `[ ]` open.

### Phase 0: setup (2026-10-31)

- [x] Tag `pre-cleanup` on `main` (`62b2cee`).
- [x] Branch `phase-0` and its worktree `.claude/worktrees/phase-0`.
- [x] This plan.
- [x] `.claude/settings.json` keeps the Read tool away from the huge files (it doesn't stop scripts): the two
      three.js copies, the MediaPipe bundles, the anatomy model, the notebook,
      tracks, goldens and videos.
- [x] The message to Noah is sent: license, where 0.1.0 is published, the
      password, no pushes to `main`, the history rewrite (nordmu,
      2026-10-31).

### Phase 1: the map, then the core

- [x] 1.1 The map: [map.md](map.md), with every tracked file in 12 areas and
      a suggestion per area.
- [x] 1.2 Ran the full app (on the CPU) and the local preview. Also ran the
      existing in-browser pose on the Fairphone 6 and compared its diagnostics
      with ViTPose-L (map.md, Phone test). The server tabs needing Noah's
      dataset (train data) and bar detection were not run.
- [x] 1.3 **nordmu named the core** (2026-10-31; see Decisions so far).

### Phase 2: cleanup (interactive, in `phase-0`)

The former question 4 was answered on 2026-10-31: clipper goes to its own
repo, report stays here (see Decisions so far).

- [x] 2.0 Before any move (2026-10-31):
      - the message to Noah has been sent, including "no pushes to `main`";
      - **moved the core's own files out of the folders being parked**, into
        `src/pose/`:
        - `pose.mjs`, and MediaPipe as `vendor/mediapipe-pose/` with its
          licence and manifest (its credits in `src/pose/THIRD_PARTY.md`);
        - `local-mode.mjs`;
        - one 33→17 mapping, `coco17.mjs`, used by `local-mode.mjs`,
          `track-session.mjs` and the spike's `mp-run.js` (there were three
          copies, not two);
        - both servers serve `/pose/`; the squat lab imports `../pose/`;
      - removed the `ui-config.mjs` read from app.py **and** from
        `launchers/run_local.py` (the plan named only app.py; the map named
        both): `/` is always the lift page;
      - fixed `/original/`: both servers redirect it to `../` (relative, so it
        works under `/coach/`), the preview opens `/`, and it now serves
        `logo.png`;
      - tested: the grep, 68 + 5 tests, the preview and the full app over
        HTTP, and both pages in headless Brave, directly and behind a
        `/coach/` prefix-stripping proxy (a stand-in for Caddy). MediaPipe ran
        6 frames from its new folder. Not tested: the phone, and the real
        Caddy/tailnet URL.
- [ ] 2.1 The docs skeleton in pascaline's shape, one place per fact:
      - `docs/rules-core.md`: the goal in one sentence, the principles, and
        the hard rules (offline, nothing leaves the phone, licence-compatible
        dependencies);
      - `docs/README.md` (the index), `docs/backlog.md`, `docs/decisions.md`
        (the decisions above move there);
      - CLAUDE.md stays a pointer, and AGENTS.md shrinks to what is still
        true. Its deploy and tailnet rules go with the dev tooling if that is
        kept.
- [ ] 2.2 Per area, nordmu decides: keep, park, move out, or delete. "Parked"
      means a clearly named folder, or its own repo again.
- [ ] 2.3 Carry out the moves one area per commit, each with the grep and the
      tests.
- [ ] 2.4 The videos:
      - record the provenance of each committed clip;
      - move scraped or unclear clips to `tests/fixtures/local/` (gitignored,
        already supported by the app and the tests);
      - keep tracks and goldens public;
      - pseudonymize named people. The athlete's name is in 19 tracked files,
        6 of them in file paths, and in code: `src/squat/app.mjs:328`
        branches on `id.includes('athlete-a')`.
- [ ] 2.5 Stop tracking `.auth_password`, `report/.DS_Store` and
      `tests/.DS_Store`.
- [ ] 2.6 Rewrite the docs only for what stays (README, `docs/*`), and only
      after 2.2.
- [ ] 2.7 Add LICENSE, SPDX headers and `THIRD_PARTY.md` once question 1 is
      answered and the authors have agreed.
- [ ] 2.8 One history rewrite at the end of the window, before Noah resumes,
      with nordmu's explicit OK. It removes the videos, the password and the
      removed bloat. Rewritten history doesn't descend from `62b2cee`, so:
      - `main` is reset and force-pushed to `noahsta/coach`, with Noah's OK;
      - the `pre-cleanup` tag and the merged branches `test-fixtures-pipeline`
        and `origin/feature/keypoint-plotting` are deleted or moved to a
        private backup, or they keep the old files reachable;
      - every old clone is re-cloned (Noah, Nicola, JMLuner);
      - branch protection on `main` stops one push from an old clone
        bringing everything back.

### Phase 3: on-device pose spike (2–3 days in `spike/`; can start once the core is named)

- [ ] 3.1 Pick 2–3 candidates that fit the core:
      - ViTPose-S/B via easy_ViTPose's `export.py` (COCO-17, so the
        diagnostics work unchanged);
      - RTMPose-s/m (COCO-17, Apache-2.0);
      - MediaPipe Pose Landmarker (33 points, needs a COCO-17 mapping).

      The person detector is not YOLOv8 unless the whole app accepts AGPL.
- [ ] 3.2 One standalone page that:
      - decodes a fixture video with WebCodecs (not by seeking a `<video>`
        element);
      - runs the model in a Worker (ONNX Runtime Web, WebGPU with a WASM
        fallback);
      - writes a `track.json` in the fixture format.
- [ ] 3.3 Measure on real phones, in Chrome and inside a Capacitor WebView:
      ms per frame, decode time, total time per clip, peak memory, download
      size.
- [ ] 3.4 Run `diagnostics.js` on each track and compare with the ViTPose-L
      goldens. Add a **side-view snatch clip**, because the current two are
      front or oblique views, and count only scored verdicts.
- [ ] 3.5 A decision record: model, runtime and shell (PWA / Capacitor /
      TWA), with the numbers. The stop condition is agreed before 3.3: if no
      model keeps the diagnostics' results on a mid-range phone, nordmu and
      Noah discuss a server fallback or a narrower core.

### Phase 4: a small pipeline (after pascaline's fixes and nordmu's skill)

- [ ] 4.1 Port from pascaline only:
      - the package files (Why / Read / Steps / Done when);
      - the flow: a worker in its own worktree, the checks, a read-only diff
        audit, a `--no-ff` merge;
      - `.coord/log.md`, `.tasks/`, the RESULT line and the script's own
        tests.
- [ ] 4.2 One worker and one auditor. Night shifts, lanes, the coordinator and
      overseer agents, locks and Opus passes come later, if the volume of work
      needs them.
- [ ] 4.3 The checks: `npm test`, the Python tests, and a new check that
      fails on absolute asset paths (turning AGENTS.md §1 into a test).

### Phase 5: the core in depth

- [ ] 5.1 Analyse the core's code:
      - moving the frontend out of app.py into static files;
      - the pose engine interface;
      - what the core still needs from the server.
- [ ] 5.2 Tests for the core's UI path, before any unattended work touches it.
- [ ] 5.3 Output: the refactor packages.

### Phase 6: 0.1.0 scope and timeline

- [ ] 6.1 0.1.0 is the core, plus a written "not in 0.1.0" list.
- [ ] 6.2 Release criteria:
      - works in airplane mode on the target phones;
      - a working install path;
      - LICENSE and the third-party list;
      - a privacy text.
- [ ] 6.3 Packages with estimates. The timeline is their sum plus a buffer,
      not a date picked first.

### Phase 7: build 0.1.0

The packages run through the pipeline. The design-heavy ones (moving the
frontend out, the pose engine) are done interactively with nordmu.
