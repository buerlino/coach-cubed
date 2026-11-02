# coach: directives for AI agents

coach films a lift and gives technique feedback cue by cue: pose keypoints (COCO-17, `[y, x, conf]`) scored by `src/diagnostics.js`, shown as a skeleton over the video, keypoint plots and a verdict per cue. It is being cut down to 0.1.0, an offline phone app (PWA and Android APK) with pose running on the phone. The Flask server with ViTPose stays as dev tooling, for reference tracks and goldens.

**[docs/rules-core.md](docs/rules-core.md) is binding:** the goal, the principles, the hard rules, and the rules for changing this repo (relative paths, the minimal root, moving a file, landmines, when to stop and ask). Read it first; where the two differ, rules-core wins. Where every other fact lives: [docs/README.md](docs/README.md).

## Commands (from the repo root)
```sh
npm test                                              # the JS tests and the docs checks (node:test, no dependencies)
python3 -m unittest discover -s tests -p 'test_*.py'  # the Python tests
npm --prefix app test                                 # the new app's tests (app/); node app/tools/assemble.mjs builds app/dist/
python3 launchers/run_original.py                     # the local preview, pose in the browser: http://127.0.0.1:8785/
./scripts/coach_launch.sh local                       # the full app, ViTPose on the server: http://127.0.0.1:8080
```
Setup for both (the `.venv`, the checkpoints): [README.md](README.md). The server and its scripts: [docs/server.md](docs/server.md).

## Workflow
- During the restructuring window (from 2026-10-31) all work happens on branch `phase-0`, in the worktree `.claude/worktrees/phase-0`; `main` and the `pre-cleanup` tag stay untouched. What to do next: [docs/restructure-plan.md](docs/restructure-plan.md), "Next session starts here".
- Work packages run through the agent pipeline, one package per run: `pipeline/pipeline.sh <id>` (worker, checks, audit, merge into `phase-0`). How it works and its rules: [docs/pipeline.md](docs/pipeline.md).
- One step per commit, with both test commands passing (after a move, the grep too). Never push, and never rewrite history, without nordmu's explicit OK.
- Decisions belong to nordmu, or to Noah where [docs/decisions.md](docs/decisions.md) says so: ask, don't guess, and record the answer there.

## Layout
What each folder holds: the Layout table in [README.md](README.md#layout).

## Conventions
- One place per fact ([docs/README.md](docs/README.md) says which). A change updates the doc that describes it in the same commit; docs are rewritten in place, git keeps the history. No status, history or reasoning in this file.
- Root special files are uppercase (`README.md`, `THIRD_PARTY.md`); everything under `docs/` is lowercase-kebab-case. Every subfolder with its own docs has a `README.md`.
- The root README's Layout table and docs/README.md are the maps: update them when a folder or doc is added or moved.
- Budgets and links are tested (`tests/docs.test.js`): this file at most 40 lines and 6 kB, CLAUDE.md at most 10 lines.
