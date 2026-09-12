# 3 — Lateral raise: top-of-rep height

## Description of the diagnostic

**Cue.** At the top of each rep the arms lift to about shoulder height — not
swung above it, not stopped short.

**Scalar.** Shoulder minus wrist elevation, per side, as a percentage of torso
length, read at each rep's own peak:

```
value = 100 * (elev(shoulder) - elev(wrist)) / torsoScale
```

0% = wrist exactly at shoulder height; positive = above; negative = below.
Left and right sides are two independent estimates from disjoint keypoints,
averaged for the reported value, with their absolute difference as the
uncertainty band — same contract as every snatch diagnostic.

**Efficiency measure.** The worst rep (largest absolute deviation from 0%) is
the headline; the mean across reps is reported alongside it. Provisional
bands on the worst rep: **≤ 15% good, ≤ 30% warning, > 30% critical**, full red
at 45%. Eyeballed against the two bundled cable examples, nothing more.

## Active phase definition

Not one window — every rep in the clip, from the shared **lateral-raise rep
trigger** (`lateralRaiseReps` in `diagnostics.js`), the lateral-raise analogue
of the snatch's `barKneeCrossing`. It turns the combined shoulder→wrist
elevation signal (smoothed over ~0.3s, never frame-to-frame) into a list of
reps: a rep starts after rising `REP_RISE_MIN` (0.3 torso-lengths) from its
local bottom and holding for 3 samples; its top is the highest point before the
signal descends `REP_RELEASE_DROP` (0.3 torso-lengths) from that rep's own peak.
The lowest point reached before the next ascent becomes the boundary shared by
the two reps, so continuous sets need not return to the initial resting height.
A rep candidate shorter than `MIN_REP_SECONDS` (~0.6s) is dropped as more
likely pose noise than a real rep, and the drop is reported in the transparency
block rather than silently changing the rep count.

*Fallback:* no shoulder/wrist signal at all → not scored, says so. Every rep
candidate too short → not scored, says so. First/last rep's resting bottom
falls outside the clip → that rep's boundary is clamped to the clip's own
edge, flagged in the notes.

## Visualization and transparency

**Plot**: one point per rep, active phase shaded, dashed reference line at 0%
(shoulder height).

**Stat tiles**: worst rep (carries the ramp), mean top height, reps scored,
L/R disagreement.

**Overlay**: both shoulder→wrist segments in the ramp colour (the measurement
is also its own readout), plus a dashed purple rule at shoulder height,
labelled — the target the top is judged against, not a score itself.

**Transparency** lists which frames each rep spans, a per-rep breakdown
(`rep 1: +8%, rep 2: -3%, …`) so fatigue or inconsistency is visible without
opening the raw data, the axis note, the time-smoothing state, and the usual
caveat that the good/warning bands are provisional.
