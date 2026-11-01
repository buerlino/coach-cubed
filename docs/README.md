# Docs index

What to read, and where each fact lives. One place per fact: the binding
rules in [rules-core.md](rules-core.md), decisions and open questions in
[decisions.md](decisions.md), open items in [backlog.md](backlog.md), the
restructuring's steps and status in
[restructure-plan.md](restructure-plan.md). Each doc is the source of truth
for its own area: if you change something a doc describes, update that doc in
the same commit. Update this index only when a doc is added, moved or
removed. `npm test` checks every link, that every path named here exists, and
the size budgets ([tests/docs.test.js](../tests/docs.test.js)).

## Read first

| Doc | Holds |
| --- | --- |
| [rules-core.md](rules-core.md) | **Binding:** the goal, the four principles, the hard rules (offline, nothing leaves the phone, licence-compatible dependencies), and the rules for changing this repo: relative paths, the minimal root, moving a file, landmines, when to stop and ask (in AGENTS.md until step 2.9). |
| [restructure-plan.md](restructure-plan.md) | The restructuring toward an offline 0.1.0 (from 2026-10-31): "Next session starts here", the findings, the phases and their status. |
| [map.md](map.md) | A frozen snapshot of 2026-10-31: every tracked file in 12 areas, what each does, offline feasibility, hidden couplings, provenance, and the phone test on the Fairphone 6. Read "Hidden couplings" before any move; current facts are in the docs below. |
| [../AGENTS.md](../AGENTS.md) | The entry point every agent loads (CLAUDE.md points to it): what coach is, the commands, the workflow, the layout, the conventions. At most 40 lines and 6 kB. |

## Where each fact lives

| Doc | Holds |
| --- | --- |
| [decisions.md](decisions.md) | Every decision with who and when; the open questions and who answers them. |
| [backlog.md](backlog.md) | Open bugs, unverified assumptions and stale text in code that stays. |
| [../THIRD_PARTY.md](../THIRD_PARTY.md) | Every third-party component, in the app and around it: name, version, licence, source. |
| [authors.md](authors.md) | Who wrote how much of the code, for the licence consent (question 1). |
| [server.md](server.md) | The Flask server as dev tooling: what runs, the checkpoints, the setup and launch scripts, testing under the `/coach/` prefix, its landmines, the sibling notes on the deploy machine. |

## Reference

| Doc | Covers |
| --- | --- |
| [pose-spike.md](pose-spike.md) | Step 3.7, the working pick (nordmu, 2026-11-01): the on-device pose spike's numbers on the Fairphone (speed, memory, agreement with ViTPose-L, capture, heat), the licence gate, F-Droid (3.8) and the decision. |
| [fixture-data-contract.md](fixture-data-contract.md) | The consuming side: `track.json`/`manifest.json` schemas, where profiles live, the endpoints a page reads them through, and what the extracted data is actually like. |
| [../tests/README.md](../tests/README.md) | What each test file covers, how to run the tests, and how a lift video becomes a fixture with a golden snapshot. |
| [../tests/fixtures/README.md](../tests/fixtures/README.md) | The fixture layout, global vs. local scope, where each example clip came from and why none is committed, the limb and sign profiles. |
| [dataset-stats.md](dataset-stats.md) | How many clips, how many survived pose extraction, why the rest didn't, and the command that regenerates each number. |
| [clipper-pipeline.md](clipper-pipeline.md) | Step by step: how `scripts/sync_clipper_fixtures.py` turns a clip cut by clipper (its own repo, `weightlifting-clipper`, since step 2.3) into a coach test case. |
| [train-data-todo.md](train-data-todo.md) | Open work on the clipper dataset: the playback failure, stance and gender labelling gaps, 3D calibration per session, and what has already been ruled out. Moves with the train tab. |
| [../parked/README.md](../parked/README.md) | What is parked, since when, and what parked means. The research report's own guide: [../parked/report/README.md](../parked/report/README.md). |
| [../src/anatomy/README.md](../src/anatomy/README.md) | The anatomy view and the Movement Lab: how to use them, and how their modules fit together. |
