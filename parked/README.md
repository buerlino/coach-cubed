# parked/

Areas outside 0.1.0's core, moved here unchanged during the restructuring
(nordmu, 2026-10-31; [docs/decisions.md](../docs/decisions.md)). Parked means
kept, not deleted: each area was moved with `git mv`, so `git log --follow`
still reaches its history, and it is unwired from the app.

Parked code is not maintained. `npm test` doesn't run its tests, and nothing
in the core may import from here. Each area's entry in
[docs/map.md](../docs/map.md) describes what it does and what it was coupled
to; reviving one means moving it back and re-wiring those couplings.

| Folder | What | Parked |
| --- | --- | --- |
| [report/](report/) | The LaTeX research report (pose, smoothing, depth math) and the notebook that makes its figures. `make` in that folder builds the PDF (it needs the TeX fonts its README lists). | 2026-10-31, step 2.3 |
