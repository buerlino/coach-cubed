# Shared optional anatomy, version 5

`integration.mjs` adds anatomy to the original workspace at `/original/`.
`src/squat/app.mjs` is the teal all-exercise workspace at `/squat/`, with the
original diagnostic engine and geometric 3D controls mounted by
`original-tools.mjs`. `ui-config.mjs` chooses the package's default page/port.

Both pages start with anatomy off and the on-video layout selected. Three visible buttons select overlay, model-only or side-by-side. Hiding the
video preserves its clock and transport controls. They share `sequence.mjs`, `stability.mjs`, `viewer.mjs` and
`barbell.mjs`. Video and anatomy use one playback clock.

`sequence.mjs` maps actual frame indices/timestamps, registers backend depth,
and uses one clip-level atlas scale. The default conservative depth blend can
be changed to full reconstructed depth. `stability.mjs` rejects isolated spikes,
smooths display coordinates, fills missing references and detects stationary
foot contacts that release on motion. Turning stabilization and foot contact off
preserves the original image coordinates.

Missing limbs use parent-relative estimates; completely missed frames hold the
last complete display pose. Estimated regions are blue-grey. These are explicitly
display-only estimates, not recovered measurements. `track-session.mjs` passes
only detector coordinates/confidence to squat review and original diagnostics.

`viewer.mjs` skins 337 BodyParts3D surfaces to regional segments. It never hides
a surface because an attachment joint was missed. Opaque depth-tested materials
plus whole-canvas opacity avoid per-surface transparent sorting artifacts.
Camera mode uses the video's contain rectangle; orbit mode uses clip bounds.
`pose-rig.mjs` provides inferred pelvis/back anchors, manual corrections and an
optional limb-length / soft ROM prior. Vertebral points are not newly detected.

`barbell.mjs` places a visual bar from equipment boxes, or from explicitly chosen
hand-held/back-rack placement. It does not infer presence from hand position and
does not estimate mass or forces. MediaPipe-only videos need manual placement.

`review.mjs` integrates squat estimates and bounded feedback with the original
interface. Non-squat tabs use their original diagnostics and neutral muscle
colour. The new display smoothing and contact constraints never affect findings.

`local-mode.mjs` provides bundled browser inference for the original lightweight
preview. `src/local_depth.py` reuses geometric depth/profile route bodies from
`app.py` without requiring ViTPose. The full Flask entry point remains present.

See `ROM.md`, `models/ATTRIBUTION.md` and the root `VALIDATION.md`.

`grip.mjs` adds optional fixed hand contacts on a smoothed bar, with elbow
placement and manual grip calibration/width. Constraints are display-only and
release unreachable targets. The atlas fingers remain static.
