# Fixture data contract

What the pose pass writes, where it writes it, and how the page reads it. For
anyone building against the extracted ViTPose data rather than producing it —
see [`clipper-pipeline.md`](clipper-pipeline.md) for the producing side.

## Layout

The directory tree, the two scopes and the full slug
`<scope>/<stance>/<stem>` are in
[tests/fixtures/README.md](../tests/fixtures/README.md). `FIXTURES_DIR` in
`src/app.py` is `tests/fixtures`. A fixture's id carries its scope, so a
local and a global fixture with the same slug both show; only profiles
shadow by name.

**On the deploy box, the two stance directories under `local/` are symlinks to
bulk storage.** A full sync copies every clip into the fixture tree, which is
~7.3 GB of video the clips already hold elsewhere, and root had 32 G free at
89%. Only those two dirs are redirected: they are covered by `.gitignore`'s
`tests/fixtures/local/*` so git never sees the symlink, whereas
`local/.gitkeep` is tracked, which is why `local/` itself has to stay a real
directory. The manifest and the dedup state stay on the SSD — small, and read
on every request.

## `<stem>.track.json`

`vitpose_backend`'s own output, unmodified. The same shape
`/api/pose/video/result` returns, so page code that reads one reads the other.

```js
{
  "keypoints": {
    "<frameIndex>": {          // STRING key: "0", "1", ... "479"
      "<personId>": [          // tracker id, e.g. "2218" — only the kept person
        [y, x, confidence],    // 17 rows, COCO order; y points down
        ...
      ]
    }
  },
  "meta": {
    "fps": 30.0,
    "frame_count": 480,
    "frames_processed": 480,
    "frame_stride": 1,
    "width": 1920, "height": 1080,       // x,y are SOURCE pixels, not normalised
    "frame_indices": [0, 1, 2, ...],     // which frames were processed
    "frame_times_ms": [0.0, 33.33, ...], // decoder timestamps
    "skeleton": [[15,13], [13,11], ...], // bone pairs, indices into the joint list
    "tracks": { "kept": "2218", "kept_frames": 371,
                "dropped": [{"id": "2221", "frames": 240}, ...] }
    // tracks made before 2026-10-31 also carry "equipment", "equipment_error"
    // and "equipment_prompts" (bar detection, since parked); 3D still reads
    // "equipment" when it is there
  }
}
```

Joint order, which `meta.skeleton` indexes into:

```
0 nose  1 l_eye  2 r_eye  3 l_ear  4 r_ear  5 l_shoulder  6 r_shoulder
7 l_elbow  8 r_elbow  9 l_wrist  10 r_wrist  11 l_hip  12 r_hip
13 l_knee  14 r_knee  15 l_ankle  16 r_ankle
```

Three things that bite:

- Frame keys are **strings**, not numbers. `Object.keys()` comes back in
  insertion order, which is not numeric order — sort before you iterate.
- The inner dict is keyed by **tracker id**, which differs per clip. Read
  `meta.tracks.kept` rather than assuming a name or taking the first key.
- `frame_times_ms` is the authority on timing when present. `index / fps` is
  wrong under a stride, and wrong again on variable frame timing.

## `manifest.json`

One entry per fixture, keyed `"<stance>/<stem>"` within its scope.

```json
"clean-and-jerk/01-2019-arafura-games-session-1-uzbodnfldbu_04_0h07m35s_unknown": {
  "stance": "clean-and-jerk",
  "diagnostics": "clean-and-jerk",      // DIAGNOSTIC_SETS key it is scored against
  "source_file": "..._unknown.mp4",
  "model_size": "l",
  "frame_stride": 1,
  "frame_count": 400, "frames_processed": 400,
  "kept_person": "8111",
  "attempt_result": "unknown",          // clipper's referee verdict: made|miss|unknown
  "detect_equipment": false,           // entries made before 2026-10-31 only
  "generated_at": "2026-10-13T19:37:12+00:00",
  "labels": [],                         // hand-written; the pose pass never touches it
  "notes": "stance auto-detected from pose trajectory: ..."
}
```

`labels` and `notes` are the hand-review channel: `batch_extract_tracks.py` and
`sync_clipper_fixtures.py` both preserve whatever they find there.

## Adding a fixture: the mechanism

`_load_manifest()` re-reads both manifests **from disk on every call**, with no
cache. A fixture is therefore live the moment its three pieces exist — no
restart, no reload:

1. `tests/fixtures/<scope>/<stance>/<stem>.mp4`. A `global` fixture's clip
   may sit at the same path under `local/` instead; today every global clip
   does, because they are third-party
   ([tests/fixtures/README.md](../tests/fixtures/README.md#videos))
2. `tests/fixtures/<scope>/<stance>/<stem>.track.json`
3. an entry in that scope's `manifest.json`

`/api/examples` skips any entry whose video or track is missing, so a
half-written fixture is invisible rather than broken. Per-size tracks are
`<stem>.<size>.track.json` for sizes `l` and `h`; a bare `<stem>.track.json`
counts as the size named in `model_size`, and an explicit per-size file wins.

### `/api/examples` used to be quadratic — fixed 2026-10-13

It was measured at 788 entries as **293 KB, 5.4 s per request**: `api_examples`
called `_example_tracks(key)` and `_example_video(key)` per entry, and each of
those re-parsed both manifests — 2n+1 full parses per request, heading for
~90 s at the full 3,226. Both helpers now take the already-loaded entry
(`_example_tracks(key, entry)`), so the manifests are parsed once per request.
Measured after the change at 811 entries: **303 KB, 0.06 s** (0.061 / 0.059 /
0.058). The zero-restart property above is kept: nothing is cached across
requests.

The response now also carries `attempt_result`, `labels`, `frame_count` and
`generated_at` from the manifest, so a picker can filter on made/miss without
fetching the manifests itself. There is still no pagination or filter
parameter; the training data explorer (next section) filters client-side
over its own listing instead.

## The training data explorer (`train data` tab, `/api/train/*`)

The in-app browser over clipper's output — every cut clip, not only the
fixtures. It reads `$CLIPPER_OUT` (`COACH_TRAIN_DIR` overrides it). On the
deploy, the systemd unit gets it from a drop-in under
`~/.config/systemd/user/coach-app.service.d/`, since a user unit does not read
`~/.bashrc`: a clip path that 404s after a shell export is this. With neither
set, the app still falls back to the in-repo `clipper/downloads`, which left
with clipper ([backlog.md](backlog.md)).

```
GET /api/train/clips                 {dir, lifts, clips: [...]} — one row per **/clips/*.mp4
GET /api/train/clip/<path>           the clip itself (path relative to CLIPPER_OUT)
PUT /api/train/labels/<path>         {exercise?, category?, gender?} -> train_labels.json
POST /api/train/link                 {path, size, frame_stride,
                                      fallback_exercise, track: {keypoints, meta}}
```

A row has what the filename and `clips.json` give (`event`, `session`,
`session_idx`, `attempt`, `t`, `result`, `duration`, `bytes`, `mtime`), whether
a fixture with a cached track exists for that clip (`precomputed`,
`example_id`, `sizes` — matched on `source_file`), and the three labels the
footage can't supply: `exercise`, `category`, `gender`. `exercise_source` says
where the exercise came from: `label` (set by hand), `track` (the stance
classifier), `default` (the classifier abstained and the link endpoint fell
back to the panel the clip was opened in — the manifest `notes` start with
`stance NOT classified`), or `null`. Labels live in `train_labels.json`, keyed
by the clip's path relative to `CLIPPER_OUT`, and a hand-set exercise beats the
classifier's.

Double-clicking a clip with a track loads it as the example it is. One without
is run through `/api/pose/video/*` at the panel's model size and the result is
`POST`ed to `/api/train/link`, which writes the same three pieces the sync
does: the clip copy, `<stem>.track.json` (or `<stem>.<size>.track.json` when
the slug already holds another size) and the manifest entry, which also gets
`train_clip`. It regenerates the golden when it writes a bare
`<stem>.track.json`. It writes into `local/`, unless the clip already has a
global fixture, in which case into `global/` (where the clip copy is
gitignored). For a local fixture it also adds the sha256 entry in
`.clipper_sync_state.json`, so a later sync skips the clip, and the entry in
`train_links.json`: a sync run that started
with an older copy of `sync_clipper_fixtures.py` rewrites `local/manifest.json`
from its own in-memory dict, dropping entries linked in the meantime, and
`_load_manifest()` restores any entry from that file whose track still exists.
The sync script re-reads the manifest before each save since 2026-10-13, so a
run started after that no longer does this.

## Reading it from the page

A cached fixture — what you want for the clipper dataset:

```js
const BASE = location.pathname.replace(/[/]+$/, '').replace(/[/]original$/, '');
const [vid, track] = await Promise.all([
  fetch(`${BASE}/api/examples/${encodeURI(id)}/video`),
  fetch(`${BASE}/api/examples/${encodeURI(id)}/track?size=l`),
]);
```

`id` is the full slug. Omit `size` and you get `model_size`, else the smallest
cached; a size with no cached track is a 404, and the listing's `sizes` tells
you which exist.

A fresh upload is a job, not a request — one slot per app instance, and
`start` returns 409 while one is `counting` or `running`:

```
POST /api/pose/video/start     multipart: video=<file>, size=l|h,
                               frame_stride=<int >= 1>
                               (detect_equipment=1 answers 400 since bar
                               detection was parked on 2026-10-31)
GET  /api/pose/video/progress  {status: idle|counting|running|done|error|cancelled,
                                processed, total, rateFps, etaSeconds,
                                error (when status is error)}
GET  /api/pose/video/result    the {keypoints, meta} object — one-shot, clears the slot
POST /api/pose/video/cancel
POST /api/pose                 single image, synchronous
GET  /api/capabilities         {} — nothing optional since bar detection was parked;
                               the fixture scripts use it as a liveness probe
```

The slot is per instance: two instances on different ports have independent
slots, which is how a batch run and the UI can coexist.

## Profiles: limb lengths and depth directions

Both are **named profiles chosen in the app**, not files attached to a clip,
because neither is a property of one. `tests/fixtures/README.md` has the full
rationale; this is the on-disk and over-the-wire shape.

On this machine, yours go in:

```
tests/fixtures/local/profiles/limbs/<name>.json
tests/fixtures/local/profiles/signs/<name>.json
```

Real directories, not symlinked. `<name>` must match
`^[a-z0-9][a-z0-9._-]{0,63}$`. Move a file to `global/profiles/` to commit it.

**limbs** — each segment as a fraction of torso (pelvis→neck). Belongs to the
*athlete*:

```json
{ "notes": "where these came from",
  "ratios": { "thigh": 0.730, "shank": 0.707, "uarm": 0.461,
              "farm": 0.442, "shoulders": 0.74, "hips": 0.47 } }
```

**signs** — which way each limb bends out of the screen. Belongs to the *shot*,
so one table serves every clip from that camera position:

```json
{ "notes": "camera front-right of the athlete",
  "signs": { "5": 1, "7": -1, "8": 1, "9": -1, "10": 1,
             "13": 1, "14": 1, "15": -1, "16": -1 } }
```

Keys are joint indices as **strings**; `+1` is toward the camera, `-1` away.
Choosing a signs profile puts the solver in manual mode with exactly that
table; *none* lets it solve the directions from the pose.

Do not hardcode either key list. `/api/depth/methods` serves `limb_segments`
(key, label, min, max, default) and the joint list precisely so the UI and the
files don't have to, and a partial limbs file is filled per segment from
`default` rather than rejected.

```
GET /api/profiles/limbs|signs          {"profiles": [...]}, built-ins first
PUT /api/profiles/limbs|signs/<name>   body is the profile object
```

Built-ins (`default`, `all-toward`, `all-away`) are never on disk and `PUT`
refuses those names. Which scope a `PUT` writes to, shadowing, and what
happens to a malformed file: [tests/fixtures/README.md](../tests/fixtures/README.md).

## Caveats on the data itself

What the extracted data is like (how many clips were held for review and why,
the 85:15 stance split, what that means before the data trains anything) is in
[dataset-stats.md](dataset-stats.md) and [train-data-todo.md](train-data-todo.md).
