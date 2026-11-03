# Adding a lift or a cue

For Noah and for the agents he runs: how a new cue or a new lift gets into the
app (`app/`), and how to check it, from the fastest check to the phone. The
old page (`src/app.py`, its `PAGES` list and its tabs) is frozen
([pipeline.md](pipeline.md#hard-rules)): a lift or a cue never needs an edit
there.

Where things live:

| What | Where |
| --- | --- |
| The cues, the sets of cues per lift, whether a lift has a lift window | `src/diagnostics.js`: the cue objects, `DIAGNOSTIC_SETS`, `LIFT_WINDOW_SETS` |
| The lifts the app offers: label, store abbreviation, provisional, figure, filming tip | `app/src/contracts/lifts.mjs`, the lift registry |
| The fixture tracks and their goldens | `tests/fixtures/global/`, `tests/golden/global/` ([tests/README.md](../tests/README.md#step-by-step-turning-clips-into-test-cases)) |
| The page test's fixture per lift | `app/tools/lift-fixtures.mjs`, with its clip in `tests/app/clips/` |

The app runs MoveNet Thunder on TF.js and hands `diagnostics.js` COCO-17
keypoints as `[y, x, conf]` in pixels, y down
([rules-core.md](rules-core.md), principle 4); the fixture tracks are
ViTPose's, in the same format.

## Adding a cue

A cue is one object in `src/diagnostics.js`, written in the order the
`lifting-diagnostic` skill (`.claude/skills/lifting-diagnostic/SKILL.md`)
gives, each part built on the one before:

1. **The description:** the cue in a coach's words (`title`, `cue`) and the
   one number that stands for it (`unit`).
2. **The active phase:** `phase(track, scale, axis)`, the window where the
   cue applies, found from triggers in the keypoints; a phase it can't find
   is an `{ error }` in plain words, never an empty chart.
3. **The visualization and the transparency:** `measure` (a series with two
   independent estimates, `lo` and `hi`), `verdict`, `score`, `tiles`,
   `referenceLine`, `transparencyLines`, `overlay`. The app also needs
   `provisional` (true until the thresholds are checked on real lifts),
   `worstRule`, `zones` (or `null` with `bands`), `unitNoun` and
   `verdictBasis`: A1, A2 and S1b read them through the headless API
   (`describe`, `tiles`, `worstMoment`, `zones`, `rule`, `scoringLines`), so a
   new cue needs no change in `app/`.
4. **The set:** list the object under its lift's key in `DIAGNOSTIC_SETS`.
   A cue belongs to one lift's set; two lifts share a cue only through one
   factory, with the reason in the cue's note.

Write the cue's note in `.claude/skills/lifting-diagnostic/diagnostics/`
(through the report, since `.claude/` is a shared file), then make the
goldens of the fixtures that set scores and read their diff before you keep
it (`node tests/update_golden.js global/<stance>/<clip>`; never to silence a
failing test).

## Adding a lift

1. **The set, in `src/diagnostics.js`:** a key in `DIAGNOSTIC_SETS` (an empty
   list is allowed: the lift then has no cues yet) and the same key in
   `LIFT_WINDOW_SETS`, `true` for a barbell lift (the bar below knee height,
   then a held lockout) or `false` for a lift with no bar (a lateral raise).
   `diagnostics.js` throws when it loads if the second is missing.
2. **One entry in the registry, `app/src/contracts/lifts.mjs`**
   (`SHIPPED_LIFTS`), in the order the import step offers the lifts:

   ```js
   {
     id: 'clean-and-jerk',        // the DIAGNOSTIC_SETS key
     label: 'Clean and jerk',     // what the app shows
     abbr: 'cj',                  // the stored lifts' id suffix: 2 to 4 letters, nobody else's
     provisional: true,           // its thresholds aren't checked on real lifts yet
     icon: { head: { cx: 24, cy: 17 }, path: 'M5 7h38…' },   // optional: a figure in a 48 × 48 box; none draws the lateral raise's
     framing: 'Film from the side, …',   // optional: one sentence on how to film it, for milestone B's R1
   }
   ```

   That is the whole change in `app/`: the import step, S1's default lift,
   the settings' check, the store's ids, the labels and H's and Q1's figure
   all read the registry. Which lifts ship is a decision for Noah and nordmu
   (`clean-and-jerk` has a set in `diagnostics.js` and is not offered).
3. **A fixture track and its golden.** Start the dev server, extract the
   clip's pose track with ViTPose, make its golden, run the tests:

   ```sh
   COACH_PORT=8090 .venv/bin/python src/app.py      # the dev server (ViTPose), in its own terminal; the .venv from scripts/setup_no_conda_linux.sh
   .venv/bin/python scripts/batch_extract_tracks.py --stance <lift> --host 127.0.0.1:8090 clip.mp4   # 84 s for 75 frames on the CPU
   node tests/update_golden.js local/<lift>/<clip>   # under a second
   npm test
   ```

   The track lands in `tests/fixtures/local/` (gitignored); `--scope global`
   writes it where it is committed. A stance that isn't a set key needs
   `--diagnostics <set>`. Check the kept person and the frame count, then
   commit the track, its manifest entry and its golden together
   ([tests/README.md](../tests/README.md#step-by-step-turning-clips-into-test-cases)
   has the whole way, the crop included).
4. **The page test's fixture.** A committed track becomes the page test's
   with a clip of the same frame rate and frame count in `tests/app/clips/`
   (ffmpeg's `testsrc2`, nothing recorded; the command is in
   [tests/README.md](../tests/README.md#the-test-clips-testsappclips)), for
   example 25 fps and 75 frames:

   ```sh
   X264="-c:v libx264 -preset veryslow -crf 48 -pix_fmt yuv420p -bf 2 -sc_threshold 0 -movflags +faststart -an -map_metadata -1 -fflags +bitexact -flags:v +bitexact"
   ffmpeg -y -f lavfi -i "testsrc2=size=108x192:rate=25" -frames:v 75 $X264 -g 25 -keyint_min 25 testsrc2-<lift>-25fps-75f.mp4
   ```

   and an entry in `app/tools/lift-fixtures.mjs` (`lift`, `track`, `clip`).
   A lift with none isn't walked: the page test says so in its output
   (`page-test: not walked, no fixture in app/tools/lift-fixtures.mjs: …`)
   and still passes.

## Checking it

In this order: each step is slower than the one before, and the first that
fails says where to look. The times are from the laptop (CPU only) on
2026-11-03.

| # | Command | What it checks | Time |
| --- | --- | --- | --- |
| 1 | `npm --prefix app test` | the app's tests: the registry and `diagnostics.js` agree (`tests/app/lifts.test.js`), the contracts, scoring every committed fixture, the screens' logic | 8 s |
| 2 | `npm test` | every test, `diagnostics.js`'s goldens included (a new fixture without its golden fails with the command that makes it) | 17 s |
| 3 | `python3 -m unittest discover -s tests -p 'test_*.py'` | the Python side (the server, the scripts) | 3 s |
| 4 | `npm --prefix app run test:page` | the app offline in headless Brave or Chromium, one walk per lift with a fixture: import, mark, analyse, the cards against the scoring in Node | 10 s |
| 5 | `pipeline/devlock.sh slice page-real node app/tools/page-test.mjs --real lateral-raise-cable-1` | the real engine, MoveNet on TF.js, on a real clip, in headless Brave (software WebGL, so slow) | 85 s, plus the CPU lock's wait (188 s in all) |
| 6 | the phone, by day | the APK on the Fairphone, offline | below |

`--real` takes the example clips in the `phase-0` worktree's
`tests/fixtures/local/example/` (`lateral-raise-cable-1`, `athlete-a-trim`)
and needs that worktree's TF.js bundle and weights; a new lift's real clip
goes there, with its fixture under `example/`. Step 5 runs through
`pipeline/devlock.sh slice` because it is heavy CPU work.

**The phone** is `c26`'s way: by day only, since the Fairphone is nordmu's
own phone and goes into airplane mode, so nordmu knows the run is happening.
Build the debug APK on the laptop:

```sh
pipeline/devlock.sh slice apk-web app/tools/build-apk.sh web      # 112 s: npm ci, the TF.js bundle, the weights, assemble, cap sync
pipeline/devlock.sh slice apk-gradle app/tools/build-apk.sh apk   # 38 s: Gradle, app/out/coach-debug.apk (18 MB)
```

Then a package for curie, the one agent that runs adb
([pipeline.md](pipeline.md#the-phone)): with the phone's lock, the APK
installed and airplane mode on, the lift's clip imported on H, marked and
analysed, the cards read; the numbers are medians of five runs. Nobody else
touches the phone.
