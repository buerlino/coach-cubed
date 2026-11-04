# Work packages

One file per package, `<id>.md`, run with `pipeline/pipeline.sh <id>`. The format, the ids and how a run goes:
[../pipeline.md](../pipeline.md#package-files). A merged package's file is deleted in a later docs commit (git keeps it);
an unmerged one stays until its branch merges or is given up.

## Template

````markdown
# w7: the result view's cue list (dirac, sonnet, branch `wp/dirac-cue-list`)
**Why:** what is missing or broken, with evidence (a file:line, a screen ID from docs/ui-design.md, a log line).
**Read:** docs/ui-design.md "R1"; src/diagnostics.js `computeResults()`; the files the steps change, by repo path.
**Red first:** yes
1. Tests first: what the new tests check, and that they fail on phase-0.
2. The change, step by step, naming the files.
3. What to measure or report, if anything.
**Done when:**
- each line checkable by reading the diff or running a command;
- the tests named in step 1 pass, and `npm test` and the Python tests pass.
````

Leave out `**Red first:** yes` for a package with no test that could fail first (a research note, a build script). A
research package goes to einstein, a phone measurement to curie.

## The queue

Kept by the coordinating session; workers never edit it ([../pipeline.md](../pipeline.md#package-files)). Phase 5's
packages are cut from [../app-plan.md](../app-plan.md), which says what each one builds and why; `s1` and `s2` are backlog
fixes. Runs go one at a time: almost every package edits app/README.md and tests/README.md. Phone packages (`c20`,
`c34`, `c26`, `c30`, `c30b`, `c60`, `c31`, `c33`) run by day, with nordmu told. Before each run the coordinating session checks the package against
what merged since it was written (paths, the contracts' real names, what earlier reports asked for) and fixes its file
in a docs commit first. After a merge the row gets the merge commit; the file goes in a later docs commit.

| # | Id | Package | Worker | After | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | `s1` | A fixture without a diagnostics set fails loudly | schrödinger, sonnet | — | merged `b77f9ce` |
| 2 | `s2` | sync_clipper_fixtures takes any attempt number | schrödinger, sonnet | — | merged `cce33c3` |
| 3 | `d3` | The app's frame | dirac, sonnet | — | merged `60f1995` |
| 4 | `s4` | diagnostics.js's headless API | schrödinger, opus | `d3` | merged `3b0e915` |
| 5 | `s5` | The app's contracts | schrödinger, opus | `d3`, `s4` | merged `4d5d093` |
| 6 | `s6` | TF.js and pose-detection from source | schrödinger, opus | `d3` | merged `27732d8` |
| 7 | `s7` | The from-source bundle gives npm's numbers | schrödinger, sonnet | `s6` | merged `e44db95` |
| 8 | `c8` | The store | curie, sonnet | `s5` | merged `86265ea` |
| 9 | `s9` | The frame source (mediabunny) | schrödinger, sonnet | `s5` | merged `9d491e0` |
| 10 | `s10` | The pose engine | schrödinger, sonnet | `s5`, `s6`, `s7` | merged `13f7f78` |
| 11 | `c20` | The Capacitor shell, and the engine on the phone | curie, sonnet | `d3`, `s9`, `s10` | merged `5739c78` (by day, nordmu told; on Opus) |
| 12 | `c34` | The frame source and the cut on the phone | curie, opus | `c20` | merged `e1bac52` (by day, nordmu told) |
| 13 | `s11` | The scoring adapter | schrödinger, sonnet | `s4`, `s5` | merged `d65e3ed` |
| 14 | `s32` | Keep the lift's video: the marked range cut to MP4 | schrödinger, sonnet | `s9`, `c8` | merged `7dcb70b` |
| 15 | `s12` | The analysis job and its queue | schrödinger, opus | `s9`, `s10`, `s11`, `c8`, `s32` | merged `e4bbb8b`; FIX `s12f1` (the Analyse test's cut comparison, flaky) merged `d214912` |
| 16 | `s35` | Four contract changes (contracts 1, 2, 4, 5) | schrödinger, opus | `s9`, `s10`, `s11`, `s12` | merged `b972daf` |
| 17 | `s36` | A lift without a lift window says so | schrödinger, opus | `s35` | merged `f926b4f` |
| 18 | `s37` | batch_extract_tracks.py writes the diagnostics set | schrödinger, sonnet | — | merged `e8b2a92` |
| 19 | `s38` | One-frame steps from a cache | schrödinger, opus | `s35`, `c34` | NOT MERGED in run 20 (two fix rounds); FIX `s38f1` (nordmu, 2026-11-02) merged `4af1286` |
| 20 | `d41` | Import starts on the default lift; H and Q1 agree on a job's percent | dirac, sonnet | `d13`, `d15`, `d24` | merged `8b797a6` |
| 21 | `s42` | The tempo and symmetry cues say their time smoothing | schrödinger, sonnet | `s39` | merged `5550b77` |
| 22 | `c43` | No Android backup, so the privacy text holds | curie, sonnet | `d24`, `c20` | merged `f3eb21d` |
| 23 | `d13` | H and importing a video | dirac, sonnet | `d3`, `c8`, `s12` | merged `109eaeb` |
| 24 | `d14` | M1–M3, marking a lift | dirac, sonnet | `s9`, `s12`, `s35`, `s38` | merged `ca8b583` |
| 25 | `d15` | Q1, analysing | dirac, sonnet | `s12` | merged `ea03e35` |
| 26 | `d16` | A1's player with the skeleton overlay | dirac, sonnet | `s9`, `s11`, `s32`, `s35`, `s38` | merged `50f40bc` (no split) |
| 27 | `d17` | A1's timeline and cue cards | dirac, sonnet | `d16`, `s36` | merged `821593f` |
| | | **Look A0** (D7): nordmu, about 15 minutes on the Fairphone | | `d13`, `d14`, `d15`, `d17`, `c20` | not a gate |
| 28 | `c19` | The service worker, the app offline | curie, sonnet | `d3`, `s6`, `s12` | merged `5ccc0a0` |
| 29 | `c21` | The page test, offline | curie, sonnet | `d13`, `d14`, `d15`, `d17`, `c19` | merged `7f95223` (by day, nordmu told; one fix round; `test:page` now runs in every app run) |
| 30 | `s39` | The headless API gives A2's scoring lines and zones | schrödinger, opus | `s35`, `s36` | merged `2b93172` |
| 31 | `d18` | A2, a cue's detail | dirac, sonnet | `d17`, `s4`, `s39` | merged `b37cda9` (by day, nordmu told; two fix rounds; adds flow state `scoring`, screen S1b) |
| 32 | `s44` | scoreLift() returns the smoothed keypoints (A1 smooths only once) | schrödinger, sonnet | `d18` | merged `54f53fa` |
| 33 | `s45` | The API gives each cue's unit noun and how its verdict is decided | schrödinger, opus | `d18`, `s44` | merged `e3a87b6` |
| 34 | `d46` | A2's "Play the rep at ½×" opens A1 at the cue's phase | dirac, sonnet | `d18` | merged `908e96d` |
| 35 | `c47` | A test's browser ends with the test (the brave wrapper leak; nordmu, 2026-11-02) | curie, sonnet | — | merged `c3cf06f` |
| 36 | `c48` | The app tests leave no temp folders behind (9.3 GB in /tmp; nordmu, 2026-11-02) | curie, sonnet | — | merged `aef3346` (one fix round: red-first) |
| 37 | `d22` | A3, view options | dirac, sonnet | `d17`, `c8`, `d14`, `s35`, `c47` | merged `47abc6c` (resumed after run 38's OOM; one fix round: the unsure-joints switch) |
| 38 | `d23` | The screens v1 doesn't draw | dirac, sonnet | `d17`, `s12`, `c8`, `c47` | merged `2ec0c35` (one fix round: the report hidden behind the queue's merge of phase-0) |
| 39 | `d24` | S1, settings and about | dirac, sonnet | `c8` | merged `5d33a32` |
| 40 | `d25` | A4 and the responsive check | dirac, sonnet | `d18`, `c21`, `c47` | merged `ee43c27` (two fix rounds: the app tests, then A4's video column in a wide window) |
| 41 | `c26` | Milestone A on the Fairphone | curie, opus | `d13`, `d14`, `d18`, `c19`, `c20`, `c34`, `c43` | merged `2ecf071` (run 62: run 61's work after the docs-budget fix f4c49b7; run 60 died with its session) |
| 42 | `d51` | Q1's "Pick another video", and smoothing capped at 300 ms | dirac, sonnet | `d22`, `d23` | merged `d37d6f6`; its two follow-ups are `d56` and `d57` |
| 43 | `s50` | A re-marked lift replaces the old one once its analysis is done | schrödinger, opus | `d22` | merged `8d03665`; its four answers accepted as built (nordmu, 2026-11-02); FIX `s50f1` (its tests' path check matched the new lift's id; run 45's checks read an uncommitted tree, now refused) merged `4687875` |
| 44 | `c52` | The tools' browser leaves no org.chromium.Chromium folders in /tmp | curie, sonnet | `c47`, `c48` | NOT MERGED in run 47 (two fix rounds; branch `wp/curie-chromium-tmp` kept at `3b0c477`); laptop only (nordmu, 2026-11-02, on c48's report); FIX `c52f1` (`exec sleep` in the test's fake browser, `removeTmp()` best-effort; nordmu, 2026-11-03) merged `6835b2f` (round 0) |
| 45 | `s49` | One lift registry, and the guide to adding a lift or a cue (Noah's handover of the lift side) | schrödinger, opus | `d25` | merged `b18ac7b` |
| 46 | `d53` | Pick the video, then "Which lift?" (L1); M's lift switch goes | dirac, sonnet | `d51`, `s50`, `s49` | merged `be72e68` (one fix round) |
| 47 | `d54` | M1–M3: the steps are the buttons, and nothing moves | dirac, opus | `d53` | merged `2aad2cf` |
| 48 | `d55` | Fewer words, symbols, and a cue where a screen goes on below | dirac, sonnet | `d54` | merged `cf69173` (one fix round: README wording) |
| 49 | `d56` | Q1 offers "Pick another video" wherever another video helps (unreadable, unknown format) | dirac, sonnet | `d53`, `d55` | merged `dcc644b` |
| 50 | `d57` | The layout check measures Q1's failed panels (No person found, unreadable) | dirac, sonnet | `d56` | merged `4ccac5d` |
| | | **Checkpoint A:** nordmu uses milestone A on the Fairphone; feedback by screen ID. Then **2.7 and 2.8** with the queue empty (D8) | | `c26` | passed for laptop rows (nordmu, 2026-11-02: feedback given on the PWA, more to come; `c26` still runs by day; 2.7 done 2026-11-03 (LICENSE and the SPDX headers), 2.8 in its own session after `c26` (nordmu, 2026-11-03)) |
| 51 | `c33` | The tester APK: the real name and ID, release signing | curie | checkpoint A, 2.8, question 10, the key's holder | id only: written after checkpoint A |
| 52 | `c27` | Capture and the rolling buffer: the camera's real rate, H.264 with a keyframe a second, the 60 s ring, snapshots as MP4, the wake lock; on fakes and headless Brave's fake camera | curie, opus | checkpoint A | merged `34b6ba8` (one fix round: the ring's dropped chunks; no `c27b`) |
| 53 | `d28` | R1 and R2: setting up the camera, recording; the session | dirac, sonnet | `c27`, `s49`, `d53`, `d55` | merged `7cba248` (two fix rounds: S1's replay mode saved, then the page test's intro tap retried after a load flake) |
| 54 | `d29` | R3, the replay, and marking a kept lift (back to R2 with it queued) | dirac, sonnet | `d28`, `d14`, `d54` | merged `1e180ca` (two fix rounds: a page-test `home -> home` once, guarded, cause unproven; then the queue-line tap) |
| 55 | `d29b` | R3b, the delayed view, as a setting | dirac, opus | `d29` | merged `adbc83e` |
| 56 | `d58` | A1 and A2 fit the window, A1's cue list fades, Welcome says it once (d54's and d55's follow-ups; nordmu, 2026-11-03) | dirac, sonnet | `d54`, `d55` | merged `1721b24` |
| 57 | `c61` | One camera at a time, a Start that says when it didn't, a failed camera that keeps the lift (the milestone B review, 2026-11-03) | curie, opus | `d29b` | merged `0ff2fe0` (one fix round: the page test's R3b problem text); laptop only (nordmu, 2026-11-03: Try again and keep the lift) |
| 58 | `s59` | s12's watchdog from c26's numbers: the stall time, restarts, tick and Q1's time left | schrödinger, sonnet | `c26` | id only: written from c26's report (nordmu, 2026-11-02); laptop only, can run the night after `c26` |
| 59 | `c30` | The camera on the Fairphone: the permission, the real rate, the ring's memory | curie, opus | `d28`, `c26` | waits; phone: by day, nordmu told (after `c26`, by day); file checked against c27, d28, d29 and d29b on 2026-11-03 |
| 60 | `c30b` | Recording and analysis together on the Fairphone: a job beside recording, the screen kept on, the app in the background | curie, opus | `c30`, `d29b` | waits; phone: by day, nordmu told; file checked against c27, d29 and d29b on 2026-11-03 |
| 61 | `c60` | Milestone A on the Samsung S8+ (`ce011711cdc8a10c05`, Android 9, Chrome 101 as the WebView, kept: nordmu won't update it): the PWA in Chrome and the APK (question 3); what an old Chrome lacks gets a fallback (`100vh` before `100dvh`, Chrome 108+) | curie, opus | `c26` | id only: written from c26's report; phone: by day, nordmu told (nordmu, 2026-11-03) |
| 62 | `c31` | A session on the Fairphone, 30–60 minutes: heat, battery, storage, memory | curie, sonnet | `c30b` | waits; phone: by day, nordmu present; the phone films the laptop playing an example clip (nordmu, 2026-11-02) |
| | | **Checkpoint B:** nordmu runs a real gym session | | `c31` | |
| 63 | `c40` | The handover: the pipeline runnable for Noah | curie | checkpoint B | id only; laptop only |

Gates outside the queue ([../app-plan.md](../app-plan.md#gates-outside-the-sessions)): no APK goes to testers before
`c33`, which needs the name and the package ID (question 10) and the signing key's holder.
