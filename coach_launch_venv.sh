#!/bin/bash
# Starts what coach needs. Two modes:
#   full  — app.py (waitress, loopback 8080) + Caddy (443, LAN/tailnet).
#   local — app.py only, loopback 8080, no Caddy/TLS/LAN exposure.
#
# Usage:  ./coach_launch.sh          prompts for full/local
#         ./coach_launch.sh local    start app only (127.0.0.1:8080)
#         ./coach_launch.sh full     start app + Caddy
#         ./coach_launch.sh stop     stop everything
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
mkdir -p log pki-public

# Detect Python interpreter (.venv first, then Conda fallback)
if [ -z "$COACH_PYTHON" ]; then
	if [ -x "$ROOT/.venv/bin/python" ]; then
		COACH_PYTHON="$ROOT/.venv/bin/python"
	else
		CONDA_BASE="$(conda info --base 2>/dev/null || true)"
		if [ -n "$CONDA_BASE" ] && [ -x "$CONDA_BASE/envs/coach/bin/python" ]; then
			COACH_PYTHON="$CONDA_BASE/envs/coach/bin/python"
		else
			echo "!! Python environment not found. Run ./setup_cpu_linux.sh first." >&2
			exit 1
		fi
	fi
fi
echo "python: $COACH_PYTHON"

if [ "$1" = "stop" ]; then
	pkill -f "$ROOT/.venv/bin/python app.py" 2>/dev/null || true
	pkill -f "envs/coach/bin/python app.py" 2>/dev/null || true
	"$HOME/.local/bin/caddy" stop 2>/dev/null \
		|| pkill -f "caddy run" 2>/dev/null \
		|| sudo pkill -f "caddy run" 2>/dev/null \
		|| true
	echo "stopped"
	exit 0
fi

MODE="$1"
if [ -z "$MODE" ]; then
	if [ -t 0 ]; then
		echo "how should coach be reachable?"
		select choice in "full (Caddy, LAN/tailnet)" "local (127.0.0.1:8080 only)"; do
			case "$REPLY" in
				1) MODE=full; break ;;
				2) MODE=local; break ;;
				*) echo "pick 1 or 2" ;;
			esac
		done
	else
		MODE=full
	fi
fi

case "$MODE" in
	full|local) ;;
	*) echo "!! unknown mode '$MODE' — expected 'full', 'local', or 'stop'" >&2; exit 1 ;;
esac
echo "mode: $MODE"

if [ ! -f "$HOME/models/easy_vitpose/torch/coco/vitpose-l-coco.pth" ]; then
	echo "!! checkpoints missing under ~/models/easy_vitpose — run ./download_models.sh" >&2
	exit 1
fi

if [ -f "$ROOT/free_ports.sh" ]; then
	chmod +x "$ROOT/free_ports.sh"
	"$ROOT/free_ports.sh"
fi

echo "=== app (8080, loopback) ==="
nohup "$COACH_PYTHON" app.py > log/app.log 2>&1 &
until curl -sf --max-time 2 http://127.0.0.1:8080/ > /dev/null; do sleep 1; done
echo "  up"

if [ "$MODE" = "local" ]; then
	echo
	echo "ready:  http://127.0.0.1:8080"
	echo "  logs  $ROOT/log/"
	exit 0
fi

echo "=== caddy (443) ==="
CADDY="$HOME/.local/bin/caddy"
if command -v "$CADDY" >/dev/null 2>&1; then
	if getcap "$CADDY" 2>/dev/null | grep -q cap_net_bind_service; then
		"$CADDY" start --config "$ROOT/Caddyfile"
	else
		sudo "$CADDY" start --config "$ROOT/Caddyfile"
	fi
else
	echo "Warning: Caddy binary not found at $CADDY. Running in app-only mode on :8080."
	exit 0
fi

CA_SRC="$ROOT/.caddy/pki/authorities/local/root.crt"
if [ -f "$CA_SRC" ] && [ ! -f "$ROOT/pki-public/root.crt" ]; then
	echo "=== publishing local CA root to pki-public/ ==="
	cp "$CA_SRC" "$ROOT/pki-public/root.crt"
	openssl x509 -in "$CA_SRC" -outform der -out "$ROOT/pki-public/root.der"
fi

echo
echo "ready:  http://127.0.0.1:8080"
echo "  logs  $ROOT/log/"