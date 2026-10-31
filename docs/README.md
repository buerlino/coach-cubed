# Docs index

What to read, and where each fact lives. One place per fact: the binding
rules in [rules-core.md](rules-core.md), decisions and open questions in
[decisions.md](decisions.md), open items in [backlog.md](backlog.md), the
restructuring's steps and status in
[restructure-plan.md](restructure-plan.md). Each doc is the source of truth
for its own area: if you change something a doc describes, update that doc in
the same commit. Update this index only when a doc is added, moved or
removed.

## Read first

| Doc | Holds |
| --- | --- |
| [rules-core.md](rules-core.md) | **Binding:** the goal, the four principles, the hard rules (offline, nothing leaves the phone, licence-compatible dependencies). |
| [restructure-plan.md](restructure-plan.md) | The restructuring toward an offline 0.1.0 (from 2026-10-31): "Next session starts here", the findings, the phases and their status. |
| [map.md](map.md) | Every tracked file in 12 areas: what each does, offline feasibility, hidden couplings, provenance, and the phone test on the Fairphone 6. Read "Hidden couplings" before any move. |
| [../AGENTS.md](../AGENTS.md) | How to change things here: relative paths, moves and the grep, landmines, when to stop and ask. |

## Where each fact lives

| Doc | Holds |
| --- | --- |
| [decisions.md](decisions.md) | Every decision with who and when; the open questions and who answers them. |
| [backlog.md](backlog.md) | Open bugs, unverified assumptions and stale text in code that stays. |
| [server.md](server.md) | The Flask server as dev tooling: testing under the `/coach/` prefix, its landmines, the sibling notes on the deploy machine. |

## Reference

| Doc | Covers |
| --- | --- |
| [fixture-data-contract.md](fixture-data-contract.md) | The consuming side: `track.json`/`manifest.json` schemas, where profiles live, the endpoints a page reads them through, and what the extracted data is actually like. Its keypoint order is wrong in one place (see backlog). |
| [../tests/README.md](../tests/README.md) | End to end: turning lift videos into fixtures, labels, golden snapshots, running `npm test`. |
| [../tests/fixtures/README.md](../tests/fixtures/README.md) | The fixture directory layout, `manifest.json` schema, global vs. local scope. |
| [deploy.md](deploy.md) | Deploy shape, checkpoints (incl. the gated SAM 3 download), Caddy/ports, conda env, auth. Stale in places: read [server.md](server.md) first. |
| [dataset-stats.md](dataset-stats.md) | How many clips, how many survived pose extraction, why the rest didn't, and the command that regenerates each number. |
| [clipper-pipeline.md](clipper-pipeline.md) | Step by step: how `scripts/sync_clipper_fixtures.py` turns a `clipper/` clip into a coach test case. Leaves with clipper. |
| [train-data-todo.md](train-data-todo.md) | Open work on the clipper dataset: deployment map, stance/gender labelling gaps, 3D calibration per session, and what has already been ruled out. Moves with the train tab. |
| [../report/README.md](../report/README.md) | What's in the LaTeX report, how to build the PDF, how to regenerate its figures. To be parked as research. |
