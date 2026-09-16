# 1 — First pull: constant back angle

## Description of the diagnostic

**Cue.** Through the first pull, the back angle to the floor stays constant.
The legs open the knees and the bar rises, but the trunk keeps its inclination
— it does not "rise early". A lifter whose shoulders come up faster than the
bar arrives at the knee with the bar out front and the pull already lost.

**Scalar.** Trunk inclination is the angle between the hip→shoulder segment and
the floor, in the image plane:

```
angle = atan2(hip.y - shoulder.y, |shoulder.x - hip.x|)     # y grows downward
```

0° is a horizontal trunk, 90° vertical. `|dx|` makes it independent of which
way the lifter faces, so left-facing and right-facing videos score alike.

Measured once per side — left hip→left shoulder and right hip→right shoulder —
giving **two independent estimates from disjoint keypoints**. Their mean is the
reported angle; their absolute difference is the uncertainty (see below).

**Efficiency measure.** Constancy, reported three ways because they fail
differently:

| Quantity | What it catches |
| --- | --- |
| **SD** of the angle over the phase (headline) | overall wobble, robust to endpoints |
| **Range** (max − min) | a single sharp break |
| **Drift** (last − first) | the actual fault — a monotone rise of the chest |

SD is the headline because the endpoints of the phase are the least reliable
samples (motion onset is a soft trigger; the knee crossing is one frame).
Drift is the number that matches the cue most literally, so it is reported
beside it.

Provisional bands on SD: **≤ 2.5° good, ≤ 5° warning, > 5° critical.** Eyeballed
against what a visibly early chest rise produces on test video, nothing more.
Re-fit these.

## Active phase definition

The first pull: floor to bar-past-knee.

**Start — the wrists begin to rise.** The bar leaving the floor is the hands
going up, and nothing else in the setup is. The signal is the **signed vertical
speed of the wrist centroid** (mean of the confident wrists) along the bar
axis's own up, normalized by median torso length; the start is the first frame
of the run of samples at or above **0.1 torso-lengths/s upward** that leads
into the end trigger.

Found by walking *backwards* from the bar/knee crossing through that run,
rather than forwards from frame 0. The run ends at **3 consecutive samples**
that are not rising, and the start is the sample after that block — persistence
in both directions, so one noisy sample inside the pull does not cut the run
short and one noisy sample in the setup does not extend it. Forwards from
frame 0 finds the setup: grip adjustments, the hook re-set, the lifter rocking
into position all clear a motion threshold before the pull starts.

Requiring the motion to be *upward* — rather than the earlier "last stillness
before the pull", a threshold on speed magnitude — is what makes this hold on
a lifter who never goes still. Rolling the bar into the shins is sideways
motion and never joins the run; a re-grip drops the hands before it lifts them,
so the drop breaks the run; a slow, quiet first inch off the floor is still a
rise. The magnitude version had no answer for the first of those (it clamped
to frame 0 or landed on whatever earlier stillness it found) and could put the
start inside a slow pull for the last.

The speed is measured on a smoothed centroid (window fixed at 0.3 s, so nine
samples at 30 fps stride 1), differenced over about a quarter of that window
either side — **not** frame to frame. This is the detail the trigger lives or
dies on: ±3px of pose jitter over a 1/30s step is ~0.5 torso-lengths/s,
several times the threshold, so a one-frame difference reports a motionless
lifter as moving and the phase start collapses on every real video. On the
wider baseline the signed vertical component of that jitter sits around
0.02–0.05 while an actual pull runs 1–2. Verified on synthetic tracks
(`tests/diagnostics.test.js`): a busy setup with a re-grip and a continuous
roll-in right up to lift-off, at ±0, ±3 and ±5px of jitter, and a still lifter
at up to ±8px over 60 seeded runs, none of which started the phase before the
scripted lift-off. On the athlete-b clean fixture the rise reads 0.01–0.07 through
the set position and crosses 0.1 two frames into the pull.

The cost is that the smoothing spreads the pull's motion backwards, so onset is
detected ~3 samples early — the phase picks up the last ~0.1s of the setup.
Harmless here (the bar is still on the floor and the trunk angle is already
static) and the safer direction to err: late onset would cut off the part of
the pull the cue is about.

*Fallbacks:* the run reaches the first sample that has a speed at all (video
starts mid-lift) → clamp to the first sample; the run reaches a stretch where
both wrists were lost for longer than the gap fill → start where they
reappear. Both are flagged in the transparency block, with which of the two it
was.

The transparency block reports the rise speed at the start frame and the
fastest the wrists rose in the three samples before it, so the margin the
boundary was set on is visible.

**End — the bar crosses the knee.** ViTPose has no bar keypoint, so the bar is
approximated per side from the wrist:

```
bar.y = wrist.y + |elbow − wrist| / 6
```

The hand wraps the bar, so the bar centre sits below the wrist joint centre by
roughly a sixth of the forearm length. Taken as a vertical offset in elevation,
per the cue's own phrasing; along the forearm direction would be marginally
more accurate but is more fragile when the elbow drops below confidence, and
the difference is under a pixel or two at the crossing, where the forearm is
near vertical. Both sides are averaged when available.

*Fallback:* elbow below confidence → offset 0, i.e. the wrist itself, flagged.

Knee height is the mean of the confident knee keypoints. The phase ends at the
first sample where `bar.y < knee.y` (bar above knee), scanning forward from the
first sample where the bar was *below* the knee — so a video that opens with
the bar already overhead doesn't end the phase at sample 0.

*Fallback:* no crossing found → the diagnostic does not run, and reports that
the bar never passed knee height rather than scoring a partial phase.

## Visualization and transparency

**Plot**, below the video, sharing its time axis and click-to-seek:

- Trunk angle over time, drawn only inside the active phase.
- Band between the left-side and right-side estimates — the uncertainty.
- Dashed horizontal mean, direct-labeled.
- Active phase shaded; the rest of the video's duration stays visible as
  context so the phase's position in the lift is legible.

**Stat tiles**: constancy (SD) with its verdict, drift (in the ramp colour, the
only legend the ramp gets), and mean angle.

**Overlay**, on the video, only while the playhead is inside the phase, drawn
at the playhead's own time rather than at the nearest sampled frame so it
tracks the interpolated mesh underneath it:

- Both hip→shoulder segments — the measurement itself — in the score colour,
  behind a short fading trail of the previous few processed frames. A chest
  that rises leaves a spreading fan; one that holds leaves a tight bundle.
- The end trigger's geometry in purple, spanning the frame **parallel to the bar
  axis**: the knee height at half strength, the bar estimate (wrist + 1/6
  forearm) as a solid rule, and the bare wrist it was corrected from as a dashed
  one, so the size of that correction is visible rather than taken on trust.
  Weight, not hue, separates the measurement from its reference — they are all
  the same role.

The angle is measured to the bar axis rather than to the image's bottom edge,
and the bar/knee crossing compares heights along it — so camera roll shifts
neither the number nor the marks that explain it. The forearm correction is
applied along that axis's own "down" for the same reason. See "The bar axis" in
the skill; note that this diagnostic's start trigger is what locates the frame
the axis is read from, via the shared `firstPullWindow` — shared with the clean's
first pull too, see [08-clean-first-pull-back-angle.md](08-clean-first-pull-back-angle.md).

**Transparency block** reports: the phase's frame range and duration; the wrist
rise at onset (and just before it) and the bar–knee gap at the crossing; samples measured; the
fraction interpolated across dropped detections; the fraction with both sides
visible; the mean left–right disagreement; and the bar axis — its tilt, which
joint pairs and which frame set it, how well they agreed, and which were dropped
as outliers.

### Reading the uncertainty

The left–right difference is a genuine independent check — the two estimates
share no keypoints. But it conflates two things:

- **Pose noise**, which is what you want it to mean.
- **Real out-of-plane rotation.** Filmed from the side, the near hip and
  shoulder project differently from the far ones, so a lifter genuinely twisted
  on the bar shows a persistent, non-zero difference that is signal, not error.

A large *steady* difference means the camera isn't square to the lifter or the
lifter is twisted; a large *jittery* difference means the pose track is
unreliable. The plot distinguishes them by showing the band over time rather
than a single ± number.

## Known limitations

- Requires a side-on camera. Front-on video makes `|dx|` collapse and the angle
  saturates near 90° regardless of technique. Camera *roll* is corrected for via
  the bar axis; when that can't be estimated the angle carries the roll as a
  constant offset — harmless to the SD and the drift, which are what the cue is
  actually about, but visible in the mean.
- The bar estimate assumes the hands are *on* a bar. It reports nonsense for
  dumbbell or unloaded movement, and nothing detects that.
- Pixel-plane only: a lifter moving toward or away from the camera during the
  pull changes the projection. Torso-length normalization handles the speed
  trigger, not the angle.
