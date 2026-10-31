# Decision log

What binds, with who decided and when. Open questions wait in "Needs an
answer"; once answered, they move to "Decided". A decision that changes is
rewritten in place (git keeps the history). The binding rules that follow
from these are in [rules-core.md](rules-core.md).

## Needs an answer

| # | Question | Who | Recommendation |
| --- | --- | --- | --- |
| 1 | License | Noah | GPL-3.0-or-later. AGPL-3.0 only if Noah wants to stop others from hosting coach as a web service: for an offline app its network clause (§13) rarely applies. Every author whose code stays must agree (noah, nordmu, Nicola Walker, JMLuner); [map.md](map.md) shows whose code is in the core. |
| 3 | Test phones | nordmu, Noah | Answered in part (nordmu, 2026-10-31): nordmu's Fairphone 6 (`4d42e62f`; LineageOS, no Google Chrome). A stock Android phone with Chrome and Google's WebView is still missing; an iPhone too, if iOS matters. |
| 5 | `.auth_password` is an unsalted SHA-256 hash of the old login password, with a scheme "identical to tecna". Is that password used anywhere else? | Noah | Change it wherever it's used. The file leaves the history in step 2.8 either way. |
| 7 | **How the gym recording session works** (see "What 0.1.0 is"). To cover: how long the rolling buffer is; how start and end are marked (buttons, tap on a timeline, voice?); whether several lifts per session are kept; which lift is set before or after; front or back camera, resolution and frame rate (60 fps matters for the snatch); what happens to the raw video afterwards; where the phone stands. | nordmu | Ask nordmu when Phase 5 starts; nothing gets built before nordmu's input. |
| 8 | Review the goal sentence and the four principles in [rules-core.md](rules-core.md), and the parking of the squat, image and clean & jerk tabs. They were written up as nordmu's, but nordmu has not confirmed all of them (2026-10-31). | nordmu | Until confirmed they are proposals: follow them, but don't build anything that depends on their exact wording. |
| 6 | How long the restructuring window lasts | Noah | Step 2.8 (the history rewrite) has to finish before Noah resumes. |

Questions 1, 2 and 5 went to Noah on 2026-10-31.

## Decided

Newest first within each group.

### What 0.1.0 is

- **2026-10-31, nordmu: 0.1.0 includes a gym recording session.** The camera
  records continuously (a rolling recording). Right after a lift, the user
  marks its start and end, and the lift is processed on the phone while the
  user is still training. "The app is only useful" with it (nordmu). How it
  works in detail waits for nordmu's input (question 7); it is built in
  Phase 5.
- **2026-10-31, nordmu: the UI is reworked from scratch, mobile-first.** One
  responsive app: designed for phones, and the layout widens on laptops and
  desktops (for example, video and plots side by side). No desktop-only
  features in 0.1.0; a richer desktop version can come later.
- **2026-10-31, nordmu: the new UI is built fresh as static files; the old
  page is frozen.** The old page (`INDEX_HTML` in `src/app.py`) stays untouched
  as the dev server's reference viewer. Anatomy, 3D, the Movement Lab and the
  train, squat, image and clean & jerk tabs stay wired into it. They are
  parked together with it once the new UI covers the core (step 5.8). This
  cancels the remaining parking steps of 2.3.
- **2026-10-31, nordmu: 0.1.0 ships as a PWA and as a signed APK on GitHub**
  (Capacitor; installable with Obtainium). **F-Droid comes after a
  feasibility check** (step 3.6): F-Droid builds everything from source, and
  the pose runtimes (WebAssembly) and model weights are prebuilt binaries.
  Noah was asked the same question; if Noah answers differently, this entry is
  revisited.
- **Proposed, awaiting nordmu's review (question 8): park the squat, image
  and clean & jerk tabs.** The new UI offers only what 0.1.0 analyses (lateral
  raise, plus the snatch if the spike passes), which follows from the
  confirmed decision on lifts. Clean & jerk's one cue is a copy of the
  snatch's.
- **2026-10-31, nordmu: the core of 0.1.0 is the lift analysis pipeline:**
  video, on-device pose, `diagnostics.js`, plots and verdicts (map areas 1–3).
  3D, bar detection, anatomy, the Movement Lab and the train tab are parked.
- **2026-10-31, nordmu: 0.1.0 analyses the lateral raise, plus the snatch if
  the Phase 3 spike passes** (otherwise the snatch moves to 0.2).
- **2026-10-31, nordmu: `clipper/` goes back to its own repo; `report/` stays
  here as a parked research folder.** The repo is `weightlifting-clipper`
  (its original name), a local sibling of coach, not pushed anywhere yet.
  coach keeps its side of the link: `scripts/sync_clipper_fixtures.py`, which
  now needs `$CLIPPER_OUT` or `--clipper-dir`.
- **2026-10-31, nordmu: offline is a hard requirement, so no server compute.**

- **2026-10-31, nordmu: bar detection is parked backend and UI together.**
  The detectors, their download path and skill go to `parked/bar-detection/`;
  the page loses its equipment controls and box drawing. 3D keeps reading the
  boxes cached in older tracks until 3D is parked.

### Data and privacy

- **2026-10-31, nordmu: no third-party video is committed** (step 2.4). The
  four example clips moved to the same path under the gitignored
  `tests/fixtures/local/`; their tracks, manifest entries and goldens stay
  public. Both servers look for a global example's clip under `local/` when
  it isn't beside its track, so a machine with the clips keeps its gallery
  and a fresh clone has none (the page hides the picker). The report's copy
  of the athlete-a clip stays on disk beside the notebook, gitignored.
  Provenance: [tests/fixtures/README.md](../tests/fixtures/README.md#videos).
- **2026-10-31, nordmu: named athletes are pseudonymized** (step 2.4):
  `athlete-a` for the athlete in the example clip, its limb profile and the
  report; `athlete-b` for the one named only in notes about a local fixture.
  The real names stay out of the repo, in a gitignored note on nordmu's
  laptop; step 2.8 has to remove them from the history too.

### Rules and docs

- **Proposed, awaiting nordmu's review (question 8): the goal and the four
  principles** in
  [rules-core.md](rules-core.md): "film a lift on your phone and get
  cue-by-cue technique feedback, offline, with nothing leaving the phone";
  honest verdicts, narrow core, reuse first, one keypoint format.
- **2026-10-31, nordmu: AGENTS.md keeps the rules for every change;** the
  server-only rules (Caddy, the live CA, restarts, sibling notes) live in
  [server.md](server.md), with a pointer from AGENTS.md.

### The restructuring window

- **2026-10-31, nordmu: where things go.** The core's in-browser pose lives in
  `src/pose/`. Parked areas go to `parked/<area>/` at the root, moved with
  `git mv` and unwired from the app. Their tests move with them and leave
  `npm test`, which then guards only the core; each parking commit records
  the new count.
- **2026-10-31, nordmu: until the pipeline exists, one Claude Code session
  does the writing work, one step per commit, in order.** Read-only research
  may fan out to parallel agents. Steps that touch `src/app.py` never run in
  parallel: the areas being parked are tangled into it (map.md, "Hidden
  couplings"). Independent work in its own folder, such as the Phase 3 spike
  in `spike/`, may run as a second session alongside.
- **2026-10-31, nordmu: restructuring happens on branch `phase-0`** (worktree
  `.claude/worktrees/phase-0`). `main` stays at tag `pre-cleanup` until the
  end of the window (step 2.8).
- **2026-10-31, nordmu: cleanup first, then a small pipeline ported from
  pascaline** (not APODroid). The pipeline waits for fixes to pascaline's own
  pipeline and for the skill nordmu is extracting from it.
- **2026-10-31, nordmu: nordmu names the core, from the map** (step 1.3).
  Everything outside it is parked, not deleted.
- **2026-10-31, Noah: nordmu may restructure the repo for a while;** Noah
  resumes work afterwards.
