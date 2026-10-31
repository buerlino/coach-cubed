# Credits and asset provenance

## MediaPipe Pose

Google's `@mediapipe/pose` package, version **0.5.1675469404**, downloaded from
the npm registry. Apache-2.0 as declared by the package. JavaScript, WebAssembly,
graph data, packed detector assets and the full landmark model are bundled in
`vendor/mediapipe-pose/`. Heavy/lite model variants and source maps are omitted
because this view uses modelComplexity 1. The original package manifest is
retained, and `vendor/pose-assets-manifest.json` records each file's size and
SHA-256. Full licence: `vendor/APACHE-2.0.txt`.

Package source:
https://registry.npmjs.org/@mediapipe/pose/-/pose-0.5.1675469404.tgz

Documentation:
https://chuoling.github.io/mediapipe/solutions/pose.html

The older complete Pose package is pinned deliberately for a self-contained
local prototype. Migration to the newer Tasks Vision API is a future maintenance
task, not required to start this bundled version.

(Moved here from `src/squat/THIRD_PARTY.md` with the files, in step 2.0 of
[the restructuring plan](../../docs/restructure-plan.md).)
