# 6 — Lateral raise: tempo

## Description of the diagnostic

**Cue.** The weight is lowered under control — the descent isn't noticeably
faster than the raise.

**Scalar.** Per rep, per side: wrist vertical speed from the rep's bottom to
its peak (ascent) and from the peak back to the bottom (descent), each in
torso-lengths/second. The rep's value is the ratio descent÷ascent, averaged
across the sides that could be measured — two independent estimates of the
same rep's tempo, same contract as every other diagnostic here, rather than
one estimate from the wrist centroid.

A ratio near 1 means the lift and the lowering took about the same time; well
above 1 means the descent was much faster — dropped rather than lowered.

**Efficiency measure.** The worst (highest) ratio across reps is the headline.
Provisional bands: **≤ 1.5x good, ≤ 2.5x warning, > 2.5x critical**, full red
at 4x.

## Active phase definition

Reuses the same rep list as the other lateral-raise diagnostics, but only reps
with **both** a bottom before and a bottom after their peak are usable — a rep
whose start or end falls outside the clip has no full ascent or descent to
time, and is excluded with a note rather than scored on a partial window.

*Fallback:* no reps at all, every candidate too short, or no rep with both
boundaries present, each flagged with its own message.

## Visualization and transparency

**Overlay is not a pose track here** — it's a static dashed path per rep
(bottom → peak → bottom) in the ramp colour, since the measurement is a
rep-level ascent/descent shape rather than a per-frame position.

**Stat tiles**: descent vs ascent (worst ratio, carries the ramp), mean ratio,
reps scored, L/R disagreement (in ratio units).

**Transparency**: how many reps were found vs. scored, the per-rep
ascent/descent measurement described, and a caveat that an extreme ratio can
also mean a rep's ascent or descent was too short to time reliably at the
current frame stride, not necessarily a real tempo fault.
