# tests/fixtures

Cached ViTPose tracks used as test cases, so the diagnostic tests run against
a real lift without paying for GPU inference every run.

The same files are the app's **example gallery**: every fixture with a cached
track shows up in the video tab's "example" picker.

```
tests/fixtures/
  global/                     committed — ships with the repo
    manifest.json             one entry per fixture, keyed "<stance>/<clip-stem>"
    <stance>/
      <clip-stem>.mp4         the source clip (kept short/trimmed)
      <clip-stem>.track.json  {"keypoints": ..., "meta": ...} — vitpose_backend's
                               own output, unmodified; same shape /api/pose/video
                               returns to the browser
      <clip-stem>.limbs.json  optional limb-length profile for the athlete in
                               this clip (see below); absent means "generic"
  local/                      gitignored — your own clips, this machine only
    manifest.json             same layout as global/
    <stance>/...
```

The two scopes are identical in layout and differ only in whether git sees
them. The app merges both manifests into one picker (grouped `global` /
`local`), and the tests score both. Everywhere outside the manifest files
themselves — the app's example ids, `tests/update_golden.js`, golden file
paths — a fixture is named by its full slug `<scope>/<stance>/<clip-stem>`,
e.g. `global/example/athlete-a-trim`. Goldens mirror the split:
`tests/golden/<scope>/<stance>-<clip-stem>.json`, with `tests/golden/local/`
gitignored too.

## Limb-length profiles

`<clip-stem>.limbs.json` holds each segment's length **as a fraction of torso**
(pelvis→neck), for the athlete in that clip:

```json
{
  "name": "athlete-a",
  "notes": "where these came from",
  "ratios": { "thigh": 0.730, "shank": 0.707, "uarm": 0.461, "farm": 0.442 }
}
```

These belong to the *person*, not the clip, which is why the depth lift can't
just read them off the footage. Its own per-clip estimate takes each segment's
longest projection, and that equals the true length only if the athlete fully
extends that limb on camera — in a lifting clip they often never do, so every
segment reads short and the lift turns the difference into fabricated depth.

A profile is filled from a frame where the athlete faces the camera with the
limb extended, since then the projection *is* the length. The left/right spread
is the check that the pose really was frontal: on `athlete-a` the two sides agree
to 1.7% on the thigh and 0.6% on the shank. Ratios go in as measured and are
used unclamped — a measurement, not a guess.

Two profiles exist so far: `athlete-a` (measured) and `generic` (the population
priors in `depth_backend._BONE_RATIO`, i.e. the same thing the lift does with no
profile at all). Every example ships one; three are `generic` placeholders.

Edit them in the app under the video tab's **limb lengths** checkbox — each
change re-runs the reconstruction immediately, and *save to example* writes the
file back. Missing, malformed, or partial files degrade to `generic` per
segment rather than erroring, so a bad profile costs the calibration and not the
clip. Served by `/api/examples/<id>/limbs` (`GET`/`PUT`); the segment list and
the generic table come from `/api/depth/methods`, so neither the UI nor this
file has to hardcode which segments exist.

## Adding a fixture

```sh
./scripts/coach_launch.sh local                 # start the app, loopback only
python scripts/batch_extract_tracks.py --stance snatch clip1.mp4 clip2.mp4
# lands in tests/fixtures/local/ — add --scope global to commit it instead
```

See `scripts/batch_extract_tracks.py`'s docstring for the full CLI. It appends
to that scope's `manifest.json` (keyed by clip, so re-running on the same clip
overwrites rather than duplicates) and never guesses at a `labels`/`notes`
field it already finds there — those are written by hand, not by the pose
pass.

To promote a local fixture to global, move its `.mp4` and `.track.json` under
`global/<stance>/`, move its entry from `local/manifest.json` to
`global/manifest.json`, and regenerate its golden
(`node tests/update_golden.js global/<stance>/<clip-stem>`).

## `labels`

`manifest.json`'s `labels` array is how a fixture becomes more than a
regression snapshot: a hand-reviewed judgement about the lift, e.g.
`["first-pull-back-angle:good"]` or `["second-pull-triple-extension:critical"]`
(diagnostic id : expected `verdict.status`). Tests can assert against these
directly once a fixture has them; until then a fixture with an empty `labels`
list is still useful as a **golden/snapshot** test — it only proves the
diagnostic's output hasn't silently changed, not that the output is correct.

## `global/example/athlete-a-trim`

Seeded from `report/examples/athlete-a-trim.{mp4,track.json}` — the report's
one worked example — rather than freshly generated, so there's a fixture to
test against from the start. Its lift type (snatch vs. clean) isn't recorded
in `report/`, so it's filed under the generic `example` stance rather than a
guessed one; re-label it once confirmed.
