# Core rules (binding)

These rules bind every session, agent and contributor: the goal, the
principles, the hard rules, and the rules for changing this repo.
[AGENTS.md](../AGENTS.md), the entry point every agent loads, links here;
where the two differ, this file wins. Rewrite in place, never amend (git
keeps the history).

**The goal** (confirmed by nordmu, 2026-10-31): *film a lift on your phone and get
cue-by-cue technique feedback, offline, with nothing leaving the phone.*

The first release, 0.1.0, ships as a PWA and as a signed Android APK, from
one mobile-first, responsive web app. What it
covers is in [decisions.md](decisions.md); how the repo gets there is in
[restructure-plan.md](restructure-plan.md).

**Four principles decide every default** (confirmed by nordmu,
2026-10-31):

1. **Honest verdicts.** A cue is scored only when the keypoints support it;
   otherwise the app says it can't score it. Thresholds stay marked
   provisional until they are checked on real lifts.
2. **Narrow core, park the rest.** A feature joins only if it serves the lift
   analysis. Everything else waits in `parked/`: moved, not deleted.
3. **Reuse first.** Open-source models and libraries over our own. We write
   the diagnostics, the glue and the UI.
4. **One keypoint format.** Every pose model hands COCO-17 `[y, x, conf]`
   (pixels, y pointing down) to `diagnostics.js`, so swapping the model never
   touches the cues.

## Hard rules

### Offline
- The app works with no network at all. Models, code and assets ship with it,
  vendored; nothing is fetched from a CDN at run time.
- No server compute for analysing a video: pose runs on the phone. The Flask
  server stays as dev tooling (reference tracks, goldens; see
  [server.md](server.md)), never as a dependency of the app.

### Nothing leaves the phone
- Videos, tracks and results stay on the device; the app sends nothing
  anywhere.
- No analytics, crash reporters or trackers.

### Licence-compatible dependencies
- coach is GPL-3.0-or-later ([decisions.md](decisions.md#licence)). Every
  dependency that ships in the app is permissive or GPL-3.0-compatible, and
  nothing AGPL ships: YOLOv8 (`ultralytics`) is AGPL-3.0 and stays on the
  dev server.
- Record each one with its name, version, licence and source in the root
  [THIRD_PARTY.md](../THIRD_PARTY.md).

## Changing this repo

The repo has been broken twice by changes that looked harmless alone (an
absolute path, a moved file) and failed only behind the real reverse proxy.
These rules stop a third time. The server's own rules are in
[server.md](server.md).

### Paths stay relative
- Every asset reference the app emits (`<script src=...>`, import maps, a
  launcher finding its own tools) is relative to the document or to the
  script's own location: never absolute (`/foo`), never a machine path.
- Why: the deploy mounts coach at `/coach/*` and strips the prefix before
  Flask sees the request, so `/vendor/three.module.js` hits the site root and
  404s. On 2026-09-17 that broke the 3D viewer and the slider markers, after
  working fine on `localhost:8080`.
- If you touch `INDEX_HTML` in `src/app.py`, or a launcher or script that
  locates another file, confirm the path still resolves under a prefix, not
  only at the root: `http://127.0.0.1:8080/` passes even when the production
  URL is broken. How: [server.md](server.md#test-under-the-real-path-prefix).
- Python too: `launchers/*.py` resolve `ROOT` from
  `Path(__file__).resolve().parent(.parent...)`, never from `os.getcwd()` or
  a hardcoded string, so they work wherever the repo is cloned or run from.

### The root stays minimal
- The root holds only what belongs at the top (README, LICENSE-style docs,
  `Caddyfile`, `package.json`, `.gitignore`, ...); everything else lives in a
  folder named for what it is.
- Runnable Python entry points and their double-click `.command`/`.bat` twins
  live in `launchers/`.
- Anything that builds into the LaTeX report, `.aux`/`.log`/`.out` byproducts
  included, stays under `parked/report/`, whose Makefile builds and cleans
  there. A `report.aux` at the root is always a mistake (the root
  `.gitignore` catches it).
- A new kind of file gets a new folder named for its purpose, not a spot at
  the root "because it's just one file". The Layout table in the root
  [README](../README.md#layout) is the map and stays accurate.

### Moving a file
Grep the whole repo for the old name before you call the move done: docs,
the READMEs in subfolders, tests, scripts and launchers name paths as
strings, and none of that fails as an import error until someone runs it.

```sh
grep -rn "old_file_name" --include="*.md" --include="*.py" --include="*.sh" \
  --include="*.bat" --include="*.command" --include="*.js" .
```

Then run what you moved (`npm test`, `python3 -m unittest discover -s tests
-p 'test_*.py'`, or the launcher itself) instead of trusting the move.

### Landmines
- **Vendored assets are there on purpose.** `src/vendor/three.module.js`,
  `src/squat/vendor/three.module.js` and the MediaPipe files under
  `src/pose/vendor/mediapipe-pose/` make coach work with no network (see
  "Offline", and the comment above `THREE_JS` in `src/app.py`). Don't swap
  one for a CDN import. The two `three.module.js` copies are separate because
  different routes serve them: don't dedupe them without confirming that the
  main app and the squat lab both still resolve theirs.
- **`launchers/*.command` and `*.bat` `cd` up to the repo root** before
  anything relative (`.venv`, `requirements-preview.txt`, `src/`). Moving one
  without the others, or without updating the `cd` target, silently breaks
  double-click launch on someone else's machine, where nobody sees the error.
- **The server has landmines of its own** (two Caddyfiles, the live CA in
  `.caddy/`, restart versus reload, the sibling notes on the deploy machine):
  [server.md](server.md#landmines). Read it before changing how the app is
  served or launched, how it loads models, or what it holds.

### Stop and ask
If you're about to convert a relative path to an absolute one, move a file
without grepping the repo for its old name, touch anything under `.caddy/`,
swap a vendored asset for a network fetch, or otherwise reintroduce the class
of bug above: **stop and say so, out loud, before you do it.** Use this exact
tone, deliberately silly so it's impossible to miss and impossible to mistake
for a normal status update:

> Hewwo! Befowe you continue ^.^ this might bweak compatibiwity because
> [specific reason]. Pwease consider a diffewent appwoach, or double-check
> with Noah that this is weally what we want, teehee~ UwU

Then wait for confirmation instead of proceeding. This isn't general caution:
it's for the narrow set of changes that look fine locally and fail only once
deployed, where whoever approves the change may not know to check for that.
