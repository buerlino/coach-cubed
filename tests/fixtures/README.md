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
      <clip-stem>.mp4         the source clip, if it may be published; none may
                               today (see "Videos" below)
      <clip-stem>.track.json  {"keypoints": ..., "meta": ...} — vitpose_backend's
                               own output, unmodified; same shape /api/pose/video
                               returns to the browser
    profiles/                 named profiles, chosen in the app, not tied to a clip
      limbs/<name>.json       an athlete's limb lengths (see below)
      signs/<name>.json       a camera position's depth directions (see below)
  local/                      gitignored — your own clips, this machine only
    manifest.json             same layout as global/
    <stance>/...              also the clips of global fixtures that can't be
                               committed, at the same <stance>/<file> path
    profiles/                 same layout as global/profiles/
    .clipper_sync_state.json  the clipper sync's dedup state, by content hash
    train_labels.json         the training data explorer's hand labels
    train_links.json          the manifest entries the explorer linked
```

The file shapes and the endpoints that serve them are in
[docs/fixture-data-contract.md](../../docs/fixture-data-contract.md).

The two scopes are identical in layout and differ only in whether git sees
them. The app merges both manifests into one picker (grouped `global` /
`local`), and the tests score both. Everywhere outside the manifest files
themselves — the app's example ids, `tests/update_golden.js`, golden file
paths — a fixture is named by its full slug `<scope>/<stance>/<clip-stem>`,
e.g. `global/example/athlete-a-trim`. Goldens mirror the split:
`tests/golden/<scope>/<stance>-<clip-stem>.json`, with `tests/golden/local/`
gitignored too.

## Videos

No video is committed. Every clip behind a global fixture is third-party
footage that grants no licence to redistribute it, so since step 2.4
(2026-10-31) each one sits at the same `<stance>/<file>` path under the
gitignored `local/`. Their tracks, manifest entries and goldens stay public:
they hold keypoints, not footage. Where each clip came from:

| Clip, under `local/` | Source | Who is in it |
| --- | --- | --- |
| `example/lateral-raise-cable-1.mp4` | YouTube `n77-W0nkuPw`, the first 3 s | one identifiable person, unnamed |
| `example/lateral-raise-cable-2.mp4` | YouTube `f_OGBg2KxgY`, seconds 8–11 | one identifiable person, unnamed |
| `example/athlete-a-trim.mp4` | Not recorded. The same file is the report's example (`parked/report/examples/`, gitignored there too). | a competition athlete, pseudonymized as `athlete-a` (the clip, the limb profile and the report all used the real name until step 2.4) |
| `snatch/Session14_01_0h18m07s_made.mp4` | An Australian Weightlifting Federation competition stream, cut by clipper | the lifter, whose name shows on the broadcast's scoreboard |

What still works without the clips, on a fresh clone:

- **The tests:** all of them. No test reads a video; they read the tracks
  and goldens only.
- **The example gallery:** empty, and the page hides its picker. Both
  servers (`_example_video` in `src/app.py`, `examples()` in
  `launchers/run_local.py`) look for a global example's clip beside its
  track first, then at the same path under `local/`; with a copy of the
  clips there, the gallery comes back unchanged.

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

  Filled from a frame where the athlete faces the camera with the limb
  extended, since then the projection *is* the length. The left/right spread is
  the check that the pose really was frontal: on `athlete-a` the two sides agree
  to 1.7% on the thigh and 0.6% on the shank. Ratios are used unclamped.

  Present: `athlete-a` (measured, global) and `default` (built in — the
  population priors in `depth_backend._BONE_RATIO`, what the lift runs with when
  nobody has been measured).

- **`profiles/signs/<name>.json`** — which way each limb bends out of the
  screen, toward the camera or away. Belongs to the
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

To promote a local fixture to global, move its `.track.json` under
`global/<stance>/`, move its entry from `local/manifest.json` to
`global/manifest.json`, and regenerate its golden
(`node tests/update_golden.js global/<stance>/<clip-stem>`). Move its `.mp4`
too only if the clip may be published (see "Videos"); otherwise it stays at
the same path under `local/`, where the app still finds it.

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
test against from the start. Its lift type isn't recorded in the report, so it
was filed under the generic `example` stance.

It is a snatch: eight frames of the clip show a wide grip and the bar going from
the floor to overhead in one movement, caught in an overhead squat (looked at
and confirmed by nordmu on 2026-11-02). Its manifest entry's
`"diagnostics": "snatch"` is therefore the right set. It stays under `example`: moving it would rename its
slug, its golden and the local clip's path for no gain.
