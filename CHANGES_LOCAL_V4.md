# Revision 4

This replaces revision 3's presentation-only integration with two real pages.
The teal page in the reported screenshot now contains Squat, Lateral Raise,
Snatch and Clean & Jerk tabs. `src/squat/original-tools.mjs` mounts the original
`Diagnostics` engine and connects the original geometric depth/profile/optimizer
API. The original page retains its tools and adds the shared anatomy and squat
review. Both packages contain both pages; their default route and port differ.

The default anatomy display is one video with an overlaid transparent canvas.
The secondary model stage is hidden in this mode; comparison is explicitly
optional. Controls remain visible beside the combined video. The original
wireframe preview is collapsed by default. The new build has a visible revision
label, ports 8774/8775, and distinct extracted folder names.

## Stability and continuity

- Confidence-weighted temporal smoothing and isolated-spike rejection run only
  on display coordinates. Actual detector data remains the diagnostic input.
- Default depth is conservative: clip-level torso separation and restrained limb
  depth reduce flips/scale breathing. The full backend depth remains selectable.
- Stationary ankle runs establish temporary foot contacts. Velocity and displacement
  thresholds release contacts for steps or foot motion; the feature is toggleable.
  This is image/depth stability, not a calibrated floor or force-plate estimate.
- Partial occlusion retains parent-relative limb estimates. Whole-frame dropout
  holds a completed display pose and marks it estimated. Missing joints no longer
  hide atlas surfaces; degenerate segments retain nonzero geometry.
- Materials use opaque depth-tested surfaces; the completed canvas supplies the
  adjustable overlay opacity. This removes transparent-surface sorting flicker.
- Toe orientation uses a clip-level estimate for COCO tracks without foot points.
- Barbell display supports actual equipment boxes where supplied, manual hand-held
  placement and manual upper-back placement. Plates are optional and visual only.

The BodyParts3D atlas remains unchanged: 337 source surfaces / 1,324,762 triangles.
Regional skinning, forearm rotation and soft tissue deformation remain approximate.
The original `depth_backend.py`, `diagnostics.js`, and original Three.js module are
byte-identical to the supplied newer project ZIP. Original diagnostic golden files
were not changed. No remote repository changes were made.
