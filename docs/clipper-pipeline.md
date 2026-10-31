# clipper → coach test case pipeline

How a clip from clipper (its own repo, `weightlifting-clipper`, since
2026-10-31; before that `clipper/` in this repo) becomes a coach test case,
end to end, via
`scripts/sync_clipper_fixtures.py`. Verified working on one real clip
(2026-09-22) — see the proof-of-concept run at the bottom.

## The chain, step by step

1. **clipper cuts the clip.** It downloads a session video and
   trims one file per lift attempt (bar pickup → lockout) into a folder
   named after the source video and sitting beside it:
   `<video>/clips/<session>_NN_HhMMmSSs_<made|miss>.mp4`.
   It knows order, timestamp and referee decision — never lift type.

2. **`sync_clipper_fixtures.py` discovers new clips.** It globs
   `**/clips/*.mp4` under a `--clipper-dir` and dedupes by content hash
   (`tests/fixtures/local/.clipper_sync_state.json`), so re-running after
   clipper re-cuts something (which can renumber an already-seen attempt)
   never re-processes it.

3. **Each new clip is pose-extracted against the running coach app** — the
   same ViTPose call the manual `clips_inbox/` flow uses
   (`batch_extract_tracks.py`'s `start_job`/`wait_for_result`). This is the
   "wireframe": per-frame keypoints (wrists, elbows, hips, bar position,
   etc.) as a `.track.json`. Coach (`coach_launch.sh`/`coach_launch_venv.sh`)
   has to be up first; there's no way to skip this step, even for a dry run.

4. **Stance gets classified from that track**, not guessed from clip length:
   `scripts/pose_stance.py` reads the wrist/bar-height trajectory — one
   continuous rise to an overhead catch is a snatch, two rises separated by
   a rack pause is a clean & jerk. A track that doesn't read confidently
   (including one that looks physically broken) is left for manual review
   via `--stance-override SUBSTRING=STANCE`, never silently guessed.

5. **The fixture gets written**, same shape as every other fixture:
   - `tests/fixtures/local/<stance>/<clip-stem>.mp4` + `.track.json`
   - a `manifest.json` entry (stance, frame count, kept-person id, the
     auto-detected classification reason, etc.)
   Lands in `local/` (gitignored) by default; promoting to `global/`
   (committed) is a manual step.

6. **The golden snapshot gets regenerated** —
   `Diagnostics.computeResults()`'s output for that fixture, written to
   `tests/golden/local/<stance>-<clip-stem>.json`. This is what `npm test`
   checks every fixture against.

7. **`npm test` picks the new fixture up automatically** (it reads
   `manifest.json`, no test code to write per clip) and scores it against
   every registered diagnostic.

## Running it

```sh
./scripts/coach_launch.sh local        # or coach_launch_venv.sh — app must be up first
python scripts/sync_clipper_fixtures.py --dry-run   # extract + classify, write nothing
python scripts/sync_clipper_fixtures.py             # for real: writes fixture/manifest/golden
npm test
```

`--clipper-dir` defaults to `$CLIPPER_OUT`; with that unset, pass
`--clipper-dir /path/to/actual/downloads` to point at wherever clipper's
output really lives (e.g. a session archive under `~/Downloads`). There is no
in-repo default since clipper left the repo.

## Proof of concept (2026-09-22)

Ran the full chain on one real clip
(`Session14_01_0h18m07s_made.mp4`, 7.4s, 444 frames, CPU-only extraction):

- pose-extracted cleanly
- auto-classified as **snatch** ("one continuous rise to the peak, range
  2.82 torso-lengths") — no manual stance label
- fixture + manifest entry + golden snapshot written to
  `tests/fixtures/local/snatch/` and `tests/golden/local/`
- `npm test`: 66/66 pass, including
  `computeResults on local/snatch/Session14_01_0h18m07s_made matches its
  golden snapshot`

Next step: point `--clipper-dir` at the full session archive to batch this
over every clip instead of one at a time.
