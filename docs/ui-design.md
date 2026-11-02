# The new UI: design (plan step 5.2)

The design of 0.1.0's new, mobile-first UI: nordmu's requirements, the
mockups and what they propose, and what is still open. What binds is in
[decisions.md](decisions.md); the steps are Phase 5 of
[restructure-plan.md](restructure-plan.md). Rewrite in place.

## Status

- **Mockups v1, 2026-11-01:** 14 screens on a claude.ai Design canvas,
  <https://claude.ai/artifact/UXtAPva2iUi5m4FWJKxnC5> (private to nordmu's
  account; Noah sees it once nordmu shares it from the canvas's Share menu).
  A copy of its sources is in [design/](../design/README.md).
- **Approved by nordmu on 2026-11-01 as the basis to build on** ("good
  enough to build now"; tweaks later). The build:
  [app-plan.md](app-plan.md). The real app runs on the Fairphone from
  milestone A's phone run on.

## nordmu's requirements (2026-11-01)

- **Recording.** A continuous recording mode: place the phone, do the lift,
  walk back, and the replay plays right away. Not happy with it: carry on.
  For a replay worth analysing, a button brings up the marks: drag the video
  left and right under a mark in the middle of the timeline and tap Set for
  the start, then the same for the end; with both set, an Analyse button. The
  marks stay as tight as possible: processing time grows with their length.
- **Analysis.** Expected to change a lot as development goes. Every action
  has a button, plus whatever else a functional UI needs. UI best practices,
  and maintainable code, not a pile of spaghetti.

## The screens (v1)

| ID | Screen | What it covers |
| --- | --- | --- |
| H | Home | Start a gym session, import a video, today's lifts and their state (analysing, ready, waiting), earlier sessions, "everything stays on this phone". |
| R1 | Set up the camera | A framing guide, the lift (lateral raise or snatch) with a framing tip each, the replay mode, start. |
| R2 | Recording | REC and the session time, the camera's real frame rate, the queue, a large Replay button, end session; the screen stays on. |
| R3 | Replay (nordmu's idea) | The last 20 s play at once: pause, scrub, ½×. Keep and mark, or back to live (by itself after a while); recording never stops. |
| R3b | Delayed view (proposed) | The screen shows the camera 5–20 s late, a small live view in the corner; Keep this lift; nothing to touch until then. |
| M1–M3 | Mark the lift | One screen in three states (start, end, ready): the filmstrip moves under a fixed playhead; Set start, Set end, one-frame steps; the marked length and the time to analyse it; Analyse, Redo. |
| Q1 | Analysing | Progress by stage (read the video, find the pose, score the cues), the time left, the queue; leaving doesn't stop it. |
| A1 | Result | The video with the skeleton: play, frame steps, speed; a timeline with the lift found and where a cue went wrong; a card per cue (status, verdict, value) that opens to the cue, a camera note and the provisional thresholds. |
| A2 | Cue detail | The worst moment with the cue drawn on the video, the cue's plot over time against its zones, its tiles, the cue, how it's scored. |
| A3 | View options | Overlays (skeleton, cue drawings, unsure joints), loop the lift, speed, the lifter, smoothing (advanced), re-mark, delete. |
| A4 | Result, wide | One responsive page: the video and the selected cue's plot side by side, the cues in a sidebar; it stacks at phone width. |
| S1 | Settings and about | Replay mode and lengths, camera, quality, default lift, storage and keeping videos, version, the privacy text, credits and licences. |
| S1b | How the cues are scored (built, d18) | S1's row opens a short text: each cue of a lift, its rule from the cue's zones and, from the newest analysed lift, how it was measured. |

The flows: **milestone A**, H, import, M1–M3, Q1, A1 and A2. **Milestone
B**, H, R1, R2, R3 or R3b, M1–M3, then back to R2 while the lift waits in
the queue, and A1 from H or the queue.

## What the mockups add to the requirements

- **The delayed view (R3b),** instead of the Replay button or as a setting
  beside it: nothing to touch with chalky hands until a lift is worth
  keeping, like the video-delay mirrors gyms use.
- **Rough marks are enough:** `diagnostics.js` finds the exact lift inside
  the marked range itself (`liftWindow`), so the marks only bracket it;
  one-frame steps for when precision matters.
- **The cost shows while marking:** about 2.9 s of processing per second of
  30 fps video (MoveNet Thunder, WebGL, Brave on the Fairphone), so a
  snatch takes about 10 s and a 13 s set about 40 s.
- **Analyse doesn't block:** the lift joins a queue and recording goes on
  (decided 2026-10-31: processed while the user still trains).
- **Honest verdicts on screen:** a cue that can't be scored says why, in the
  engine's words, and every threshold says it is provisional.
- **The camera's real frame rate** on R2.
- **The old page's playback and tracking controls** (speed, smoothing, the
  lifter, overlay toggles) move to A3, off the main screen.

## The look (v1, proposed)

- Dark only, camera-first. Ground `#0E0F11`; surfaces `#17191C`,
  `#21242A`; lines `#2E3238`; text `#F2F1EC`, `#B4B8BF`, `#8E939B`; the
  accent for actions and marks `#C8F04A`; record `#FF4D4D`. Status: good
  `#6FB7FF`, watch `#F2C14E`, work on `#FF8A4C`, can't score `#8E939B`,
  always with an icon and a word, never colour alone.
- Type: Barlow and Barlow Condensed (SIL OFL 1.1). The mockups load them
  from Google Fonts; the app vendors them
  ([rules-core.md](rules-core.md#offline)) and lists them in
  [THIRD_PARTY.md](../THIRD_PARTY.md) once they ship.
- Touch targets 44 px or more, real buttons and links. The wordmark is plain
  text until the name and the logo exist.

## The data in the mockups

A1–A4 show the engine's real output for the test clip
`lateral-raise-cable-1`: its golden snapshot and its committed pose track
(one rep, so symmetry can't be scored). The camera screens use a drawn
stand-in lifter; the times, counts and sizes on H, Q1 and S1 are sample
state.

## Feasibility, from Phase 3

The numbers are in [pose-spike.md](pose-spike.md).

- The camera gives 30 fps at most in the browser on the Fairphone; 60 fps
  for the snatch would need a native camera plugin (untested). A dim room
  halves the rate.
- A rolling buffer works with WebCodecs: hardware H.264, a keyframe every
  second, no frames dropped, and a cut from any keyframe decodes.
- Scrubbing decodes from the last keyframe, at most a second back, at
  1–3 ms per frame in hardware.
- Recording, decoding and pose ran together for 35 minutes with no
  throttling, on about 3.4% of the battery (batterystats' estimate, on USB
  power).

## How the design work continues

1. nordmu reviews the canvas and gives feedback by screen ID, in a session
   or as comments on the canvas.
2. A session revises the canvas, records what nordmu decided in
   [decisions.md](decisions.md) and here, and refreshes the copy in
   `design/mockups/` from the canvas, in the same commit.
3. nordmu approved v1 on 2026-11-01, so 5.2 is done; Noah sees it once
   nordmu shares the canvas. The app is built fresh as static files from
   it ([app-plan.md](app-plan.md)); the mockups' code (the canvas's
   format) isn't reused. Changes after checkpoint A go through the canvas
   first.
4. On the Fairphone, the canvas opens in a browser logged in to claude.ai;
   from 5.3 on, the real app runs on the phone.

## Keeping the UI maintainable

- Each screen is its own ES module; one small state machine owns the
  session flow (live, replay, mark, queued, result), so screens never call
  each other.
- The cue list is built from `computeResults()`, unchanged, and each cue's
  title, cue text, verdict and tiles as data, so a new cue in
  `diagnostics.js` needs no UI change (as the old page's panel already
  works).
- The pose engine sits behind one async Worker interface.
- Colours, type and spacing are tokens in one stylesheet.
- The screens are Preact components written with htm, vendored, with no
  build step (nordmu, 2026-11-01; D1 in [app-plan.md](app-plan.md)).

## Open questions

None blocks the build. Question 7 took v1's answers (nordmu, 2026-11-01;
[decisions.md](decisions.md#what-010-is)) until nordmu changes them: R3
as the replay and R3b as a setting, a 20 s replay, a 60 s buffer, an
analysed lift keeps its video, several lifts per session, the lift chosen
before recording, no "how to fix it" tips in 0.1.0.

Not drawn in v1, so built in its style and reviewed in the app (nordmu,
2026-11-01): a snatch result; the errors (no person found, a video that
can't be read, storage full, the engine failing); the first run. A light
theme waits, and phone landscape gets no layout of its own, only 5.7's
check that nothing breaks.

Built beyond the mockups and kept (nordmu, 2026-11-02, from d13's, d15's,
d24's and c19's reports): Import as built ("Which lift?", then "Pick a
video", then Back), starting on S1's default lift (d41); the gym card's
"Coming in a later version"; the snatch marked "provisional" until step
3.6 closes; earlier days expanded in place on H; Q1's "Paused" in the
background and "Analyse again" after a failed or stopped analysis, with
M handing Q1 the lift's id (d14); H's percent from Q1's bands (d41); S1's
milestone B settings shown disabled, with the lengths as built until c27
measures the buffer; the credits keeping the build-only tools, marked so;
"How the cues are scored" built with A2 (d18); after an update the app
asks for a reload rather than reloading itself. The privacy text is
approved as written once Android backup is off (c43).
