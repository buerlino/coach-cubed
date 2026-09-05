# 2 — Second pull: full triple extension

## Description of the diagnostic

**Cue.** At the top of the second pull, the hips and knees open fully —
"triple extension" — before the arms bend into the turnover. A lifter who
starts pulling with the arms before the legs and hips finish extending has
cut the pull short and traded leg drive for arm strength, which is weaker and
less consistent.

**Scalar.** Two joint angles, each the interior angle at the joint (180° =
the two segments meeting there are collinear, i.e. that joint is fully
extended — this needs no reference axis, unlike diagnostic 1's angle-to-floor):

```
hipAngle  = angle at hip  between hip->shoulder and hip->knee
kneeAngle = angle at knee between knee->hip and knee->ankle
```

Each is measured once per side (hip: shoulder–hip–knee; knee: hip–knee–ankle),
giving two independent estimates from disjoint keypoints for the hip angle,
same contract as diagnostic 1. The knee angle is tracked alongside it as the
second of the three joints the cue names.

**"Triple" is really "double" here.** COCO-17 (what `vitpose_backend.infer_video`
produces) has no foot or toe keypoint, so ankle extension — rising onto the
toes — cannot be measured from the pose track at all. This is stated in the
diagnostic's own notes every time it runs, not just in this doc, because it's
the kind of limitation that's easy to forget once the plot looks complete.

**Efficiency measure.** Reported two ways because they catch different faults:

| Quantity | What it catches |
| --- | --- |
| **Extension deficit** (180° − angle at peak, hip and knee) | the pull stopping short of full extension |
| **Synchrony** (time gap between the hip's and the knee's own peak within the phase) | the joints extending in sequence rather than together — the literal meaning of "triple" |

A lifter can score well on deficit (both joints eventually reach near 180°)
while scoring badly on synchrony (one reaches it well before the other,
meaning at no single instant are they both extended) — the two numbers catch
different failures of the same cue.

Provisional bands on the worse of the two deficits: **≤ 10° good, ≤ 20°
warning, > 20° critical.** Eyeballed, nothing more. Re-fit these.

## Active phase definition

The second pull: bar-past-knee to peak hip extension.

**Start — the bar crosses the knee.** This is the exact same event that ends
the first pull (see
[01-first-pull-back-angle.md](01-first-pull-back-angle.md)), so both
diagnostics call the same shared function (`barKneeCrossing` in
`diagnostics.js`) rather than each re-deriving the crossing. If the two ever
disagreed about where the first pull ends and the second begins, that would
be a bug, not a modeling choice — hence the shared code.

**End — peak hip elevation.** The mean of the (smoothed) left and right hip
`y` reaching its minimum (highest point in image coordinates, since y grows
downward) after the start trigger.

This is a *soft* trigger — a smoothed extremum, not a crisp crossing like the
first pull's — so it needs the same persistence discipline the skill asks for
everywhere else, just applied to confirming a peak instead of a threshold
crossing: the elevation must give back at least **0.08 torso-lengths** from
its running minimum and stay given back for **3 consecutive samples** before
that minimum is accepted as the peak. Without this, the first noisy upward
jitter right after the true peak — or even a jitter *before* it — would end
the phase early. The elevation signal itself is smoothed first, for the same
reason the wrist-speed trigger is: raw per-frame position jitter is larger than
a single frame of real motion at 30fps.

That smoothing window is fixed in **time (0.3s)**, not in samples. It began as
the same 9-sample mean the wrist speed uses — which *is* 0.3s at 30fps and
stride 1, but spans 27 frames at stride 3, flattening the very peak it is used
to find. On a synthetic pull whose hips peak at frame 70, the sample-based
window ended the phase at frame 72/76/81 for stride 1/2/3; time-based it is
frame 72 at all three. The wrist-speed trigger still uses a sample-based window
and has the same latent stride sensitivity, less visibly.

Verified stable (±1 frame across 12 seeded noise draws of ±2px) against
synthetic tracks built the same way the wrist-speed trigger describes
verifying itself.

*Fallback:* no confirmed descent before the clip ends (it may genuinely end
at or near peak extension) → use the highest point found so far, flagged in
the transparency block as unconfirmed rather than presented as a settled
peak.

*Fallback:* the hip is never confidently tracked after the crossing → the
diagnostic does not run, and says so.

## Visualization and transparency

**Plot**, below the video, sharing its time axis and click-to-seek — its own
section, stacked under diagnostic 1's, per the shared multi-diagnostic
renderer (each diagnostic always gets its own plot; the tickbox above the
video only gates that diagnostic's overlay, not whether it's shown here):

- Hip angle over time (the headline series), drawn only inside the active
  phase.
- Band between the left-side and right-side hip-angle estimates — the
  uncertainty, same convention as diagnostic 1.
- Dashed reference line at **180° exactly** — not the phase's own mean. The
  cue here is distance from a fixed anatomical target, unlike diagnostic 1
  where the cue is internal constancy, so the two diagnostics' reference
  lines mean different things and each supplies its own.
- Active phase shaded; the rest of the clip's duration stays visible as
  context.

**Stat tiles**: hip extension deficit with its verdict, knee extension
deficit, synchrony gap (with which joint led), and left/right disagreement.

**Overlay**, on the video, only while the playhead is inside the phase, drawn
at the playhead's own time: the full shoulder–hip–knee–ankle chain on each side
in the score colour (both joint angles being scored are visible on the frame as
the segments that form them, and the chain that carries the measurement carries
its reading too), plus a labeled full-width dashed rule in purple at the peak
hip height the end trigger found — the same role as diagnostic 1's knee/bar
rules, sized for a signal whose geometry spans the whole frame rather than a
hand's-width region.

That rule is drawn **parallel to the bar axis**, not horizontal — a height is
only horizontal if the camera was level, and drawn flat on a rolled clip the
line visibly disagrees with the bar and the plates it is meant to be a height
above. Peak hip elevation is measured along the same axis, so the mark and the
trigger are the same number. See "The bar axis" in the skill.

It sits at the hip **as measured** at the frame the trigger chose, not at the
smoothed signal's value there. The smoothing exists to pick the frame without a
noisy sample stealing it; its value at that frame is a mean over the window
either side, which sits below the hip by however far the hip travelled during it.
A rule labelled "peak hip height" drawn below the hips is simply wrong.

**Score** (what the ramp shows): the worse of the hip and knee deficits, full
red at 45° short of straight. Deliberately the worse of the two rather than the
headline hip number — "triple extension" is not met by opening the hip alone,
so the colour can read redder than the hip tile when it is the knees that
stayed bent. Provisional, like every threshold here.

**Transparency block** reports: the phase's frame range and duration; that
the start trigger is shared with diagnostic 1; whether the end trigger's peak
was confirmed by a descent or is the best point found so far; samples
measured; the fraction with both hip-side estimates and the fraction
interpolated; and that the reported deficit is a 3-sample tail mean, not one
raw sample, because the phase end itself already comes from a smoothed
signal.

### Reading the uncertainty

Same shape as diagnostic 1: the left–right hip-angle difference is a genuine
independent check (disjoint keypoints), but conflates pose noise with real
out-of-plane rotation from a camera that isn't square to the lifter. A large
*steady* difference is the camera or a twisted bar path; a large *jittery*
one is an unreliable pose track.

## Known limitations

- Ankle extension is not measured at all — no foot/toe keypoint in COCO-17.
  "Triple extension" is scored as two joints. A lifter who gets excellent
  hip/knee extension but never rises onto their toes will still read as
  fully extended here.
- Requires a side-on camera, same as diagnostic 1, and for the same reason:
  both joint angles are computed from 2-D image-plane coordinates. Camera
  *roll* is handled — heights and rules use the bar axis — but out-of-plane
  rotation still is not.
- The peak-elevation end trigger assumes the hips are genuinely at their
  highest point at peak extension (true for a well-executed pull) — a lift
  where the hips keep rising after the legs and hips have extended (e.g. the
  lifter jumping upward as a separate action) would push the end trigger
  later than the joint angles themselves suggest, which the synchrony number
  would likely also flag as a large gap.
- Shares the first pull's bar approximation only insofar as it reuses the
  crossing event; the second pull's own measurement (joint angles) does not
  depend on the bar estimate at all, so an unreliable elbow/forearm reading
  does not degrade this diagnostic's core numbers the way it can degrade
  diagnostic 1's phase end.
