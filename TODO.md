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
   The same pass should extend `report.tex` §"Choosing by balance", which now
   describes only half of how a sign gets picked — the start-position gate from
   item 2 is written up in `report/depth-math.md` §4b but not in the report.

2. **Deterministic sign chooser before optimization.** *(done — see
   `start_pose_gate`)* Pick the toward/away configuration from joint angles at
   the start position rather than letting a global cost search, or the limb
   optimiser's own argmin, choose it. Snatch and clean & jerk only: they are the
   lifts with a floor start, where the athlete is still and the hips, knees and
   elbows are at angles a body can actually hold.

3. **Optimise across frames.** Limb length is constant, so one frame is the
   wrong unit. There are other frames where something is known for certain —
   the start position, the catch, the overhead hold — and summing the objective
   over them would stop a single unlucky frame (the current frame 0) from
   setting all four ratios. Frame *selection* matters as much as the sum: the
   measured per-term scan showed the terms point within 0.01-0.03 of the truth
   on a good frame and 0.15-0.18 off on a bad one.

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
