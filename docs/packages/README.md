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
`c26`, `c31`, `c33`) run by day, with nordmu told. Before each run the coordinating session checks the package against
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
| 9 | `s9` | The frame source (mediabunny) | schrödinger, sonnet | `s5` | waits |
| 10 | `s10` | The pose engine | schrödinger, sonnet | `s5`, `s6`, `s7` | waits |
| 11 | `c20` | The Capacitor shell, and the engine on the phone | curie, sonnet | `d3`, `s9`, `s10` | waits; phone: by day, nordmu told |
| 12 | `s11` | The scoring adapter | schrödinger, sonnet | `s4`, `s5` | waits |
| 13 | `s32` | Keep the lift's video: the marked range cut to MP4 | schrödinger, sonnet | `s9`, `c8` | waits; new (D6) |
| 14 | `s12` | The analysis job and its queue | schrödinger, opus | `s9`, `s10`, `s11`, `c8`, `s32` | waits |
| 15 | `d13` | H and importing a video | dirac, sonnet | `d3`, `c8` | waits |
| 16 | `d14` | M1–M3, marking a lift | dirac, sonnet | `s9`, `s12` | waits |
| 17 | `d15` | Q1, analysing | dirac, sonnet | `s12` | waits |
| 18 | `d16` | A1's player with the skeleton overlay | dirac, sonnet | `s9`, `s11`, `s32` | waits; L at the limit: split point `d16b` |
| 19 | `d17` | A1's timeline and cue cards | dirac, sonnet | `d16` | waits |
| | | **Look A0** (D7): nordmu, about 15 minutes on the Fairphone | | `d13`, `d14`, `d15`, `d17`, `c20` | not a gate |
| 20 | `c19` | The service worker, the app offline | curie, sonnet | `d3`, `s6`, `s12` | waits |
| 21 | `c21` | The page test, offline | curie, sonnet | `d13`, `d14`, `d15`, `d17`, `c19` | waits |
| 22 | `d18` | A2, a cue's detail | dirac, sonnet | `d17`, `s4` | waits |
| 23 | `d22` | A3, view options | dirac, sonnet | `d17`, `c8`, `d14` | waits |
| 24 | `d23` | The screens v1 doesn't draw | dirac, sonnet | `d17`, `s12`, `c8` | waits |
| 25 | `d24` | S1, settings and about | dirac, sonnet | `c8` | waits |
| 26 | `d25` | A4 and the responsive check | dirac, sonnet | `d18`, `c21` | waits |
| 27 | `c26` | Milestone A on the Fairphone | curie, sonnet | `d13`, `d14`, `d18`, `c19`, `c20` | waits; phone: by day, nordmu told (airplane mode) |
| | | **Checkpoint A:** nordmu uses milestone A on the Fairphone; feedback by screen ID. Then **2.7 and 2.8** with the queue empty (D8) | | `c26` | |
| 28 | `c33` | The tester APK: the real name and ID, release signing | curie | checkpoint A, 2.8, question 10, the key's holder | id only: written after checkpoint A |
| 29 | `c27` | Capture and the rolling buffer (cuts with `s32`'s cut) | curie | checkpoint A | id only |
| 30 | `d28` | R1 and R2 | dirac | `c27` | id only |
| 31 | `d29` | R3 and R3b | dirac | `d28`, `d14` | id only |
| 32 | `c30` | Recording and analysis together | curie | `d29`, `s12` | id only |
| 33 | `c31` | A session on the Fairphone | curie | `c30` | id only; phone: by day |
| | | **Checkpoint B:** nordmu runs a real gym session | | `c31` | |

Gates outside the queue ([../app-plan.md](../app-plan.md#gates-outside-the-sessions)): no APK goes to testers before
`c33`, which needs the name and the package ID (question 10) and the signing key's holder.
