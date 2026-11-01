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
fixes. One run at a time; packages with no file in common may run side by side when nordmu wants (`d3` and `s4`, for
one). Before each run the coordinating session checks the package against what merged since it was written (paths, the
contracts' real names, what earlier reports asked for) and fixes its file in a docs commit first. After a merge the row
gets the merge commit; the file goes in a later docs commit.

| # | Id | Package | Worker | After | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | `s1` | A fixture without a diagnostics set fails loudly | schrödinger, sonnet | — | **next:** 4.4's first run, watched by nordmu |
| 2 | `s2` | sync_clipper_fixtures takes any attempt number | schrödinger, sonnet | — | ready |
| 3 | `d3` | The app's frame | dirac, sonnet | — | ready |
| 4 | `s4` | diagnostics.js's headless API | schrödinger, opus | — | ready |
| 5 | `s5` | The app's contracts | schrödinger, opus | `d3`, `s4` | waits |
| 6 | `s6` | TF.js and pose-detection from source | schrödinger, opus | `d3` | waits |
| 7 | `s7` | The from-source bundle gives npm's numbers | schrödinger, sonnet | `s6` | waits |
| 8 | `c8` | The store | curie, sonnet | `s5` | waits |
| 9 | `s9` | The frame source | schrödinger, sonnet | `s5` | waits |
| 10 | `s10` | The pose engine | schrödinger, sonnet | `s5`, `s6` | waits |
| 11 | `s11` | The scoring adapter | schrödinger, sonnet | `s4`, `s5` | waits |
| 12 | `s12` | The analysis job and its queue | schrödinger, opus | `s9`, `s10`, `s11` | waits |
| 13 | `d13` | H and importing a video | dirac, sonnet | `d3`, `c8` | waits |
| 14 | `d14` | M1–M3, marking a lift | dirac, sonnet | `s9`, `s12` | waits |
| 15 | `d15` | Q1, analysing | dirac, sonnet | `s12` | waits |
| 16 | `d16` | A1's player with the skeleton overlay | dirac, sonnet | `s9`, `s11` | waits |
| 17 | `d17` | A1's timeline and cue cards | dirac, sonnet | `d16` | waits |
| 18 | `d18` | A2, a cue's detail | dirac, sonnet | `d17`, `s4` | waits |
| 19 | `c19` | The service worker, the app offline | curie, sonnet | `d3`, `s6` | waits |
| 20 | `c20` | The Capacitor shell | curie, sonnet | `d3`, `s9` | waits |
| 21 | `c21` | The page test, offline | curie, sonnet | `d17`, `c19` | waits |
| 22 | `d22` | A3, view options | dirac, sonnet | `d17`, `c8` | waits |
| 23 | `d23` | The screens v1 doesn't draw | dirac, sonnet | `d17` | waits |
| 24 | `d24` | S1, settings and about | dirac, sonnet | `c8` | waits |
| 25 | `d25` | A4 and the responsive check | dirac, sonnet | `d18`, `c21` | waits |
| 26 | `c26` | Milestone A on the Fairphone | curie, sonnet | `d14`, `d18`, `c19`, `c20` | waits |
| | | **Checkpoint A:** nordmu uses milestone A on the Fairphone; feedback by screen ID | | `c26` | |
| 27 | `c27` | Capture and the rolling buffer | curie | checkpoint A | id only: written after checkpoint A |
| 28 | `d28` | R1 and R2 | dirac | `c27` | id only |
| 29 | `d29` | R3 and R3b | dirac | `d28`, `d14` | id only |
| 30 | `c30` | Recording and analysis together | curie | `d29`, `s12` | id only |
| 31 | `c31` | A session on the Fairphone | curie | `c30` | id only |
| | | **Checkpoint B:** nordmu runs a real gym session | | `c31` | |

Gates outside the queue ([../app-plan.md](../app-plan.md#gates-outside-the-sessions)): no APK goes to testers before the
name, the package ID and the signing key's holder are settled.
