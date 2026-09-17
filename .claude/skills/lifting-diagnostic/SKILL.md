---
name: lifting-diagnostic
description: Add or revise an exercise technique diagnostic in coach — a cue scored from ViTPose keypoints. Use when asked to implement a lifting cue, an efficiency measure, a repetition or phase trigger, or to change how a diagnostic is detected, measured or drawn. Covers the universal diagnostic contract, exercise-neutral pose conventions, exercise-specific phase strategies, visualization/transparency, and the registry in diagnostics.js.
---

# Lifting diagnostic

A **diagnostic** turns one coaching cue into a number computed from the pose
track. Every diagnostic in coach is written the same way, in the same order.
That order is not a style preference — each part depends on the one before it:

1. **Description of the diagnostic** — the cue in a coach's words, and the
   scalar that stands in for it.
2. **Active phase definition** — the window of the lift where the cue applies,
   defined by *triggers* computable from keypoints. A cue scored outside its
   phase is noise: the back angle is *supposed* to change once the bar passes
   the knee, so measuring it there would penalize correct lifting.
3. **Visualization and transparency** — the plot the lifter reads, plus
   everything that lets them distrust it: how the phase was found, which
   keypoints carried the measurement, and how much the two independent
   estimates disagree.

Never ship parts 1 and 2 without 3. A number the lifter can't audit is worse
than no number — pose estimation fails silently (occluded hip, a judge walking
behind the platform), and the failure looks exactly like a technique fault.

## Scope and exercise isolation

The contract above is universal. The movement-specific parts are not:

- A diagnostic belongs to exactly one exercise set in `DIAGNOSTIC_SETS`.
- Its phase trigger, thresholds, reference line, and overlay must match that
  exercise's mechanics rather than being borrowed from another lift.
- Shared helpers are allowed only when their meaning remains the same. A
  generic joint angle or torso scale is reusable; a bar-knee crossing is not a
  generic rep trigger.
- A new exercise gets its own diagnostic notes and fixtures. Do not add its
  cues to the `snatch` or `lateral-raise` set just because the same keypoints
  are available. When two lifts genuinely share an event and a cue — the
  snatch's and the clean's first pull — build both objects from one factory
  (`makeFirstPullBackAngle`) and say in the new lift's note why the sharing is
  mechanical, not just convenient.

The UI shares the video, pose track, smoothing, and rendering infrastructure
between exercise pages. Switching pages changes the active diagnostic set and
re-scores the current track; it does not make the track itself exercise-aware.
The user-selected page is therefore the exercise context, not an automatic
exercise classifier.

## Universal diagnostic contract

Every exercise-specific diagnostic should answer these questions:

1. **What cue is being scored?** Name the coaching behavior and the scalar
   that represents it.
2. **When does the cue apply?** Define a phase, repetition, or set window from
   observable pose events. If the movement is repetitive, define a shared rep
   segmenter before writing per-rep diagnostics.
3. **How is it measured?** State the keypoints, normalization, independent
   estimates, missing-data policy, and the direction of a good/bad value.
4. **How can the lifter audit it?** Draw the measured geometry at the current
   playhead, plot the active window, expose uncertainty, and explain fallbacks.

Use this checklist for every new diagnostic:

- Normalize pixel distances and speeds by a body scale when camera distance can
  vary; use raw pixels only when the quantity is explicitly image-relative.
- Require persistence for threshold triggers and use smoothed multi-sample
  signals for velocity or extrema. Never let one noisy frame start or end a
  phase.
- Treat a missing or interpolated keypoint as data quality, not as a technique
  verdict. Count it in transparency notes and fail clearly when the cue cannot
  be scored.
- Keep provisional thresholds visibly provisional until they are calibrated
  against labelled footage from the intended exercise and camera setup.
- Add a fixture or synthetic regression for the phase edge case that motivated
  the diagnostic, then add its golden snapshot when the output is intentional.

## Exercise-neutral building blocks

These concepts are safe to reuse across movements:

- COCO-17 keypoint indexing and `[y, x, confidence]` conversion.
- Confidence gating, short-gap interpolation, temporal smoothing, and torso
  scale normalization.
- Joint angles, segment angles, distances, relative heights, velocities, and
  left/right agreement.
- Generic persistent threshold crossings, local extrema, rep segmentation, and
  phase windows.
- The shared score ramp, plot, uncertainty band, stat tiles, click-to-seek
  behavior, and transparency renderer.

When reusing a helper, document the mechanical assumption at its call site.
For example, `jointAngle` is exercise-neutral, while a helper that finds a
barbell crossing is not.

## Where the code lives

| File | Role |
| --- | --- |
| `src/diagnostics.js` | All diagnostic logic + rendering. Served verbatim at `/diagnostics.js`. |
| `src/app.py` | `INDEX_HTML` hosts the section; the route re-reads the file per request. |
| `.claude/skills/lifting-diagnostic/diagnostics/` | One note per diagnostic — the spec, in prose. |

`src/app.py` re-reads `src/diagnostics.js` on every request, so a JS edit needs
only a browser reload. A change to `src/app.py` itself needs
`./scripts/restart.sh`.

Add a diagnostic by writing one object and appending it to the `DIAGNOSTICS`
array. The object's shape *is* the three-part structure:

```js
{
  id: 'first-pull-back-angle',
  title: 'First pull — constant back angle',
  phaseLabel: 'first pull',        // short label for the chart heading and overlay
  cue: 'Keep the back angle to the floor constant until the bar passes the knee.',
  unit: '°',
  phase(track, scale, axis)  -> { startIdx, endIdx, notes[], ... }  | { error }
  measure(track, phase, axis)-> { series[], summary{}, notes[] }    | { error }
  verdict(summary)           -> { label, status }         // status: good|warning|critical
  score(summary)             -> badness in [0,1] | null   // one constant per lift, drives the ramp
  referenceLine(summary)     -> { value, label } | null   // the plot's dashed line
  tiles(summary, verdict)    -> [{ label, value, sub, status? }]   // stat tiles
  transparencyLines(res, track, ctxExtra) -> [htmlString]  // the transparency block's bullets
  overlay(ctx, view, phase, res, size)    -> void          // drawing, at the playhead's own time
}
```

`overlay` is handed a `view`, not a sampled frame: `view.p` is the track
interpolated to the playhead's actual time, `view.at(t)` the same at any other
instant inside the phase, `view.dt` the mean spacing of processed frames, and
`view.axis` the clip's bar axis (below). It
has to be continuous because the marks sit on top of `src/app.py`'s wireframe,
which is itself interpolated — marks pinned to the nearest sampled frame
visibly trail the body they claim to measure.

The first four functions (`phase`/`measure`/`verdict`/`overlay`) are the
three-part structure itself and are documented in detail below.
`referenceLine`/`tiles`/`transparencyLines` exist because **every diagnostic
always gets its own plot, stat tiles and notes block** — added once there was
a second diagnostic and the shared renderer needed each one's chart mean/target
line, headline numbers and transparency prose to differ without duplicating
the chart/panel drawing code itself. Keep them thin: they return data
(numbers, strings), the shared renderer in `src/diagnostics.js`'s "rendering"
section does the actual drawing.

Each entry in `DIAGNOSTICS` automatically gets a tickbox above the plots,
labelled with its `title`, controlling whether its `overlay()` draws on the
video. The tickbox gates **only** the overlay — an unticked diagnostic is still
computed, plotted (in its own always-present section) and scored, because it's
about the frame getting crowded once there are several, not about what's being
measured. New diagnostics default to ticked; otherwise one would ship
invisible. Toggling calls back into `src/app.py` to repaint, so it works while the
video is paused.

When a new diagnostic's phase depends on another diagnostic's trigger (e.g.
the second pull starting exactly where the first pull ends), share the
trigger-finding function rather than letting each diagnostic re-derive it —
see `barKneeCrossing` in `src/diagnostics.js`. Two independently-computed versions
of "the same event" silently drifting apart across diagnostics is a bug that
is very easy not to notice, because each diagnostic looks correct in
isolation.

`series` entries are `{ frame, t, value, lo, hi }` — `lo`/`hi` are the two
independent estimates, not error bars from a model. The shared renderer draws
the band between them; their spread *is* the uncertainty. Any diagnostic that
can't produce two independent estimates must say so in `notes` and set
`lo === hi`.

## Keypoint conventions

These come from `vitpose_backend.infer_video` and are easy to get backwards.

- A keypoint is `[y, x, confidence]` — **y first**, and `y` grows *downward*.
  Elevation is therefore `-y`. "A is above B" is `A.y < B.y`.
- COCO-17 indices: 5/6 shoulder L/R, 7/8 elbow, 9/10 wrist, 11/12 hip,
  13/14 knee, 15/16 ankle. Odd = left, even = right.
- **There is only ever one person in the track.** `infer_video` keeps the
  tracked body detected in the most frames and discards the rest
  (`vitpose_backend._keep_main_person`) — a gym has bystanders in it, and YOLO
  also hallucinates bodies out of equipment. A diagnostic never has to decide
  who the lifter is. `meta.tracks` says who was kept and what was dropped; a
  dropped track nearly as long as the kept one means the tracker split the
  lifter in two, and the surviving half is missing part of the lift.
- `vMeta.frame_indices[i]` is the source frame for sample `i`;
  `vMeta.frame_times_ms[i]` is that frame's own presentation time and is the
  authority for time when non-null (see the comment on `slotForTime` in
  `src/app.py` — deriving time from `fps` desyncs on phone/MediaRecorder video).
- Drop keypoints below `DIAG_CONF` (0.3) rather than trusting a low-confidence
  position. Then smooth: raw per-frame keypoints jitter by several pixels, which
  a velocity trigger reads as motion.
- Everything is **pixels in the image plane**. There is no metric scale and no
  true 3-D. Normalize any distance or speed threshold by a body scale — coach
  uses median torso length (hip→shoulder) — so a threshold survives the lifter
  standing closer to the camera.
- "Angle in the z-axis" in a cue means rotation *within* the image plane (about
  the camera axis). It is only meaningful when filming square to the lifter's
  side; out-of-plane rotation shortens segments and biases the angle. Say this
  in the notes rather than pretending the number is 3-D.

## Exercise-specific reference: Olympic lifting and barbell work

The following bar-axis and barbell-trigger guidance applies to the snatch and
similar barbell lifts only. It is not a requirement for lateral raises,
presses, squats, or other movements without a meaningful bar axis.

### The bar axis

Every "height" in coach is measured against the **bar axis**, not against the
image's bottom edge, and every rule drawn across the frame is parallel to it.
It is one direction per clip, computed once in `run()` (`barAxis`) and handed to
every `phase`/`measure`/`overlay` — the same reason `barKneeCrossing` is shared:
two diagnostics disagreeing about which way is up is a bug that looks correct in
each one alone.

It is read off the **lifter**, not the bar, and from **one frame**, not an
average over the clip. Every left/right pair — shoulders, hips, knees, ankles —
is separated across the platform, i.e. along the bar, so each pair is an
independent reading of the same direction, and several pairs at one instant give
the redundancy that several frames would, without the movement in between.

Two things follow from that, and both were arrived at the hard way:

- **Not the wrists.** They are a left/right pair like the others, but the hands
  are what the plates hide: a wrist snapped to a plate rim tilts its line by
  tens of degrees, and it happens on the frames where the bar matters most.
- **Not averaged over frames.** The direction is constant; the body is not. The
  lifter twists, joints occlude each other and reappear, and each of those is a
  wrong slope that an average over frames mixes in rather than cancels. The
  setup frame — the frame the wrists start rising off the floor, from
  `firstPullWindow` (a few samples early because of the smoothing, so still the
  set position) — is square to the camera, motionless and unoccluded, and is
  the one frame worth trusting.

Within that frame: median of the pairs, drop anything more than 12° off it, then
a **baseline-weighted** mean of what survives (a pair's angular error goes as its
pixel error over its separation, so the shoulders outvote a pair of ankles
standing nearly on top of each other).

Four things stop it being estimated, and each falls back to the image axes and
says so in the transparency block rather than tilting everything by a guess:
fewer than two pairs detected far enough apart; the surviving pairs not being a
*majority* of the visible ones (two of four agreeing is a coincidence, not a
direction); the survivors spanning more than 12° between themselves; and a
result past 25°, which is more camera roll than a gym video plausibly has. If
the setup frame itself can't produce an answer, the next five frames are tried
and how far it walked is reported.

The API:

| | |
| --- | --- |
| `axis.deg` | tilt off the image horizontal; `.ux/.uy` along the bar, `.dx/.dy` down |
| `elev(pt, axis)` | height, still growing downward like image `y`, so `A above B` stays `A < B` |
| `toBar(pt, axis)` / `fromBar(a, h, axis)` | into and out of bar coordinates |
| `barRule(ctx, pt, axis, dash, alpha, w)` | a full-frame rule through a point, parallel to the bar |
| `axisNote(axis)` | the transparency bullet — every diagnostic includes it |

A joint angle (`jointAngle`) is rotation-invariant and needs none of this. A
segment's tilt (`trunkAngle`) does, and takes the axis as an argument.

The one ordering constraint in `run()`: the axis needs the setup frame, and the
setup frame comes from a trigger that needs an axis. `firstPullWindow` is run
once against `IMAGE_AXIS` to break the cycle — safe, because the bar/knee
crossing moves by at most a frame or two under any roll the axis will accept,
and the still frame it leads back to is still a still frame.

## Writing the active phase

Phase design is exercise-specific. Start with the most reliable observable
event for the movement: a bar crossing for an Olympic lift, a local repetition
cycle for a lateral raise, or a joint-position transition for a squat or press.
Do not force every exercise through `firstPullWindow` or `barKneeCrossing`.

### Generic trigger rules

Triggers are the hard part, and the failure mode is always the same: a trigger
defined as "the first frame where X" fires on a stray detection early in the
video. Two rules:

- **Anchor on the most reliable trigger, then search outward from it.** The end
  of the first pull (bar crosses knee height) is a crisp geometric crossing;
  motion onset is a soft threshold on noisy velocity. So find the crossing
  first, then walk *backwards* from it for the onset. Searching forward from
  frame 0 for "hands start moving" instead finds the lifter adjusting their
  grip.
- **Require persistence.** A threshold crossing must hold for N consecutive
  samples (coach uses 3) before it counts.
- **Never difference frame to frame.** Any velocity trigger must be measured on
  a smoothed signal over a multi-sample baseline. A few px of pose jitter across
  a 1/30s step is a large apparent speed — frame-to-frame differencing makes a
  motionless lifter look like they're moving, and every motion trigger silently
  fires at sample 0. Check a new trigger against synthetic jitter before
  trusting it.

State every trigger's fallback. If the video starts mid-pull there is no quiet
period to find — clamp to the first sample and *say so in the notes*, don't
silently return a phase that starts at 0.

### The lift window

`liftWindow` in `src/diagnostics.js` is the one window that belongs to the
**lift**, not to a cue: where the attempt starts and where it finishes. It is
not a diagnostic — no cue, no scalar, no plot, no entry in `DIAGNOSTIC_SETS`.
It is computed once per track in `run()` alongside the bar axis, exposed as
`Diagnostics.liftWindow()`, and drawn by `src/app.py` as the two markers on the
video's and the 3D view's time sliders (the "lift start/end markers" tickbox).

- **Start** = `firstPullWindow(...).startIdx`, the same call the first-pull
  diagnostics make. Shared, not re-derived: the marker on the slider and the
  shaded phase on the first-pull chart have to be the same instant.
- **End** = the first sample from which all four of these hold for
  `LOCK_HOLD_SECONDS`: both elbows above `LOCK_ELBOW` (150°), both knees above
  `LOCK_KNEE` (170°), the body slower than `STILL_SPEED` at every instant, and
  the body's *net* travel across the whole hold under `STILL_DRIFT`.

The end trigger is worth reading before writing any "the lifter finished"
trigger of your own, because each of its four gates was added after the one
before it shipped and fired early:

1. **Angles alone** fire on the scoop and on the triple extension — a tenth of
   a second each, which a persistence window rejects.
2. **Angles held half a second** still fire during the *stand-up out of the
   catch*, where all four joints come open together, slowly, for a full second,
   while the lifter is still rising. The position is a finish; the movement
   isn't. So the hold also asks the body to be slow — and only slow, since a
   finish contains sway, a step back and the bar settling. `bodyMotion` reports
   the **median** speed over every keypoint (so the arms under a settling bar
   cannot veto a body that has plainly stopped) and `STILL_SPEED` is a third of
   a torso-length per second, not zero.
3. **One threshold on speed** is still not enough, because slow is not the same
   as stationary: a recovery creeping up at 0.3 torso-lengths/s is under the
   gate at every instant and has still moved a third of a body by the time the
   half second is out. `STILL_DRIFT` is the same measurement taken end to end
   over the hold — net displacement, not path length — so rocking in place
   scores near zero however busy it looks, and monotone creep fails however
   gentle it is. On the fixtures the separation is an order of magnitude: a
   recovery in progress drifts 0.2–0.65, a real finish 0.05–0.09.
4. **The knees are not the elbows.** An elbow is locked or it isn't. A knee is
   *soft* for the whole recovery — it drifts up through the 150s and 160s long
   before the lifter is standing — so it gets its own, tighter threshold. Any
   joint whose angle changes gradually through the movement needs one.

Three rules this leaves behind for any similar trigger:

- **A posture is not an event.** Where a body *is* rarely distinguishes a
  transient from a destination; where it is *going* does. Pair every position
  threshold that has to mean "arrived" with a motion one — and check the motion
  both instant by instant and end to end, because they fail differently.
- **Unknown is not false.** Speed is differenced across a baseline either side
  of a sample, so the few samples at each end of the clip have none — exactly
  where a finish that runs off the end of the clip lives. `liftWindow` treats
  those as a third state: a hold cannot *start* on one, but it survives them,
  and a hold that reaches the end of the clip that way is reported with
  `truncated: true` rather than thrown away.
- **A short window cannot judge a slow signal.** That truncated path is also
  how a clip ending with the lifter merely upright collects a spurious marker
  from its last three frames — over a few samples, net travel is mostly the
  smoothing window's own lag. `LOCK_MIN_SPAN` is the floor below which the
  question is declined rather than answered.

## Visualization and transparency

The plot goes **below the video**, shares its time axis, and is click-to-seek —
same contract as the keypoint plot already in `src/app.py`, so the lifter can put
any point on the curve back on the frame that produced it.

- The active phase is shaded; the trace is drawn only inside it.
- The mean over the phase is a dashed reference line, direct-labeled.
- The band between the two independent estimates is the same hue as the trace
  at low alpha. It is *not* a second series and gets no legend entry.
- The headline number is a stat tile, not a point on the chart.

### Color scheme

Three roles, three fixed treatments, on the video and on the plot alike.
**Nothing else gets a hue** — a new diagnostic that introduces a fourth colour
is the bug, not the palette. Values come from the validated dark palette (see
the `dataviz` skill, `references/palette.md`) and live in `C` in
`src/diagnostics.js`.

| Role | Treatment | Why |
| --- | --- | --- |
| **The skeleton** — the pose track drawn on the frame | white `#ffffff` | It is a measurement of the lifter, not a judgement of them. It says where the body was, and nothing about whether that was good. |
| **The diagnostic** — the mark that *is* the measurement, its trace, its uncertainty band, its trail | green→amber→red `#0ca30c` / `#fab219` / `#d03b3b`, via `scoreColor(score(summary))` | The mark carrying the number is also the readout of it, so the frame and the plot cannot disagree about how the lift scored. |
| **Phase and interpretability indicators** — phase shading and edges, trigger geometry (the heights a crossing compares, the extremum a phase ended on), their labels | purple `#b39ddb`, via `phaseColor(alpha)` | These say *when* and *why*, not *how well*. On the ramp their edges would read as "good" or "bad" — a phase boundary is neither. |

Grid, axes, playhead, tooltips and prose stay neutral (`C.ink` / `C.ink2` /
`C.muted` / `C.grid` / `C.axis`). Status is never carried by color alone — it
ships with its label. Weight and dash pattern, not hue, separate a measurement
from its reference *inside* a role: diagnostic 1's bar estimate is a solid
purple rule and the raw wrist it was corrected from is a dashed one.

`score()` is what drives the ramp, and it is one constant for the whole lift,
not a per-frame value: recolouring frame by frame makes the mark flicker
through the ramp during playback and invites reading a single frame's colour as
a verdict. It can differ from `verdict()` — diagnostic 1 scores SD but colours
total drift — so say so in the transparency block when it does, and give the
number the ramp is built from its own stat tile in that colour, since that tile
is the only legend the ramp gets.

The transparency block under the plot is mandatory and lists, at minimum:
which frames the phase spans and which trigger values chose them; how many
samples were measured; what fraction of them were interpolated across a
dropped detection; how many had both sides visible; and the mean disagreement
between the two sides. When a diagnostic can't run, it says which trigger
failed — never an empty chart.

## Thresholds are provisional

The good/warning/critical cutoffs in each diagnostic are first guesses, not
sports-science findings. Label them as such wherever they surface, and record
in the diagnostic's note what they were based on. They should be re-fit once
there are enough labelled lifts to fit them against.

## TODO

- **Recognize the start position from rough keypoint posture.** Detect the
  frame where the lifter is set over the bar — bar on the floor, hips below
  shoulders, knees flexed, hands outside the knees — from the keypoint
  configuration alone, without reference to motion. Every phase trigger so far
  is a motion or crossing threshold, which is why they all need a smoothed
  signal and a backwards search from an anchor. A posture match is a per-frame
  classification instead: it holds on a *stationary* lifter, which is exactly
  where velocity triggers are weakest, and it gives the first pull a real start
  anchor rather than the current "walk back until the wrists stop rising". It also
  gates the diagnostics on the clip actually being a lift, which nothing
  currently checks.

## Diagnostics

| # | Diagnostic | Note |
| --- | --- | --- |
| 1 | First pull — constant back angle | [diagnostics/01-first-pull-back-angle.md](diagnostics/01-first-pull-back-angle.md) |
| 2 | Second pull — full triple extension | [diagnostics/02-second-pull-triple-extension.md](diagnostics/02-second-pull-triple-extension.md) |
| 3 | Lateral raise — top-of-rep height | [diagnostics/03-lateral-raise-top-height.md](diagnostics/03-lateral-raise-top-height.md) |
| 4 | Lateral raise — torso lean | [diagnostics/04-lateral-raise-torso-lean.md](diagnostics/04-lateral-raise-torso-lean.md) |
| 5 | Lateral raise — elbow lead | [diagnostics/05-lateral-raise-elbow-lead.md](diagnostics/05-lateral-raise-elbow-lead.md) |
| 6 | Lateral raise — tempo | [diagnostics/06-lateral-raise-tempo.md](diagnostics/06-lateral-raise-tempo.md) |
| 7 | Lateral raise — rep-to-rep symmetry | [diagnostics/07-lateral-raise-symmetry.md](diagnostics/07-lateral-raise-symmetry.md) |
| 8 | Clean — first pull, constant back angle | [diagnostics/08-clean-first-pull-back-angle.md](diagnostics/08-clean-first-pull-back-angle.md) |
