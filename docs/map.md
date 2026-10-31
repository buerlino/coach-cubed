# Repo map (2026-10-31)

Every tracked file sorted into areas, so the core of 0.1.0 can be chosen
([restructure-plan.md](restructure-plan.md), steps 1.1–1.3). It started as a
snapshot of `62b2cee` (tag `pre-cleanup`). Phase 2 updates it where a step
moves files or resolves a coupling, and says which step; line numbers are
still those of `62b2cee` unless a step says otherwise.

**Sources:**
- four read-only mapping passes over the code, with their main claims checked
  against it;
- the app running on a laptop CPU;
- a test on a real phone (see [Phone test](#phone-test-2026-10-31)).

Line counts are current lines. Authors come from `git blame`, with "noah
stauble" counted as noah.

The **suggestion** column is advice: nordmu decides (step 1.3).

## Overview

| # | Area | What a user gets | Lines | Authors | Offline on a phone | Suggestion |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [Lift analysis page](#1-lift-analysis-page) | Video in, skeleton overlay, keypoint plots, smoothing, per-lift tabs | app.py 4,805 (≈3,600 of it the frontend as one Python string) | noah 87%, nordmu 9% | The frontend can run offline; its `/api` calls can't | **Core** (the shell) |
| 2 | [Diagnostics engine](#2-diagnostics-engine) | 8 technique cues with phases, plots, verdicts | diagnostics.js 2,867 | noah 55%, Nicola 28%, nordmu 15% | **Yes, unchanged** | **Core** |
| 3 | [In-browser pose](#3-in-browser-pose) | MediaPipe pose in the browser, mapped to COCO-17 | ~90 (pose.mjs, local-mode.mjs) + 23 MB vendored | JMLuner | **Yes, measured** | **Core** (as the starting point) |
| 4 | [Server pose](#4-server-pose) | ViTPose-L/H + YOLOv8s on a GPU | 498 + submodule | noah 92% | No | Dev tool (reference tracks) |
| 5 | [Bar and plate detection](#5-bar-and-plate-detection) | Bar and plate boxes over the video | 578 | noah | No (0.7–3.4 GB models) | Park |
| 6 | [3D reconstruction](#6-3d-reconstruction) | 3D turntable, limb and direction profiles | 2,983 (≈1,258 of it code) | noah 98% | Only after a numpy → JS port | Research, park |
| 7 | [Movement Lab and anatomy](#7-movement-lab-and-anatomy) | Squat review, 3D muscle model, grip lock, "activation" bars | 2,712 + 49 MB of assets | JMLuner 92% | Yes (browser), but heavy | Park, unless squat is in the core |
| 8 | [Dataset tooling](#8-dataset-tooling) | Clips cut from competition streams; the train-data tab | 2,965 | noah 59%, nordmu 40% | Not product | clipper to its own repo; the rest is dev tooling |
| 9 | [Research report](#9-research-report) | LaTeX write-up of the pose, smoothing and depth math | 1,264 | noah 100% | Not product | Park |
| 10 | [Ops and deploy](#10-ops-and-deploy) | Caddy, setup, launch and download scripts | 823 | noah 94% | Not product | Dev tool (server) |
| 11 | [Tests and fixtures](#11-tests-and-fixtures) | 66 JS + 3 Python tests, 4 example clips | 1,458 | noah 54%, JMLuner 20%, nordmu 19% | n/a | Keep; videos go private |
| 12 | [Docs and agent skills](#12-docs-and-agent-skills) | README, docs/, AGENTS.md, 3 skills | 2,831 | noah 77% | n/a | Rewrite after the core |

## Phone test (2026-10-31)

**The phone:**
- Fairphone 6 (`4d42e62f`): LineageOS, Android 16, Snapdragon 7s Gen 3.
- No Google Chrome. Browsers: Brave 1.98 (Chromium 156), /e/ Browser 153 and
  Firefox 159.
- System WebView 153.

The page was served from the laptop via `adb reverse`, so it loaded as
`localhost` (a secure context).

**WebGPU works, in Brave and in a Capacitor WebView.**
- In Brave: adapter and device OK, including `shader-f16` (half-precision
  models) and `subgroups`. WebCodecs is available.
- In WebView 153, tested inside pascaline's debug app (a Capacitor app):
  adapter, device, `shader-f16` and WebCodecs are all available.

So on this phone Capacitor doesn't force the slower WebAssembly path. This is
one phone; Google's WebView on stock Android isn't tested.

**The existing MediaPipe prototype runs, but the `<video>` seeking is the
bottleneck.**

The test ran `src/squat/pose.mjs` (now `src/pose/pose.mjs`; the code
`local-mode.mjs` uses) at 20 fps on
the four example clips. Of 341 frames, 340 had a person.

| Clip | Length | Frames | Seeking alone | Total | Model alone (estimate) |
| --- | --- | --- | --- | --- | --- |
| lateral raise 1 | 3.0 s | 60 | 11.3 s | 18.7 s | ~120 ms/frame |
| lateral raise 2 | 3.0 s | 61 | 24.0 s | 29.8 s | ~95 ms/frame |
| athlete-a | 3.6 s | 72 | 17.8 s | 24.7 s | ~95 ms/frame |
| snatch (1080p, 60 fps) | 7.4 s | 148 | 74.6 s | 86.7 s | ~80 ms/frame |

Without the seeking, the snatch clip's 148 frames took about 12 s of model
time. So decoding in order with WebCodecs should bring it to roughly 15 s,
**at 20 fps**. At the clip's full 60 fps (444 frames, ~80 ms each) it's
~36 s plus decoding, and a better model may be slower per frame. Phase 3
measures this.

**The diagnostics agree on the lateral raise, not on the snatch.**

The same `diagnostics.js` scored the server's ViTPose-L tracks and the
phone's MediaPipe tracks (raw tracks, as the goldens are; the UI smooths them
first):

| Lift | Scored verdicts | Same verdict | Notes |
| --- | --- | --- | --- |
| Lateral raise (2 clips) | 8 | **7** | Symmetry can't be scored on either model (one rep per clip). Phases agree within 0.1–0.3 s. The one miss is borderline (top height 10.8 vs 16). Tempo on clip 2 differs (0.4 vs 0.8) under the same verdict. |
| Snatch (Session14 + athlete-a) | 4 | **0** | See the per-clip numbers below. |

Snatch, per clip:
- **Session14** (60 fps, broadcast):
  - first-pull back angle 78.2° (ViTPose) vs 60.6° (MediaPipe);
  - left/right spread 3.6× ViTPose's;
  - the second pull gets 5 samples at 20 fps, against 22 at 60 fps.
- **athlete-a** (30 fps):
  - back angle 41.2° vs 61.1°, so the error goes the other way;
  - spread from 10.6× down to 0.87× of ViTPose's;
  - the second pull gets 10 samples vs 13, so the sample rate doesn't explain
    this clip.

Three explanations are open, and Phase 3 has to separate them:
- **model quality:** test ViTPose-S/B or RTMPose;
- **sample rate:** test at full frame rate;
- **camera angle:** both snatch clips are front or oblique views, where the
  2D back angle is a projection. Phase 3 needs a side-view snatch clip.

ViTPose-L is the reference here, not ground truth.

**For comparison on the laptop:** ViTPose-L + YOLOv8s on the CPU (no GPU)
takes about 1 s per 1080p frame once warm.

## 1. Lift analysis page

- **Files:** [src/app.py](../src/app.py).
  - Routes: lines 37–1036.
  - `INDEX_HTML`: 1039–4606.
  - `PAGES`, the settings blocks, `render_index` and main: 4618–4805.
- **Tabs:** squat, image, snatch (the default), lateral raise, clean & jerk,
  train data.
- **What a user can do:**
  - Pick a video file or record one with the camera; or open an example clip
    with its cached track.
  - Run pose on the server.
  - Playback speed; time smoothing (σ 0–300 ms, default 50); lift start/end
    markers.
  - Skeleton overlay; keypoint plot (y / x / speed, click to seek); the
    diagnostics panel.
- **Calls that need the server:**
  - `/api/pose`
  - `/api/pose/video/*`
  - `/api/examples`
  - `/api/depth/*` (runs automatically on every track load, app.py:2793)
  - `/api/profiles/*`
  - `/api/train/*`
  - `/api/capabilities`
- **Tests:** none for the page's routes or UI. Only its inline 3D viewer
  is tested (`tests/viewer.test.js` extracts it from app.py).
- **Offline on a phone:**
  - Pull the frontend out of the Python string into static files.
  - Replace pose with on-device pose (area 3).
  - Bundle the examples, or drop them.
  - Drop or port the 3D and profile calls.
  - Remove the train tab.
- **Couplings:** see [Hidden couplings](#hidden-couplings).
- **Stale:**
  - The app.py docstring (lines 1–11) names one backend; it imports three
    (26–28).
  - 4245–4248 says three.js loads from a CDN; it's vendored.
  - "Grounding DINO" is hard-coded even when SAM 3 is active.

## 2. Diagnostics engine

- **Files:** [src/diagnostics.js](../src/diagnostics.js). An IIFE that sets
  `window.Diagnostics`, with a headless `computeResults()` that runs in Node.
- **Cues** (`DIAGNOSTIC_SETS`, line 2237):
  - snatch: first-pull back angle, second-pull triple extension;
  - clean & jerk: first-pull back angle (the snatch's thresholds, copied);
  - lateral raise: top height, torso lean, elbow lead, tempo, symmetry.
- **Gaps:**
  - The squat page names a set that doesn't exist, so it gets none.
  - Every threshold is marked "provisional" in the source.
- **Input:** `keypoints[frame][person]` = 17 × `[y, x, conf]` (COCO-17, y
  pointing down). It uses indices 5–16 with a confidence gate of 0.3.
- **Tests:** [tests/diagnostics.test.js](../tests/diagnostics.test.js) has
  golden snapshots for the 4 example tracks plus synthetic trigger and rep
  tests.
  - The goldens score raw tracks; the UI scores smoothed ones.
  - Passing goldens prove stability, not correctness.
- **Offline:** runs unchanged on a track in this format. Whether the 0.3 gate
  fits MediaPipe's "visibility" values is unverified.

## 3. In-browser pose

- **Files** (all in [src/pose/](../src/pose/) since step 2.0; before that in
  `src/squat/` and `src/anatomy/`):
  - [pose.mjs](../src/pose/pose.mjs): legacy `@mediapipe/pose` 0.5.x,
    vendored at 23 MB under `src/pose/vendor/mediapipe-pose/`.
  - [local-mode.mjs](../src/pose/local-mode.mjs): feeds the main page when it
    runs as the local preview.
  - [coco17.mjs](../src/pose/coco17.mjs): the one 33→17 mapping, also used by
    the parked `src/anatomy/track-session.mjs`.
- **Served at** `/pose/` by both the full app and the local preview. The squat
  lab imports `../pose/pose.mjs`.
- **Offline:** yes; measured above.
- **Weak points:**
  - The deprecated legacy package (its own `THIRD_PARTY.md` lists the move to
    the Tasks API as future work).
  - `<video>` seeking.
  - 20 fps sampling.
  - Visibility used as confidence.
  - ~~The 33→17 mapping is written twice~~: one copy since step 2.0.
- **Tests:** `tests/pose.test.js` checks the mapping (since step 2.0).
- **Licence:** Apache-2.0.

## 4. Server pose

- **Files:**
  - [src/vitpose_backend.py](../src/vitpose_backend.py);
  - `vendor/easy_ViTPose` (submodule, Apache-2.0, pinned `bb98603`);
  - `report/extract_track.py`, which uses it directly.
- **Models:**
  - ViTPose-L (1.2 GB) and ViTPose-H (2.5 GB), COCO-17;
  - YOLOv8s person detector via `ultralytics`, which is **AGPL-3.0**;
  - SORT tracking.
- **Runtime:** CUDA, then MPS, then CPU.
- **Tests:** none.
- **Use after the restructure:** produces reference tracks and goldens, and
  is the yardstick for the phone model (Phase 3).

## 5. Bar and plate detection

- **Files:**
  - [src/equipment_backend.py](../src/equipment_backend.py): Grounding DINO
    (about 700 MB, via `transformers`; not installed on the laptop).
  - [src/equipment_sam3.py](../src/equipment_sam3.py): SAM 3 (3.4 GB, gated),
    used when `COACH_SAM3=1`.
- **Used by:** the overlay and the 3D plate-anchor method.
- **Tests:** none.
- **Stale:**
  - `docs/deploy.md` and `download_models.sh` say SAM 3 isn't wired; it is
    (`equipment_backend.py:363`).
  - The script downloads SAM 3 to `~/models/sam3`, but the loader reads the
    Hugging Face cache.

## 6. 3D reconstruction

- **Files:**
  - [src/depth_backend.py](../src/depth_backend.py): numpy, plus one
    `cv2.fitEllipse` call for SAM 3 plates.
  - [src/local_depth.py](../src/local_depth.py)
  - app.py: lines 249–334 and ~830–969
  - [TODO.md](../TODO.md)
  - `report/depth-math.md`
- **What a user gets:** the 3D turntable with click-to-flip, limb and
  direction profiles, the limb optimiser, and the depth feed for the anatomy
  model.
- **Diagnostics never use it.**
- **Tests:** none.
- **Offline:**
  - Needs a JS port. The hard parts are the vectorised sign search over 256
    candidates, a batched eigh, and the gradient-descent optimiser.
  - Profiles would need on-device storage.
- **Provenance:** `tests/fixtures/global/profiles/limbs/athlete-a.json` stores a
  named athlete's limb ratios measured from a press photo.

## 7. Movement Lab and anatomy

- **Files:**
  - [src/squat/](../src/squat/): the `/squat/` page, its own squat engine
    `analysis.mjs`, and MediaPipe.
  - [src/anatomy/](../src/anatomy/): the BodyParts3D mesh (`body.bin` 25.8 MB,
    1.3 M triangles), rig, grip, stability, review and viewer.
  - 14 [launchers/](../launchers/) files and
    [START_HERE.md](../START_HERE.md).
  - `scripts/build_anatomy.py`.
- **Wired into the main page:** "Show anatomy", and the squat tab's rep
  review (app.py:4602–4604).
- **Duplication:**
  - a second analysis engine next to diagnostics.js: `analysis.mjs`, with its
    own angles, filter, phase machine and rep detection;
  - two squat review UIs that export different payloads under one format name;
  - two byte-identical three.js copies, both loaded by the main page;
  - a second 3D viewer.
- **Tests:** 4 anatomy files and `squat.test.js` (35 tests). The pages
  themselves are untested.
- **Licence:**
  - BodyParts3D under CC BY 4.0 (the current grant; the legacy OBJ headers
    said CC BY-SA 2.1 JP, `ATTRIBUTION.md:36`).
  - three.js MIT; MediaPipe Apache-2.0.
- **Stale:**
  - `START_HERE.md` describes two ZIP packages that nothing builds.
  - `src/anatomy/workspace.css` is loaded nowhere.
  - ~~The local preview's default page `/original/` is broken.~~ Fixed in step
    2.0: both servers redirect `/original/` to `../`, the preview opens `/`,
    and it now serves `logo.png` too. (Before: relative paths resolved under
    `/original/`, so `diagnostics.js`, the three anatomy modules, `logo.png`
    and three.js returned 404. The phone test bypassed the page: it called
    `pose.mjs` directly and scored in Node.)

## 8. Dataset tooling

- **Files:**
  - clipper: downloads Australian Weightlifting Federation YouTube streams
    with yt-dlp and cuts one clip per attempt. Its own project, merged in as
    `clipper/` on 2026-09-23; **moved out again in step 2.3** (2026-10-31) to
    its own local repo, `weightlifting-clipper`, next to coach (not pushed
    anywhere), with its history: nordmu's two original commits, then Noah's
    commit of 2026-10-15.
  - `scripts/sync_clipper_fixtures.py`, `scripts/pose_stance.py`,
    `scripts/batch_extract_tracks.py`
  - the train-data tab and `/api/train/*` (app.py:500–829)
  - `docs/clipper-pipeline.md`, `docs/train-data-todo.md`,
    `docs/dataset-stats.md`, `docs/fixture-data-contract.md`
- **The dataset:** 3,226 clips from 5 competitions, stored outside the repo
  on Noah's machine (`$CLIPPER_OUT`).
- **Couplings:**
  - clipper shares **no code** with coach, only the clip filename format and
    folder layout.
  - `pose_stance.py` is imported by app.py.
  - The train block is tangled into `_load_manifest` (app.py:376), `vPoll` and
    `setPage`.
- **Tests:** none.
- **Bugs and stale docs:**
  - The sync script accepts only 2-digit attempt numbers
    (`sync_clipper_fixtures.py:84`, `\d{2}`) where app.py accepts any
    (`\d+`, app.py:522). This is the likely cause of the 30 skipped clips.
  - `clipper/trace.npz` is referenced nowhere (it left with clipper).
  - **`docs/train-data-todo.md:27–29` lists Noah's LAN and tailnet addresses
    and hostname.**

## 9. Research report

- **Files:** [report/](../report/): `report.tex`, a 568 KB notebook, 5
  figures (2 unused), and the athlete-a example (the same video as the
  fixture).
- **Coverage:** documents the snatch pulls, smoothing and the depth appendix.
  It doesn't cover the lateral raise, MediaPipe, equipment detection or
  anatomy.
- **Couplings:** nothing in the app depends on it. The notebook uses
  depth_backend's private names.

## 10. Ops and deploy

- **Files:**
  - `Caddyfile` (a reference copy hard-coded to `/home/noah`; the live config
    is on Noah's machine)
  - `pki-public/`
  - `scripts/coach_launch*.sh`, `restart.sh`, `free_ports.sh`, `setup_*.sh`,
    `download_models.sh`
  - `requirements*.txt`, `docs/deploy.md`
- **Needed for:** the server deploy; the setup and launch scripts also serve
  local development (nordmu uses `setup_no_conda_linux.sh` +
  `coach_launch_venv.sh`).
- **Stale:** `docs/deploy.md` contradicts the scripts in several places
  (systemd unit, number of backends, where the CA lives). The repo
  `Caddyfile` cites files that don't exist.

## 11. Tests and fixtures

- **Results:** `npm test` passes 66 of 66 and the Python tests 3 of 3 (only
  the launcher ports are tested in Python). Step 2.0 added 2 JS tests (the
  33→17 mapping) and 2 Python tests (the preview's `/` and `/original/`
  routes): 68 and 5.
- **No test reads a video:** the tests use `track.json` and the goldens only.
- **The committed videos are all third-party:**

| Video | Source |
| --- | --- |
| `example/lateral-raise-cable-1.mp4` | YouTube `n77-W0nkuPw` (an identifiable, unnamed person) |
| `example/lateral-raise-cable-2.mp4` | YouTube `f_OGBg2KxgY` (an identifiable, unnamed person) |
| `example/athlete-a-trim.mp4` (also in `report/examples/`) | unrecorded; named athlete |
| `snatch/Session14_01_0h18m07s_made.mp4` | AWF broadcast; the lifter's name is on the board |

- **Stale:**
  - `tests/README.md` lists only 2 of the 8 test files and gives the wrong
    golden path.
  - A fixture without a `diagnostics` field is silently scored as snatch.

## 12. Docs and agent skills

- **AGENTS.md:** mostly accurate. Its deploy parts describe Noah's machine,
  not this laptop.
- **Skills:** `lifting-diagnostic`, `model-add` and `panel-add` are partly
  stale (wrong registry names, missing lifts); their per-diagnostic notes match
  the code.
- **README.md:** ~~ends with clipper's `clip-nvidia` section, copied in by
  mistake~~: removed in step 2.3 (it is in clipper's own README).
- **[docs/fixture-data-contract.md:53](fixture-data-contract.md) gives
  keypoints as `[x, y, confidence]`; the code and data use `[y, x, conf]`.**
  Fix this before Phase 3 writes tracks from a new model.

## Hidden couplings

These break silently, not as import errors:

- **`launchers/run_local.py:31–42`** rebuilds the page by parsing app.py's
  source with `ast`. It depends on `INDEX_HTML`, `PAGES`, `DEFAULT_PAGE`,
  `IMAGE_SETTINGS_HTML`, `VIDEO_SETTINGS_HTML`, `_tabs_html` and
  `render_index`.
- **`src/local_depth.py:15–21`** runs app.py's depth and profile route
  functions by name.
- **`tests/loadViewer.js`** extracts the last `<script type="module">` of
  app.py and needs the ids `v3dcanvas*`.
- ~~**The `ui-config.mjs` regex** in app.py:1028 and run_local.py:26~~:
  removed in step 2.0, so `/` no longer reads anything in `src/anatomy/`.
- **Page ids** are tied to `DIAGNOSTIC_SETS`, `depth_backend.START_POSE_LIFTS`,
  `pose_stance.py`, `review.mjs` and CSS.
- **Window globals and events:** `CoachBridge`, `CoachAnatomy`,
  `CoachReview`, `CoachV3D`, `Diagnostics`, and `coach:*` events.
- **Absolute paths, against AGENTS.md §1** (app.py:1030 and 4233,
  `squat/index.html:12` and `local-mode.mjs:10` were fixed in step 2.0):
  - `squat/index.html:56`
  - `squat/app.mjs:325–328`
  - `original-tools.mjs:17–27`
  - `integration.mjs:7,30`
  - `review.mjs:7`
  - `ui.mjs:5`
  - `batch_extract_tracks.py:183`

## Legal and hygiene

- **No LICENSE.** The authors whose code stays have to agree to one (see the
  Authors column above).
- **AGPL:** YOLOv8 via `ultralytics` is AGPL-3.0 (server path only).
- **`.auth_password`:** an unsalted SHA-256 hash of the app's old login
  password.
  - The first commit (`0529038`, 2026-08-30) read it, with a comment calling
    the scheme "identical to tecna".
  - `c80c14d` (2026-09-01) removed the reader and the `.gitignore` entry;
    `dc30cc9` committed the file that same afternoon.
  - An unsalted hash of a weak password can be cracked. **Ask Noah whether the
    password is used anywhere else, tecna included, and change it if so.**
- **Two `.DS_Store` files are tracked:** `report/` and `tests/`.
- **Stale branches**, both fully merged: `test-fixtures-pipeline` and
  `origin/feature/keypoint-plotting`.
- **History:** 46 MB `.git`. The biggest blobs are `body.bin` 24.6 MB and the
  MediaPipe assets (~20 MB); the rewrite in step 2.8 is the moment to decide
  what history keeps.
