# clipper → coach test case pipeline

How a clip cut by clipper (its own repo, `weightlifting-clipper`, since
2026-10-31; before that `clipper/` in this repo) becomes a coach test case,
via `scripts/sync_clipper_fixtures.py`. The numbers the full pass produced
are in [dataset-stats.md](dataset-stats.md).

## The chain, step by step

1. **clipper cuts the clip.** It downloads a session video and trims one file
   per lift attempt (bar pickup → lockout) into a folder named after the
   source video and sitting beside it:
   `<video>/clips/<session>_NN_HhMMmSSs_<made|miss|unknown>.mp4`, where `NN`
   is the attempt number, two digits or more. It knows order, timestamp and
   referee decision, never the lift type.

2. **`sync_clipper_fixtures.py` discovers new clips.** It globs
   `**/clips/*.mp4` under `--clipper-dir` and dedupes by content hash
   (`tests/fixtures/local/.clipper_sync_state.json`), so re-running after
   clipper re-cuts something (which can renumber an already-seen attempt)
   never re-processes it.

3. **Each new clip is pose-extracted against the running dev server**: the
   same ViTPose call `batch_extract_tracks.py` makes (`start_job` /
   `wait_for_result`), which writes the 17 COCO keypoints per frame as a
   `.track.json`. The server has to be up first, and there is no way to skip
   this step, even for a dry run: the stance can only be read off the track.

4. **The stance is classified from that track**, not guessed from the clip
   length: `scripts/pose_stance.py` reads the wrist-height trajectory. One
   continuous rise to an overhead catch is a snatch; two rises separated by a
   rack pause are a clean & jerk. A track that doesn't read confidently
   (including one that looks physically broken) is left alone and reported,
   never guessed: fix it with `--stance-override SUBSTRING=STANCE`, or look
   into it, and re-run. Its docstring says what the classifier has and hasn't
   been validated against; read it before trusting a large batch of clean &
   jerk verdicts.

5. **The fixture is written**, the same shape as every other fixture:
   `tests/fixtures/local/<stance>/<clip-stem>.mp4` and `.track.json`, and a
   `manifest.json` entry (stance, frame count, kept-person id, the
   classifier's reason). It lands in `local/` (gitignored). `--scope global`
   writes into the committed scope instead; the clip itself stays out of git
   there ([tests/fixtures/README.md](../tests/fixtures/README.md#videos)).

6. **The golden snapshot is regenerated**: `Diagnostics.computeResults()`'s
   output for that fixture, in `tests/golden/<scope>/<stance>-<clip-stem>.json`.

7. **`npm test` picks the new fixture up** from `manifest.json`, with no test
   code per clip, and scores it against its lift's diagnostic set.

## Running it

```sh
./scripts/coach_launch.sh local                     # the dev server must be up first
python scripts/sync_clipper_fixtures.py --dry-run   # extract + classify, write nothing
python scripts/sync_clipper_fixtures.py             # for real: fixture, manifest, golden
npm test
```

`--clipper-dir` defaults to `$CLIPPER_OUT`, the same variable clipper's
`clip.sh` writes its output to; with that unset, pass `--clipper-dir` with
wherever clipper's output lives. Nothing is copied into this repo except the
fixtures the sync keeps.

The first run of the whole chain was on one clip, `Session14_01_0h18m07s_made`
(2026-09-22), now the committed fixture `global/snatch/Session14_01_0h18m07s_made`.
