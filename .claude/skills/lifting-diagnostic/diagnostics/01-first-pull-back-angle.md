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

**Start — the hands begin to move.** Wrist centroid speed (mean of the
confident wrists), normalized by median torso length, exceeding
**0.15 torso-lengths/s for 3 consecutive samples**.

Found by walking *backwards* from the end trigger for the last sample where
the wrists were quiet for 3 consecutive samples, rather than forwards from
frame 0. Forwards finds the setup: grip adjustments, the hook re-set, the
lifter rocking into position all clear a motion threshold before the pull
starts. Backwards from a crisp geometric anchor finds the real onset.

The speed itself is measured on a 9-sample mean of the centroid, differenced
over ±2 samples — **not** frame to frame. This is the detail the trigger lives
or dies on: ±3px of pose jitter over a 1/30s step is ~0.5 torso-lengths/s,
several times the threshold, so a one-frame difference reports a motionless
lifter as moving and the phase start collapses to frame 0 on every real video.
On the wider baseline that same jitter lands near 0.07 while an actual pull
runs ~2. Verified stable at ±1.5px, ±3px and ±5px of synthetic jitter.

The cost is that the smoothing spreads the pull's motion ~5 samples backwards,
so onset is detected slightly early — the phase picks up the last ~0.15s of the
setup. Harmless here (the bar is still on the floor and the trunk angle is
already static) and the safer direction to err: late onset would cut off the
part of the pull the cue is about.

*Fallback:* no quiet window before the crossing (video starts mid-lift) → clamp
to the first sample, flagged in the transparency block.

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

**Stat tiles**: constancy (SD) with its verdict, drift, and mean angle.

**Overlay**, on the video, only while the playhead is inside the phase: both
hip→shoulder segments in the series color, the estimated bar point as a hollow
marker, and a horizontal knee reference line — so the two triggers and the
measured segments are all visible on the frame itself.

**Transparency block** reports: the phase's frame range and duration; the wrist
speed at onset and the bar–knee gap at the crossing; samples measured; the
fraction interpolated across dropped detections; the fraction with both sides
visible; and the mean left–right disagreement.

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
  saturates near 90° regardless of technique.
- The bar estimate assumes the hands are *on* a bar. It reports nonsense for
  dumbbell or unloaded movement, and nothing detects that.
- Pixel-plane only: a lifter moving toward or away from the camera during the
  pull changes the projection. Torso-length normalization handles the speed
  trigger, not the angle.
