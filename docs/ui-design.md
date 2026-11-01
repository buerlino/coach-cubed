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
- Waiting on nordmu's feedback and the open questions below. Not yet tried
  on the Fairphone.

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
3. Once nordmu approves, and Noah has seen it, 5.2 is done. 5.3 builds the
   app fresh as static files from the approved design; the mockups' code
   (the canvas's format) isn't reused.
4. On the Fairphone, the canvas opens in a browser logged in to claude.ai;
   from 5.3 on, the real app runs on the phone.

## Keeping the UI maintainable (a proposal for 5.3)

- Each screen is its own ES module; one small state machine owns the
  session flow (live, replay, mark, queued, result), so screens never call
  each other.
- The cue list is built from `computeResults()`, unchanged, and each cue's
  title, cue text, verdict and tiles as data, so a new cue in
  `diagnostics.js` needs no UI change (as the old page's panel already
  works).
- The pose engine sits behind one async Worker interface.
- Colours, type and spacing are tokens in one stylesheet.
- A small vendored framework or plain web components: decided in 5.3.

## Open questions

For nordmu (the rest of question 7 in [decisions.md](decisions.md)):

- the replay: R3, R3b, or both with a setting;
- the replay length (20 s in v1) and how much the buffer keeps (60 s in v1);
- whether an analysed lift keeps its video (on in v1) or only the pose and
  the results;
- who writes a "how to fix it" tip per cue (the engine has the cue, no fix);
- several lifts per session, and the lift chosen before recording (v1
  assumes both).

Not drawn yet: a snatch result; the errors (no person found, camera
permission denied, storage full); the first run; a light theme; landscape.
