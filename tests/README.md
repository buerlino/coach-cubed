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
| `app/flow.test.js` | The new app's flow, `app/src/flow/flow.mjs`: the states, the transitions milestone A needs (H, import, mark, queued, result, back to H), an illegal one throws, listeners hear each change, each state has a screen module. |
| `app/diagnostics-headless.test.js` | `diagnostics.js`'s headless API on the committed lateral raise and snatch tracks: `describe(set)` (the cues in order, their text, provisional), `tiles` and `referenceLine` against what the mounted old panel shows, `drawCue` on a recording fake context (inside the cue's phase only, no DOM or module state, the same calls as the old page's `overlay()` in each motion mode), `worstMoment` by each cue's rule. The old page's overlay is pinned by digests in `app/golden/overlay-digests.json`, recorded from phase-0's code before `s4` (`UPDATE_OVERLAY_DIGESTS=1` rewrites them; only for a deliberate drawing change). |
| `app/store.test.js` | The store, `app/src/store/`, against `tests/app/fake-opfs.js`'s in-memory OPFS: save, list (newest first, today's apart), read, update and delete a lift with its folder; the index written by move and rebuilt when missing or damaged; settings with v1's defaults; `persist()` once; usage and quota; a full disk as `storage-full`; nothing outside OPFS. |
| `app/assemble.test.js` | `app/tools/assemble.mjs` into a temporary folder: `index.html`, the manifest, the vendored files and their licences, `diagnostics.js` and `src/track/`, `files.json` with every file and a version hash, the run without `app/vendor/tfjs/` and `app/models/`, and a refusal to empty a folder that isn't assemble's. Needs neither gitignored folder. |
| `app/serve.test.js` | `app/tools/serve.mjs`: the types for `.mjs`, `.webmanifest`, `.woff2` and `.wasm`, no COOP/COEP, `/` is `index.html`, nothing outside the folder. |
| `docs.test.js` | The docs: AGENTS.md, CLAUDE.md and the big docs within their budgets, every relative link and anchor in a tracked `.md` file, every path `docs/README.md` names. The budgets are at its top. |
| `test_launchers.py` | The local preview (`launchers/run_local.py`): its entry points, the `/` and `/original/` routes, and the example gallery. |
| `test_sync_clipper_fixtures.py` | `scripts/sync_clipper_fixtures.py`: its clip-name pattern matches clipper's names (format string quoted from its `src/cut.py`) for attempts 1, 99, 100 and 123, keeps session, attempt and result, and rejects a name with no result; clips are found in attempt order (99 before 100). |
| `test_adb_guard.py` | The Bash hook `.claude/hooks/adb_guard.py`: a bare adb, another serial, the tablet's serial and the shared adb server are blocked, also behind wrappers, `bash -c` and `$( )`; `adb -s 4d42e62f`, `adb devices`, "adb" as a plain word and in a here-document's text pass. |

The helpers: `fixtures.js` (where fixtures and goldens live), `loadDiagnostics.js`
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
python scripts/batch_extract_tracks.py --stance clean  --dir clips_inbox/clean
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
and appends an entry to `tests/fixtures/local/manifest.json` keyed
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
and `diagnostics` are never touched by the batch script once they've been
filled in, so this is safe to do by hand at any point, including before or
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
