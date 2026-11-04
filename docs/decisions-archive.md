# Decision log, archive

Decisions about work that is done: the restructuring window (Phases 0–2),
its doc moves, and Phase 5 package details that have merged. They stay true, but no session needs them to start. The live
log is [decisions.md](decisions.md).

### What 0.1.0 is, done

- **2026-11-03, nordmu, on the second night's reports** (each as the
  worker recommended): no clean-and-jerk in 0.1.0 (Noah's to add through
  docs/lifts.md), and `registerLift` stays for the tests (`s49`). M's
  refusal for a start moved past the end keeps d54's wording. Welcome
  drops its footer's "Nothing leaves this phone." and keeps the point;
  A1's cue list gets its own fade; A1 and A2 get d54's no-scroll check:
  all three in `d58`. As built: the ring's upper bound (`c27`), with
  10 Mbit/s and Baseline-first provisional until `c30`; H's "Back to the
  session" goes home → live only while a session runs (`d28`); R3's 25 s
  countdown until nordmu sees it on the phone (`c30b`); the empty ring
  under the "failed" problem (`d29`); d29b's six points, a kept lift
  longer than the buffer and the 0.3 s skip lag included (both measured
  in `c30`/`c30b`).
- **2026-11-02, nordmu, checkpoint A round 1** (the review page in
  [design/](../design/README.md); [ui-design.md](ui-design.md)): the picker,
  then L1 "Which lift?", then M (`d53`); on M the steps are the buttons, ↶
  undoes the last mark, a green step pressed again moves its mark, fixed
  positions (`d54`, before B's `d29`); the whole wording pass and a ⌄ where
  a screen goes on below (`d55`). The page is the record; the canvas
  catches up later.
- **2026-11-02, nordmu, on d22, d23 and d25:** a re-marked lift replaces
  the old one once its analysis succeeds (`s50`); unsure-joint rings stay,
  judged on the phone later; A3's smoothing becomes the default for later
  analyses, capped at 300 ms in settings (`d51`); Q1's "No person found"
  gets "Pick another video" (`d51`); the first-run text goes into the
  wording pass; `introSeen` stays in settings. A4's 980 px breakpoint, phone
  landscape scrolling to its buttons and A2's single column on a laptop
  stay; no "Rep 1" before cues are scored per rep. The tools' browser
  leaves no `org.chromium.Chromium.*` folders (`c52`). Noah takes the lift
  side after 2.8 (`s49`).
- **2026-11-02, nordmu, on the first night's reports:** one contract
  package (`s35`): `frameTimes` in contract 5, a `reset` message in
  contract 1, contract 4's window may lack its end and the view records
  its smoothing, contract 2's reading reworded. Each set in diagnostics.js
  says whether it has a lift window; the lateral raise has none (`s36`).
  `athlete-a-trim` is a snatch (seen on the clip). S1 hides keepVideos
  until contract 3 allows a lift without its cut; c8's setting ranges are
  provisional until c27. mediabunny ships unminified. s9's and s32's phone
  measurements move from c26 to `c34`, after c20. After c20 and c34: a
  frame cache for M1–M3's steps before d14 (`s38`); the placeholder app ID
  until question 10; persist() false is shown, not an error; the media code
  stays; c34's clips stay cached for c26.
- **2026-10-31, nordmu: bar detection is parked backend and UI together.**
  The detectors, their download path and skill go to `parked/bar-detection/`;
  the page loses its equipment controls and box drawing. 3D keeps reading the
  boxes cached in older tracks until 3D is parked.

### Rules and docs, step 2.6

- **2026-10-31, nordmu: one doc per fact, so two docs went** (step 2.6).
  `docs/deploy.md` is deleted after its true facts moved to
  [server.md](server.md). `START_HERE.md` is split: the launch commands into
  the root README, the anatomy guide into `src/anatomy/README.md`. The repo
  `Caddyfile` stays, with its stale comments fixed (comments only, so the
  deploy can't break).
- **2026-10-31, nordmu: no notes about Noah's deploy box in the repo** (step
  2.6). The deploy map in `train-data-todo.md` (sibling services, units,
  addresses) is removed, as [server.md](server.md) already required; the
  sibling notes live on that machine.
- **2026-10-31, nordmu: athlete names in OCR samples become `<name>`** (step
  2.6), as under "Data and privacy" in [decisions.md](decisions.md#data-and-privacy).

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
