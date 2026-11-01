# pipeline/

The agent pipeline's scripts: one work package from its file to a merge into `phase-0`, with fresh headless agents. How it
works and its rules: [docs/pipeline.md](../docs/pipeline.md). Ported from pascaline's `scripts/` and `tools/`.

| File | Does |
| --- | --- |
| `pipeline.sh` | One run: bundle, worker, the merge queue, checks, audit, merge. `pipeline.sh <id>`; `pipeline.sh selftest` runs the tests below. Options in its header. |
| `lib.sh` | Its helpers (the agents, package headings, red-first, locks, child processes), sourced by it and the tests. |
| `devlock.sh` | Locks: coach's own (`integ`, `branch-*`) in the main checkout's `.coord/locks`, the machine's (`host-cpu`, the phone) shared with pascaline; `slice` for heavy work. |
| `gc.sh` | Archives finished runs in `.tasks/archive/`; moves, never deletes. Runs after every third run. |
| `stay-awake.sh` | Keeps the phone awake for a measurement and puts its settings back (curie only). |
| `*.test.sh` | The tests: throwaway repos with a stub `claude`, no real agent. About 30 s in all. |

```sh
pipeline/pipeline.sh w7 --dry-run   # the plan and the bundle, nothing started
pipeline/pipeline.sh w7             # the run; one RESULT line on stdout
tail -n 20 .coord/log.md            # in the main checkout: one line per step
pipeline/devlock.sh status          # who holds what
```
