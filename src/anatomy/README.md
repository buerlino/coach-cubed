# Shared optional anatomy, version 5

`integration.mjs` adds anatomy to the original workspace at `/`.
`src/squat/app.mjs` is the teal all-exercise workspace at `/squat/`, with the
original diagnostic engine and geometric 3D controls mounted by
`original-tools.mjs`. `ui-config.mjs` used to choose the package's default page;
since step 2.0 of the restructuring nothing reads it, and `/` is always the
original workspace.

## Using it

Open the original workspace with `launchers/run_original.py` or the Movement
Lab with `launchers/run_anatomy.py` (the root README has the setup). The
header links switch between the two pages; export the session first, because
switching pages reloads it. Both pages start with anatomy off.

**Three display buttons**, directly above the video, each of which turns
anatomy on:

- **3D pane + model** composites the model into the 3D reconstruction pane
  ("Inspect original 3D reconstruction", below the video) instead of drawing
  it over the video, as an orbit-able 3D object that doesn't depend on the
  video's size.
- **Model only** hides the video and shows a full-size model with rotation
  and zoom. The clip keeps driving it, and play, pause, speed and scrubbing
  stay available.
- **Side by side** shows the video and the model in two synchronized panels.

**Show anatomy** switches the whole feature off and restores the video.
**Match video camera** returns the model to the recorded viewpoint. Overlay
opacity applies only to 3D pane + model; the model is opaque in the other two
modes.

**Keeping the hands on a bar:**

1. Choose the placement under **Barbell**: **Present · across upper back**
   for a back squat, **Present · held in hands** for a held bar. **Detected
   equipment only** needs equipment boxes in the loaded track, which only
   tracks made before bar detection was parked carry; MediaPipe finds no bar.
2. Leave **Keep hands on bar** on. The display uses a smoothed bar path, a
   fixed grip spacing and an elbow solution to keep the hands attached;
   hidden wrists stay estimated rather than disappearing.
3. If the spacing is wrong, pause on a frame where the lifter grips the bar,
   choose **Set grip from this frame**, then adjust **Grip width**. It is a
   visual estimate (the video foreshortens), not a measured hand separation.
4. Turn **Keep hands on bar** off for a lift with a release, a re-grip or a
   different hand position; the model doesn't recognize a released grip. A
   target out of reach releases its constraint instead of stretching an arm,
   and the status text says so.

Grip constraints change only the displayed model, never the detector's
landmarks, the diagnostic findings, the squat failure hypotheses or the
activation estimates. The atlas fingers don't close into a fist: this steadies
the hand and palm, not the grasp.

## How it works

Hiding the video preserves its clock and transport controls. Both pages share
`sequence.mjs`, `stability.mjs`, `viewer.mjs` and `barbell.mjs`. Video and
anatomy use one playback clock.

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
"Match video camera" mode approximates the recorded framing; orbit mode uses
clip bounds. In the original workspace, "3D pane + model" composites the
model into `app.py`'s own `#v3dcanvasWrap` (the original 3D reconstruction
turntable) rather than pixel-aligning it to the video element — see the
comment above `#wireframe-inspection` in `app.py` and `setOpacity`'s `blend`
flag in `viewer.mjs` for why: locking the model's camera to a specific video's
box broke as soon as a differently-shaped video came through it.
`pose-rig.mjs` provides inferred pelvis/back anchors, manual corrections and an
optional limb-length / soft ROM prior. Vertebral points are not newly detected.

`barbell.mjs` places a visual bar from equipment boxes, or from explicitly chosen
hand-held/back-rack placement. It does not infer presence from hand position and
does not estimate mass or forces. MediaPipe-only videos need manual placement.

`review.mjs` integrates squat estimates and bounded feedback with the original
interface. Non-squat tabs use their original diagnostics and neutral muscle
colour. The new display smoothing and contact constraints never affect findings.

`src/pose/local-mode.mjs` (moved out of this folder in step 2.0) provides bundled
browser inference for the original lightweight preview. `src/local_depth.py` reuses geometric depth/profile route bodies from
`app.py` without requiring ViTPose. The full Flask entry point remains present.

`grip.mjs` implements the hand contacts described above: the smoothed bar,
the elbow placement and the grip calibration.

See `ROM.md` and `models/ATTRIBUTION.md`.
