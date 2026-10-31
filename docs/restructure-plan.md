# Restructuring plan

How coach goes from two months of growth without a clear goal to a first
release. This file holds the plan and its status. Rewrite it in place as steps
finish (git keeps the history). Decisions and open questions are in
[decisions.md](decisions.md) (since step 2.1), the binding rules in
[rules-core.md](rules-core.md), open items outside the plan in
[backlog.md](backlog.md).

## Next session starts here

- **Current step:** Phase 2 is done apart from two steps that wait:
  - 2.7's LICENSE and SPDX headers (GPL-3.0-or-later): they wait for the
    authors' written OKs ([decisions.md](decisions.md#licence));
    `THIRD_PARTY.md` is ready;
  - 2.8, the history rewrite, at the very end of the window, with nordmu's
    explicit OK.

  Next: the Phase 3 spike, and Phase 5 once question 7 is answered.
- **The old page is frozen:** don't edit `INDEX_HTML` in `src/app.py`, or the
  Movement Lab, anatomy and 3D code, except to fix something that blocks the
  dev server.
- **In parallel:** the Phase 3 spike may run as a second session in `spike/`;
  its baseline scripts are in `spike/phone-baseline/`.
- **Waiting on nordmu:**
  - question 8, the review of the tab parking (the goal and the principles
    are confirmed);
  - question 7, how the gym recording session works (needed by Phase 5).
- **Waiting on Noah:** what he was asked, and what goes in the next message,
  is in [decisions.md](decisions.md#needs-an-answer).
- **The example clips are not in git** (since step 2.4): they sit under the
  gitignored `tests/fixtures/local/` on machines that have them, this laptop
  included. A fresh clone runs every test but has no example gallery.
- **Test baseline:** 71 JS (3 of them the docs checks, since step 2.9) and
  6 Python tests.
- **AGENTS.md stays lean** (step 2.9): status, history and reasoning go in
  this file, [backlog.md](backlog.md) or [decisions.md](decisions.md), never
  there. `npm test` fails when AGENTS.md or a big doc passes its budget.
- **Don't touch:** `main`, the `pre-cleanup` tag, `.caddy/`, and the tablet
  `HA24BZ2Y` (it belongs to other projects' night shifts; the Fairphone 6
  `4d42e62f` is coach's test phone, always via `adb -s`).
- **Read first:** this file, then [decisions.md](decisions.md),
  [rules-core.md](rules-core.md), [map.md](map.md) ("Hidden couplings") and
  AGENTS.md. [docs/README.md](README.md) says where every other fact lives.

## Goal

Release **0.1.0**: an Android app (iOS possibly as a PWA) that works entirely
offline. Pose inference runs on the phone, with no server compute for
analysing videos. 0.1.0 covers a narrow core, and everything else waits for
later releases.

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
F-Droid after a feasibility check (step 3.6).** On the Fairphone 6, WebGPU
works in a Capacitor WebView ([map.md](map.md#phone-test-2026-10-31)). A stock
Android phone with Google's WebView is still untested.

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
          licence and manifest (its credits in `src/pose/THIRD_PARTY.md`, merged into the root
          `THIRD_PARTY.md` in step 2.7);
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
        Caddy/tailnet URL. Behind the prefix, absolute paths in the frozen
        code still 404, and the record left them out: `/anatomy/shared.css`
        (`src/anatomy/integration.mjs:7`), the `/squat/` link (`ui.mjs:5`)
        and the Movement Lab's `/api/...` calls ([backlog.md](backlog.md)).
- [x] 2.1 The docs skeleton in pascaline's shape, one place per fact
      (2026-10-31):
      - [rules-core.md](rules-core.md): the goal, the four principles (both
        nordmu's) and the hard rules;
      - [README.md](README.md) (the index; it replaces the root README's docs
        table), [backlog.md](backlog.md) (seeded with the map's open items in
        code that stays), [decisions.md](decisions.md) (the decisions and open
        questions from this file);
      - CLAUDE.md stays a pointer. AGENTS.md lost nothing that is still true:
        its server-only rules (Caddy, the live CA, restarts, the sibling
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
- [x] 2.3 Carry out the moves one area per commit, each with the grep and the
      tests, in this order:
      - [x] `clipper/` to its own repo (2026-10-31): `weightlifting-clipper`,
        a local sibling of coach, not pushed. Its history is nordmu's two
        original commits (same hashes) plus Noah's `e178d97`, replayed with
        Noah's author and date; the tree is identical to coach's `clipper/`.
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
      - [x] bar detection (2026-10-31), backend and UI (nordmu's choice):
        `parked/bar-detection/` holds the detectors, a full copy of the old
        download script, the `transformers` requirement, `reference/` and the
        `model-add` skill; its README lists every unwired call site.
        `vitpose_backend` lost the equipment thread and the shared GPU lock
        (its own `_infer_lock` still serializes ViTPose); `/api/capabilities`
        answers `{}`; a start with `detect_equipment=1` answers 400. Tested:
        tests, a syntax check of every inline script, and the full app in
        headless Brave with the athlete-a example (no exceptions; 3D still
        scores plate-anchor from the cached boxes). Not tested: a real pose
        run (the night shift had the CPU), the setup scripts, the conda path,
        anything on the GPU box. `depth_backend.py`'s comments about the
        detectors move with 3D;
      - **Cancelled (nordmu, 2026-10-31):** Movement Lab and anatomy, 3D, and
        the train, squat, image and clean & jerk tabs. The new UI is built
        fresh and the old page is frozen as the dev server's reference viewer
        ([decisions.md](decisions.md), "What 0.1.0 is"). These areas stay
        wired into the old page and are parked together with it in step 5.8.
        Known loose end in the frozen page: the train tab's `TRAIN_DIR` still
        falls back to the in-repo `clipper/downloads`, which left in the
        clipper step.
- [x] 2.4 The videos (2026-10-31; nordmu's choices in
      [decisions.md](decisions.md), "Data and privacy"):
      - the provenance of each clip is in
        [tests/fixtures/README.md](../tests/fixtures/README.md#videos);
      - all four example clips left git for the same path under the
        gitignored `tests/fixtures/local/`; the report's byte-identical copy
        stays on disk, gitignored. Their tracks, manifest entries and goldens
        stay public. `.gitignore` now also refuses videos under
        `tests/fixtures/global/`;
      - both servers (`_example_video` in app.py, `examples()` in
        `run_local.py`) look for a global example's clip under `local/` when
        it isn't beside its track; a new Python test covers the preview's
        side (68 JS + 6 Python tests);
      - the named athlete is `athlete-a` everywhere (clip, golden, limb
        profile, the report, code, docs), and the second one, named only in
        notes, `athlete-b`. Frozen code touched, by name only:
        `src/squat/app.mjs` (the `athlete-a` → snatch branch) and two
        comments in `src/depth_backend.py`. The real names are only in the
        gitignored `tests/fixtures/local/PROVENANCE.md` on nordmu's laptop;
      - tested: the grep; the tests; the preview and the full app over HTTP
        and in headless Brave (all four examples load from `local/`, the
        Movement Lab still switches to snatch for `athlete-a`); and the
        staged tree exported without videos, as a fresh clone sees it: all
        tests pass, the gallery is empty and its picker hidden, no
        exceptions. Not tested: the phone, Caddy, the report's notebook and
        PDF.
- [x] 2.5 Stopped tracking `.auth_password`, `parked/report/.DS_Store` and
      `tests/.DS_Store` (2026-10-31). All three stay on disk; `.gitignore`
      already covered `.DS_Store` and now covers `.auth_password`. Nothing
      in the repo reads the password file. They stay in the history until
      step 2.8.
- [x] 2.6 The docs of what stays (2026-10-31; nordmu's choices in
      [decisions.md](decisions.md), "Rules and docs"). Two read-only audits
      checked the skills and the dataset docs against the code first.
      - a new root README: what coach is now, the local preview and the dev
        server, the layout;
      - [server.md](server.md) took in what was still true of `deploy.md`
        (what runs, the checkpoints, every script), and `deploy.md` is gone;
        its detector notes went to `parked/bar-detection/README.md`;
      - `START_HERE.md` is gone: its launch commands are in the README, its
        anatomy guide in `src/anatomy/README.md`;
      - `tests/README.md` lists every test file and both commands, and its
        golden path and commit step are right; the clipper sync is described
        once, in [clipper-pipeline.md](clipper-pipeline.md);
      - the dataset docs lost their stale and duplicated facts (one owner
        each: numbers in [dataset-stats.md](dataset-stats.md), the layout and
        profiles' meaning in `tests/fixtures/README.md`, shapes and endpoints
        in [fixture-data-contract.md](fixture-data-contract.md)). The deploy
        map left `train-data-todo.md`, and its OCR samples name no athletes;
      - both skills match the code (`panel-add` rewritten; `lifting-diagnostic`
        and its notes corrected), as do the repo `Caddyfile`'s comments, the
        `app.py` docstring, and a comment in `diagnostics.js`;
      - frozen code touched, comments only: the HTML comment above the import
        map in `INDEX_HTML`;
      - tested: the grep; 68 JS + 6 Python tests; the `panel-add` checks as
        written; both servers render the page in headless Brave with no
        exceptions. Not tested: anything on Noah's machine, which most of
        server.md and the dataset docs describe.
- [~] 2.7 Licence prep (2026-10-31). Done:
      - the root [THIRD_PARTY.md](../THIRD_PARTY.md): every component in
        the app, the dev server's packages and model weights, the data, with
        version, licence and source. `src/pose/THIRD_PARTY.md` merged into it;
        `src/squat/THIRD_PARTY.md` stays as the Movement Lab's "Credits"
        page, which its footer links to, trimmed to that page's
        attributions;
      - [authors.md](authors.md): who wrote how much (git blame), for the
        consent request.

      Waiting: the authors' written OKs to GPL-3.0-or-later
      ([decisions.md](decisions.md#licence)); then LICENSE and the SPDX
      headers.
- [ ] 2.8 One history rewrite at the end of the window, before Noah resumes,
      with nordmu's explicit OK. **Precondition:** `../weightlifting-clipper`
      is pushed or backed up somewhere other than this laptop. After the
      rewrite it is the only copy of clipper. It removes the videos, the password and the
      removed bloat, and the athletes' real names: they are in old file
      paths, in old file contents (`athlete-a`/`athlete-b` since step 2.4)
      **and** in commit messages (`212f502` and `6904224`; find others with
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
      - branch protection on `main` stops one push from an old clone
        bringing everything back.
- [x] 2.9 A lean AGENTS.md, and a test that keeps the docs lean (2026-10-31,
      done before 2.8, which stays last; nordmu's choices in
      [decisions.md](decisions.md), "Rules and docs"):
      - AGENTS.md is down from 120 lines to 38: what coach is, the commands,
        the workflow, the layout, the conventions. CLAUDE.md stays a pointer;
      - its rules (relative paths, the minimal root, moving a file, the
        landmines, stop and ask) moved to [rules-core.md](rules-core.md),
        "Changing this repo", each war story cut to a line; every
        "AGENTS.md §N" now points there;
      - `tests/docs.test.js`, in `npm test`, checks the budgets, every
        relative link and anchor in tracked Markdown, and the paths named in
        [README.md](README.md). Its first run found no broken link;
      - tested: the grep, 71 JS + 6 Python tests, and the check failing on a
        broken link, a broken anchor and a missing README path.

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
- [ ] 3.6 **F-Droid feasibility** (pascaline did the same): can the chosen
      runtime (MediaPipe or ONNX Runtime Web WebAssembly) and the model
      weights be built from source, or are they accepted as assets? This may
      steer the runtime choice in 3.5, so run it alongside. Until it passes,
      0.1.0 ships as a PWA and a GitHub APK.

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
      - `diagnostics.js` mounted unchanged;
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
      the skeleton overlay, smoothing, the lift window markers, the keypoint
      plots and the diagnostics panel. Port by reading the old code, not by
      copying the Python string.
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

- [ ] 6.1 0.1.0 is the core, plus a written "not in 0.1.0" list.
- [ ] 6.2 Release criteria:
      - works in airplane mode on the target phones;
      - a working install path;
      - LICENSE and the third-party list;
      - a privacy text.
- [ ] 6.3 Packages with estimates. The timeline is their sum plus a buffer,
      not a date picked first.

### Phase 7: build 0.1.0

The packages run through the pipeline. The design-heavy ones (the new UI,
the recording session, the pose engine) are done interactively with nordmu.
