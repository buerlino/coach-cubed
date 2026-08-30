#!/bin/bash
# Starts what coach needs: app.py (waitress, loopback 8080) + Caddy (443, LAN/
# tailnet). Same two-process shape as tecna's run_tecna.sh, minus the ComfyUI
# hop. Only one of tecna/coach's Caddy can hold :443 at a time — that's fine,
# they're never run together (see COACH_DEPLOY.md).
#
# Usage:  ./run_coach.sh          start everything
#         ./run_coach.sh stop     stop everything
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
mkdir -p log pki-public

if [ -z "$COACH_PYTHON" ]; then
	CONDA_BASE="$(conda info --base 2>/dev/null || true)"
	[ -n "$CONDA_BASE" ] || { echo "!! conda not found — run ./setup_conda_linux.sh" >&2; exit 1; }
	COACH_PYTHON="$CONDA_BASE/envs/coach/bin/python"
fi
[ -x "$COACH_PYTHON" ] || {
	echo "!! no python at $COACH_PYTHON — run ./setup_conda_linux.sh" >&2; exit 1; }
echo "python: $COACH_PYTHON"

if [ "$1" = "stop" ]; then
	pkill -f "python app.py" 2>/dev/null || true
	"$HOME/.local/bin/caddy" stop 2>/dev/null \
		|| pkill -f "caddy run" 2>/dev/null \
		|| sudo pkill -f "caddy run" 2>/dev/null \
		|| true
	echo "stopped"
	exit 0
fi

if [ ! -f "$HOME/models/easy_vitpose/torch/coco/vitpose-l-coco.pth" ]; then
	echo "!! checkpoints missing under ~/models/easy_vitpose — see download step" >&2
	exit 1
fi

"$ROOT/free_ports.sh"   # stop tecna (or whatever else) so 80/443/8080 are ours

echo "=== app (8080, loopback) ==="
nohup "$COACH_PYTHON" app.py > log/app.log 2>&1 &
until curl -sf --max-time 2 http://127.0.0.1:8080/api/auth/status > /dev/null; do sleep 1; done
echo "  up"

echo "=== caddy (443) ==="
CADDY="$HOME/.local/bin/caddy"
if getcap "$CADDY" 2>/dev/null | grep -q cap_net_bind_service; then
	"$CADDY" start --config "$ROOT/Caddyfile"
else
	echo "  (no cap_net_bind_service on $CADDY — using sudo; see tecna/Caddyfile header)"
	sudo "$CADDY" start --config "$ROOT/Caddyfile"
fi

# First run only: Caddy just minted its local CA into .caddy/pki/ — mirror it
# into pki-public/ so the plain-HTTP /root.crt route (see Caddyfile) can serve
# it. No script upstream does this for tecna either; it's a one-time manual step.
CA_SRC="$ROOT/.caddy/pki/authorities/local/root.crt"
if [ -f "$CA_SRC" ] && [ ! -f "$ROOT/pki-public/root.crt" ]; then
	echo "=== publishing local CA root to pki-public/ ==="
	cp "$CA_SRC" "$ROOT/pki-public/root.crt"
	openssl x509 -in "$CA_SRC" -outform der -out "$ROOT/pki-public/root.der"
fi

echo
echo "ready:"
echo "  tailnet   https://coach-host.example-tailnet.ts.net        <- use this (real cert)"
echo "  tailnet6  https://[2001:db8::1]"
echo "  tailnet4  https://100.64.0.1"
echo "  LAN       https://192.0.2.10"
echo "  CA root   http://[2001:db8::1]/root.crt   (plain HTTP on purpose)"
echo "  logs      $ROOT/log/"
echo
echo "From a userspace-mode tailscale client (no TUN), dial through its SOCKS proxy:"
echo "  curl --socks5-hostname localhost:1055 https://[2001:db8::1]/"
