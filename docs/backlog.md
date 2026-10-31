# Backlog

Open items that no plan step covers yet: bugs, unverified assumptions and
stale text, in any area (the frozen and parked ones too, since
[map.md](map.md) is a frozen snapshot). One or two lines each, with where
it was found. Done items leave this file (git keeps them). Rewrite in
place.

## Where we are

During the restructuring window, the order of work and its status are in
[restructure-plan.md](restructure-plan.md) ("Next session starts here").

## Bugs

- A fixture without a `diagnostics` field is silently scored as snatch
  ([map.md](map.md#11-tests-and-fixtures), area 11).
- `scripts/sync_clipper_fixtures.py` accepts only 2-digit attempt numbers
  (`\d{2}`) where app.py accepts any (`\d+`); the likely cause of the 30
  skipped clips ([dataset-stats.md](dataset-stats.md)).
- With neither `$COACH_TRAIN_DIR` nor `$CLIPPER_OUT` set, the train tab's
  `TRAIN_DIR` (`src/app.py`) falls back to the in-repo `clipper/downloads`,
  which left with clipper in step 2.3. Python, outside `INDEX_HTML`.
- Known absolute paths in frozen code, which 404 under the `/coach/`
  prefix and stay until the code is parked: `/anatomy/shared.css` and the
  credits links (`src/anatomy/integration.mjs:7,30`), the `/squat/` links
  (`src/anatomy/ui.mjs:5`, `review.mjs:7`), and in the Movement Lab
  `/diagnostics.js` (`src/squat/index.html:56`) and every `/api/...` call
  (`src/squat/app.mjs`, `original-tools.mjs`). `tests/paths.test.js`
  allowlists exactly these.

## Unverified

- Whether `diagnostics.js`'s 0.3 confidence gate fits MediaPipe's
  "visibility" values (map areas 2 and 3). Phase 3 should settle it.
- The goldens score raw tracks; the UI scores smoothed ones, so the tests
  don't cover what the user sees (map area 2).
- Where the deploy's live CA lives: [server.md](server.md) says `.caddy/` in
  the repo folder on Noah's machine; the old `deploy.md` said the gateway's
  own storage. Only that machine can tell.
- In [dataset-stats.md](dataset-stats.md) the `exercise` counts sum to 3,228
  against 3,226 clips. The numbers come from Noah's machine.
- Notes in the `lifting-diagnostic` skill quote measurements that nothing in
  the repo reproduces: the athlete-b clean fixture's rise and phase (it is
  local on Noah's machine), the second pull's stride test (no committed test)
  and the setup jitter of "0.02–0.05" (the code comment says 0.02–0.04).

## Before 0.1.0 ships

- The app needs a credits screen: CC BY 4.0 needs BodyParts3D's
  attribution where users see it (if anatomy ships at all), and Apache-2.0
  and MIT need their notices shipped with the code. The old page has none;
  the Movement Lab links `src/squat/THIRD_PARTY.md`.
- The three.js copy in `src/vendor/` has only its licence header; the full
  MIT text is beside the other copy, in `src/squat/vendor/`.
- The pose model and runtime that Phase 3 picks go into
  [THIRD_PARTY.md](../THIRD_PARTY.md) with their weights' licence; the
  current MediaPipe entry covers only the prototype.

## Before anything is published (step 2.8)

- `../weightlifting-clipper` has no remote. It needs a home (for example a
  private GitHub repo) before step 2.8 removes clipper from coach's history.
- Noah's tailnet hostname is in [server.md](server.md),
  `scripts/coach_launch.sh` and the repo `Caddyfile`; the `Caddyfile` also
  lists his LAN and tailnet IP addresses. Noah decides whether they may be
  public. Step 2.6 removed the deploy map with the same addresses from
  [train-data-todo.md](train-data-todo.md); it stays in the history unless
  step 2.8 removes it.
