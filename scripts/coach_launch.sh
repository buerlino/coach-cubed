#!/bin/bash
# Starts what coach needs. Two modes:
#   full  — app.py (waitress, loopback 8080) + Caddy (443, LAN/tailnet). Same
#           two-process shape as tecna's tecna_launch.sh, minus the ComfyUI
#           hop. coach, ../tecna and ../llm-server all want :8080/:443/:80 on
#           this one box and are never run together (see COACH_DEPLOY.md) —
#           free_ports.sh stops every known neighbor (tecna/llm-server run
#           under systemd; coach itself has no units, so the other two
#           scripts stop it with a direct pkill instead).
#   local — app.py only, loopback 8080, no Caddy/TLS/LAN exposure. For
#           working on the box itself without minting certs or fighting
#           tecna/llm-server for :443.
#
# Usage:  ./scripts/coach_launch.sh          prompts for full/local
#         ./scripts/coach_launch.sh full     start app + Caddy (LAN/tailnet reachable)
#         ./scripts/coach_launch.sh local    start app only (127.0.0.1:8080)
#         ./scripts/coach_launch.sh stop     stop everything (either mode)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p log pki-public

if [ -z "$COACH_PYTHON" ]; then
	CONDA_BASE="$(conda info --base 2>/dev/null || true)"
	[ -n "$CONDA_BASE" ] || { echo "!! conda not found — run ./scripts/setup_conda_linux.sh (or setup_conda_mac.sh)" >&2; exit 1; }
	# The env doesn't always live under the base prefix: with a configured
	# envs_dirs (this Mac uses ~/.conda/envs) it's elsewhere. Ask conda where
	# 'coach' actually is, and only fall back to the base-relative guess.
	COACH_PYTHON="$(conda run -n coach python -c 'import sys; print(sys.executable)' 2>/dev/null || true)"
	[ -x "$COACH_PYTHON" ] || COACH_PYTHON="$CONDA_BASE/envs/coach/bin/python"
fi
[ -x "$COACH_PYTHON" ] || {
	echo "!! no python at $COACH_PYTHON — run ./scripts/setup_conda_linux.sh" >&2; exit 1; }
echo "python: $COACH_PYTHON"

if [ "$1" = "stop" ]; then
	# Matched by the env's own interpreter path, not the bare "python app.py" —
	# tecna and llm-server invoke their own app.py the same way, and a loose
	# pattern here would kill whichever of the three happens to also be up.
	pkill -f "envs/coach/bin/python src/app.py" 2>/dev/null || true
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
		select choice in "full (Caddy, LAN/tailnet — as before)" "local (127.0.0.1:8080 only)"; do
			case "$REPLY" in
				1) MODE=full; break ;;
				2) MODE=local; break ;;
				*) echo "pick 1 or 2" ;;
			esac
		done
	else
		MODE=full   # non-interactive (e.g. cron, systemd): keep prior default behavior
	fi
fi
case "$MODE" in
	full|local) ;;
	*) echo "!! unknown mode '$MODE' — expected 'full', 'local', or 'stop'" >&2; exit 1 ;;
esac
echo "mode: $MODE"

if [ ! -f "$HOME/models/easy_vitpose/torch/coco/vitpose-l-coco.pth" ]; then
	echo "!! checkpoints missing under ~/models/easy_vitpose — run ./scripts/download_models.sh" >&2
	exit 1
fi

# The equipment detector (Grounding DINO, ~700MB) is OPTIONAL — it only powers
# the video tab's "detect bar & plates" tickbox. The app runs fully without it:
# /api/capabilities reports it absent and the frontend greys those controls out,
# and a run that asks for equipment anyway is refused with a 503, not a crash.
# So unlike the pose weights above, a missing detector never blocks launch — it
# is offered here and the launch continues either way. Path must match
# equipment_backend.DINO_DIR / download_models.sh's DINO_DIR.
DINO_DIR="${COACH_DINO_DIR:-$HOME/models/grounding-dino-base}"
if [ -f "$DINO_DIR/model.safetensors" ]; then
	echo "equipment detector: present ($DINO_DIR)"
elif [ -t 0 ]; then
	echo "equipment detector (Grounding DINO, ~700MB): NOT installed — optional."
	echo "  Only the 'detect bar & plates' overlay needs it; everything else works without it."
	read -r -p "  download it now before starting? [y/N] " reply || reply=""
	case "$reply" in
		[Yy]*)
			# COACH_DINO=1 fetches just the detector without re-prompting; the
			# script's pose loop skips checkpoints already on disk, so this is
			# cheap. Optional, so a failed download must NOT abort the launch.
			COACH_DINO=1 "$ROOT/scripts/download_models.sh" \
				|| echo "  detector download failed — starting without it; retry with COACH_DINO=1 ./scripts/download_models.sh" ;;
		*) echo "  skipping — the app will run without it; add it later with COACH_DINO=1 ./scripts/download_models.sh" ;;
	esac
else
	# Non-interactive launch (systemd/cron): never prompt or block. Just say how.
	echo "equipment detector: not installed (optional) — add it with COACH_DINO=1 ./scripts/download_models.sh"
fi

"$ROOT/scripts/free_ports.sh"   # stop tecna (or whatever else) so 80/443/8080 are ours

echo "=== app (8080, loopback) ==="
nohup "$COACH_PYTHON" src/app.py > log/app.log 2>&1 &
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
