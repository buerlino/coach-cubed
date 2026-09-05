# report

Technical note on `coach`: the pose model, the deployment, the smoothing math,
and the geometry of each diagnostic. Source of truth for the numbers is the
code itself (`vitpose_backend.py`, `app.py`'s `smoothKeypoints` /
`retimeAlongPath` / `cubicAt`, and `diagnostics.js`) — if a threshold moves
there, it moves here.

| File | Role |
| --- | --- |
| `report.tex` | The whole document. Self-contained: `thebibliography`, no `.bib`, no figures. |
| `Makefile` | `make` -> `report.pdf`, `make clean` drops the aux files. |

## Building

```sh
make          # in this directory
```

Needs a LaTeX toolchain. The preamble uses only `amsmath`, `geometry`,
`booktabs`, `microtype` and `hyperref`, so the three base texlive packages are
enough — no `texlive-latex-extra` (~500 MB) required:

```sh
sudo apt-get install -y texlive-latex-base texlive-latex-recommended texlive-fonts-recommended
```
