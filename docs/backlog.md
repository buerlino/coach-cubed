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
- [fixture-data-contract.md:53](fixture-data-contract.md) gives keypoints as
  `[x, y, confidence]`; the code and data use `[y, x, conf]`. Fix before
  Phase 3 writes tracks from a new model (map area 12).
- `scripts/sync_clipper_fixtures.py` accepts only 2-digit attempt numbers
  (`\d{2}`) where app.py accepts any (`\d+`); the likely cause of the 30
  skipped clips (map area 8).

## Unverified

- Whether `diagnostics.js`'s 0.3 confidence gate fits MediaPipe's
  "visibility" values (map areas 2 and 3). Phase 3 should settle it.
- The goldens score raw tracks; the UI scores smoothed ones, so the tests
  don't cover what the user sees (map area 2).

## Stale text (for step 2.6, unless a step touches the file first)

- The `src/app.py` docstring names one backend; it imports three (map area 1).
- The comment above the import map in `src/app.py` says three.js loads from a
  CDN; it's vendored (map area 1).
- [deploy.md](deploy.md) contradicts the scripts (systemd unit, number of
  backends, where the CA lives), and the repo `Caddyfile` cites files that
  don't exist (map area 10). Fold what is still true into
  [server.md](server.md).
- `tests/README.md` lists 2 of the 8 test files and gives the wrong golden
  path (map area 11).
- The two skills left in `.claude/skills/` are partly stale: wrong registry
  names, missing lifts (map area 12).

## Before anything is published (step 2.8)

- [train-data-todo.md:27–29](train-data-todo.md) lists Noah's LAN and tailnet
  addresses and hostname (map area 8). The file moves to `parked/` with the
  train tab, but stays in the history unless 2.8 removes it.
- Noah's tailnet hostname is also in [server.md](server.md) (taken over from
  AGENTS.md) and in `scripts/coach_launch.sh`. Noah decides whether it may be
  public.
