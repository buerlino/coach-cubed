# Decision log

What binds, with who decided and when. Open questions wait in "Needs an
answer"; once answered, they move to "Decided". A decision that changes is
rewritten in place (git keeps the history). The binding rules that follow
from these are in [rules-core.md](rules-core.md).

## Needs an answer

| # | Question | Who | Recommendation |
| --- | --- | --- | --- |
| 2 | Where 0.1.0 is published | Noah | nordmu decided it (PWA and GitHub APK, F-Droid after a check; "What 0.1.0 is"). Noah was asked too and may revise it; until he does, nordmu's answer binds. |
| 5 | `.auth_password` is an unsalted SHA-256 hash of the old login password, with a scheme "identical to tecna". Is that password used anywhere else? | Noah | Change it wherever it's used. The file leaves the history in step 2.8 either way. |
| 6 | How long the restructuring window lasts | Noah | Step 2.8 (the history rewrite) has to finish before Noah resumes. It is scheduled at Phase 5's checkpoint A (D8); if Noah comes back earlier, the queue drains early for it. |
| 9 | Branch protection on `main` of `noahsta/coach`, so one push from an old clone can't undo step 2.8 | Noah (repo owner) | Turn it on. |
| 10 | **The app's name and the PWA's domain.** nordmu's pick (2026-11-02): coach³, "Coach Cubed". The public PWA waits for the domain: a PWA's installs and stored data belong to its origin, so moving it later costs users their data. | Noah | Clean where checked ([branding.md](branding.md)); then Noah, a trademark search, the domain. The package ID doesn't wait ([What 0.1.0 is](#what-010-is)). |

**What went to Noah, and when:** nordmu's message of 2026-10-31 asked
questions 1 (the licence, reopened as 11), 2 and 5 (as "is it a real
password?"), and said "no pushes to `main`" and that a history rewrite is
coming. nordmu's next message (drafted 2026-11-02) asks for his one-line OK
to AGPL-3.0-or-later (11), again about 2 and 5, then 6, 9 and 10, whether his
tailnet hostname and IP addresses may stay public ([backlog.md](backlog.md)),
and for a look at `origin/phase-0` before `main` moves.

## Decided

Newest first within each group. Decisions about finished work (the
restructuring window, merged packages' details) are in [decisions-archive.md](decisions-archive.md).

### What 0.1.0 is

- **2026-11-05, nordmu, the release route and four reports** (each as
  recommended): `phase-0` goes onto `main` as a merge, no force-push; the
  first GitHub run is by hand with deploy off, and the tag `v0.1.0` waits
  for nordmu's word after it passes. The workflow's checkout gets
  `persist-credentials: false` (`c67`). Q1's "Up next" estimate, blind to
  the clip's frame rate (`s59`), becomes `s68`, held for Noah. No repair
  for ranges stored before `s63` (nothing was released before it).
  `d66`'s switch row as the gym section's heading and `createSession` on
  by default stay.
- **2026-11-04 (late), nordmu: 0.1.0 is milestone A, as a PWA on
  coach-cubed.org.** The gym session ships off by default behind a
  "preview" switch (`d66`); Noah finishes milestone B (`c30b`, `c60`,
  `c64`, `c31`, checkpoint B) after the handover, and the APK (`c33`). No
  S8+ run before release: `c65`'s fallbacks are laptop-tested. The coach³
  logo merges as it is. nordmu releases `v0.1.0` from
  `buerlino/coach-cubed` through Pages (`c67`), then transfers the repo
  and the domain to Noah (docs/handover.md).
- **2026-11-03, nordmu:** the S8+ runs `c60` after `c26`, on Chrome 101
  as it is (the oldest likely Chrome). A failed camera offers Try again and keeps the
  lift (`c61`). The PWA goes online unlisted once named: own domain, Pages
  from a public repo.
- **2026-11-02, nordmu, on milestone B's packages** (`c27` to `c31`,
  [packages/](packages/README.md)): R1–R3b are built from v1's mockups with
  checkpoint A's rules (fewer words, symbols, nothing moves) and reviewed in
  the app at checkpoint B; R1's framing tip per lift lives in `s49`'s
  registry; in `c31` the phone films the laptop playing an example clip.
- **2026-11-02, nordmu, checkpoint A** (on the Fairphone, the PWA; more
  feedback to come): keep the look and the green accent; less text, more
  symbols; the lift is chosen once, in its own step after the video is
  picked; M1–M3 reworked (the numbered steps are the controls, undo is a
  symbol, nothing moves, the controls stay on screen). The design goes
  through the canvas first. Checkpoint A counts as passed for milestone B's
  laptop packages; `c26` still runs by day. `c27` runs on the laptop alone,
  `c30` and `c31` on the phone. Tonight's order: the fixes, `s49`, then B.
- **2026-11-04, nordmu: the Android package ID is
  `io.github.noahsta.coachcubed`** (was `io.github.noahsta.coach`,
  2026-11-02): the app's name under Noah's GitHub namespace, not the
  domain; it replaces `org.coach.placeholder` in `c33` and can't change
  once published.
- **2026-11-02, nordmu: the validation set isn't part of the handover.**
  0.1.0 ships MoveNet Thunder; checking the analysis against real clips
  (3.0, 3.6) is Noah's work after the handover, so nothing waits on it.
- **2026-11-02, nordmu: 0.1.0 is the handover.** It ships as planned, then
  coach goes back to Noah, who builds on with the pipeline (`c40`).

- **2026-11-02, nordmu, later:** Question 8: the
  squat, image and clean & jerk tabs are parked; the new UI offers
  only what 0.1.0 analyses, and they leave with the old page at step 5.8.
  Question 3: the test phones are the Fairphone 6, an old Samsung Galaxy
  S8+ (Google's Chrome and WebView) and an old iPhone XS Max (the PWA in
  Safari); nordmu has no others. Question 10: nordmu picks "Coach Cubed".
- **2026-11-01, nordmu, after the plan's review**
  ([app-plan.md](app-plan.md#decided-2026-11-01)): D5, the raw keypoint
  plots aren't ported (A2's per-cue plots replace them). D6, an analysed
  lift keeps a cut of its marked range, MP4, made with mediabunny at
  Analyse (package `s32`). D7, Look A0: nordmu tries the app on the
  Fairphone once `d17` merges, not a gate. D8, 2.7 and 2.8 run at
  checkpoint A with the queue empty.
- **2026-11-01, nordmu: mockups v1 are the basis to build on** ("good
  enough to build now"; tweaks later), and the build follows
  [app-plan.md](app-plan.md). D1: the UI in Preact with htm, vendored, no
  build step (Lit, plain modules and Svelte weighed). D2, question 7: v1's
  answers until nordmu changes them: R3 as the replay and R3b as a
  setting, a 20 s replay, a 60 s buffer, an analysed lift keeps its video,
  several lifts per session, the lift chosen before recording, no fix tips
  in 0.1.0. D3: the screens v1 doesn't draw are built in its style and
  reviewed in the app. D4: every package runs through the pipeline.
- **2026-11-01, nordmu: the pose runtime that ships is open source and
  buildable from source,** so not MediaPipe Tasks' web runtime (the
  benchmark; a fallback only nordmu can choose). **Step 3.7: MoveNet
  Thunder on TensorFlow.js**, every frame, the working pick until 3.6
  passes on the validation set. TF.js is frozen, so 5.3 builds it from its
  tags' sources and fixes are ours. See [pose-spike.md](pose-spike.md).
- **2026-10-31, nordmu: 0.1.0 comes in two milestones.** A: import a clip
  and get the cues, offline, for testers (nordmu, Noah, friends). B: the gym
  recording session. The public 0.1.0 needs both.
- **2026-10-31, nordmu: a validation set comes before the spike's
  measurements** (step 3.0), filmed by a friend of nordmu, who gives a
  written OK to use the footage first: about 10 lateral-raise sets of
  several reps and about 5 side-view snatches, each with a ViTPose-L
  reference track and a few verdicts judged by a person. A pose model
  passes when, on smoothed tracks and counting only verdicts both score, it
  agrees with the reference on ≥ 85% of lateral-raise and ≥ 80% of snatch
  verdicts, scores ≥ 90% of the cues the reference scores, and finishes a
  10 s clip in ≤ 90 s on the Fairphone. If every candidate stays under 70%
  on the lateral raise, the spike stops and nordmu and Noah rethink the
  core; a snatch under 80% moves to 0.2.
- **2026-10-31, nordmu: the Flask server is dev tooling only:** reference
  tracks, goldens and the validation set's references, never a dependency
  of the app ([rules-core.md](rules-core.md)).
- **2026-10-31, nordmu: 0.1.0 includes a gym recording session.** The camera
  records continuously (a rolling recording). Right after a lift, the user
  marks its start and end, and the lift is processed on the phone while the
  user is still training. "The app is only useful" with it (nordmu).
  **2026-11-01, nordmu:** place the phone, lift, walk back, and the replay
  plays at once; not happy, carry on; mark start and end by dragging the
  video under a fixed playhead, as tight as possible, then Analyse
  ([ui-design.md](ui-design.md)). Question 7: v1's answers (above). Built in Phase 5.
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
  feasibility check** (step 3.8): F-Droid builds everything from source, and
  the pose runtimes (WebAssembly) and model weights are prebuilt binaries.
  Noah may revise it (question 2).
- **2026-10-31, nordmu: the core of 0.1.0 is the lift analysis pipeline:**
  video, on-device pose, `diagnostics.js`, plots and verdicts (map areas 1–3).
  3D, bar detection, anatomy, the Movement Lab and the train tab are parked.
- **2026-10-31, nordmu: 0.1.0 analyses the lateral raise and the snatch.**
  The snatch was tied to the spike; 2026-11-02, nordmu: it ships as built.
- **2026-10-31, nordmu: `clipper/` goes back to its own repo; `report/` stays
  here as a parked research folder.** It lives in `../weightlifting-clipper`,
  a plain folder beside coach. 2026-11-02, nordmu: clipper's history isn't
  kept, so step 2.8 doesn't wait for it. coach
  keeps its side of the link: `scripts/sync_clipper_fixtures.py`, which
  now needs `$CLIPPER_OUT` or `--clipper-dir`.
- **2026-10-31, nordmu: offline is a hard requirement, so no server compute.**

### Licence

- **2026-11-02, nordmu: coach is AGPL-3.0-or-later** (question 11),
  superseding the entry below; Noah, Nicola Walker and JMLuner (Josh) agreed
  (reported by nordmu, 2026-11-02). The goal:
  open source, but nobody sells a closed copy. No open licence bans selling;
  the AGPL makes every copy publish its source, also one run as a network
  service. The written OKs asked for are OKs to this.
- **2026-11-02, nordmu: YOLOv8 never ships in the app** (question 12); the
  app doesn't need it.
- **2026-10-31, Noah: coach is GPL-3.0-or-later** (question 1; reported by
  nordmu, who picked "-or-later"). All four authors agreed ([authors.md](authors.md));
  nordmu collects a one-line written OK from each before the LICENSE commit
  (step 2.7). **2026-11-03, nordmu:** their spoken OK is enough; LICENSE
  and the headers went in without the written ones.

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

- **2026-11-01, nordmu: faraday runs the night** (`.claude/agents/faraday.md`):
  one agent that runs the queue, picks the next ready package, checks it
  against what merged, records merges, stops at the gates and reports in the
  morning. Laptop packages only; phone packages wait for a watched day run.
  Opus at medium effort: the check before each run is a judgement nobody
  catches at night.
- **2026-11-01, nordmu: Phase 5 runs through the agent pipeline**
  ([pipeline.md](pipeline.md)): dirac the UI, schrödinger the analysis
  core, curie the phone and platform, einstein the advisor, hillbert the
  auditor. This file's budget rises to 15 kB.
- **2026-10-31, nordmu: step 3.7's numbers live in
  [pose-spike.md](pose-spike.md)**, so this file stays in its budget.

- **2026-10-31, nordmu: AGENTS.md is a lean entry point, and the docs'
  budgets are tested** (step 2.9), following pascaline. AGENTS.md holds only
  what every session needs (what coach is, the commands, the workflow, the
  layout, the conventions) and links to [rules-core.md](rules-core.md), which
  now holds the rules for changing the repo; CLAUDE.md stays a pointer to it,
  since AGENTS.md serves every agent. `tests/docs.test.js`, in `npm test`,
  fails when a doc passes its budget (listed at the top of that file), a
  relative link or its anchor doesn't resolve, or a path named in
  [README.md](README.md) is gone. Raising a budget is a decision recorded
  here.

- **2026-10-31, nordmu: the goal and the four principles** in
  [rules-core.md](rules-core.md) are confirmed (again when asked about
  question 8): "film a lift on your phone and get
  cue-by-cue technique feedback, offline, with nothing leaving the phone";
  honest verdicts, narrow core, reuse first, one keypoint format.
- **2026-10-31, nordmu: the rules for every change live in
  [rules-core.md](rules-core.md)** (in AGENTS.md until step 2.9); the
  server-only rules (Caddy, the live CA, restarts, sibling notes) live in
  [server.md](server.md), with a pointer from rules-core.md.
