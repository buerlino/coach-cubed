# The new app: build plan (Phase 5)

How 0.1.0's new app gets built, from the approved mockups to milestones A
and B: what it builds on, the architecture, the packages in stages, and the
gates. Each package's file is in [packages/](packages/README.md), whose
queue holds the order and the status. The steps' status stays in
[restructure-plan.md](restructure-plan.md) (Phase 5), decisions in
[decisions.md](decisions.md), the design in [ui-design.md](ui-design.md).
Rewrite in place.

## Status

- **2026-11-01:** nordmu approved mockups v1 as the basis to build on
  ("good enough to build now"; tweaks later) and decided D1–D4
  ([below](#decided-2026-11-01)). The packages are cut from this plan.
  Plan step 4.4 is `s1`, watched by nordmu, then `s2` and `d3`; `d3` is
  watched too, as the first run of the app's checks.
- **2026-11-01, after the plan's review:** its fixes are in: D5–D8
  ([below](#decided-2026-11-01)), the new package `s32`, Look A0 and the
  tester APK's `c33`.

## What it builds on

| What | Where | State |
| --- | --- | --- |
| The design | [ui-design.md](ui-design.md), [design/mockups/](../design/README.md) | v1, 14 screens, approved to build on. The canvas is unchanged since the copy in `31d84bb`. |
| Scoring | `src/diagnostics.js` | `computeResults(keypoints, meta, personId)` after `setPage(lift)`, pure, tested against goldens. The headless API (`s4`, documented above the `Diagnostics` object) gives each cue's descriptor with `describe(set)`, and `tiles`, `referenceLine`, `worstMoment` and `drawCue(ctx, id, t, computed)` from `computeResults()`'s output, with no mounted panel. |
| The track | `src/track/` | Smoothing and the lift window, tested against the old page (3.2). |
| Pose | `spike/pose-bench/` | The worker and its one async `estimate()`, MoveNet on TF.js through pose-detection, mp4box and WebCodecs decoding, `build-tfjs.mjs` (from npm's built `dist/`, not from source yet). |
| Capture | `spike/capture-check/` | WebCodecs H.264 with a keyframe a second, muxed and cut by mediabunny: the rolling buffer works (3.4). |
| The shell | `spike/webview-shell/` | A Capacitor 8.5.3 debug APK build, the camera permission, the wake lock. |
| The pipeline | [pipeline.md](pipeline.md) | Five agents; the app's own checks (`npm --prefix app test`, `test:page`) once `app/package.json` has the scripts; no real run yet (4.4). |
| Fixtures | `tests/fixtures/` | Committed tracks and goldens. The example clips are gitignored: only the `phase-0` worktree on this laptop has them, under `tests/fixtures/local/`, and pipeline worktrees don't. |

Spike code is promoted, not imported: a package copies what it needs into
`app/`, trims it to MoveNet, and tests it. `spike/` stays as the bench.

## The architecture

### Where it lives

`app/` at the root, a new folder named for its purpose
([rules-core.md](rules-core.md), "The root stays minimal"). The pipeline
already expects it: `AUDIT_OPUS_RE` in `pipeline/lib.sh` sends diffs under
`app/src/pose/`, `scoring/`, `analysis/`, `media/` and `app/tools/` to an
Opus audit.

```
app/
  index.html  manifest.webmanifest  sw.js  package.json
  src/
    main.mjs     boot: the engine's warm-up, the flow
    flow/        the state machine: home, import, mark, queued, result, live, replay
    ui/          one Preact component per screen (H, R1-R3b, M, Q1, A1-A4, S1), shared components
    styles/      tokens.css (the look), base.css
    contracts/   the shared shapes: JSDoc types and validators
    pose/        the engine: worker, client, MoveNet on TF.js
    analysis/    a job (decode, pose per frame, track, smoothing, score) and the queue
    scoring/     diagnostics.js behind an adapter: the cue view model
    media/       decoding and frame access; the cut kept at Analyse (s32); capture and the rolling buffer (B)
    store/       OPFS: lifts, videos, tracks, results, the quota
    draw/        canvas renderers: skeleton, cue overlays, plots, filmstrip
  vendor/        Preact, htm, the fonts (committed); the TF.js bundle (built, gitignored)
  models/        MoveNet Thunder's weights (fetched with SHA-256, gitignored)
  tools/         build-tfjs.mjs, fetch-models.sh, assemble.mjs, serve.mjs
  android/       the Capacitor project
  dist/          the assembled app (gitignored): what the PWA host and Capacitor get
tests/app/       the app's tests: the pipeline's red-first check reads only tests/
```

`npm --prefix app test` runs `tests/app/`, which the root `npm test` also
finds. The canvas renderers, the flow, the contracts, scoring, the store
and the engine are plain modules, so only the screens depend on Preact.

### The build

- **Our code needs no build:** plain ES modules with relative imports, and
  the screens as Preact components written with htm's tagged templates,
  run as written.
- **`assemble.mjs`** copies `app/` (without `tools/`), `src/diagnostics.js`
  and `src/track/` into `app/dist/`, with the TF.js bundle, the weights and
  the fonts, and writes the service worker's file list with a version hash.
  `diagnostics.js` and `src/track/` stay where they are: the old page serves
  them and the tests load them from there.
- **TF.js from source** (nordmu, 2026-11-01;
  [pose-spike.md](pose-spike.md#maintaining-tfjs-ourselves)): esbuild,
  pinned, bundles core, the converter, the WebGL and WebGPU backends and
  pose-detection from the TypeScript at the tags `tfjs-v4.22.0` and
  `pose-detection-v2.1.3`, MoveNet only, `@mediapipe/pose` stubbed as in
  the spike. The clones live in a cache **outside the repo**
  (`$XDG_CACHE_HOME/coach/`, by default `~/.cache/coach/`): the root
  `npm test` is a bare `node --test`, which runs test files in any folder
  of the tree, gitignored ones too.
- **Dev:** `node app/tools/serve.mjs` serves `app/dist/` without COOP/COEP,
  like the WebView, which can't be cross-origin isolated.
- **The example clips** stay where they are: a package that needs them
  takes their folder as an option and reads the `phase-0` worktree's
  `tests/fixtures/local/`, read-only, never a copy.

### The contracts, agreed before both sides build

[pipeline.md](pipeline.md) asks for these in a package of their own (`s5`):

1. **The pose worker's messages:** `init {backend}` → `ready {info}` or
   `error`; `estimate {id, frame, tMs}` (a `VideoFrame`, transferred) →
   `result {id, keypoints, ms}`, keypoints COCO-17 `[y, x, conf]` in frame
   pixels or `null`; `reset {id}` → `cleared {id}` or `cleared {id, error}`:
   between clips the worker clears MoveNet's crop, after any estimate before
   it, and keeps its model (`s35`). pose-bench's, trimmed.
2. **An analysis job:** id, lift id, lift (`lateral-raise` or `snatch`),
   source (the stored cut's path, D6), range `{t0, t1}` in the cut's own
   timeline, state (queued, reading, pose, scoring, done, failed,
   cancelled), progress `{stage, done, total, etaS}` (reading counts one
   unit, the cut read and opened; pose one a frame; scoring one), error. A queued job
   names only stored files, so it survives a restart.
3. **A stored lift:** id, created, lift, the video's path (the cut, D6),
   the range, the track's and the result's paths, the app version, the
   engine (model, backend, runtime version).
4. **The cue view model**, what the UI draws: per cue its id, title, cue,
   status (good, watch, work on, can't score), verdict text, value and
   unit, tiles, series, phase `{t0, t1}`, worst moment, whether its
   thresholds are provisional, and for "can't score" the engine's reason;
   plus the lift window (`{t0, t1: null}` when the engine found the start
   and no held finish, with the engine's note as its reason), the notes and
   the smoothing `{sigmaMs, keepVelocity}` the verdicts were scored with
   (`s35`).
5. **A frame source:** open a file → duration, frame rate, size, rotation,
   and every frame's start time in presentation order (`frameTimes`, `s35`);
   one frame at a time, a range as a stream of `VideoFrame`s, thumbnails.

### The pieces

- **Scoring stays in `diagnostics.js`.** The UI calls `computeResults()`
  unchanged. What the new UI needs beyond it (each cue's descriptor, its
  tiles and reference line, and its overlay drawn on any canvas without the
  mounted panel) comes from a small additive headless API (`s4`); the old
  page's output stays the same, pinned by the goldens.
- **Pose:** MoveNet SinglePose Thunder, every frame, WebGL by default,
  warmed up at start (the first frames compile shaders). WebGPU and the
  one-thread WASM fallback come later. SinglePose tracks one person, so
  A3's "the lifter" has nothing to choose: hidden until a model tracks
  several.
- **The UI:** Preact with htm (D1). One state machine owns the flow, and
  screens never call each other. The cue list is data from the view
  model, so a new cue in `diagnostics.js` needs no UI change. Colours, type
  and spacing are tokens in one stylesheet; Barlow and Barlow Condensed are
  vendored (OFL-1.1). Dark only and English only in 0.1.0. The manifest's
  name is the placeholder "coach" until question 10 is settled.
- **What the mockups drop:** the old page's raw keypoint plots (D5,
  nordmu's call). A2 plots each cue's own series against its zones
  instead, so step 5.5 ports the skeleton overlay and the lift window; the
  raw plots stay on the old page as a dev tool.
- **Storage:** OPFS, one folder per lift (the cut video, D6: the marked
  range cut to MP4 at Analyse by `s32`; `track.json` in the fixture
  format; `result.json`) and an index; `persist()` asked at the first
  save; the quota shown in S1.
- **Offline:** curie's service worker precaches `dist/` (dirac's app
  shell, TF.js, the weights, the fonts) under a versioned cache; an update
  waits until no job runs.
- **Capacitor 8.5.3**, as in the spike: `webDir` is `app/dist`. Debug APKs
  only, until the name and the package ID are fixed (question 10) and the
  signing key has a holder (6.2); then `c33` makes the tester APK.

## The packages, in stages

One package each; the id is the lane (`d` dirac, `s` schrödinger, `c`
curie, `e` einstein) and a global number. Sizes: **S** about an hour of
agent work, **M** about two, **L** a full run (three hours at most).
"After" lists the hard dependencies only; the queue adds the order.

### Foundation

| Id | What | Size | After |
| --- | --- | --- | --- |
| `d3` | **The app's frame:** `app/` with `index.html`, the manifest, `tokens.css`, the vendored fonts, Preact and htm, the flow's state machine with placeholder screens, `assemble.mjs` and `serve.mjs`, `app/package.json` with `test`, the paths test covering `app/`, `app/README.md`, the Layout row, THIRD_PARTY's new-app section. | M | — |
| `s4` | **`diagnostics.js`'s headless API:** the set's descriptors, `tiles`, `referenceLine` and `drawCue(ctx, id, t, computed)`, additive; red first; the goldens unchanged. Opus. | M | `d3` |
| `s5` | **The contracts** (1–5 above) in `app/src/contracts/`, with validators and tests. Opus. | M | `d3`, `s4` |

### The engine and the analysis

| Id | What | Size | After |
| --- | --- | --- | --- |
| `s6` | **TF.js from source:** `app/tools/build-tfjs.mjs`, the pinned clones in the cache outside the repo, `fetch-models.sh` for MoveNet Thunder with its SHA-256; THIRD_PARTY for TF.js, pose-detection and the weights. Opus. At the 3-hour limit: its file names a split point, `s6b`. | L | `d3` |
| `s7` | **The same numbers as npm's bundle,** in Node on the CPU backend: the from-source bundle and the npm one on a fixed input tensor and a synthetic image. A difference stops the queue before `s10`. Real clips wait for `c26` on the phone (headless Brave's WebGL is software, CPU-heavy). | S | `s6` |
| `c8` | **The store:** OPFS lifts (contract 3), the index, a settings record (S1's defaults, A3's options), `persist()`, the quota, delete; tests with an in-memory fake. | M | `s5` |
| `s9` | **The frame source** in `app/src/media/`: demuxing with mediabunny (D6: one library for imports, cuts and later recordings), WebCodecs, rotation, a range decoded from its keyframe, thumbnails. Tests on a tiny generated clip (ffmpeg's test pattern, our own, committed). | L | `s5` |
| `s10` | **The pose engine** in `app/src/pose/`: pose-bench's worker and client, MoveNet only, warm-up, errors; tests with a fake worker. | M | `s5`, `s6`, `s7` |
| `s11` | **The scoring adapter:** `computeResults()` to the cue view model, with the status words, the reasons and the provisional flags; the committed fixture tracks give their goldens through it. | M | `s4`, `s5` |
| `s32` | **Keep the lift's video** (D6): the marked range cut to MP4 by mediabunny at Analyse, a stream copy from the keyframe at or before the start, and `keepVideo` through the store, so the job and A1 read the stored cut. | M | `s9`, `c8` |
| `s12` | **The analysis job and the queue:** the stored cut decoded, the engine on every frame, the track in the fixture format, `src/track/`'s smoothing, scoring; progress by stage, the time left from the measured ms per frame, cancel; one job at a time; a queued job survives a restart. Tests with a fake decoder and engine. Opus. | L | `s9`, `s10`, `s11`, `c8`, `s32` |

### Milestone A's screens

| Id | What | Size | After |
| --- | --- | --- | --- |
| `d13` | **H and import:** the lift, the file picker, today's lifts and their state, earlier sessions, "everything stays on this phone". | M | `d3`, `c8` |
| `d14` | **M1–M3, marking:** the filmstrip under a fixed playhead, Set start and Set end, one-frame steps, the marked length and its analysis time, Analyse into the queue, Redo. | L | `s9`, `s12` |
| `d15` | **Q1, analysing:** the stages, the time left, the queue; leaving doesn't stop it. | S | `s12` |
| `d16` | **A1's player:** the stored cut (`s32`) with the skeleton overlay, ported from the old page behind tests pinned to it first (5.5); play, frame steps, speed. At the 3-hour limit: its file names a split point, `d16b`. | L | `s9`, `s11`, `s32` |
| `d17` | **A1's timeline and cue cards:** the lift found, where a cue went wrong, a card per cue from the view model. | M | `d16` |
| `d18` | **A2, cue detail:** the worst moment with `drawCue`, the cue's plot against its zones, its tiles, how it's scored, "provisional". | L | `d17`, `s4` |
| `d22` | **A3, view options:** overlays, loop, speed, smoothing, re-mark, delete. | M | `d17`, `c8`, `d14` |
| `d23` | **What the mockups don't draw** (D3): no person found, a video that can't be read, storage full, the engine failing, the first run, a snatch result. | M | `d17`, `s12`, `c8` |
| `d24` | **S1, settings and about:** the defaults, storage, the version, the privacy text, credits and licences from THIRD_PARTY's new-app section. | M | `c8` |
| `d25` | **A4 and the responsive check** (5.7): phone portrait and landscape, tablet, laptop, in `c21`'s test build. | M | `d18`, `c21` |

**Look A0** (D7): once `d17` has merged, nordmu uses H → import → mark →
Q1 → A1 on the Fairphone for about 15 minutes and gives feedback by
screen ID. The coordinating session installs a debug APK with `c20`'s
script, or nordmu opens the PWA. Fixes run as packages, design changes go
through the canvas. It isn't a gate: the queue goes on with `d18` unless
nordmu stops it.

### The platform and the phone

Phone packages (`c20`, `c26`, and later `c31` and `c33`) run by day, with
nordmu told first.

| Id | What | Size | After |
| --- | --- | --- | --- |
| `c19` | **The service worker:** precaching assemble's list, versioned, updating while idle; a headless test with the network off. | M | `d3`, `s6`, `s12` |
| `c20` | **The Capacitor shell, and the engine on the phone:** `app/android/`, `webDir` `app/dist`, file import in the WebView, a debug APK build from the spike's `build.sh`, a placeholder package ID. It runs early (#11 in the queue) and also runs the engine on the Fairphone: the from-source WebGL bundle's first run on real hardware, on `s9`'s test clip. | M | `d3`, `s9`, `s10` |
| `c21` | **The page test** (5.6), `npm --prefix app run test:page`: headless Brave over CDP loads a test build offline (without the gitignored TF.js bundle and weights) and runs a lateral raise and a snatch through the flow, replaying committed fixture tracks over its own clips, matched to each track's size, rate and length, and asserting the adapter's verdicts; seconds in any worktree. The real engine is an optional mode on the CPU backend, run in slices; the real clips belong to `c26`. Fails on a console error, a 404 or a wrong verdict. Done (`c21`): `--real <clip>` runs the real engine on one example clip (about a minute, a devlock slice) on software WebGL, since the app has no CPU backend. | M | `d13`, `d14`, `d15`, `d17`, `c19` |
| `c26` | **Milestone A on the Fairphone:** in Brave as a PWA, offline with the forwards removed, and as the APK in airplane mode, switched off again after; the four example clips: time, memory, verdicts, and track parity with `difftrack.mjs` against pose-bench's npm bundle on the same clips (the real-clip parity `s7` leaves out); the numbers into [pose-spike.md](pose-spike.md). | M | `d13`, `d14`, `d18`, `c19`, `c20` |

**Checkpoint A:** nordmu uses milestone A on the Fairphone and gives
feedback by screen ID; fixes run as packages, design changes go through
the canvas first ([ui-design.md](ui-design.md)). Then, with the queue
empty (no `wp/*` branch, no run), 2.7's LICENSE and SPDX headers and
2.8's history rewrite (D8). Milestone B's packages are written after it.

### Before testers

Cut now, written after checkpoint A. Testers get an APK only from it.

| Id | What | Size | After |
| --- | --- | --- | --- |
| `c33` | **The tester APK:** the real name and package ID, release signing, `versionCode`, the icon; nordmu uploads it. | M | checkpoint A, 2.8, question 10, the key's holder |

### Milestone B, the gym session

Written in full on 2026-11-02, after checkpoint A's pass for laptop
packages: `d29` and `c30` are split (`d29b`, `c30b`), and `c27` runs on the
laptop alone, so its first real camera is `c30`'s (nordmu). R1–R3b follow
v1 with checkpoint A's rules ([decisions.md](decisions.md#what-010-is)).

| Id | What | Size | After |
| --- | --- | --- | --- |
| `c27` | **Capture and the rolling buffer** in `app/src/media/`: the camera and its real rate, H.264 with a keyframe a second, a 60 s ring, snapshots as MP4 (from which `s32`'s cut keeps a range), `follow()` for the delayed view, the wake lock; tests with fakes and headless Brave's fake camera. Its file names a split point, `c27b`. | L | checkpoint A |
| `d28` | **R1 and R2:** setup (the framing guide, the lift with its framing tip from `s49`'s registry) and recording (REC, the session time, the real rate, the queue, Replay, End); the session; H's gym card and S1's gym rows. | M | `c27`, `s49`, `d53`, `d55` |
| `d29` | **R3:** the last 20 s at once, pause, scrub, ½×; keep and mark through `d54`'s M1–M3, then back to R2 with the lift queued. | M | `d28`, `d14`, `d54` |
| `d29b` | **R3b, the delayed view,** as a setting: the camera 5–20 s late, decoded from the ring; R1's replay mode. | M | `d29` |
| `c30` | **The camera on the Fairphone:** the camera permission in the APK, the real rate, rotation, the encoder, the ring's memory (the settings' ranges), snapshots on the phone. | M | `d28`, `c26` |
| `c30b` | **Recording and analysis together:** the queue runs while recording goes on; the screen kept on; what Android's freeze of a backgrounded WebView does to the capture and a running job. | M | `c30`, `d29b` |
| `c31` | **A session on the Fairphone,** 30–60 minutes, recording and analysing: heat, battery, storage; in the APK and in Brave; the phone films the laptop playing an example clip. | M | `c30b` |

**Checkpoint B:** nordmu runs a real gym session with it.

### Toward the public 0.1.0 (Phase 6), not yet packages

- WebGPU in the app, and the one-thread WASM fallback (outside an F-Droid
  build), measured on the Fairphone. Off the critical path.
- Step 5.8: park the old page with anatomy, 3D, the Movement Lab and the
  train tab, or keep a trimmed reference viewer (nordmu decides).
- Step 3.6 on the validation set, once its clips and the friend's OK are
  in: it confirms Thunder or switches the engine module (`s10` again; the
  contracts keep COCO-17, so nothing else changes). Whatever stays
  unvalidated shows as provisional.
- The release criteria of 6.2, most of them nordmu's: the hosting origin,
  the signing key, a stock Android phone, the privacy text, the credits.
  LICENSE and the SPDX headers come earlier, at checkpoint A (D8).
- An F-Droid recipe trial (3.8's follow-up). Off the critical path.
- `c40`, **the handover** (nordmu, 2026-11-02): 0.1.0 is where coach goes
  back to Noah, so the pipeline has to run for him. Nothing in `pipeline/`,
  `.claude/` or the phone scripts may assume nordmu's laptop, the
  Fairphone's serial or pascaline's nights: they come from settings. A
  short guide shows Noah how to write and run a package, and how to add a
  lift to the new app. Written after checkpoint B, once the pipeline stops
  changing.

## The size, roughly

Step 6.3's estimate: milestone A is 25 packages, about 54 hours of agent
work; milestone B 7 packages after its splits, about 15 more; `c33` about an M, before
testers. Not counted: fix rounds, resumes after the worker's 3-hour limit,
and the coordinating session's re-check before each run. Sizes, not
dates: re-estimate once `d3` and `s6` have run. Phone packages run by day
and wait for the Fairphone, which pascaline's nights share. The critical
path to milestone A runs from `d3` and `s5` along two lines that meet in
`c26`: the analysis (`s6`, `s7`, `s10`, `s12`, `d14`) and the result view
(`s9`, `s32`, `d16`, `d17`, `d18`).

## Decided (2026-11-01)

nordmu's answers, recorded in [decisions.md](decisions.md#what-010-is):

- **D1, the UI framework: Preact with htm,** vendored, no build step. Lit,
  plain modules and Svelte 5 were weighed; Svelte, even precompiled, keeps
  a compiler in every loop and two copies of each screen in git.
- **D2, question 7: v1's answers** until nordmu changes them: R3 as the
  replay and R3b as a setting, a 20 s replay, a 60 s buffer, an analysed
  lift keeps its video, several lifts per session, the lift chosen before
  recording, no fix tips in 0.1.0.
- **D3, the screens v1 doesn't draw:** dirac builds them in v1's style,
  and nordmu reviews them in the app.
- **D4, how the packages run:** all through the pipeline, autonomously,
  merged on the audit; nordmu reviews once a prototype runs, at
  checkpoints A and B.

After the plan's review, the same day:

- **D5, the keypoint plots dropped:** the old page's raw keypoint plots
  aren't ported; A2's per-cue plots replace them, and the raw plots stay
  on the old page as a dev tool. Step 5.5 ports the skeleton overlay and
  the lift window only.
- **D6, the lift's video:** kept as a cut of the marked range, MP4, a
  stream copy from the keyframe at or before the start, made with
  mediabunny at Analyse and stored with the lift (`s32`). So `s9` demuxes
  with mediabunny, one library for imports, cuts and later recordings; the
  job's source is the stored cut, so a queued job survives a restart; A1
  plays it; milestone B's `c27` reuses the cut.
- **D7, Look A0:** once `d17` has merged, nordmu uses H → import → mark →
  Q1 → A1 on the Fairphone for about 15 minutes and gives feedback by
  screen ID. Not a gate: the queue goes on unless nordmu stops it.
- **D8, 2.7 and 2.8 at checkpoint A:** the LICENSE and SPDX headers and
  the history rewrite run there, with the queue empty; milestone B's
  packages are written after it anyway. If Noah comes back earlier
  (question 6), the queue drains early instead.

Settled with the plan: `app/` as the folder, the assembled `dist/`, no
build for our own code, the lifter choice hidden.

## Gates outside the sessions

- **Before testers get an APK:** `c33`, which needs the name and the
  package ID (question 10), since changing the ID later breaks updates,
  and who holds the signing key and its backup (6.2), since Obtainium
  needs the same key forever.
- **At checkpoint A (D8):** LICENSE and the SPDX headers after the
  authors' written OKs (2.7), and the history rewrite (2.8), with the
  queue empty. "Before Noah resumes" stays the outer limit (question 6).
- **Before the public 0.1.0:** a run on the Samsung S8+ with Google's
  WebView (question 3); the hosting origin. The validation set and 3.6
  are Noah's after the handover; nothing waits on them (nordmu,
  2026-11-02, [decisions.md](decisions.md#what-010-is)).
- **Noah sees the mockups** (nordmu shares the canvas). It doesn't block
  the build.

## Risks

- **TF.js from source:** `s6` built it with no patch (esbuild takes every
  construct; the feared `const enum` doesn't occur in the bundled
  packages), and the WebGL bundle runs MoveNet Thunder in headless Brave.
  Whether it gives npm's numbers is `s7`'s; real hardware is `c20`'s.
- **Imported videos vary:** HEVC, rotation, variable frame rates, 60 fps.
  `s9` reports what the WebView decodes; what it can't read gets `d23`'s
  error, not a crash.
- **Seeking a `<video>` was slow on the phone** (Phase 1): marking and
  stepping use WebCodecs frames; whether playback does too is `s9`'s and
  `d16`'s call.
- **Android freezes a backgrounded WebView:** a job pauses while the app
  is away and resumes after; Q1 says so.
- **One test phone,** shared with pascaline's nights: phone packages queue
  on its lock and run by day, with nordmu told.
- **Seven L packages sit at the worker's 3-hour hard limit** (`timeout -k
  60 10800` in `pipeline/pipeline.sh`): `s6`, `s9`, `s12`, `d14`, `d16`,
  `d18` and `c27`. `s6`, `d16` and `c27` name split points (`s6b`, `d16b`,
  `c27b`); a run cut off
  resumes and isn't counted in the estimate.
- **The from-source engine on real hardware:** `c20` ran it on the
  Fairphone (WebView 153, Adreno 810): it loads, answers 17 keypoints or
  null, 75 ms a frame on the test clip; real clips' speed and parity are
  `c26`'s.
- **Noah may come back before checkpoint A:** then the queue drains early
  for 2.8 (question 6).
- **The pick rests on four clips.** A switch to BlazePose costs the engine
  module and a re-run, not the UI.
