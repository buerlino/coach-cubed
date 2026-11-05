# coach³ 0.1.0

The first release: milestone A as a web app (a PWA) at
**https://coach-cubed.org**, served by GitHub Pages from the public repo
`buerlino/coach-cubed` (nordmu, 2026-11-04,
[decisions.md](decisions.md#what-010-is)). What was left out, and who finishes
it: [handover.md](handover.md).

## What it does

Film a lift, get cue-by-cue technique feedback, on the phone, offline, and
nothing leaves it ([rules-core.md](rules-core.md)):

- **Import a clip** from the phone, pick the lift, **mark the lift** (the start
  and the end, frame by frame), and the pose model runs on the phone.
- **The cues**, one card each with a verdict and its value; a cue the keypoints don't support says "can't score" instead of
  guessing, and a threshold nobody has checked on real lifts is marked
  provisional.
- **Two lifts:** the lateral raise and the snatch.
- **Offline once loaded:** the service worker keeps the whole app, the pose
  model included (about 17.5 MB); an update installs next to the running
  version and takes over when no analysis is running.
- **Nothing leaves the phone:** no server, no analytics, no account. Videos,
  tracks and results live in the browser's private storage.

## Tested on

The Fairphone 6 (LineageOS, Android 16), in **Brave 1.98.63** (Chromium 156),
the PWA installed from Brave's menu and run in a tab of its origin, and in the
debug APK's **Android System WebView 153**; both offline (airplane mode), four
clips, 40 analyses, none failed. An analysis took 5.6 to 31.6 s in Brave for 75
to 444 frames (about 70 ms a frame; medians of 5 runs), and the verdicts agreed
with the bench's ViTPose-L reference: lateral raise 40 of 40, snatch 20 of 20. The numbers and how they were
measured:
[pose-spike.md](pose-spike.md#the-app-itself-on-the-fairphone-c26-2026-11-03).

**It needs Chrome or another Chromium browser, version 108 or later**
(`100dvh`). Fallbacks for older ones (down to Chrome 101) exist and are tested
on the laptop only. **Firefox and Safari are untested.**

## Not in 0.1.0

- **The gym session** (recording at the gym, the replay, the delayed view):
  built but off. S1's switch "Gym session (preview)" turns it on; it is
  unfinished (`c30b`, `c31`, checkpoint B).
- **The APK** (`c33`): the real name, package ID and signing.
- **The run on the Samsung S8+ with Chrome 101** (`c60`).
- **The validation set** (steps 3.0 and 3.6): the pose model is not yet
  confirmed on a set of real lifts; what is unvalidated shows as provisional.
- **F-Droid** and **WebGPU.**

The queue behind these: [handover.md](handover.md).

## Install

Open https://coach-cubed.org in the browser, then its menu's **Install app** or
**Add to Home screen**. It works offline after the first load.

## Licence

AGPL-3.0-or-later ([LICENSE](../LICENSE)). The coach³ logo is
CC BY-SA 4.0 ([logo/](../logo/README.md)). The third-party components and their
licences are in the app (Settings, "Credits and licences") and in
[THIRD_PARTY.md](../THIRD_PARTY.md).
