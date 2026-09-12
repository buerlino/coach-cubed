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
