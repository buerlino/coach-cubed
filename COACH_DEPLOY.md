# coach — deploy notes

Same shape as tecna (Flask + waitress behind Caddy, tailnet IPv6 reachable),
pointed at ViTPose instead of ComfyUI. Differences from tecna, and why:

## No ComfyUI-style backend process

ViTPose (YOLOv8 detect + ViT keypoints) is a single fast forward pass with no
queue or per-session state to manage, unlike a diffusion graph or a chat
model's KV cache. So the model loads directly in `app.py`'s process
(`vitpose_backend.py`) instead of talking to a sidecar service over HTTP —
one less moving part, no benefit lost. See the docstring in
`vitpose_backend.py` for the full reasoning.

## Checkpoints

Live outside the repo at `~/models/easy_vitpose` (torch `.pth` only — coco
dataset, sizes l/h). Not vendored here, same as tecna keeps its checkpoints
out of git. `./download_models.sh` pulls them (and `yolov8s.pt`) straight
from the JunkyByte/easy_ViTPose HuggingFace repo into that layout —
`COACH_MODEL_DIR`/`COACH_SIZES` env vars override the destination/sizes.

## Caddy / port 443

coach has its own `Caddyfile`, copied from `../tecna/Caddyfile` with just the
project paths swapped (`.caddy` storage dir, `pki-public/`) — same hostnames,
same tailnet IPs, same `reverse_proxy 127.0.0.1:8080`, since it's the same
physical box either way. Dropped tecna's `/qwen/openai/v1/*` passthrough block
(no equivalent route in coach's app.py).

This only works because **tecna, llm-server and coach are never run at the
same time** — all three want :443 and :8080. `coach_launch.sh` starts/stops
app.py *and* Caddy together (`./coach_launch.sh` / `./coach_launch.sh stop`)
and calls `free_ports.sh` first, which stops whichever of tecna/llm-server is
up (systemd units, or a raw process from their own `*_launch.sh`) — no manual
stop-first step needed.

First `./coach_launch.sh` run also mints a fresh local CA (separate from tecna's
— different `.caddy` storage dir) and publishes its root cert to
`pki-public/root.crt` for phones/laptops to install, same as tecna's does.

## conda env

`./setup_conda_linux.sh` builds a `coach` env (python 3.12, ROCm 7.1 torch,
same wheels tecna uses — this box's W7800 has no CUDA path). Separate from
`tecna`'s env: coach's dependency set is much smaller and there's no reason to
couple upgrades.

## Auth

None — unauthenticated. Caddy/tailnet is the access boundary, same as the
rest of the deploy.

## Not done yet

- systemd --user unit (tecna has `tecna-app`/`tecna-comfyui`/`tecna-caddy`;
  coach would want a `coach-app` + `coach-caddy` pair once this is past the
  prototype stage — and they'd need to conflict with tecna's units, not run
  alongside them, per the port-sharing note above)
- Fine-tuning pipeline (the l/h torch checkpoints already pulled are the
  fine-tune-ready format — `vendor/easy_ViTPose/model_split.py` +
  `vendor/easy_ViTPose/train.py`; not wired into this app, which is inference
  only)
