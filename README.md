# coach

Local anatomy preview, version 5: see [START_HERE.md](START_HERE.md). Use `python launchers/run_original.py` for the original UI or `python launchers/run_anatomy.py` for the teal UI. Generic `python launchers/run_local.py` opens the original UI. The anatomy workspace at `/squat/` and the original workspace at `/` both support the integrated exercise tools.

A minimal website around the ViTPose model: upload or record a lift, get a
pose track, and see per-rep technique diagnostics scored from the keypoints
(back angle, extension, tempo, symmetry, ...). Same deploy shape as `tecna`
(Flask + waitress behind Caddy, tailnet-reachable) — see
[`docs/deploy.md`](docs/deploy.md) for why it differs where it does.

## Quickstart

```sh
./scripts/setup_conda_linux.sh   # or setup_conda_mac.sh / setup_no_conda_linux.sh
./scripts/download_models.sh     # pulls the ViTPose + YOLOv8 checkpoints
./scripts/coach_launch.sh local  # app only, http://127.0.0.1:8080, no TLS/Caddy
```

`./scripts/coach_launch.sh full` also ensures the shared gateway for
LAN/tailnet access (coach is served at `/coach/`, alongside the box's other
apps) and claims GPU priority so its models load into a free card;
`./scripts/coach_launch.sh stop` stops either mode. See
[`docs/deploy.md`](docs/deploy.md) for the full picture (checkpoints, ports,
conda env, auth).

## Layout

| Path | What's there |
| --- | --- |
| [`src/`](src/) | The app: `app.py` (routes), `vitpose_backend.py` / `equipment_backend.py` / `depth_backend.py` (ML, kept out of `app.py`), `diagnostics.js` (the diagnostic registry, runs client-side), `pose/` (MediaPipe pose in the browser, mapped to COCO-17). |
| [`clipper/`](clipper/) | The clip-cutting tool (downloads a session video, trims one file per lift attempt) — its own project, merged in with history intact; see [`clipper/README.md`](clipper/README.md). |
| [`scripts/`](scripts/) | Everything you run for the production deploy: setup, model download, launch/stop, port cleanup, fixture batch-extraction (incl. syncing fixtures straight from `clipper/`'s output — see [`tests/README.md`](tests/README.md)). |
| [`launchers/`](launchers/) | The zero-install local preview: `run_local.py`/`run_original.py`/`run_anatomy.py`/`run_squat.py` and their double-click `.command`/`.bat` twins. All `cd` to the repo root before touching `.venv` or `src/`, so they only work run from (or launched from within) this folder — don't move them further apart. |
| [`tests/`](tests/) | Fixture-driven golden tests for `diagnostics.js`. Start at [`tests/README.md`](tests/README.md). |
| [`report/`](report/) | LaTeX writeup of the pose model, smoothing math, and diagnostic geometry, plus the notebook that generates its figures. Start at [`report/README.md`](report/README.md). |
| [`docs/`](docs/) | Everything below. |
| [`reference/`](reference/) | Static images (`barbell.png`, `plates.png`) used as detection prompts/overlay references. |
| `vendor/` | `easy_ViTPose`, as a git submodule. |
| `Caddyfile`, `pki-public/`, `log/` | The deploy's reverse proxy, its published root cert, and its logs. |
| `.claude/skills/` | Playbooks for recurring changes (add a lift page, add a diagnostic, swap the equipment model) — written for an AI pair-programmer but equally a map of how those changes are made by hand. |

## Documentation

Every doc, and which one holds which fact: [`docs/README.md`](docs/README.md).
Start with [`docs/rules-core.md`](docs/rules-core.md) (binding) and
[`docs/restructure-plan.md`](docs/restructure-plan.md).

## Conventions

- Root-level special files stay `README.md`/`LICENSE`-style uppercase;
  everything under `docs/` uses lowercase-kebab-case.
- Every subfolder with its own docs gets a `README.md`.
- The Layout table above and [`docs/README.md`](docs/README.md) are the maps —
  update them in the same commit whenever a folder or doc moves or a new one
  is added.

## Running it on the NVIDIA card, overnight — `clip-nvidia.sh`

Nothing in `src/` uses a GPU: the analysis is OpenCV on the CPU. What *can*
leave the CPU is ffmpeg's share — decoding every frame of the source (the
heaviest step) and x264-encoding the cut clips (the burstiest). On a box with
an NVIDIA card, `./clip-nvidia.sh` runs `clip.sh` unmodified with both of those
routed to that card's NVDEC/NVENC engines, inside a low-priority cgroup, so a
whole work list can run overnight without the desktop noticing:

```
./clip-nvidia.sh check                  # preflight: card, ffmpeg, NVENC/NVDEC smoke test
./clip-nvidia.sh                        # same arguments as clip.sh, foreground
./clip-nvidia.sh --detach               # background unit that survives logout
./clip-nvidia.sh status | log | stop    # the detached run
```

It works by placing an `ffmpeg` shim ahead on `PATH` for the duration of the
run; `clip.sh` and `src/` never know. The shim probes each input's codec and
only uses the NVIDIA decoder for h264/hevc/vp9/vp8 — **AV1 stays on the CPU on
purpose** (older NVIDIA cards have no AV1 engine and the CUDA path does not fall
back; it grinds). See the header of `clip-nvidia.sh` for the environment knobs
(`CLIPPER_NV_DECODE=0`, `CLIPPER_NV_ENCODE=0`, `CLIPPER_FFMPEG_DIR`, …) and
measured CPU savings.
