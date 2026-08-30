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
dataset, sizes l/h; see the earlier huggingface pull). Not vendored here,
same as tecna keeps its checkpoints out of git.

## Caddy / port 443

coach has its own `Caddyfile`, copied from `../tecna/Caddyfile` with just the
project paths swapped (`.caddy` storage dir, `pki-public/`) — same hostnames,
same tailnet IPs, same `reverse_proxy 127.0.0.1:8080`, since it's the same
physical box either way. Dropped tecna's `/qwen/openai/v1/*` passthrough block
(no equivalent route in coach's app.py).

This only works because **tecna and coach are never run at the same time** —
both want :443 and :8080. `run_coach.sh` starts/stops app.py *and* Caddy
together (`./run_coach.sh` / `./run_coach.sh stop`); make sure
`../tecna/run_tecna.sh stop` has been run first if tecna was up.

First `./run_coach.sh` run also mints a fresh local CA (separate from tecna's
— different `.caddy` storage dir) and publishes its root cert to
`pki-public/root.crt` for phones/laptops to install, same as tecna's does.

## conda env

`./setup_conda_linux.sh` builds a `coach` env (python 3.12, ROCm 7.1 torch,
same wheels tecna uses — this box's W7800 has no CUDA path). Separate from
`tecna`'s env: coach's dependency set is much smaller and there's no reason to
couple upgrades.

## Auth

Reuses tecna's scheme verbatim (sha256 password file + in-memory bearer
tokens) — `.auth_password` is per-app, set on first visit, not shared with
tecna's.

## Not done yet

- systemd --user unit (tecna has `tecna-app`/`tecna-comfyui`/`tecna-caddy`;
  coach would want a `coach-app` + `coach-caddy` pair once this is past the
  prototype stage — and they'd need to conflict with tecna's units, not run
  alongside them, per the port-sharing note above)
- Fine-tuning pipeline (the l/h torch checkpoints already pulled are the
  fine-tune-ready format — `vendor/easy_ViTPose/model_split.py` +
  `vendor/easy_ViTPose/train.py`; not wired into this app, which is inference
  only)
