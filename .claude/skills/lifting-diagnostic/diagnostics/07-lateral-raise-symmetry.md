# 7 — Lateral raise: rep-to-rep symmetry

## Description of the diagnostic

**Cue.** Every rep in the set reaches about the same height as the first —
height dropping as the set goes on is fatigue, not a one-off.

**Scalar.** The same per-rep top-height reading `lateral-raise-top-height`
makes (shoulder minus wrist elevation at each rep's peak, as % of torso
length). The formula is written out again here, not shared: a change to one
has to be made in the other, or the two drift apart on what "this rep's
height" means. Scored across reps instead of
against shoulder height: **decline** = first rep's value minus the last rep's,
in percentage points. Negative decline means the last rep was actually higher
— not a fault, and the diagnostic says so.

**Efficiency measure.** Provisional bands on decline: **≤ 8pp good, ≤ 18pp
warning, > 18pp critical**, full red at 35pp.

## Active phase definition

The same rep list every lateral-raise diagnostic shares. Needs **at least two
reps** — a single-rep clip has nothing to compare and is not scored, with a
message saying so rather than a degenerate zero-decline "pass".

*Fallback:* no reps at all, every candidate too short, or only one rep found,
each flagged with its own message.

## Visualization and transparency

**Plot**: one point per rep (same series shape as top-height), dashed
reference line at the first rep's own value — the target is the set's own
start, not an external anatomical value.

**Stat tiles**: decline (carries the ramp), first rep, last rep, L/R
disagreement.

**Overlay**: both shoulder→wrist segments in the ramp colour, same as
top-height's.

**Transparency**: a per-rep breakdown identical in format to top-height's, the
decline computation spelled out, the axis note, and a caveat that with only a
few reps one noisy rep can dominate the first/last comparison.
