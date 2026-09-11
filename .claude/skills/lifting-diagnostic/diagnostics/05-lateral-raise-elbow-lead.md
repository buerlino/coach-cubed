# 5 — Lateral raise: elbow lead

## Description of the diagnostic

**Cue.** Through the raise the elbow stays at or slightly above the wrist —
the wrist shouldn't flick up and lead the lift.

**Scalar.** Elbow minus wrist elevation, per side, as a percentage of torso
length:

```
value = 100 * (elev(wrist) - elev(elbow)) / torsoScale
```

Positive = elbow above wrist (expected); negative = wrist above elbow (the
"wrist flip" fault this cue guards against).

**Scope.** Scored only while the arm is actually working, gated on the same
combined shoulder–wrist elevation signal the rep trigger computes
(`REP_BOTTOM_FRAC`): at rest, with the arm hanging, the elbow trivially sits
above the wrist regardless of technique, so those frames are excluded rather
than diluting the score with a trivially-passing baseline.

**Efficiency measure.** The worst (most negative) frame in the working range is
the headline. Provisional bands: **≥ 5% good, ≥ -5% warning, < -5% critical**,
full red at -20%.

## Active phase definition

Same rep span and trigger as `lateral-raise-top-height`; unlike that
diagnostic, this one is scored continuously (every working-range frame), same
shape as the torso-lean diagnostic.

*Fallback:* identical to the other lateral-raise diagnostics — no signal,
every rep too short, or a clamped boundary, each flagged in the notes.

## Visualization and transparency

**Plot**: elbow/wrist margin over the working range, dashed reference line at
0% (elbow level with wrist).

**Stat tiles**: elbow lead margin (worst frame, carries the ramp), mean margin,
frames scored, L/R disagreement.

**Overlay**: both elbow→wrist segments in the ramp colour.

**Transparency**: frames spanned, the fraction of the span excluded as
resting, the axis note, time-smoothing state, and the provisional-bands
caveat.
