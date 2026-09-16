# TODO — single-view depth lift

Open work on `src/depth_backend.py`'s 3D reconstruction, roughly in the order it
needs doing. Items 2-5 are all the same underlying problem from different
sides: the lift turns a length prior into depth, and everything it gets wrong
it gets wrong through the sign and the length.

1. **Explain the optimization technique in the report.** `optimize_limbs`
   descends the four limb ratios against five anatomical penalties
   (`HUMANNESS_TERMS`) with numerical gradients, and it is measurably a biased
   estimator — on the one athlete whose lengths are known it converges ~0.07
   torso away from them. Both the method and that bias belong in `report/`.

   It also does not find the minimum of its own objective. On the clean & jerk
   it stalls at 0.320 where 0.109 exists 0.224 torso away; walking the straight
   line between the two shows why — the argmin sign flips at t≈0.2 and the
   objective bumps +0.012 there, so the backtracking line search halves its step
   twelve times, finds every trial uphill and reports "stalled". A single
   steepest-descent direction cannot cross a kink. Two cheap fixes worth
   measuring: restart from a coarse random sweep (4000 draws found the 0.109),
   and evaluate each sign candidate's descent separately rather than taking an
   argmin inside the objective. Relatedly the Jacobian is rank-deficient on the
   snatch — `uarm` has exactly zero gradient, because at the stall the right
   upper arm projects to l/L = 1.52 and the clamp pins dz to 0, leaving the
   parameter inert (singular values 2.54 / 0.62 / 0.057 / 0.00).

   The objective is now a choice (`depth_backend.OBJECTIVES`, picked in the
   limb-lengths bar): `humanness` is all five terms, `mirror` is midplane +
   symmetry only. Dropping `legs` and `hands` removes the kink — `mirror`
   converges on both fixtures and lands on its own global minimum (snatch
   0.0664 vs 0.0653; clean & jerk 0.0723 vs 0.0723, against a stall at 0.320
   for the wide objective). It is *not* more accurate about length: on the
   measured athlete it still settles 0.107 torso off, 0.189 on the shank. So
   the stall and the bias are separate faults and fixing the first does not
   touch the second. The write-up should say both.

   A third objective, `mirror_joint`, makes the same two statements share one
   plane instead of fitting it to the midpoints and then grading the separations
   against whatever came out. That matters because the six midpoints run up the
   body and are nearly collinear (principal spreads 0.35 / 0.24 / 0.03 torso on
   the snatch), so the axis they leave undetermined is exactly the one the
   separations care about — and the separations, which are not collinear, get no
   vote. Adding the two squared residuals gives `n^T (C - D) n` with `C` the
   midpoint covariance and `D` the mean outer product of the separations, so the
   best plane is the smallest eigenvector of `C - D`: closed form, one `eigh`
   per candidate, verified against a 4000-point sweep of the sphere on every
   candidate of both fixtures to machine precision. The jointly fitted normal
   sits ~8 deg off the midpoint-fitted one and the total drops from 0.291 to
   0.202 (snatch) and 0.214 to 0.185 (clean & jerk) at the same lengths. It
   converges to its own global minimum (0.0673 vs 0.0665; 0.0770 vs 0.0768) and
   is *still* 0.109 torso off the measured athlete — so this fixes a
   measurement, not the bias. `orthogonal` has its own 2D floor with a closed
   form of its own (`orthogonal_floor`): the RMS version minimises to the
   length-squared-weighted principal direction of the image separations,
   `2 phi = atan2(sum |u|^2 sin 2 theta, sum |u|^2 cos 2 theta)`, giving 0.039
   on the snatch and 0.034 on the clean & jerk.
   The same pass should extend `report.tex` §"Choosing by balance", which now
   describes only half of how a sign gets picked — the start-position gate from
   item 2 is written up in `report/depth-math.md` §4b but not in the report.

2. **Deterministic sign chooser before optimization.** *(done — see
   `start_pose_gate`)* Pick the toward/away configuration from joint angles at
   the start position rather than letting a global cost search, or the limb
   optimiser's own argmin, choose it. Snatch and clean & jerk only: they are the
   lifts with a floor start, where the athlete is still and the hips, knees and
   elbows are at angles a body can actually hold.

   **Order is forced, and the gate must never be recomputed from optimised
   lengths.** Gating and limb optimisation do not commute — on the clean & jerk
   the two orders end on different signs and lengths 0.19 torso apart. The
   asymmetry that settles it: gate strength is monotone in the length prior
   (survivors 16/256 at 1.0x, 256/256 at 0.8x — no ruling at all), and the
   optimiser shrinks limbs, so optimise-then-gate dissolves the evidence the
   gate runs on. Iterating gate -> optimise on the snatch fixture converges in
   three rounds to exactly that degenerate corner: thigh 0.386, gate 256/256,
   margin 0.000. So the gate is computed once from lengths that did not come
   from the optimiser — the measured profile if there is one, else the per-clip
   estimate — and held. The circularity is real (signs depend on lengths, lengths
   on signs) and only an externally measured length breaks it, which is the
   strongest argument for the per-athlete profiles.

3. **Optimise across frames.** Limb length is constant, so one frame is the
   wrong unit. There are other frames where something is known for certain —
   the start position, the catch, the overhead hold — and summing the objective
   over them would stop a single unlucky frame (the current frame 0) from
   setting all four ratios. Frame *selection* matters as much as the sum: the
   measured per-term scan showed the terms point within 0.01-0.03 of the truth
   on a good frame and 0.15-0.18 off on a bad one.

   **Measured: the objective cannot reach zero, and its minimum is not the
   truth.** Counting exact-zero conditions — 6 midpoints coplanar (3), 6 pairs'
   separations parallel to one normal (12), 6 arm joints coplanar (3), 2 leg
   planes vertical (2) — gives 20 equalities against 4 ratios. Worse, `symmetry`
   has a floor set by the 2D pose alone: zero requires all six left/right
   separations parallel to one normal, so their *image* directions must all
   agree, and no depth assignment changes an image direction. Closed form
   `min_phi (1/6) Σ |u_i| |sin(θ_i − phi)|` — a length-weighted angular median —
   gives 0.031 torso on athlete-a (directions spread 15.4 deg) and 0.027 on athlete-b
   (10.0 deg), and numerically minimising `symmetry` over all 17 depths free
   reproduces exactly those numbers. With every depth free the weighted total
   still floors at 0.081 / 0.058, so the terms also fight each other.

   And on the one athlete whose lengths are known, the objective ranks the truth
   *worst*: athlete-a's measured profile scores 0.720 at frame 0, against 0.466
   for the generic priors and 0.233 at the global minimum, which sits 0.097 torso
   from her real ratios (0.137 on the thigh). The term doing it is `legs` —
   0.265 of that 0.720 — which asks each leg's plane to be vertical while a
   snatch set-up deliberately tracks the knees out over the toes. Summing 20
   frames under one clip-wide sign does not rescue it (mean error 0.113, thigh
   driven onto the box floor), so this is a mis-specified term and not a
   frame-selection problem. Fix the terms before fitting harder.

   Also bound the ratios anatomically. `LIMB_RATIO_RANGE` is `(0.1, 2.0)`, which
   is not a human range, and once item 2's gate stopped the descent from buying
   improvement by changing the depth configuration it bought it by shrinking
   limbs instead — on the snatch fixture the thigh ran to 0.39 torso. A
   per-segment range would cost nothing and rule that out.

4. **Incorporate depth corrections.** Perspective refinement exists
   (`_perspective_refine`, `COACH_PERSP_ITERS`) but is off by default, and the
   orthographic `dz = sqrt(L^2 - l^2)` clamp silently reconstructs a bone as
   `max(L, l)` whenever the prior is too short. Both corrections need to be
   measured against the fixtures and turned on if they pay.

5. **Sign switches mid-clip.** A sign is currently one value per joint for the
   whole clip. A limb that actually crosses the image plane switches, and it can
   only switch at a frame where the bone is parallel to the image plane —
   `P(l) = l`, where the projected length equals the full length and `dz = 0`.
   That gives a detectable switching point, but it needs a picker metric
   evaluated before and after the crossing, and a wrong switch is worse than no
   switch. Requires great care.
