# Core rules (binding)

These rules bind every session, agent and contributor. [AGENTS.md](../AGENTS.md)
links here; where the two differ, this file wins. Rewrite in place, never
amend (git keeps the history).

**The goal** (nordmu, 2026-10-31): *film a lift on your phone and get
cue-by-cue technique feedback, offline, with nothing leaving the phone.*

The first release, 0.1.0, is an Android app (iOS possibly as a PWA). What it
covers is in [decisions.md](decisions.md); how the repo gets there is in
[restructure-plan.md](restructure-plan.md).

**Four principles decide every default** (nordmu, 2026-10-31):

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
- Every dependency that ships in the app has a licence compatible with
  coach's. Until that licence is chosen (question 1 in
  [decisions.md](decisions.md)), pick permissive or GPL-3.0-compatible ones,
  and nothing AGPL: YOLOv8 (`ultralytics`) is AGPL-3.0 and stays on the dev
  server.
- Record each one with its name, version, licence and source: today in the
  `THIRD_PARTY.md` next to it (for example
  [src/pose/THIRD_PARTY.md](../src/pose/THIRD_PARTY.md)), from step 2.7 in
  one root `THIRD_PARTY.md`.
