# Decision log

What binds, with who decided and when. Open questions wait in "Needs an
answer"; once answered, they move to "Decided". A decision that changes is
rewritten in place (git keeps the history). The binding rules that follow
from these are in [rules-core.md](rules-core.md).

## Needs an answer

| # | Question | Who | Recommendation |
| --- | --- | --- | --- |
| 1 | License | Noah | GPL-3.0-or-later. AGPL-3.0 only if Noah wants to stop others from hosting coach as a web service: for an offline app its network clause (§13) rarely applies. Every author whose code stays must agree (noah, nordmu, Nicola Walker, JMLuner); [map.md](map.md) shows whose code is in the core. |
| 2 | Where the Android 0.1.0 is published | Noah | Play Store, F-Droid, an APK on GitHub, or a PWA link. Needed before step 3.5, because the shell depends on it. |
| 3 | Test phones | nordmu, Noah | Answered in part (nordmu, 2026-10-31): nordmu's Fairphone 6 (`4d42e62f`; LineageOS, no Google Chrome). A stock Android phone with Chrome and Google's WebView is still missing; an iPhone too, if iOS matters. |
| 5 | `.auth_password` is an unsalted SHA-256 hash of the old login password, with a scheme "identical to tecna". Is that password used anywhere else? | Noah | Change it wherever it's used. The file leaves the history in step 2.8 either way. |
| 6 | How long the restructuring window lasts | Noah | Step 2.8 (the history rewrite) has to finish before Noah resumes. |

Questions 1, 2 and 5 went to Noah on 2026-10-31.

## Decided

Newest first within each group.

### What 0.1.0 is

- **2026-10-31, nordmu: park the squat, image and clean & jerk tabs**
  (question 4). The UI offers only what 0.1.0 analyses. Clean & jerk's one cue
  is a copy of the snatch's; reviving it later means un-parking its tab.
- **2026-10-31, nordmu: the core of 0.1.0 is the lift analysis pipeline:**
  video, on-device pose, `diagnostics.js`, plots and verdicts (map areas 1–3).
  3D, bar detection, anatomy, the Movement Lab and the train tab are parked.
- **2026-10-31, nordmu: 0.1.0 analyses the lateral raise, plus the snatch if
  the Phase 3 spike passes** (otherwise the snatch moves to 0.2).
- **2026-10-31, nordmu: `clipper/` goes back to its own repo; `report/` stays
  here as a parked research folder.**
- **2026-10-31, nordmu: offline is a hard requirement, so no server compute.**

### Rules and docs

- **2026-10-31, nordmu: the goal and the four principles** in
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
- **2026-10-31, nordmu: until the pipeline exists, the Claude Code session
  coordinates.** Read-only work fans out to parallel agents. Writing work goes
  to one agent per area (Opus 5.5, high effort), each in its own worktree,
  and the session reviews the diff and runs the tests before merging into
  `phase-0`.
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
