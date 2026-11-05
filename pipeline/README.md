# pipeline/

The agent pipeline's scripts: one work package from its file to a merge into `phase-0`, with fresh headless agents. How it
works and its rules: [docs/pipeline.md](../docs/pipeline.md). Ported from pascaline's `scripts/` and `tools/`.

| File | Does |
| --- | --- |
| `pipeline.sh` | One run: bundle, worker, the merge queue, checks, audit, merge. `pipeline.sh <id>`; `pipeline.sh selftest` runs the tests below. Options in its header. |
| `lib.sh` | Its helpers (the agents, package headings, red-first, locks, child processes), sourced by it and the tests. |
| `devlock.sh` | Locks: coach's own (`integ`, `branch-*`) in the main checkout's `.coord/locks`, the machine's (`host-cpu`, the phone) shared with pascaline; `slice` for heavy work. |
| `detach.sh` | Starts one run as a systemd user service, `coach-<name>.service`, so it outlives the session that starts it. |
| `gc.sh` | Archives finished runs in `.tasks/archive/`; moves, never deletes. Runs after every third run. |
| `stay-awake.sh` | Keeps the phone awake for a measurement and puts its settings back (curie only). |
| `*.test.sh` | The tests: throwaway repos with a stub `claude`, no real agent. About 30 s in all. |

```sh
pipeline/pipeline.sh w7 --dry-run   # the plan and the bundle, nothing started
pipeline/pipeline.sh w7             # the run; one RESULT line on stdout
pipeline/detach.sh w7 w7            # the same run, detached from this session (log: .coord/detached-w7.log)
tail -n 20 .coord/log.md            # in the main checkout: one line per step
pipeline/devlock.sh status          # who holds what
```

**A run started from a session** (by day, a phone package): `pipeline/detach.sh <id> <id>`, never `systemd-run --scope`
or a background Bash command. A run is a child of the shell that starts it, scope or not, and dies when that session
ends: c26 (run 60) died that way on 2026-11-03 after 33 minutes and left the phone in airplane mode. `detach.sh` makes
it a systemd user service (`coach-<id>.service`, `OOMPolicy=continue`); stdout goes to `.coord/detached-<id>.log`;
`systemctl --user stop coach-<id>.service` ends it cleanly. A curie run that dies anyway leaves the phone as it was:
check `adb -s 4d42e62f shell settings get global airplane_mode_on` and run `pipeline/stay-awake.sh 4d42e62f
--restore-real`. faraday's runs stay its own children: the night lives as long as its session does.

**Resuming:** a run on a branch that already exists reuses its worktree, merges `phase-0` in, and tells the worker to
continue from the commits it finds (a fresh worker sees only the bundle).
