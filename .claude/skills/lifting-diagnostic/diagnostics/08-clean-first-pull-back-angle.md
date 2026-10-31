# 8 — Clean: first pull, constant back angle

Belongs to the `clean-and-jerk` set. Built by the same factory as the snatch's
diagnostic 1 (`makeFirstPullBackAngle` in `src/diagnostics.js`), with its own
id (`clean-first-pull-back-angle`), title and cue wording. Everything not
stated here is as in
[01-first-pull-back-angle.md](01-first-pull-back-angle.md).

## Description of the diagnostic

**Cue.** Through the clean's first pull the back angle to the floor stays
constant: the knees open and the bar rises, but the trunk keeps its
inclination until the bar passes the knee. Same fault, same consequence as in
the snatch — shoulders rising faster than the bar puts the bar out front and
loses the pull before the second pull starts.

**Scalar.** Trunk inclination (hip→shoulder segment to the bar axis, in the
image plane), two independent estimates from the left and right sides, and the
same three constancy numbers: SD (headline), range, drift (the ramp colour).

## Why sharing with the snatch is justified

The skill forbids borrowing a phase trigger from another lift unless the
event *means the same thing*. Here it does:

- **The event is identical.** The first pull is bar-off-the-floor to
  bar-past-the-knee in both lifts. The bar starts on the floor at the same
  height, the hands are on it, and the knee crossing is the same geometric
  crossing of the same estimated bar point against the same knee centroid.
- **The cue is identical.** "Keep the back angle" is coached the same way for
  both, for the same mechanical reason.
- **The keypoints and the failure modes are identical.** Side-on camera, hip
  and shoulder confidence, wrist snapped to a plate rim — nothing about the
  clean changes which of these bites.

What the narrower grip *does* change is the setup: the hands are closer
together, so the shoulders sit higher over the bar and the trunk starts more
upright — typically ~10° steeper than the same lifter's snatch start. That
shifts the **mean** angle, which this cue does not score, and leaves the
**constancy**, which it does, untouched.

Two objects rather than one so a fixture label, a golden snapshot or a
transparency note can name one lift's cue without implying the other's, and so
the thresholds can diverge later without a refactor.

## Active phase definition

Shared `firstPullWindow`: the wrists' first sustained rise (≥ 0.1
torso-lengths/s upward, walking back from the knee crossing until 3
consecutive non-rising samples) to the bar/knee crossing. See diagnostic 1
for the full derivation, fallbacks and the synthetic checks; the
`tests/diagnostics.test.js` trigger tests run against both sets and assert
they agree on the same track.

On the one clean fixture (athlete-b, 246 kg; local, on Noah's machine), the rise
reads 0.01–0.07 through the set position and crosses the threshold two frames
into the pull; the phase resolves to 17 frames with a mean trunk angle of
52° — more upright than the snatch start, as expected.

## Visualization and transparency

As diagnostic 1: same plot, tiles, overlay and transparency lines. The caveat
line additionally says that the good/warning bands were carried over from the
snatch rather than set on clean footage.

## Thresholds

**≤ 2.5° SD good, ≤ 5° warning** — copied from the snatch, not fitted to any
clean footage. Provisional, and labelled as such in the transparency block.
Re-fit once there are labelled cleans. The bands are module constants
(`SD_GOOD`, `SD_WARN`) that `makeFirstPullBackAngle` shares between both
lifts; if the clean turns out to hold a different amount of wobble, the
factory needs a per-lift threshold parameter first.

## Known limitations

Everything in diagnostic 1, plus: nothing distinguishes a clean from a snatch
in the track. The page the lifter selected is the exercise context, so a
snatch scored on this page gets scored as a clean — identical numbers, but
the note about the more upright start would be misleading.
