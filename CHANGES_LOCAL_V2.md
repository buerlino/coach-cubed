# Local anatomy revision

No commits, branches, pull requests or pushes were made on GitHub. This copy
continues from the uploaded project and the previous local squat prototype.

## Shared optional anatomy

`src/anatomy/` contains one asset-backed renderer and pose adapter. The original
exercise pages gain a collapsed **anatomy · optional** settings group; its
master switch starts off. Mesh files are loaded only when enabled. The same
overlay follows the original video clock on snatch, lateral raise and clean &
jerk pages. It can appear in its own rotatable panel or directly on the video.
The existing diagnostics, ViTPose output, depth algorithms and 3D viewer are
retained. Source integration is limited to a static route, a module include,
and track/playback/reset hooks. The previous top-of-page squat banner is gone.

## What changed in the model

The procedural skeleton and muscle envelopes were removed. The replacement
contains 337 named BodyParts3D anatomical surfaces. Each side's shoulder,
elbow, wrist, hip, knee and ankle drives its corresponding anatomy. There is
no fixed barbell, racked-arm pose or squat forward-kinematics function.

Eight named control markers show the two tracked hips plus pelvis centre,
sacrum/L5–S1, lumbar/L3, thoracolumbar/T12, thoracic/T6 and C7. Regional rig
segments articulate the atlas spine through those points. Amber points are
inferred, blue points manually corrected, green hips tracked. The model
contains actual vertebral surfaces, but individual vertebral motion is not
measured. A manual video click supplies two coordinates, not depth.

Mark points on paused frames and export them to keep corrections. They apply
within 0.12 s of their keyframe, and are not propagated through an entire clip
as if tracked. They can be reset near the playhead. The full exercise view's
point files are tied to a content fingerprint of their pose track; squat
session exports include the points and fitting settings.

## Activation and fitting

Squat activation colours keep their previous meaning: uncalibrated estimates
of relative activation, never weakness or measured EMG. Lifter feedback does
not alter them. Other exercises animate the same anatomy with a neutral muscle
colour, because their activation and failure rules are not implemented here.

The squat view adds optional constant-length arm/leg fitting, with adjustable
soft knee/elbow flexion priors. It only accepts estimated 3D world landmarks;
2D tracks explicitly abstain. See `src/anatomy/ROM.md` for medical references,
definitions and the distinction between reference ranges and chosen priors.

## Limits worth reviewing locally

The source anatomy is a static adult male atlas. Regional skinning, reference
joint centres, scapular motion, soft-tissue deformation and body scaling are
approximate and need review. Missing landmarks hide affected geometry. A flat
track receives a clearly identified display-depth prior to separate limbs;
which side is nearer remains ambiguous. The demo starts standing at time zero.
Neither detailed lumbar motion nor true muscle recruitment is recovered from
ordinary video by adding more control markers.
