---
name: lifting-diagnostic
description: Add or revise a weightlifting technique diagnostic in coach — a cue scored from ViTPose keypoints. Use when asked to implement a lifting cue, an efficiency measure, a phase trigger (first pull, second pull, turnover, receiving), or to change how a diagnostic is detected, measured or drawn. Covers the required three-part structure (diagnostic / active phase / visualization + transparency), the keypoint conventions coach uses, and the registry in diagnostics.js.
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

## Where the code lives

| File | Role |
| --- | --- |
| `diagnostics.js` | All diagnostic logic + rendering. Served verbatim at `/diagnostics.js`. |
| `app.py` | `INDEX_HTML` hosts the section; the route re-reads the file per request. |
| `.claude/skills/lifting-diagnostic/diagnostics/` | One note per diagnostic — the spec, in prose. |

`app.py` re-reads `diagnostics.js` on every request, so a JS edit needs only a
browser reload. A change to `app.py` itself needs `./restart.sh`.

Add a diagnostic by writing one object and appending it to the `DIAGNOSTICS`
array. The object's shape *is* the three-part structure:

```js
{
  id: 'first-pull-back-angle',
  title: 'First pull — constant back angle',
  cue: 'Keep the back angle to the floor constant until the bar passes the knee.',
  unit: '°',
  phase(track, scale)        -> { startIdx, endIdx, notes[] } | { error }
  measure(track, phase)      -> { series[], summary{}, notes[] }
  verdict(summary)           -> { label, status }         // status: good|warning|critical
  overlay(ctx, sample, ...)  -> void                      // optional per-frame drawing
}
```

Each entry in `DIAGNOSTICS` automatically gets a tickbox above the plot,
labelled with its `title`, controlling whether its `overlay()` draws on the
video. The tickbox gates **only** the overlay — an unticked diagnostic is still
computed, plotted and scored, because it's about the frame getting crowded
once there are several, not about what's being measured. New diagnostics
default to ticked; otherwise one would ship invisible. Toggling calls back into
`app.py` to repaint, so it works while the video is paused.

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
- `vMeta.frame_indices[i]` is the source frame for sample `i`;
  `vMeta.frame_times_ms[i]` is that frame's own presentation time and is the
  authority for time when non-null (see the comment on `slotForTime` in
  `app.py` — deriving time from `fps` desyncs on phone/MediaRecorder video).
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

## Writing the active phase

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

## Visualization and transparency

The plot goes **below the video**, shares its time axis, and is click-to-seek —
same contract as the keypoint plot already in `app.py`, so the lifter can put
any point on the curve back on the frame that produced it.

- The active phase is shaded; the trace is drawn only inside it.
- The mean over the phase is a dashed reference line, direct-labeled.
- The band between the two independent estimates is the same hue as the trace
  at low alpha. It is *not* a second series and gets no legend entry.
- The headline number is a stat tile, not a point on the chart.

Colors come from the validated dark palette (see the `dataviz` skill,
`references/palette.md`): series `#3987e5`, reference geometry `#d95926`,
status good/warning/critical `#0ca30c` / `#fab219` / `#d03b3b`, muted ink
`#898781`, gridline `#2c2c2a`. Status is never carried by color alone — it
ships with its label.

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

## Diagnostics

| # | Diagnostic | Note |
| --- | --- | --- |
| 1 | First pull — constant back angle | [diagnostics/01-first-pull-back-angle.md](diagnostics/01-first-pull-back-angle.md) |
