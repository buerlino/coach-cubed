# Backlog

Open items that no plan step covers yet: bugs, unverified assumptions and
stale text in code that stays (the core and the dev server). One or two lines
each, with where it was found. Items in parked areas stay with that area's
entry in [map.md](map.md). Done items leave this file (git keeps them).
Rewrite in place.

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

## Before anything is published (step 2.8)

- `../weightlifting-clipper` has no remote. It needs a home (for example a
  private GitHub repo) before step 2.8 removes clipper from coach's history.
- Noah's tailnet hostname is in [server.md](server.md),
  `scripts/coach_launch.sh` and the repo `Caddyfile`; the `Caddyfile` also
  lists his LAN and tailnet IP addresses. Noah decides whether they may be
  public. Step 2.6 removed the deploy map with the same addresses from
  [train-data-todo.md](train-data-todo.md); it stays in the history unless
  step 2.8 removes it.
