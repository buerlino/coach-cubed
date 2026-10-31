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
    profiles/                 named profiles, chosen in the app, not tied to a clip
      limbs/<name>.json       an athlete's limb lengths (see below)
      signs/<name>.json       a camera position's depth directions (see below)
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

## Profiles: limb lengths and depth directions

Two things the depth reconstruction needs that the footage can't supply. Both
are **named profiles chosen in the app**, under the video tab's *limb lengths*
and *depth direction* checkboxes, and the choice is remembered across clips and
reloads. Neither is attached to a clip, because neither is a property of one:

- **`profiles/limbs/<name>.json`** — each segment's length as a fraction of
  torso (pelvis→neck). Belongs to the *athlete*. The lift's own per-clip
  estimate takes each segment's longest projection, which equals the true
  length only if the athlete fully extends that limb on camera — in a lifting
  clip they often never do, so every segment reads short and the lift turns the
  difference into fabricated depth.

  ```json
  { "notes": "where these came from",
    "ratios": { "thigh": 0.730, "shank": 0.707, "uarm": 0.461, "farm": 0.442 } }
  ```

  Filled from a frame where the athlete faces the camera with the limb
  extended, since then the projection *is* the length. The left/right spread is
  the check that the pose really was frontal: on `athlete-a` the two sides agree
  to 1.7% on the thigh and 0.6% on the shank. Ratios are used unclamped.

  Present: `athlete-a` (measured, global) and `default` (built in — the
  population priors in `depth_backend._BONE_RATIO`, what the lift runs with when
  nobody has been measured).

- **`profiles/signs/<name>.json`** — which way each limb bends out of the
  screen, `{joint index: +1 toward the camera | -1 away}`. Belongs to the
  *shot*: a single view can't tell toward from away, and the answer depends on
  where the camera stood, so one table serves every clip filmed from that spot.
  Choosing a profile puts the directions in manual mode with exactly that
  table; *none* leaves the solver to work them out from the pose.

  Present: `camera-front-right` (set by eye from the 3D view on the athlete-a
  clip, global) and the two built-ins `all-toward` / `all-away`.

Built-in profiles are never on disk and can't be saved over — an edit to one is
saved under a new name. *save…* in either bar asks for a name; an existing name
is overwritten in whichever scope holds it, a new one lands in `local/` (this
machine only, gitignored — a person's measured limbs are exactly the kind of
thing to keep there). Move the file to `global/profiles/` to commit it. A local
file with the same name as a global one shadows it. A missing, malformed or
partial file is skipped (limbs: filled per segment from `default`) rather than
breaking the picker.

Served by `/api/profiles/<kind>` (`GET`, the full list with built-ins first)
and `/api/profiles/<kind>/<name>` (`PUT`); the segment list, the joint list and
the default ratios come from `/api/depth/methods`, so neither the UI nor a
profile file has to hardcode which segments or joints exist.

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

Seeded from `parked/report/examples/athlete-a-trim.{mp4,track.json}` — the report's
one worked example — rather than freshly generated, so there's a fixture to
test against from the start. Its lift type (snatch vs. clean) isn't recorded
in the report, so it's filed under the generic `example` stance rather than a
guessed one; re-label it once confirmed.
