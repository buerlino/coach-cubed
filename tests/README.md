# tests

Run them from the repo root:

```sh
npm test                                              # every *.test.js (node:test, no dependencies)
npm --prefix app test                                 # just tests/app/, the new app's
python3 -m unittest discover -s tests -p 'test_*.py'  # the Python tests
```

| File | Tests |
| --- | --- |
| `diagnostics.test.js` | `src/diagnostics.js`: every fixture's results against its golden snapshot, plus synthetic tracks for the phase triggers and rep counting. |
| `fixtures.test.js` | `diagnosticsSet` in `fixtures.js`: a manifest entry without a `diagnostics` field, or naming a set `diagnostics.js` doesn't know, throws and names the slug; every entry of the committed global manifest passes. |
| `pose.test.js` | `src/pose/coco17.mjs`: the BlazePose-33 → COCO-17 mapping and its `[y, x, conf]` output. |
| `viewer.test.js` | The 3D view's click-to-flip-a-depth-sign, run on the viewer module taken straight out of `src/app.py` (`loadViewer.js`) with three.js's renderer stubbed: no GPU, no browser. This interaction broke twice in ways nothing else could see. |
| `anatomy.test.js`, `anatomy-grip.test.js`, `anatomy-sequence.test.js`, `anatomy-stability.test.js` | The anatomy view's modules in `src/anatomy/`: the rig, the hand contacts on the bar, the display sequence, stabilization. |
| `track.test.js` | `src/track/`: time smoothing, the lifter choice, scoring as the old page scores and the lift window's marks, each compared with the old code taken out of `src/app.py`'s `INDEX_HTML` and `src/diagnostics.js` (`loadOldCode.js`). |
| `squat.test.js` | The Movement Lab's squat engine, `src/squat/analysis.mjs`. |
| `paths.test.js` | rules-core's "Paths stay relative": no new absolute path (`'/...'`) in an import, import map, `src`, `href`, `fetch`, redirect, CSS `url()` or `/api/` call in `src/`, `launchers/`, `parked/` and `app/` (not its `vendor/`, `dist/`, `android/` or `node_modules/`). Today's paths in frozen code are allowlisted at its top, each with a reason. |
| `app/flow.test.js` | The new app's flow, `app/src/flow/flow.mjs`: the states, the transitions milestone A needs (H, the lift step (L1), mark, queued, result, A2's detail, back to H; `d53`: `lift` replaces `import`, the moves around it, `home -> mark` still illegal; `d28`: `setup` is R1, `home -> setup -> live`, `home -> live` illegal except while a session runs; `d29b`: `delayed` is R3b, its moves, `home -> delayed` only while a session runs, `liveStateOf` and `sessionReturn`), an illegal one throws, listeners hear each change, each state has a screen module. |
| `app/result.test.js` | A1's timeline and cards (`d17`), `app/src/ui/result-model.mjs`, on views scored from committed tracks (the lateral raise, a snatch, a snatch cut before its finish): the cards in diagnostics.js's order with status word, icon, verdict and value; "provisional"; "can't score" with the engine's reason; the notes; a cue added needs no change; the timeline's marks in seconds and as shares (no window and no reason for a lateral raise, the start alone with the view's reason, both ends); a tap on a mark seeks; the flow's `detail` state; no colour literals. |
| `app/home.test.js` | H's logic, `app/src/ui/home-model.mjs`: a lift's state from the store and the queue's jobs (waiting, analysing, failed, ready, stopped), today's and earlier lifts, the result counts, the pick step (a file goes to the lift step; a cancelled picker says nothing; a non-video is refused), no literal colour in `app/src/ui/`, and `main.mjs`'s one `appQueue()` and `warmUp()`. |
| `app/lift.test.js` | L1, "Which lift?" (`d53`): the tiles from the lift registry in its order with the default ringed, a tile's accessible name, one tap to M with `{ file, lift }`, the picker buttons on H, the first run, M and Q1, and that `Import.mjs` is gone. |
| `app/lifts.test.js` | The lift registry, `app/src/contracts/lifts.mjs` (`s49`): a third, test-only lift (diagnostics.js's `clean-and-jerk`, registered in the test only) reaches L1's tiles and the step to M, the settings' `defaultLift`, the store's ids (its own abbreviation) and `LiftIcon` (its own figure, or the raise's); every shipped lift has its set in `DIAGNOSTIC_SETS` and its `LIFT_WINDOW_SETS` entry; the shipped list and its framing tips; `registerLift`'s refusals; the fixtures per lift (`app/tools/lift-fixtures.mjs`); no lift id written out in `app/src` outside the registry, the settings' default and the contracts' examples. `app/import-map.mjs` gives Node `app/index.html`'s import map, so the test draws Preact. |
| `app/diagnostics-headless.test.js` | `diagnostics.js`'s headless API on the committed lateral raise and snatch tracks: `describe(set)` (the cues in order, their text, provisional), `tiles` and `referenceLine` against what the mounted old panel shows, `drawCue` on a recording fake context (inside the cue's phase only, no DOM or module state, the same calls as the old page's `overlay()` in each motion mode), `worstMoment` by each cue's rule, `scoringLines` (plain text that joins back to the old panel's transparency bullets, on every committed fixture against every set; markup besides the label throws) and `zones` (each band checked against the cue's own `verdict()`, through a test-only copy of the script that hands out its cue objects; `null` where the series doesn't plot the verdict's value). The old page's overlay is pinned by digests in `app/golden/overlay-digests.json`, recorded from phase-0's code before `s4` (`UPDATE_OVERLAY_DIGESTS=1` rewrites them; only for a deliberate drawing change). |
| `app/lift-window-flag.test.js` | Whether a lift has a lift window (`s36`): `describe(set).hasLiftWindow` (the snatch and the clean and jerk yes, the lateral raise no), `computeResults()` for a lateral raise (no window, no error, `hasLiftWindow: false`), the barbell sets' windows on every committed fixture against `app/golden/lift-windows.json` (phase-0's `computeResults().lift`, recorded from b8039d4's `diagnostics.js`, `RECORD_LIFT_WINDOWS=<that file>`), and what the old page's own `renderLiftMarks()`, cut out of `INDEX_HTML`, shows: nothing for a lateral raise. |
| `app/store.test.js` | The store, `app/src/store/`, against `tests/app/fake-opfs.js`'s in-memory OPFS: save, list (newest first, today's apart), read, update and delete a lift with its folder; the index written by move and rebuilt when missing or damaged; settings with v1's defaults; `persist()` once; usage and quota; a full disk as `storage-full`; nothing outside OPFS. |
| `app/frame-source.test.js` | The frame source, `app/src/media/` (`s9`): the sample table and its keyframe search on a synthetic B-frame stream; mediabunny's demuxing of our own clips in `app/clips/` (metadata, rotation, frame times, a variable rate); a range's frames in order from the keyframe before it, the frame at a time, thumbnails, rotation applied once; the decode loop against `fake-webcodecs.js` (reordering, a key chunk first, backpressure, an erroring, silent or stuck decoder, close); HEVC where the decoder lacks it and bytes that aren't a video fail with a named error; the stepper (`s38`): one-frame steps from its cache, its budget, its refill ahead and behind, and its paused forward decoder holding at most 2 decoded frames beyond the budget (`s38f1`); mediabunny is the only demuxer, vendored pinned with its licence and no "Incompatible With Secondary Licenses" notice. The real decoder, the canvas turn and the speed wait for the Fairphone (`c26`). |
| `app/session.test.js` | The gym session, `app/src/session.mjs` (`d28`): nothing opens at boot; `open(settings)` makes the capture and opens the camera once (never throws; asked again after a failure it opens afresh; a camera that arrives after R1 was left is closed); `start(lift)` keeps the lift and the start time, refuses a second `start`, an unknown lift and a missing preview, and leaves no session when the capture can't record; `end()` stops and closes; `subscribe`; `d29b`: `liveState` from the replay mode at `start`, none when nothing runs; one run on the real `createCapture` over the fake camera (the clock moves, the real rate, every track ended); and that main.mjs makes it once and passes it to the screens. |
| `app/record.test.js` | R1 and R2 (`d28`), `app/src/ui/record-model.mjs`: R1's lifts from the registry (order, labels, `provisional`, the default as L1, pressed and ringed), the framing tip or the guide line alone, the line under the preview, Start only in the preview; R2's clock (`m:ss`, `h:mm:ss`), the real rate, the queue line, the lift and buffer line, the wake lock, "Camera stopped" and resume, Replay's length; the capture's errors as problems in short wording; H's gym card; S1's enabled and disabled rows within `RANGES`; sources: no camera API in `app/src/ui`, no typed colour, no literal lift id in R1, the controls the walks look for, the new tokens; the layout check's R1 and R2 rules (`fitsWindow`) and the fake camera's flags in both browser tools. |
| `app/replay.test.js` | R3, the replay, and M in a session (`d29`), `app/src/ui/lookback-model.mjs` on a stand-in session (a capture that hands out a snapshot and logs every call) and a stand-in player: `snapshot(replayS)` on entry with the settings' length and play from the start at once; the label `N s ago` (snapshot end minus playhead, rounded), the position `m:ss / 0:20`, a short ring's own length; ½× between 1× and ½×; the 25 s countdown that runs only while playing and is held by a pause or a drag; the end of the countdown and "Not this one" go to `live` and close the player and drop the snapshot (once); "Keep and mark" goes to `mark` with `{ file, lift, from: 'live' }`, the file named `replay-hh-mm-ss.mp4`, type `video/mp4`; the recording never stops (the capture sees only `snapshot`); a failing snapshot, an empty ring and a missing capture as problems with the way back; `mark-model.mjs`'s `analyse` with `from: 'live'` goes to `live` (unchanged to `queued` without), `closeTarget`, `waysOn`'s "Back to the session"; sources: R3 plays through `createPlayer`, has no placeholder and no colour literal, neither it nor the model stops the capture. |
| `app/delayed.test.js` | R3b, the delayed view, as a setting (`d29b`): the delayed frames (`app/src/media/delayed.mjs`) on the capture's real ring filled with synthetic 30 fps chunks, `fake-webcodecs.js`'s decoder and a clock the test moves: the follower starts at the keyframe at or before the newest frame minus the delay; each frame is handed out once its time plus the delay has come (within a frame interval over 3 s of 60 Hz refreshes, every frame once, in order); a session younger than the delay waits; a decoder that falls behind skips to the next keyframe at or after where the view should be, decoding nothing in the gap; a new delay restarts it with a new decoder; every frame not taken and every frame held at `close()` is closed, and the decoders; a new decoder config in the ring gets a new decoder and the segment's rotation; on the real `createCapture` over the fake camera, `liveUs()` and frames about the delay behind. R3b's logic (`delayed-model.mjs`): the clock, `10 s behind`, the delays 5–20 s inside `RANGES.delayS` with the chosen one pressed, a choice saved as `delayS` (one outside refused), "Keep this lift" to `mark` with `{ file, lift, from: 'delayed' }` from `snapshot(replayS + delayS)`, a failing snapshot as a problem. R1's replay mode (`setupView`, `saveMode`, `startSession` to `live` or `delayed`), S1's delay row enabled; M's close and Analyse, M's, Q1's and H's "Back to the session" to the session's state; `go('live'` in `app/src/ui` only where R3 goes back to R2; R3b's source (canvas, live `<video>`, hooks, closes the frames, no colour, tokens), the layout check's `DELAYED_CONTROLS` and R3b walk, the page test's delayed walk. |
| `app/capture.test.js` | The capture and its rolling buffer, `app/src/media/capture.mjs` (`c27`), on `fake-webcodecs.js`'s `createFakeCapture()` (a camera whose frames carry timestamps at a chosen real rate and can end or mute, an encoder that outputs the packets of `app/clips/` with their decoder config, a wake lock, the page's visibility): the rate from the frames' timestamps, not the track's settings; a keyframe by time, also when the rate drops; frames dropped and counted while the encoder's queue is backed up; the ring's whole groups, its seconds and bytes, and every dropped chunk let go of at once (a `WeakRef` per chunk's data, a full collection); `snapshot` (the keyframe, the config first, times from 0, the rotation, never across a change of config) opened by the frame source and cut by `cutVideo`; `follow` (from a keyframe, live, its end, overtaken); each `CaptureError` code with the browser's message; the wake lock, let go on every move to `failed` (an encoder failure, a camera that fails at `resume()`, a lock granted after the failure); `ended` and `mute`, `resume`; stop and close; nothing outside `app/src/media/` touches the camera or the encoder. The real browser is `app/tools/check-capture.mjs`'s, the phone `c30`'s. |
| `app/wide.test.js` | A4, the wide result, and the responsive check (`d25`): the breakpoint written the same in `wide-model.mjs` and `base.css`, A4's CSS and `app/src/ui/` free of colour and size literals, `wide-model.mjs`'s plain functions (the breadcrumb, the selected cue, the footer), `layout-check.mjs`'s five sizes and its no-browser line, M's no-scroll check at 360×640, 360×800, 412×760 and 412×915 on a fake document (`d54`), and each `--break` fault failing with its own words (needs a browser; skipped without). |
| `app/browser.test.js` | The tools' browser (`c47`, `app/tools/browser.mjs`): none of the browser tools (the five of `c47`, `d25`'s `layout-check.mjs` and `c27`'s `check-capture.mjs`) spawns or kills one itself; live (skipped when no browser is found), `close()` leaves no process with the profile in its command line within 5 s, and a node script that gets SIGTERM takes its browser with it. |
| `app/analysis.test.js` | The analysis job and its queue, `app/src/analysis/` (`s12`), with a fake frame source, engine, clock and timers over the real store on `fake-opfs.js`: queued, reading, pose, scoring, done, one job at a time, in order, every state passing contract 2; progress per stage; the time left from the running median; cancel between frames with the engine reset; a failure in its words; the track (fixture format) and the result saved; a job cut off by the app's close restarted from the stored cut; a frozen WebView not taken for a stall; a hang replaced once, then failed; M1–M3's estimate (ui-design.md's 2.9 s/s first, then the measured rate); at Analyse `keepVideo` (on `app/clips/`) before the job; committed fixture tracks fed in place of the engine give the adapter's result. |
| `app/assemble.test.js` | `app/tools/assemble.mjs` into a temporary folder: `index.html`, the manifest, the vendored files and their licences, `diagnostics.js` and `src/track/`, `files.json` with every file and a version hash, the run without `app/vendor/tfjs/` and `app/models/`, and a refusal to empty a folder that isn't assemble's. Needs neither gitignored folder. Removes its temp folders afterwards (`app/tmp-clean.test.js` checks it). |
| `app/serve.test.js` | `app/tools/serve.mjs`: the types for `.mjs`, `.webmanifest`, `.woff2` and `.wasm`, no COOP/COEP, `/` is `index.html`, nothing outside the folder. |
| `app/tmp-clean.test.js` | The app tests clean up after themselves (`c48`): `assemble.test.js`, `serve.test.js`, `sw.test.js` and `settings.test.js` run in a child `node --test` with `TMPDIR` set to a fresh empty folder, and after it exits that folder is empty; the child's own failures fail this test too. Those four files remove each temp folder they make (through `tempDir()` in `fixtures.js`, which removes them when the test process exits, or earlier by the test itself), whether the test passes or fails. |
| `docs.test.js` | The docs: AGENTS.md, CLAUDE.md and the big docs within their budgets, every relative link and anchor in a tracked `.md` file, every path `docs/README.md` names. The budgets are at its top. |
| `test_launchers.py` | The local preview (`launchers/run_local.py`): its entry points, the `/` and `/original/` routes, and the example gallery. |
| `test_sync_clipper_fixtures.py` | `scripts/sync_clipper_fixtures.py`: its clip-name pattern matches clipper's names (format string quoted from its `src/cut.py`) for attempts 1, 99, 100 and 123, keeps session, attempt and result, and rejects a name with no result; clips are found in attempt order (99 before 100). |
| `test_batch_extract_tracks.py` | `scripts/batch_extract_tracks.py`'s `process_clip` with the server calls faked (no ViTPose, no network): a new manifest entry gets `"diagnostics"` equal to `--stance`; `--diagnostics <set>` sets it, also over a hand-set value; a re-extract keeps a hand-set value; `main()` passes the option through. |
| `test_adb_guard.py` | The Bash hook `.claude/hooks/adb_guard.py`: a bare adb, another serial, the tablet's serial and the shared adb server are blocked, also behind wrappers, `bash -c` and `$( )`; `adb -s 4d42e62f`, `adb devices`, "adb" as a plain word and in a here-document's text pass. |

The helpers: `fixtures.js` (where fixtures and goldens live; also `tempDir(prefix)`, a temp folder removed when the test process exits), `loadDiagnostics.js`
(loads `diagnostics.js` headless, with a stub `window`), `loadViewer.js`,
`loadOldCode.js` (named declarations out of the frozen old page or `diagnostics.js`), and
`update_golden.js` (step 6 below).

**`fixtures/`** holds cached ViTPose tracks, in `global/` (committed) and
`local/` (gitignored); they double as the app's example gallery. Its layout,
the manifest and where the clips are: [fixtures/README.md](fixtures/README.md).
The rest of this file is how a lift video becomes a test case.

## Clips cut by clipper

For clips from clipper (its own repo, `weightlifting-clipper`), use
`scripts/sync_clipper_fixtures.py` instead of the manual flow below: it
extracts, classifies the stance from the track and writes the fixture and its
golden in one pass. How, step by step:
[docs/clipper-pipeline.md](../docs/clipper-pipeline.md).

## Step by step: turning clips into test cases

### 1. Start the app

```sh
./scripts/coach_launch.sh local        # or coach_launch_venv.sh
```

Loopback only (`127.0.0.1:8080`), no Caddy/auth needed for this.

### 2. Drop your clips in `clips_inbox/`, one folder per stance

```
clips_inbox/
  snatch/
    lifter1-rep1.mp4
    lifter1-rep2.mp4
  clean/
    lifter2-rep1.mp4
```

`clips_inbox/` is gitignored — it's a scratch landing spot, not where clips
end up living. Bulk-copy whatever you've gathered in there; nothing under it
gets committed except a `.gitkeep`.

### 3. Batch-extract each stance folder

```sh
python scripts/batch_extract_tracks.py --stance snatch --dir clips_inbox/snatch
python scripts/batch_extract_tracks.py --stance clean  --diagnostics clean-and-jerk --dir clips_inbox/clean
```

Processes one clip at a time against the running app (that's the server's
own single-job-slot design, not a limitation of the script), and prints
progress per clip. A clip that fails (bad upload, no person detected) is
logged and skipped — it won't stop the rest of the batch.

This writes, per clip:
```
tests/fixtures/local/<stance>/<clip-stem>.mp4          the source clip
tests/fixtures/local/<stance>/<clip-stem>.track.json   its cached pose track
```
and appends an entry to `tests/fixtures/local/manifest.json`, with `"diagnostics"` set to
`--diagnostics` (default: the stance, which is a `DIAGNOSTIC_SETS` key for `snatch`; `clean` needs
`--diagnostics clean-and-jerk`), keyed
`<stance>/<clip-stem>` (re-running on the same clip overwrites its entry
rather than duplicating it). `local/` is gitignored: the clips show up in the
app's example picker and in the tests on this machine, but never in a commit.
Pass `--scope global` to write into the committed scope instead (step 8 says
what of it gets committed).

### 4. Sanity-check what landed

The script's own output (`N frames, kept person <id>`) is the first signal —
compare `frame_count` to the clip's real length and eyeball whether the
`kept` person id makes sense (see `manifest.json`, or `meta.tracks` inside a
`.track.json` for the full dropped-track report). A clip where the tracker
picked up a bystander or split the lifter across two ids is worth re-trimming
or discarding rather than keeping as a fixture.

Both of those usually mean the same thing, and have the same fix: **crop
tight to the platform**. Competition footage is the common case —
`_keep_main_person` keeps whoever was detected in the most frames, and a
spectator's head parked at the bottom edge for the whole clip beats a lifter
who is only there for 397 of 400 frames. A lifter who is small in frame is
also the one the tracker loses and re-numbers halfway through. Cropping to a
box around the platform (`ffmpeg -vf crop=W:H:X:Y`, keeping the bar's full
travel and the feet) fixes both at once, because it is the same underlying
problem: the lifter has to be the biggest, most obvious person in the frame.
Record the crop in the fixture's `notes` — it is part of how the clip was
made, not a detail of how it was framed. `tests/fixtures/local/snatch/` (if
you have it) is a worked example.

### 5. (Optional) hand-label technique for the fixtures worth asserting on

Edit the fixture's entry in its scope's `manifest.json` — `labels`, `notes`
and `diagnostics` are kept by the batch script on a re-extract (unless `--diagnostics` is given), so this is safe to do by hand at any point, including before or
after
re-extracting the same clip:

```json
"snatch/lifter1-rep1": {
  ...
  "labels": ["first-pull-back-angle:good", "second-pull-triple-extension:warning"],
  "notes": "Known-good rep, reviewed 2026-09-07 — early second-pull cutoff on video review."
}
```

`labels` isn't consumed by anything yet (the current tests are golden/
snapshot only — they prove a diagnostic's output hasn't silently changed, not
that it's correct). It's there so semantic assertions ("this fixture should
verdict `good`") have somewhere to live once you want to write them.

### 6. Generate golden snapshots

```sh
node tests/update_golden.js                             # every fixture, both scopes
node tests/update_golden.js local/snatch/lifter1-rep1    # just one (full slug, with scope)
```

Writes `tests/golden/<scope>/<stance>-<clip-stem>.json` — `Diagnostics.computeResults()`'s
output for that fixture, run headlessly (no browser, no canvas — see
`tests/loadDiagnostics.js`). This is the only step that needs re-running when
you deliberately change diagnostic logic in `src/diagnostics.js`; never run it
to silence a test that failed for an unknown reason — read the diff first.

### 7. Run the tests

```sh
npm test
```

Picks up every fixture in `manifest.json` automatically — no test code to
edit when a new stance shows up, only steps 3 and 6 above. Every entry needs
its `diagnostics` field (a `DIAGNOSTIC_SETS` key): a fixture without one, or
with an unknown name, fails with its slug instead of being scored as a snatch. A fixture with a
`.track.json` but no golden snapshot fails loudly with the `update_golden.js`
command to fix it, rather than being silently skipped.

### 8. Commit (global fixtures only)

A local fixture never reaches git. For a global one, commit its
`.track.json`, its `manifest.json` entry and its golden snapshot together.
Its `.mp4` stays out of git unless the clip may be published
([fixtures/README.md](fixtures/README.md#videos)); `.gitignore` refuses
videos under `global/`, so committing one takes `git add -f`. Keep clips
short (a few seconds).

## The test clips (`tests/app/clips/`)

Our own, from ffmpeg's `testsrc2` pattern (nothing recorded, nothing third-party): 96×54, 30 fps, 3 s (90 frames),
H.264 with two B-frames and a keyframe every 30 frames (every second), 7–10 kB each. Made with ffmpeg 7.1.5 and
libx264/libx265; the bit-exact flags keep the metadata free of the build's version string.

```sh
cd tests/app/clips
SRC="-f lavfi -i testsrc2=size=96x54:rate=30:duration=3"
X264="-c:v libx264 -preset veryslow -crf 36 -pix_fmt yuv420p -g 30 -keyint_min 30 -sc_threshold 0 -bf 2 -movflags +faststart -an -map_metadata -1 -fflags +bitexact -flags:v +bitexact"
ffmpeg -y $SRC $X264 testsrc2-h264-30fps.mp4
# the same stream with the file's rotation set to 90° clockwise (ffmpeg's display_rotation counts the other way): 54×96 upright
ffmpeg -y -display_rotation -90 -i testsrc2-h264-30fps.mp4 -c copy -map_metadata -1 -fflags +bitexact testsrc2-h264-30fps-rot90.mp4
# a variable frame rate: frames n of 0..89 with n % 5 < 3 kept, at their own times (54 frames, 2.93 s)
ffmpeg -y $SRC -vf "select='lt(mod(n,5),3)'" -fps_mode vfr $X264 testsrc2-h264-vfr.mp4
# HEVC, for the error a WebView without an HEVC decoder gives
ffmpeg -y $SRC -c:v libx265 -preset veryslow -crf 36 -pix_fmt yuv420p -x265-params "keyint=30:min-keyint=30:scenecut=0:log-level=error" -tag:v hvc1 -movflags +faststart -an -map_metadata -1 testsrc2-hevc-30fps.mp4
```

For the page test (c21, `app/tools/page-test.mjs`): portrait 108×192 clips with the frame rate and frame count of the two
committed fixture tracks they are paired with (`example/lateral-raise-cable-1`: 25 fps, 75 frames; `example/athlete-a-trim`, the
snatch: 30 fps, 107 frames), a keyframe every second, 10 and 12 kB:

```sh
cd tests/app/clips
X264="-c:v libx264 -preset veryslow -crf 48 -pix_fmt yuv420p -bf 2 -sc_threshold 0 -movflags +faststart -an -map_metadata -1 -fflags +bitexact -flags:v +bitexact"
ffmpeg -y -f lavfi -i "testsrc2=size=108x192:rate=25" -frames:v 75  $X264 -g 25 -keyint_min 25 testsrc2-lateral-raise-25fps-75f.mp4
ffmpeg -y -f lavfi -i "testsrc2=size=108x192:rate=30" -frames:v 107 $X264 -g 30 -keyint_min 30 testsrc2-snatch-30fps-107f.mp4
```

The tests take their expected values from these commands (90 frames at n/30 s; which frames the select keeps), never from
a decode. Regenerating the clips changes their bytes if the encoder changes, not the expectations.
