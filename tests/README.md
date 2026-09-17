# tests

How to turn a pile of lift videos into test cases for coach's diagnostics,
end to end. Two things live here:

- **`tests/fixtures/`** — cached ViTPose tracks, split into `global/`
  (committed) and `local/` (gitignored, your own clips); see
  `tests/fixtures/README.md` for the directory layout and `manifest.json`
  schema. These double as the app's example gallery.
- **`tests/diagnostics.test.js`** — a Node test (`node:test`, no dependencies)
  that scores every fixture's diagnostics and checks the result against a
  checked-in golden snapshot.
- **`tests/viewer.test.js`** — the 3D view's click-to-flip-a-depth-sign
  interaction, run against the viewer module extracted straight out of
  `src/app.py` (see `loadViewer.js`) with three.js's renderer stubbed. Needs no
  GPU and no browser. It is here because this interaction broke twice in ways
  nothing else could see: the module parsed, the API round-tripped and the page
  loaded, while `load()` threw on a stale reference and the pick was taken on
  mouseup after the video draw loop had already moved the skeleton.

Run everything with `npm test`.

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
Pass `--scope global` for clips meant to ship with the repo.

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

Writes `tests/golden/<stance>-<clip-stem>.json` — `Diagnostics.computeResults()`'s
output for that fixture, run headlessly (no browser, no canvas — see
`tests/loadDiagnostics.js`). This is the only step that needs re-running when
you deliberately change diagnostic logic in `src/diagnostics.js`; never run it
to silence a test that failed for an unknown reason — read the diff first.

### 7. Run the tests

```sh
npm test
```

Picks up every fixture in `manifest.json` automatically — no test code to
edit when a new stance shows up, only steps 3 and 6 above. A fixture with a
`.track.json` but no golden snapshot fails loudly with the `update_golden.js`
command to fix it, rather than being silently skipped.

### 8. Commit

Commit the fixture's `.mp4` + `.track.json`, its `manifest.json` entry, and
its golden snapshot together. Keep clips short/trimmed (a few seconds) —
they're committed directly, no git-lfs, matching `report/examples/`'s
existing convention.
