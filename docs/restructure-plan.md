# Restructuring plan

How coach goes from two months of growth without a clear goal to a first
release. This file holds the plan and its status. Rewrite it in place as steps
finish (git keeps the history). Decisions and open questions are in
[decisions.md](decisions.md) (since step 2.1), the binding rules in
[rules-core.md](rules-core.md), open items outside the plan in
[backlog.md](backlog.md).

## Next session starts here

- **Current step:** Phase 2, step 2.3, the third area: bar detection. Phases
  0 and 1, steps 2.0–2.2, and the clipper and report moves are done.
- **In flight:** nothing. The Phase 3 spike can start in parallel; its baseline
  scripts are in `spike/phone-baseline/` (now pointing at `src/pose/`).
- **Waiting on Noah:** answers to questions 1, 2 and 5 in
  [decisions.md](decisions.md) (the message went out on 2026-10-31).
- **Test baseline:** 68 JS and 5 Python tests since step 2.0.
- **Don't touch:** `main`, the `pre-cleanup` tag, `.caddy/`, and the tablet
  `HA24BZ2Y` (it belongs to other projects' night shifts; the Fairphone 6
  `4d42e62f` is coach's test phone, always via `adb -s`).
- **Read first:** this file, then [map.md](map.md) (especially "Hidden
  couplings"), then AGENTS.md. [rules-core.md](rules-core.md) binds;
  [docs/README.md](README.md) says where every other fact lives.

## Goal

Release **0.1.0**: an Android app (iOS possibly as a PWA) that works entirely
offline. Pose inference runs on the phone, with no server compute for
analysing videos. 0.1.0 covers a narrow core, and everything else waits for
later releases.

## Rules for the window

- All work happens in the `phase-0` worktree. `main` is not touched.
- [rules-core.md](rules-core.md) and [AGENTS.md](../AGENTS.md) bind. AGENTS.md
  §4 says to stop and ask before a change that can break the deploy: during
  the window nordmu is the one to ask (Noah gave the go).
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
- [x] 1.3 **nordmu named the core** (2026-10-31; see [decisions.md](decisions.md)).

### Phase 2: cleanup (interactive, in `phase-0`)

Where clipper and report go, and that the squat, image and clean & jerk tabs
are parked, was decided on 2026-10-31 ([decisions.md](decisions.md)).

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
- [x] 2.1 The docs skeleton in pascaline's shape, one place per fact
      (2026-10-31):
      - [rules-core.md](rules-core.md): the goal, the four principles (both
        nordmu's) and the hard rules;
      - [README.md](README.md) (the index; it replaces the root README's docs
        table), [backlog.md](backlog.md) (seeded with the map's open items in
        code that stays), [decisions.md](decisions.md) (the decisions and open
        questions from this file);
      - CLAUDE.md stays a pointer. AGENTS.md lost nothing that is still true:
        its server-only rules (Caddy, the live CA, restarts, §5's sibling
        notes) moved to [server.md](server.md), with a pointer, since the
        server stays as dev tooling.
- [x] 2.2 Per area, nordmu decided (2026-10-31; [decisions.md](decisions.md)):
      - park: bar detection, Movement Lab and anatomy, 3D, the train tab, and
        the squat, image and clean & jerk tabs; `report/` as research;
      - move out: `clipper/`, to its own repo;
      - keep: the core (areas 1–3). The server pose and ops stay as dev
        tooling: the map's suggestion, implied by the `server.md` decision but
        not asked on its own. The dataset scripts are sorted in the clipper
        and train-tab steps. Tests and docs follow what they cover.
- [ ] 2.3 Carry out the moves one area per commit, each with the grep and the
      tests, in this order:
      - [x] `clipper/` to its own repo (2026-10-31): `weightlifting-clipper`,
        a local sibling of coach, not pushed. Its history is nordmu's two
        original commits (same hashes) plus Noah's `e178d97`, replayed with
        his author and date; the tree is identical to coach's `clipper/`.
        The sync script stays in coach and now needs `$CLIPPER_OUT` or
        `--clipper-dir`. The README's copy of clipper's `clip-nvidia` section
        went too;
      - [x] `report/` to `parked/report/` (2026-10-31), with
        `parked/README.md` as the folder's index. `report.tex` reads only
        `figures/` beside it; `extract_track.py` finds `src/` one level
        further up. Not checked: the PDF build (this laptop's TeX lacks the
        `lmodern`/`ecrm` fonts, so `make` fails in the preamble, before any
        moved path) and the notebook's own paths (its reads are denied by
        `.claude/settings.json`);
      - [ ] bar detection;
      - [ ] Movement Lab and anatomy;
      - [ ] 3D;
      - [ ] the tabs: train, squat, image, clean & jerk (added 2026-10-31,
        after nordmu parked the last three; not an area of its own in the
        map). The train tab's `TRAIN_DIR` still falls back to the in-repo
        `clipper/downloads`, which left in the clipper step.
- [ ] 2.4 The videos:
      - record the provenance of each committed clip;
      - move scraped or unclear clips to `tests/fixtures/local/` (gitignored,
        already supported by the app and the tests);
      - keep tracks and goldens public;
      - pseudonymize named people. The athlete's name is in 19 tracked files,
        6 of them in file paths, and in code: `src/squat/app.mjs:328`
        branches on `id.includes('athlete-a')`.
- [ ] 2.5 Stop tracking `.auth_password`, `parked/report/.DS_Store` and
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
