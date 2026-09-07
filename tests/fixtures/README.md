# tests/fixtures

Cached ViTPose tracks used as test cases, so the diagnostic tests run against
a real lift without paying for GPU inference every run.

```
tests/fixtures/
  manifest.json              one entry per fixture, keyed "<stance>/<clip-stem>"
  <stance>/
    <clip-stem>.mp4           the source clip (kept short/trimmed)
    <clip-stem>.track.json    {"keypoints": ..., "meta": ...} — vitpose_backend's
                               own output, unmodified; same shape /api/pose/video
                               returns to the browser
```

## Adding a fixture

```sh
./scripts/coach_launch.sh local                 # start the app, loopback only
python scripts/batch_extract_tracks.py --stance snatch clip1.mp4 clip2.mp4
```

See `scripts/batch_extract_tracks.py`'s docstring for the full CLI. It appends
to `manifest.json` (keyed by clip, so re-running on the same clip overwrites
rather than duplicates) and never guesses at a `labels`/`notes` field it
already finds there — those are written by hand, not by the pose pass.

## `labels`

`manifest.json`'s `labels` array is how a fixture becomes more than a
regression snapshot: a hand-reviewed judgement about the lift, e.g.
`["first-pull-back-angle:good"]` or `["second-pull-triple-extension:critical"]`
(diagnostic id : expected `verdict.status`). Tests can assert against these
directly once a fixture has them; until then a fixture with an empty `labels`
list is still useful as a **golden/snapshot** test — it only proves the
diagnostic's output hasn't silently changed, not that the output is correct.

## `example/athlete-a-trim`

Seeded from `report/examples/athlete-a-trim.{mp4,track.json}` — the report's
one worked example — rather than freshly generated, so there's a fixture to
test against from the start. Its lift type (snatch vs. clean) isn't recorded
in `report/`, so it's filed under the generic `example` stance rather than a
guessed one; re-label it once confirmed.
