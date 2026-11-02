# Who wrote the code

For the licence: Noah chose GPL-3.0-or-later and all four authors agreed.
On 2026-11-02 nordmu proposed AGPL-3.0-or-later instead; it waits for Noah,
and the written OKs still to collect are OKs to AGPL
([decisions.md](decisions.md#licence), question 11).
Counted on 2026-10-31 at the end of step 2.6 (`e5d3d60`).

## How it was counted

`git blame -w` on `HEAD`, counting lines per author. "noah" and "noah
stauble" are one person, Noah Stauble. The core is counted with move and copy
detection (`-M -C -C`), so code moved or copied during the restructuring
still counts for whoever first wrote it; the areas use `-M` only. "Code" is
every tracked `.py`, `.js`, `.mjs`, `.sh`, `.bat`, `.command`, `.css`,
`.html` and `.tex` file outside `vendor/` folders; the third-party code is in
[THIRD_PARTY.md](../THIRD_PARTY.md).

nordmu's count includes the restructuring itself (phase-0, committed as
nordmu with Claude as co-author). `src/pose/coco17.mjs` counts as nordmu's,
but its mapping was merged in step 2.0 from three copies, the first of them
JMLuner's.

## The core

The core of 0.1.0 is map areas 1–3: the lift analysis page, the diagnostics
engine and the in-browser pose ([map.md](map.md)).

| File | Lines | Noah Stauble | nordmu | Nicola Walker | JMLuner |
| --- | ---: | ---: | ---: | ---: | ---: |
| `src/diagnostics.js` | 2,867 | 1,770 (62%) | 500 (17%) | 597 (21%) | — |
| `src/app.py`, the old page (`INDEX_HTML`) | 3,434 | 3,034 (88%) | 308 (9%) | 68 (2%) | 24 (1%) |
| `src/app.py`, the server | 1,224 | 991 (81%) | 197 (16%) | 15 (1%) | 21 (2%) |
| `src/pose/pose.mjs`, `local-mode.mjs`, `coco17.mjs` | 99 | — | 18 (18%) | — | 81 (82%) |
| **Total** | **7,624** | **5,795 (76%)** | **1,023 (13%)** | **680 (9%)** | **126 (2%)** |

The old page is frozen and will be replaced by the new UI (plan Phase 5), so
the part of the core expected to ship in 0.1.0 is mainly `diagnostics.js`
and the in-browser pose.

## Everything else

| Area | Lines | Noah Stauble | nordmu | Nicola Walker | JMLuner |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dev server and scripts (`src/*.py` besides `app.py`, `scripts/`) | 4,576 | 3,782 (83%) | 736 (16%) | 8 (0%) | 50 (1%) |
| Anatomy, Movement Lab, preview launchers | 2,176 | 164 (8%) | 22 (1%) | — | 1,990 (91%) |
| Tests | 1,140 | 595 (52%) | 178 (16%) | 74 (6%) | 293 (26%) |
| Parked (`parked/`) | 1,666 | 1,452 (87%) | 214 (13%) | — | — |
| The spike (`spike/`) | 138 | — | 138 (100%) | — | — |
| **All code** | **17,320** | **11,795 (68%)** | **2,304 (13%)** | **762 (4%)** | **2,459 (14%)** |
| Docs (`*.md`) | 5,000 | 2,125 (43%) | 2,214 (44%) | 319 (6%) | 342 (7%) |

So all four authors have code in the core, and the licence needed the
consent of all four: Noah Stauble, nordmu, Nicola Walker and JMLuner.
