# Restructuring plan

How coach goes from two months of growth without a clear goal to a first
release. This file holds the plan and its status. Rewrite it in place as steps
finish (git keeps the history). Decisions and open questions are in
[decisions.md](decisions.md) (since step 2.1), the binding rules in
[rules-core.md](rules-core.md), open items outside the plan in
[backlog.md](backlog.md).

## Next session starts here

- **Current step:** Phases 0–2 are done, and the review's fixes are in
  (commits since `a0a9499`), apart from two steps that wait:
  - 2.7's LICENSE and SPDX headers (GPL-3.0-or-later), for the authors'
    written OKs ([decisions.md](decisions.md#licence));
  - 2.8, the history rewrite, last, with nordmu's explicit OK, once the
    clipper repo has its home.

  **Phase 3 is under way** on branch `p3/spike` (worktree
  `.claude/worktrees/p3-spike`), merged into `phase-0` only with nordmu's
  OK. Done: 3.1–3.5 and 3.6's comparison script, measured on the
  Fairphone in Brave and the Capacitor WebView on 2026-10-31/11-01. On
  2026-11-01 nordmu ruled that the shipped runtime must be open source and
  buildable from source, which drops MediaPipe Tasks; the open runtimes were
  measured the same evening. **3.7, the working pick (nordmu,
  2026-11-01):** MoveNet SinglePose Thunder on TensorFlow.js, WebGL, every
  frame, as a PWA and in Capacitor; final once 3.6 passes on the validation
  set ([pose-spike.md](pose-spike.md)). Open:
  - 3.0, not run: the re-extraction of `lateral-raise-cable-1` with
    ViTPose-L and its diff against the committed track (max and mean
    keypoint distance in pixels, the verdicts raw and smoothed). The night
    session's queued job died with no output on 2026-11-01, and the
    re-queued one was stopped at the session's end because a pascaline
    shift still ran. Only while no night shift runs: start `src/app.py`
    directly (`COACH_PORT=8091`), POST the clip to `/api/pose/video/start`
    with `size=l`, `frame_stride=1`, save `/api/pose/video/result` outside
    the repo, then `node spike/pose-bench/difftrack.mjs <that file>`;
  - 3.0, the validation set: not in by this session's end (2026-11-01,
    20:00; neither the clips nor the friend's written OK), so 3.6 stays
    open. The clips from
    YouTube can't stand in (no lateral raises, mostly front views, on
    Noah's machine). Then its ViTPose-L references, after a clean 3.0 diff;
  - 3.6 on the validation set, which replaces the provisional agreement
    numbers (four example clips, where every candidate but MoveNet
    Lightning sits at 100%) and decides between MoveNet Thunder and
    BlazePose, and the snatch.

  Then Phase 5; milestone B's steps also wait for question 7.
- **Start now, outside a session** (to-dos, not session work):
  - nordmu: a one-line written OK to GPL-3.0-or-later from Noah, Nicola
    Walker and JMLuner (a chat message each is enough);
  - nordmu: a private GitHub repo for `../weightlifting-clipper`, pushed
    (2.8's precondition);
  - nordmu: the validation set (3.0), filmed by a friend, with the
    friend's written OK to use the footage;
  - nordmu, then Noah: the next message, with branch protection on `main`
    and the other open questions ([decisions.md](decisions.md#needs-an-answer));
  - nordmu, later: a stock Android phone with Chrome and Google's WebView,
    after the spike and before the public release (question 3).
- **Waiting on nordmu:** question 8, the review of the tab parking (the goal
  and the principles are confirmed); question 7, how the gym recording
  session works (milestone B).
- **Waiting on Noah:** what he was asked, and what goes in the next message,
  is in [decisions.md](decisions.md#needs-an-answer).
- **The old page is frozen:** don't edit `INDEX_HTML` in `src/app.py`, or the
  Movement Lab, anatomy and 3D code, except to fix something that blocks the
  dev server. Its known absolute paths are allowlisted in
  `tests/paths.test.js`; don't add to that list.
- **In parallel:** the Phase 3 spike may run as a second session in `spike/`;
  its baseline scripts are in `spike/phone-baseline/`.
- **This laptop runs pascaline night shifts:** heavy CPU work (ViTPose) waits
  until `ps -eo args | grep [n]ight.sh` is empty. Stop processes by PID, never
  with `pkill -f`, so start `src/app.py` directly rather than through
  `coach_launch.sh`.
- **The example clips are not in git** (since step 2.4): they sit under the
  gitignored `tests/fixtures/local/` on machines that have them, this laptop
  included. A fresh clone runs every test but has no example gallery.
- **Test counts** (the only place they're kept): 82 JS (5 of them the docs
  and absolute-path checks) and 6 Python tests. Update them here when a
  commit changes them.
- **AGENTS.md stays lean** (step 2.9): status, history and reasoning go in
  this file, [backlog.md](backlog.md) or [decisions.md](decisions.md), never
  there. `npm test` fails when AGENTS.md or a big doc passes its budget.
- **Don't touch:** `main`, the `pre-cleanup` tag, `.caddy/`, and the tablet
  `HA24BZ2Y` (it belongs to other projects' night shifts; the Fairphone 6
  `4d42e62f` is coach's test phone, always via `adb -s`).
- **Read first:** this file, then [decisions.md](decisions.md),
  [rules-core.md](rules-core.md) and AGENTS.md; [map.md](map.md) is a frozen
  snapshot, still worth its "Hidden couplings" before a move.
  [docs/README.md](README.md) says where every other fact lives.

## Goal

Release **0.1.0**: an Android app (iOS possibly as a PWA) that works entirely
offline. Pose inference runs on the phone, with no server compute for
analysing videos. 0.1.0 covers a narrow core, and everything else waits for
later releases. It comes in two milestones: A (import a clip, get the cues)
for testers, then B (the gym recording session); the public 0.1.0 needs
both ([decisions.md](decisions.md#what-010-is)).

## Rules for the window

- All work happens in the `phase-0` worktree. `main` is not touched.
- [rules-core.md](rules-core.md) and [AGENTS.md](../AGENTS.md) bind.
  rules-core's [Stop and ask](rules-core.md#stop-and-ask) says to stop and
  ask before a change that can break the deploy: during the window nordmu is
  the one to ask (Noah gave the go).
- Every move follows rules-core's [Moving a file](rules-core.md#moving-a-file):
  grep the whole repo for the old name, then run `npm test` and
  `python3 -m unittest discover -s tests -p 'test_*.py'`.
- Park, don't delete, until step 2.8.
- Nothing is pushed, and no history is rewritten, without nordmu's explicit OK.

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
    athlete with the athlete's measured limb lengths.
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

**Decided (nordmu, 2026-10-31): a PWA plus a signed Capacitor APK on GitHub;
F-Droid after a feasibility check (step 3.8).** On the Fairphone 6, WebGPU
works in a Capacitor WebView ([map.md](map.md#phone-test-2026-10-31)). A stock
Android phone with Google's WebView is still untested.

## Phases

`[x]` done, `[~]` in progress, `[ ]` open.

### Phase 0: setup (2026-10-31)

Finished steps keep one line each; the details are in their commits.

- [x] Tag `pre-cleanup` on `main` at `62b2cee`, branch `phase-0` and its
      worktree, this plan, Read limits on the huge files (`881d9e7`).
- [x] The first message to Noah ([decisions.md](decisions.md#needs-an-answer)).

### Phase 1: the map, then the core

- [x] 1.1 The map, [map.md](map.md) (`fde52f1`; verified in `916958f`).
- [x] 1.2 Ran the full app on the CPU, the preview, and the in-browser pose on
      the Fairphone 6 against ViTPose-L (map.md, Phone test; `fde52f1`).
- [x] 1.3 nordmu named the core (`0640216`; [decisions.md](decisions.md)).

### Phase 2: cleanup (interactive, in `phase-0`)

- [x] 2.0 The core's pose into `src/pose/` with one 33→17 mapping, `/original/`
      fixed (`423ab8d`). Behind `/coach/`, the frozen code's absolute paths
      still 404 ([backlog.md](backlog.md)).
- [x] 2.1–2.2 The docs skeleton and nordmu's per-area decisions (`b8c4b96`).
- [x] 2.3 `clipper/` back to `../weightlifting-clipper` (`ea1bd5e`), `report/`
      to `parked/report/` (`229d350`), bar detection to
      `parked/bar-detection/` (`212f502`); the other parkings were cancelled,
      those areas freeze with the old page until step 5.8 (`3c15f62`).
- [x] 2.4 The example videos out of git, the athletes pseudonymized (`0c7825a`).
- [x] 2.5 `.auth_password` and two `.DS_Store` files untracked (`d0d98cc`).
- [x] 2.6 The docs describe the repo as it is now (`e5d3d60`).
- [~] 2.7 [THIRD_PARTY.md](../THIRD_PARTY.md) and [authors.md](authors.md)
      (`cc72cc8`); LICENSE and the SPDX headers wait for the authors' written
      OKs ([decisions.md](decisions.md#licence)).
- [ ] 2.8 One history rewrite at the end of the window, before Noah resumes,
      with nordmu's explicit OK. **Precondition:** `../weightlifting-clipper`
      is in nordmu's private GitHub repo ([decisions.md](decisions.md));
      after the rewrite it is the only copy of clipper. It removes the
      videos, the password and the removed bloat, and the athletes' real
      names: they are in old file paths, in old file contents
      (`athlete-a`/`athlete-b` since step 2.4) **and** in commit messages
      (`212f502` and `6904224`; find others with
      `git log --all -i --grep=<name>`). So path filtering alone isn't
      enough: `git filter-repo` also needs `--replace-text` for the contents
      and `--replace-message` for the messages, both fed from the
      gitignored note, never from a tracked file. **Check after the
      rewrite**, with the names in a pattern file outside the repo (one per
      line): `git log --all --format=%B | grep -iwf <file>`,
      `git rev-list --all | xargs git grep -iwl -f <file>` and
      `git log --all --name-only --format= | grep -iwf <file>` all print
      nothing. Rewritten history doesn't descend from `62b2cee`, so:
      - `main` is reset and force-pushed to `noahsta/coach`, with Noah's OK;
      - the `pre-cleanup` tag and the merged branches `test-fixtures-pipeline`
        and `origin/feature/keypoint-plotting` are deleted or moved to a
        private backup, or they keep the old files reachable;
      - every old clone is re-cloned (Noah, Nicola, JMLuner);
      - branch protection on `main` (question 9) stops one push from an old
        clone bringing everything back.
- [x] 2.9 A lean AGENTS.md, its rules moved to rules-core, and
      `tests/docs.test.js` (`0aaf936`).

### Phase 3: on-device pose spike (in `spike/`)

3.0 starts first; 3.1–3.4 can run alongside it. The thresholds and the stop
condition are decided ([decisions.md](decisions.md#what-010-is)).

- [ ] 3.0 **The validation set**, before any measurement (3.5): a friend of
      nordmu films, after a written OK to use the footage,
      about 10 lateral-raise sets of several reps and about 5 side-view
      snatches (kept out of git, under `tests/fixtures/local/`). Each gets a
      ViTPose-L reference track from the dev server and a few verdicts judged
      by a person. **Precondition**, before the first new reference track or
      golden: re-extract one committed clip's track with the edited
      `vitpose_backend.infer_video` (`212f502` changed it; no pose pass has
      run since) and diff it against the committed track. Start `src/app.py`
      directly (`coach_launch.sh` runs `pkill -f`), and only while no
      pascaline night shift runs (`ps -eo args | grep [n]ight.sh`): at about
      1 s per frame on this CPU, a 3 s clip takes minutes. Not run on
      2026-10-31 or 11-01: a night shift had the CPU each time.
- [x] 3.1 Candidates: MediaPipe Pose Landmarker (lite, full, heavy),
      ViTPose-S/B and RTMPose-s/m, the last two behind Megvii's YOLOX
      (Apache-2.0); versions, sources and licence flags (ViTPose's MAE
      pretraining is CC BY-NC) in [THIRD_PARTY.md](../THIRD_PARTY.md)
      (`47f1ac2`).
- [x] 3.2 Smoothing and the lift window in `src/track/`, pinned to the old
      page by `tests/track.test.js`; the spike scores smoothed tracks with it
      (`bb5dfbb`).
- [x] 3.3 The page, [spike/pose-bench/](../spike/pose-bench/README.md):
      mp4box.js and WebCodecs, the model in a worker behind one async
      `estimate()`, `track.json` in the fixture format, scored with
      `src/track/` (`c06ccc3`).
- [x] 3.4 **Capture checks** for the recording session (milestone B):
      `getUserMedia` at 60 fps and `MediaRecorder` inside the Capacitor
      WebView, and a 30–60 minute heat and battery run on the Fairphone,
      recording and processing. [spike/capture-check/](../spike/capture-check/README.md)
      (`fa2e6a3`, `ca02d24`); the camera gives 30 fps at most
      ([pose-spike.md](pose-spike.md#capture-step-34-brave)).
- [x] 3.5 Measure on the Fairphone, in Brave and inside a Capacitor WebView:
      ms per frame, decode time, total time per clip, peak memory, download
      size. The stock Android phone comes after the spike (question 3).
      `ffc8b8a`, the shell [spike/webview-shell/](../spike/webview-shell/README.md)
      (`d20df09`), the samplers (`53bd301`, `5668d11`); numbers in
      [pose-spike.md](pose-spike.md).
- [~] 3.6 Run `diagnostics.js` on each candidate's smoothed tracks of the
      validation set and compare with the references, counting only scored
      verdicts, against the thresholds from 3.0. The script:
      `spike/pose-bench/compare.mjs` (`c7f30d5`).
- [~] 3.7 A decision record: model, runtime and shell (PWA / Capacitor /
      TWA), with the numbers, and whether the stop condition was hit:
      [pose-spike.md](pose-spike.md). First round `1277d38`; after the
      open-runtime rule (`d5e41e2`), MoveNet Thunder and Lightning and
      BlazePose on TensorFlow.js (`8aec0a4`) and BlazePose's Tasks models on
      ONNX Runtime (`160a10c`), measured on the Fairphone in Brave and the
      WebView (plans `7eb0142`; the record `64412d8`). **nordmu,
      2026-11-01: MoveNet Thunder on TF.js is the working pick**; final once
      3.6 passes on the validation set.
- [~] 3.8 **F-Droid, a paper check** (drafted in [pose-spike.md](pose-spike.md#f-droid-step-38-on-paper)) off the critical path (pascaline did the
      same): can the chosen runtime and the model weights be built from
      source, or are they accepted as assets? The runtime rule of
      2026-11-01 now steers 3.7; F-Droid itself still doesn't. Until it
      passes, 0.1.0 ships as a PWA and a GitHub APK.

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
- [ ] 4.3 The checks: `npm test` (it includes the docs checks and the
      absolute-path check) and the Python tests.

### Phase 5: the new app (mobile-first UI and the gym recording session)

Decided 2026-10-31 ([decisions.md](decisions.md), "What 0.1.0 is"). This
phase replaces the old plan of first moving the old frontend out of app.py:
the new UI is built fresh as static files, and the old page stays frozen.

Two milestones ([decisions.md](decisions.md#what-010-is)): **A**, import a
clip and get the cues offline, needs 5.2's import and result flows, 5.3
and 5.5–5.7, and goes to testers. **B**, the gym recording session, adds
5.1 and 5.4. The public 0.1.0 needs both.

- [ ] 5.1 **nordmu's input on the gym recording session** (question 7). Ask
      before anything is designed: rolling buffer length, how start and end
      are marked, several lifts per session, choosing the lift, camera and
      frame rate, what happens to the raw video, where the phone stands.
- [ ] 5.2 **Design first, then build.** Clickable HTML mockups of the phone
      layout and the widened desktop layout, tried on the Fairphone. nordmu
      approves them before 5.3. Flows to cover:
      - the recording session;
      - marking a lift;
      - the processing queue;
      - the result view: video with overlay, cues, plots.
- [ ] 5.3 **The app skeleton**, as static files with no Flask:
      - a PWA (manifest, a service worker that caches the app and the models
        for offline use);
      - the Capacitor Android shell;
      - the pose engine behind one async Worker interface, with the model
        from Phase 3;
      - scoring separate from rendering: the new UI calls `diagnostics.js`'s
        `computeResults()` unchanged and draws the results its own,
        mobile-first way. `mount()` builds the old page's desktop panel
        (toggles, plot canvases, tiles) and isn't reused;
      - every asset path relative
        ([rules-core.md](rules-core.md#paths-stay-relative)).
- [ ] 5.4 **The gym recording session**, built to nordmu's spec from 5.1.
      Technical questions to settle there:
      - MediaRecorder chunks after the first can't be decoded on their own, so
        a rolling buffer needs short restarted segments, or WebCodecs encoding
        with regular keyframes;
      - storage in OPFS, and its quota;
      - a screen wake lock;
      - battery and heat during a whole session;
      - camera permissions in the Capacitor WebView;
      - processing in a background queue while recording continues.
- [ ] 5.5 **Port from the old page what the core needs:** video playback with
      the skeleton overlay, the lift window markers and the keypoint plots;
      smoothing and the lift window come from 3.2's module. Pin each
      behaviour with tests against the old code before porting it (as 3.2
      does), the overlay included, then port by reading the old code, not
      by copying the Python string.
- [ ] 5.6 **Tests from day one:**
      - unit tests for the new modules;
      - a headless page test that loads the app offline, runs a lateral-raise
        and a snatch example, and fails on any console error, 404 or empty
        cue panel;
      - runs on the Fairphone.
- [ ] 5.7 Responsive check: phone portrait and landscape, tablet, laptop.
- [ ] 5.8 **When the new UI covers the core,** park the old page together with
      anatomy, 3D, the Movement Lab and the train tab in `parked/`. Or keep a
      trimmed reference viewer on the dev server, if nordmu wants one.

### Phase 6: 0.1.0 scope and timeline

- [ ] 6.1 0.1.0 is the core, plus a written "not in 0.1.0" list. Milestone A
      goes to testers (nordmu, Noah, friends) first.
- [ ] 6.2 Release criteria for the public 0.1.0:
      - works in airplane mode on the target phones, a stock Android phone
        with Chrome and Google's WebView included (question 3);
      - a working install path: where the PWA is hosted (a public HTTPS
        origin), and how its service worker updates the app and the models;
      - the APK signing key: who holds it and where it is backed up
        (Obtainium needs the same key for every update, forever);
      - every threshold not validated on the set from 3.0 shows as
        "provisional" in the UI ([rules-core.md](rules-core.md), "Honest
        verdicts");
      - LICENSE and the third-party list;
      - a privacy text and a credits screen ([backlog.md](backlog.md)).
- [ ] 6.3 Packages with estimates. The timeline is their sum plus a buffer,
      not a date picked first.

### Phase 7: build 0.1.0

The packages run through the pipeline. The design-heavy ones (the new UI,
the recording session, the pose engine) are done interactively with nordmu.
