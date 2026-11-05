# Developing Coach Cubed

How the repo is laid out and how to run the tooling around the app. The app
itself is in [`app/`](../app/README.md); the binding goal and rules are in
[rules-core.md](rules-core.md), the plan and its status in
[restructure-plan.md](restructure-plan.md), and the index of every doc in
[README.md](README.md). To add a lift or a cue: [lifts.md](lifts.md).

## The old page and the dev server

The new app, its commands and its checks are in [`app/README.md`](../app/README.md#commands). What follows is the tooling around it.

### The local preview: pose in the browser

The old analysis page, with pose running in the browser (MediaPipe) instead of
on a server, served by a small Python server. No pose models to download. From
the repo root:

```sh
python3 launchers/run_original.py   # the analysis page, http://127.0.0.1:8785/
python3 launchers/run_anatomy.py    # the Movement Lab, http://127.0.0.1:8784/squat/
```

It needs Python 3.9 or newer and a browser with WebGL and WebAssembly. The 3D
reconstruction also needs numpy and OpenCV:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-preview.txt   # Windows: .venv\Scripts\python.exe
.venv/bin/python launchers/run_original.py
```

Pass `--port 8786` if the port is taken; Ctrl+C stops it. `launchers/` has
double-click twins for macOS (`.command`) and Windows (`.bat`):
`setup-local-*` makes the `.venv`, `OPEN_ORIGINAL_UI_*` and
`OPEN_ANATOMY_UI_*` open the two pages.

The example gallery shows only on a machine that has the example clips: they
are third-party, so they are not in git
([`tests/fixtures/README.md`](../tests/fixtures/README.md#videos)).

### The dev server: pose with ViTPose

Server-side pose with ViTPose, for reference tracks and goldens. It needs
torch and about 3.7 GB of checkpoints:

```sh
./scripts/setup_no_conda_linux.sh   # or setup_conda_linux.sh / setup_conda_mac.sh
./scripts/download_models.sh
./scripts/coach_launch.sh local     # http://127.0.0.1:8080
```

The deploy behind Caddy, every script and the server's landmines:
[`docs/server.md`](server.md).

## Tests

`npm test` and the Python tests; what they cover, and how a lift video
becomes a test case: [`tests/README.md`](../tests/README.md).

## Layout

| Path | What's there |
| --- | --- |
| [`src/`](../src/) | `diagnostics.js` (the cues; runs in the browser and in Node), `pose/` (MediaPipe pose in the browser, mapped to COCO-17), `track/` (what happens to a pose track before scoring: time smoothing and the lift window, ported from the old page and tested against it), `app.py` (the dev server, and the old page, frozen), `vitpose_backend.py` (server pose), `depth_backend.py` and `local_depth.py` (the 3D reconstruction), `anatomy/` and `squat/` (the anatomy view and the Movement Lab, frozen with the old page), `vendor/` (three.js). |
| [`launchers/`](../launchers/) | The local preview: `run_local.py`, its entry points, and their double-click `.command`/`.bat` twins. They all `cd` to the repo root before touching `.venv` or `src/`, so they only work from inside this folder: don't move them apart. |
| [`scripts/`](../scripts/) | The dev server's setup, model download, launch and restart; turning clips into fixtures (`batch_extract_tracks.py`, and `sync_clipper_fixtures.py` for clips cut by clipper, its own repo `weightlifting-clipper`); `build_anatomy.py`. |
| [`tests/`](../tests/) | The JS and Python tests, the fixtures (cached pose tracks, which double as the example gallery) and their golden snapshots. |
| [`parked/`](../parked/) | Areas outside 0.1.0's core, moved here and unwired from the app: the research report and bar detection. |
| [`docs/`](README.md) | The rules, the plan, the decisions, the map of the repo and the reference docs; the index is [`docs/README.md`](README.md). |
| [`app/`](../app/README.md) | The new app (plan Phase 5): static files, plain ES modules, the screens in Preact with htm; its flow, tokens, vendored Preact, htm and fonts, and `tools/` (`assemble.mjs` builds `dist/`, `serve.mjs` serves it). |
| [`.github/`](../.github/workflows/pages.yml) | The Pages workflow (`c67`): on a `v*` tag it builds, tests and publishes the app to https://coach-cubed.org ([docs/handover.md](handover.md)). |
| [`spike/`](../spike/) | The on-device pose spike (plan Phase 3). |
| [`design/`](../design/README.md) | Design work that isn't app code: a copy of the UI mockups' canvas (plan step 5.2). |
| `vendor/` | `easy_ViTPose`, a git submodule (server pose). |
| [`logo/`](../logo/README.md) | The coach³ logo (CC BY-SA 4.0): its Affinity source and the two icon layers every icon is rendered from. |
| `clips_inbox/` | A gitignored landing spot for raw clips waiting to become fixtures. |
| `Caddyfile`, `pki-public/`, `log/` | A reference copy of the reverse-proxy config (not the live one), the published root cert, and the dev server's logs. |
| [`pipeline/`](../pipeline/README.md) | The agent pipeline's scripts: one work package from its file to a merge into `phase-0`, with fresh agents ([docs/pipeline.md](pipeline.md)). |
| `.claude/agents/` | The pipeline's agents: the workers dirac, schrödinger and curie, the advisor einstein, the auditor hillbert, and faraday, who runs the queue overnight. |
| `.claude/hooks/` | `adb_guard.py`, run before every Bash command (`.claude/settings.json`): an adb command must name the phone, `adb -s 4d42e62f`, and nothing may name the tablet of pascaline's nights. |
| `.claude/skills/` | Playbooks for recurring changes (add a lift page, add a diagnostic), written for an AI pair-programmer but just as usable by hand. |
| `THIRD_PARTY.md` | Every third-party component: version, licence and source. |
| `TODO.md` | Open research notes on the 3D reconstruction. |

## Conventions

- Root-level special files stay `README.md`/`LICENSE`-style uppercase;
  everything under `docs/` uses lowercase-kebab-case.
- Every subfolder with its own docs gets a `README.md`.
- The Layout table here and [`docs/README.md`](README.md) are the maps:
  update them in the same commit whenever a folder or doc moves or a new one
  is added.
