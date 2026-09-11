# 4 — Lateral raise: torso lean

## Description of the diagnostic

**Cue.** The trunk stays upright throughout the set: the weight is raised by
the arms, not by leaning or swinging the torso to sling it up.

**Scalar.** Same `trunkAngle` the snatch's first-pull diagnostic uses — the
hip→shoulder segment's angle to the bar axis, 90° = upright — measured per
side, every sampled frame across the whole set (not just at each rep's peak,
since a lean introduced mid-rep and corrected before the top would otherwise
go unseen).

**Efficiency measure.** Constancy, scored the same way as the snatch's
back-angle diagnostic: **SD** of the angle over the whole set is the headline
(overall sway), **range** is reported alongside it. Provisional bands on SD:
**≤ 3° good, ≤ 7° warning, > 7° critical**, full red at 15°.

## Active phase definition

The same rep span `lateral-raise-top-height` uses (see that note for the rep
trigger), but the whole span is scored continuously rather than only at each
rep's peak.

*Fallback:* same as the top-height diagnostic — no signal, every rep candidate
too short, or a clamped first/last boundary, each flagged the same way.

## Visualization and transparency

**Plot**: trunk angle over the whole set, dashed mean reference line
(constancy relative to the lifter's own posture, not a fixed target).

**Stat tiles**: trunk stability (SD, carries the ramp), peak sway (range),
mean trunk angle, L/R disagreement.

**Overlay**: both hip→shoulder segments in the ramp colour, the measurement
and its own readout at once.

**Transparency**: frames spanned, per-frame confidence coverage, the axis
note, time-smoothing state, and the provisional-bands caveat.
