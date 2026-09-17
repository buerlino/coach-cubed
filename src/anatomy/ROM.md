# Joint ranges and constant limb lengths

The idea is useful as a **soft prior** in a pose fit. It does not supply a
unique solution for limb lengths or depth from one camera. Projected angles
also differ from anatomical joint angles when motion leaves the image plane.

## Medical reference versus fitting prior

Soucie et al. measured passive ROM in 674 people, with reference values that
vary by age and sex. These are population averages, not maximum healthy values
or individual injury thresholds. The following are published **mean degrees
for adults aged 20–44**, rounded to one decimal. [CDC reference table](https://archive.cdc.gov/www_cdc_gov/ncbddd/jointrom/index.html),
[original study](https://pubmed.ncbi.nlm.nih.gov/21070485/).

| Motion | Female mean | Male mean | Implemented use |
| --- | ---: | ---: | --- |
| Knee flexion | 141.9° | 137.7° | Editable 160° soft fitting prior |
| Elbow flexion | 150.0° | 144.6° | Editable 160° soft fitting prior |
| Hip flexion | 133.8° | 130.4° | Reference only; pelvic axes insufficient |
| Hip extension | 18.1° | 17.4° | Reference only |
| Shoulder flexion | 172.0° | 168.8° | Reference only; not a shoulder-abduction limit |
| Ankle dorsiflexion | 13.8° | 12.7° | Reference only; measurement protocol matters |
| Ankle plantarflexion | 62.1° | 54.6° | Reference only |

The 160° defaults are deliberately broad **engineering choices**; they are
not values attributed to the paper. A physician can edit them in the squat
view's “Back points & limb fitting” controls. This prototype does not classify
a person as healthy, injured or unsafe from these ranges.

## What the fitting option does

It starts off. When enabled on a MediaPipe world-landmark track, it fits one
upper/lower length pair per arm and leg across at least five usable frames.
Median lengths and an outlier filter initialise a small search. The cost
combines segment-length consistency, reach consistency, and a soft penalty
when reconstructed hinge flexion exceeds the selected prior. Two-bone inverse
kinematics uses those constant lengths in the intermediate world-space pose.
Revision 3 registers the result back to the video using observed image X/Y
and fitted depth, so the final displayed segment lengths are not forced
constant. The option is labelled as a depth prior in the interface.

It preserves the root and observed end direction where feasible. Unreachable
endpoints are moved to the nearest reach, and displacement is retained in the
fit diagnostics. Angles may remain outside a prior; there is no hard clamp.
Raw tracking, video annotations, squat metrics, activation estimates and
failure-review evidence are unchanged by fitting. Switch it off to compare.

COCO17 image-plane tracks and imported 2D tracks are excluded: shortening in
the picture may be foreshortening. The atlas depth prior is purely for display
and is never admitted as measured 3D by the fitter. MediaPipe world landmarks
are themselves model estimates, so this option remains experimental.

## Joint definitions and next anatomical review

Knee/elbow flexion here is `180° − angle(proximal, joint, distal)`. This unsigned
three-point measure cannot distinguish hyperextension from small flexion, or
resolve axial rotation. The current fitter does not enforce hip rotation,
shoulder rotation, ankle inversion, or lumbar/thoracic joint ranges. Adding
those responsibly needs segment coordinate frames, pelvic/scapular references,
joint-specific coupling and suitable calibration. Whole-spine bending should
not be divided mechanically into identical “safe degrees” per vertebra.

A useful next review with the physician is to confirm landmark definitions,
measurement protocol, acceptable uncertainty and individual calibration
ranges, then test against known camera/marker data. These priors cannot by
themselves identify a muscle that caused a failed repetition.
