# The server (dev tooling)

The Flask app (`src/app.py`), its setup and launch scripts (`scripts/`) and
the Caddy deploy on Noah's machine. Since 2026-10-31 the server is dev
tooling: it produces reference tracks and goldens with ViTPose and serves the
old page as the reference viewer. The app itself must not depend on it
([rules-core.md](rules-core.md)). The rules here bind anyone who changes how
the server is served, launched, or what it loads.

## What runs

- **`src/app.py`**: Flask, served by waitress on `127.0.0.1:8080`
  (`COACH_HOST`, `COACH_PORT`). No login: Caddy and the tailnet are the
  access boundary.
- **ViTPose, in the same process** (`src/vitpose_backend.py`; its docstring
  says why there is no separate model server): YOLOv8s finds the person,
  ViTPose-L or -H gives COCO-17 keypoints, SORT keeps the track. A model loads
  on the first request that needs its size and then stays loaded. Device:
  CUDA (ROCm counts as CUDA), then MPS, then CPU.
- **Checkpoints** live outside the repo, in `~/models/easy_vitpose`
  (`COACH_MODEL_DIR`): `torch/coco/vitpose-{l,h}-coco.pth` (about 1.2 and
  2.5 GB) and `yolov8/yolov8s.pt`, in the layout of the JunkyByte/easy_ViTPose
  Hugging Face repo. `scripts/download_models.sh` fetches them;
  `COACH_SIZES="l"` fetches only ViTPose-L.

## Setup and launch

| Script | Does |
| --- | --- |
| `setup_conda_linux.sh` | Conda env `coach`, Python 3.12, torch from the ROCm 7.1 wheels (`--cuda` for CUDA). |
| `setup_conda_mac.sh` | The same on macOS. |
| `setup_no_conda_linux.sh` | `.venv` with the CPU build of torch (nordmu's laptop). |
| `download_models.sh` | The checkpoints above. |
| `coach_launch.sh local` | The app alone, as a process on loopback. |
| `coach_launch.sh full` | Restarts the `coach-app.service` user unit instead, if one is installed, and brings up the shared gateway. The default when not run interactively. |
| `coach_launch.sh stop` / `status` | Stops coach, or reports what is up. |
| `coach_launch_venv.sh` | Forwards to `coach_launch.sh`; kept because docs and scripts use the name. |
| `restart.sh` | Restarts only `app.py`, through the systemd unit when there is one. |
| `free_ports.sh` | Frees coach's own port and nothing else. |

Both launch modes need the ViTPose-L checkpoint, prefer `.venv/bin/python`
over the conda env (`COACH_PYTHON` overrides), and first claim GPU priority
(`--no-prio` or `NO_GPU_PRIO=1` skips it). The two shared helpers, `gpu.sh`
and `gateway.sh`, live in the folder above the repo (`COACH_SHARED_DIR`). The
scripts touch only coach's own process and port. Logs go to `log/`.

## Test under the real path prefix

coach is not served at the site root. The real deploy (`~/Caddyfile` on
Noah's machine, *not* the `Caddyfile` copy in this repo) mounts it at
`/coach/*` via `handle_path`, which **strips the prefix before Flask ever sees
the request**. That is why every asset path has to be relative
([rules-core.md](rules-core.md#paths-stay-relative)).

Testing against `http://127.0.0.1:8080/` is not sufficient: it passes even
when the production URL is broken. Test through the proxied path
(`https://coach-host.example-tailnet.ts.net/coach/...`). Without access to that box,
the stand-in is a small proxy that strips `/coach` and forwards to the app;
step 2.0 was tested that way.

## Landmines

- **Two Caddyfiles exist.** The repo's own `Caddyfile` is a single-site
  reference copy from when coach was the only app on its box. The *live* one
  is `~/Caddyfile` on Noah's machine, outside this repo, which mounts coach
  under its path prefix beside other services. When in doubt about how a
  request actually reaches this app, read `~/Caddyfile`.
- **`.caddy/` holds the live CA.** Never delete or regenerate it — every
  device that already trusts it (phones, laptops on the tailnet) would need
  to re-install a new root cert. Treat it like a production secret.
- **`diagnostics.js` is read per request; `app.py` is not.** A JS-only edit
  needs only a browser reload. A Python edit needs the backend restarted
  (`./scripts/restart.sh`) before it takes effect — don't mistake a stale
  process for a bug in your change.

## You are not alone on this box: keep your sibling notes current

The deploy is one of several web services on the same machine, behind one
shared HTTPS gateway, sharing one GPU and 22 GiB of RAM. You would not know
that from reading this repo, and **that is deliberate**: nothing here names
another service, because every cross-reference that got written turned stale
within weeks and actively misled whoever read it next. Keeping the coupling
out means this app still runs correctly alone, at the root, unmodified.

The knowledge has to live somewhere, though, and that somewhere is
**`../new-service.md`** on that machine: the tutorial for adding a service
there, plus a *sibling notes* registry with one entry per service.

**Your obligation.** If you change anything a sibling could trip over, update
this project's entry in that file **in the same change**:

- the port it binds, or any port it pins for a subprocess
- its measured peak VRAM or peak host RAM (measure with `~/gpu.sh` and
  `~/ram.sh` under real load — write down what you saw, not an estimate)
- how it can be made to release GPU memory, and how to verify that worked
- anything it registers in the shared layer (`~/Caddyfile`, `~/gpu.sh`,
  `~/ram.sh`, `~/serve_all.sh`)
- a URL that external clients bake in and that therefore cannot move
- long GPU submissions, or a host-side buffer as large as its model

Do **not** write any of that into this repo's own docs. A sibling-aware note
here is the bug this split exists to prevent.

Read that file before changing how this app is served, how it loads models,
or what it holds. The GPU and RAM rules there are not general advice — they
are measured properties of that box, including several that contradict what
the tooling reports.
