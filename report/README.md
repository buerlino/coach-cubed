# report

Technical note on `coach`: the pose model, the deployment, the smoothing math,
and the geometry of each diagnostic. Source of truth for the numbers is the
code itself (`src/vitpose_backend.py`, `src/app.py`'s `smoothKeypoints` /
`retimeAlongPath` / `cubicAt`, and `diagnostics.js`) — if a threshold moves
there, it moves here and in the notebook.

| File | Role |
| --- | --- |
| `report.tex` | The whole document. Self-contained: `thebibliography`, no `.bib`. |
| `depth-math.md` | How 2D keypoints become 3D: foreshortening, scale from the plate, the depth-sign ambiguity, and the balance test that resolves it. Mirrors `src/depth_backend.py`. |
| `analysis.ipynb` | Makes the three figures. A line-for-line Python port of the browser's smoothing and diagnostics, run over the example clip. |
| `extract_track.py` | Runs the real pipeline (YOLOv8 → ViTPose → SORT → main-person filter) on a clip and caches `<clip>.track.json`, the same payload `/api/pose/video` returns. |
| `examples/` | `athlete-a-trim.mp4` and its cached track. |
| `figures/` | `smoothing.pdf`, `first-pull.pdf`, `second-pull.pdf`, `depth-geometry.pdf`, `depth-signs.pdf` — notebook output, tracked so the PDF builds without a GPU. |
| `Makefile` | `make` -> `report.pdf`, `make clean` drops the aux files. |

## Building the PDF

```sh
make          # in this directory
```

Needs `texlive-latex-base texlive-latex-recommended texlive-fonts-recommended`
(the preamble uses `amsmath`, `geometry`, `lmodern`, `microtype`, `graphicx`,
`hyperref`). `lmodern` is there because `microtype`'s font expansion needs
outline fonts and the bitmap CM set isn't installed.

## Regenerating the figures

```sh
jupyter nbconvert --to notebook --execute --inplace analysis.ipynb
```

The notebook only needs numpy + matplotlib (any env). If
`examples/athlete-a-trim.track.json` is missing it calls `extract_track.py`
through the `coach` conda interpreter, which needs the torch/ROCm stack and
the checkpoints in `~/models/easy_vitpose`. To use a different clip, point
`CLIP` in the first code cell at it.

The port in the notebook is deliberately not vectorised or tidied: it keeps the
JS's constants, names and loop structure so a diff against `src/app.py` /
`diagnostics.js` is mechanical. If the browser code changes, change the port
the same way, re-execute, rebuild.
