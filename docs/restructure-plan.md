# Restructuring plan

How coach goes from two months of growth without a clear goal to a first
release. This file holds the plan, its status, the decisions taken so far and
the open questions. Rewrite it in place as steps finish (git keeps the
history). Once `docs/decisions.md` exists (step 2.1), the decisions move there.

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
  `.claude/worktrees/phase-0`). `main` stays at tag `pre-cleanup` until nordmu
  fast-forwards it.
- 2026-10-31, nordmu: until the pipeline exists, the Claude Code session
  coordinates. Read-only work fans out to parallel agents. Writing work goes
  to one agent per area (Opus 5.5, high effort), each in its own worktree, and
  the session reviews the diff and runs the tests before merging into
  `phase-0`.

## Open questions

| # | Question | Who | Recommendation |
| --- | --- | --- | --- |
| 1 | License | Noah | GPL-3.0-or-later. AGPL-3.0 only if Noah wants to stop others from hosting coach as a web service: for an offline app its network clause (§13) rarely applies. Every author whose code stays must agree (noah, nordmu, Nicola Walker, JMLuner); the map shows whose code is in the core. |
| 2 | Where the Android 0.1.0 is published | Noah | Play Store, F-Droid, an APK on GitHub, or a PWA link. Needed before step 3.5, because the shell depends on it. |
| 3 | Test phones | nordmu, Noah | At least one mid-range Android; an iPhone if iOS matters. |
| 4 | `clipper/` and `report/`: a parked folder here, or their own repos again | nordmu | Decide with the map. |
| 5 | `.auth_password`: a real password? | Noah | If yes, change it. It leaves the history in step 2.8 either way. |
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
  tests pass.

## Findings that shape the plan (2026-10-31)

- **Server pose doesn't fit a phone.** It runs ViTPose-L/H (about 1.2 / 2.5 GB)
  plus YOLOv8s on a workstation GPU, and outputs COCO-17 keypoints. YOLOv8 (via
  the ultralytics package) is AGPL-3.0.
- **The diagnostics are portable.** `src/diagnostics.js` already runs in the
  browser on COCO-17 keypoints and works as it is.
- **The frontend is trapped in Python.** It lives inside `src/app.py` as one
  ~3,600-line string (`INDEX_HTML`) and has no tests.
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
- [x] `.claude/settings.json` blocks reads of the huge files: the two
      three.js copies, the MediaPipe bundles, the anatomy model, the notebook,
      tracks, goldens and videos.
- [ ] The message to Noah is sent: license, where 0.1.0 is published, the
      password, no pushes to `main`, the history rewrite.

### Phase 1: the map, then the core

- [~] 1.1 Map every tracked file into areas into `docs/map.md`, with a
      suggestion per area (core / dev tool / research / drop). For each area:
      - what a user can do with it;
      - entry points and runtime needs;
      - tests and couplings;
      - whether it can run offline on a phone;
      - licence and provenance;
      - stale parts.
- [ ] 1.2 Check what each tab actually does by running the app, not from the
      docs.
- [ ] 1.3 **nordmu names the core.** This is the gate for everything below.

### Phase 2: cleanup (interactive, in `phase-0`)

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
      - pseudonymize named people.
- [ ] 2.5 Stop tracking `.auth_password`, `report/.DS_Store` and
      `tests/.DS_Store`.
- [ ] 2.6 Rewrite the docs only for what stays (README, `docs/*`), and only
      after 2.2.
- [ ] 2.7 Add LICENSE, SPDX headers and `THIRD_PARTY.md` once question 1 is
      answered and the authors have agreed.
- [ ] 2.8 One history rewrite at the end of the window, before Noah resumes,
      with nordmu's explicit OK. It removes the videos, the password and the
      removed bloat. Everyone re-clones, then nordmu fast-forwards `main`.

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
      goldens.
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
