# Movement lab: squat method and limitations

**Version 5:** anatomy now uses actual BodyParts3D surfaces and the shared
`src/anatomy/` rig. New points are pelvis, sacrum/L5–S1, L3, T12, T6 and C7;
they are inferred unless manually marked. Each tracked limb drives its own
geometry, including arms and frontal views. Optional limb fitting is separate
from the squat measurements and never changes the evidence or activation rules.
See [joint-range fitting](../anatomy/ROM.md)
and [asset provenance](../anatomy/models/ATTRIBUTION.md).


## Scope

This page also mounts the original lateral-raise, snatch and clean-and-jerk
diagnostics, profiles and geometric 3D optimizer. The squat rules below apply
only to the Squat tab. The anatomy overlay is available on every exercise.

The squat prototype supports single-person, fixed-camera, side or near-side
squat recordings. It uses the bundled MediaPipe Pose full model to track 33
landmarks at a user-selected sample rate. The displayed anatomy is generic,
driven by separate landmarks on each side. World landmarks are
retained in exported data but are not used to imply calibrated 3D dynamics.

## Motion processing

The visible side is selected once per session from mean landmark visibility,
or manually. The minimum confidence for shoulder, hip, knee and ankle is 0.55.
All x coordinates are corrected for the source width/height ratio before angle
measurement. A short local median filter does not interpolate through missing
frames or across gaps longer than 250 ms.

Knee flexion is 180 degrees minus the hip–knee–ankle angle; hip flexion is
similarly defined at the hip. Torso inclination is the shoulder–hip line
relative to the image vertical, not a measurement of spinal flexion. Shin
inclination is measured relative to image vertical. These are projected angles,
not calibrated joint rotations.

A provisional state machine identifies descent, deepest position, ascent and
return to standing. An incomplete cycle is not labelled a failed lift: a clipped
recording, intentional stop or pause can look similar. Long tracking gaps break
cycles. Thresholds are provisional and explicitly collected in `analysis.mjs`.

Hypotheses require at least 70% usable frames over the clip, 80% within the rep,
no interrupted tracking in that rep, and a side or near-side view. Camera view
is user-specified rather than inferred reliably by the detector. Oblique views
carry additional projection error. Frontal/rear clips are excluded from the
sagittal analysis and activation display.

## Activation colouring

The implementation returns an uncalibrated relative index for quadriceps,
gluteals, adductors, hamstrings, calves, spinal extensors and abdominal bracing.
It combines normalised knee/hip/shin/trunk angles and movement phase. A holding
component prevents a static deep squat from being displayed as inactive.
Ascent, descent, holding and standing have different provisional multipliers.

These are handwritten heuristic estimates, not a trained EMG predictor,
inverse dynamics, muscle-force optimisation or a validated physiological scale.
The numbers are used for shading and qualitative low/moderate/high labels;
the app never presents them as percentages of maximum voluntary activation.
Absolute loading, maximal strength, tendon properties, co-contraction, fatigue
and individual muscle recruitment are not calibrated. The app does not detect
barbell mass or derive forces from it.

Colour is not a measure of weakness, injury risk or likelihood of failure.
Self-reported sensation and rep outcome are deliberately absent from the
activation function. Missing/unsuitable data results in unavailable activation.

## Failure-related review

This first rule set reports depth-related projected angles, ascent inclination
change, slow/held regions, possible heel displacement, and incomplete cycles.
An increased torso inclination during ascent can support hypotheses about
knee-extensor capacity/ascent strategy or trunk-control demand. Alternative
explanations are shown with each hypothesis. This does not establish a weak
muscle or distinguish hip motion from lumbar flexion.

A slow or incomplete lift by itself does not create a gluteal, adductor or
other muscle-group diagnosis. When the motion does not distinguish a group,
the app says so, even if the lifter names one. This intentionally leaves many
recordings without a specific muscle hypothesis.

Video-based ranking points are internal heuristic ordering aids, not probabilities.
Matching self-report can add **at most six points** to an already-supported
hypothesis. It cannot bypass quality gates, invent a hypothesis or change the
activation estimates. Notes and outcome are stored as user context; they are
not treated as objective ground truth. Accessory work is proposed conditionally
and requires corroboration. Sensation does not establish causation.

## Anatomy and spine

The shared model imports BodyParts3D surfaces with approximate regional
skinning. The pose adapter preserves independent left and right joints; no
exercise-specific squat pose is reconstructed. Missing joints retain estimated
limb positions. Complete tracking gaps hold the last complete display pose,
marked estimated. Display continuity never fills gaps in diagnostic evidence.
Temporal smoothing, isolated-spike rejection and conditional foot contact reduce
display jitter; feet release when they move. Surfaces remain depth-tested, with
transparency applied to the completed canvas.

Spinal points are inferred from hip/shoulder references and atlas proportions,
or corrected on individual frames. They do not constitute newly detected
vertebral landmarks. For image-only tracks, an atlas depth prior separates
otherwise overlapping limbs; near-side orientation remains ambiguous. Default
depth is conservatively blended and can be switched to the full reconstruction.
Display smoothing and foot contact can adjust image positions slightly.
Estimated MediaPipe world landmarks are used when available. Neither source is a calibrated biomechanical measurement.

The master anatomy switch starts off. Fitting fixed limb lengths is optional
and uses only estimated 3D data. It does not change the raw landmarks, camera-
plane squat measurements, activation colours or the hypotheses below.

A visual barbell can use equipment detections included in an original track,
or explicit hand-held / upper-back placement. The approximate axis and optional
plates are display aids and never enter activation or failure analysis. Browser
MediaPipe does not detect barbells; it requires explicit placement.

## Privacy and reproducibility

The standalone server serves the local `src` assets and bundled example
fixtures on 127.0.0.1. User-selected videos
are loaded as browser object URLs, not POSTed to a service. Inference libraries
and weights are bundled. Session exports include timestamps, landmarks,
settings and optional feedback; they exclude the original video. No analytics,
accounts, or external requests are used by this view. Pose coordinates are sent
to the loopback server for geometric reconstruction; athlete profiles can be
saved locally. Video bytes and feedback remain in the browser.

The original Flask app has separate existing endpoints; opening this new view
does not send the selected clip to those endpoints.

## Research references and next validation

- MediaPipe Pose documentation and model behaviour:
  https://chuoling.github.io/mediapipe/solutions/pose.html
- OpenCap's multi-camera musculoskeletal approach and limitations:
  https://journals.plos.org/ploscompbiol/article?id=10.1371/journal.pcbi.1011462
- OpenSim muscle-force estimation assumptions:
  https://opensimconfluence.atlassian.net/wiki/spaces/OpenSim/pages/53085189/Working+with+Static+Optimization
- Squat bar placement, kinematics and muscle activity:
  https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2020.604177/full

These publications motivate distinctions and future development. They do not
validate the specific thresholds, colour equations or failure hypotheses here.
Next steps include anatomical review, squat recordings with independently
annotated events, movement-angle reference measurements, and hold-out testing
on unseen lifters. Muscle-level claims additionally need appropriate EMG,
strength assessments and study design; coach labels alone are not causal ground
truth. Do not infer accuracy from synthetic tests or from visually plausible 3D.

## Display-only grip constraint

A maintained grip can be imposed on the estimated bar. Fixed contact spacing,
bar-relative hand orientation and an elbow solve reduce hand jitter. The user
can calibrate a frame, adjust width, or release the constraint. It does not
recognize re-grips or infer individual finger motion, bar weight, or forces.
These constrained coordinates never enter the movement or activation analysis.
