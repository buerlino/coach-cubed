#!/bin/bash
# Starts (or restarts) coach and everything it needs, and nothing else.
#
#   app.py/waitress (8080, loopback) ──▶ gateway
#
# ViTPose loads in-process, lazily, on the first request that needs it —
# there is no subservice to start.
#
# WHAT CHANGED, and why this script is now short. It used to call free_ports.sh
# to stop every other app on the box and take :8080 + :80/:443, because only one
# app could run at a time. That is no longer true: each app has its own port and
# its own path prefix behind one shared gateway, so they run side by side. This
# script now touches ONLY coach's own process.
#
# It prefers the systemd unit, which is the supported way to run this box.
# Starting a raw process alongside an active unit is what produced the
# split-brain we kept hitting here specifically: this script would leave app.py
# running in the login session while coach-app.service sat dead, so a
# `systemctl restart coach-app` fixed nothing and the stale process kept the
# port. Raw mode is now the fallback for a machine with no unit installed.
#
# GPU: the box has one card and three apps that can each fill it. On start this
# claims priority — the shared arbiter unloads the OTHER apps' models and leaves
# coach's alone. Skip with --no-prio (or NO_GPU_PRIO=1).
#
# Modes:
#   full   app behind the shared gateway, reachable on the LAN/tailnet (default)
#   local  app only, 127.0.0.1 — for working on the box without the gateway
#
# Usage:  ./scripts/coach_launch.sh              full (prompts if interactive)
#         ./scripts/coach_launch.sh local        app only, no gateway
#         ./scripts/coach_launch.sh --no-prio    ... leave other apps' VRAM alone
#         ./scripts/coach_launch.sh stop         stop coach
#         ./scripts/coach_launch.sh status       what is up
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p log pki-public

APP_UNIT=coach-app.service
PORT="${COACH_PORT:-8080}"                 # must match the gateway's route

SHARED="${COACH_SHARED_DIR:-$(cd "$ROOT/.." && pwd)}"
GPU_ARBITER="$SHARED/gpu.sh"
GATEWAY="$SHARED/gateway.sh"

PRIO=1
ARGS=()
for a in "$@"; do
	case "$a" in
		--no-prio) PRIO=0 ;;
		*) ARGS+=("$a") ;;
	esac
done
[ "${NO_GPU_PRIO:-0}" = 1 ] && PRIO=0
set -- "${ARGS[@]+"${ARGS[@]}"}"

if [ -z "${COACH_PYTHON:-}" ]; then
	if [ -x "$ROOT/.venv/bin/python" ]; then
		COACH_PYTHON="$ROOT/.venv/bin/python"
	else
		CONDA_BASE="$(conda info --base 2>/dev/null || true)"
		[ -n "$CONDA_BASE" ] || { echo "!! conda not found — run ./scripts/setup_conda_linux.sh" >&2; exit 1; }
		# The env isn't always under the base prefix: with a configured
		# envs_dirs it lives elsewhere. Ask conda, then fall back to the guess.
		COACH_PYTHON="$(conda run -n coach python -c 'import sys; print(sys.executable)' 2>/dev/null || true)"
		[ -x "$COACH_PYTHON" ] || COACH_PYTHON="$CONDA_BASE/envs/coach/bin/python"
	fi
fi

units_available() { systemctl --user cat "$APP_UNIT" >/dev/null 2>&1; }

# Only coach's own process. Matched on this project's interpreter path and its
# own src/app.py — the other two apps on this box each run an app.py the same
# way, and a bare "python app.py" pattern would take them down.
stop_mine() {
	systemctl --user is-active --quiet "$APP_UNIT" 2>/dev/null && {
		echo "  systemctl --user stop $APP_UNIT"; systemctl --user stop "$APP_UNIT"; }
	pkill -f "envs/coach/bin/python src/app.py" 2>/dev/null || true
	pkill -f "$ROOT/.venv/bin/python src/app.py" 2>/dev/null || true
}

case "${1:-}" in
stop)
	echo "=== stopping coach ==="
	stop_mine
	echo "stopped (the gateway and other apps are left running)"
	exit 0
	;;
status)
	printf "%-24s %s\n" "$APP_UNIT" "$(systemctl --user is-active "$APP_UNIT" 2>/dev/null || true)"
	curl -sf --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null \
		&& echo "app :$PORT answering" || echo "app :$PORT not answering"
	[ -x "$GATEWAY" ] && "$GATEWAY" status
	exit 0
	;;
esac

MODE="${1:-}"
if [ -z "$MODE" ]; then
	if [ -t 0 ]; then
		echo "how should coach be reachable?"
		select choice in "full (behind the shared gateway, LAN/tailnet)" "local (127.0.0.1:$PORT only)"; do
			case "$REPLY" in
				1) MODE=full; break ;;
				2) MODE=local; break ;;
				*) echo "pick 1 or 2" ;;
			esac
		done
	else
		MODE=full   # non-interactive (cron, systemd): keep the prior default
	fi
fi
case "$MODE" in
	full|local) ;;
	*) echo "!! unknown mode '$MODE' — expected 'full', 'local', 'stop' or 'status'" >&2; exit 1 ;;
esac
echo "mode: $MODE"

[ -f "$HOME/models/easy_vitpose/torch/coco/vitpose-l-coco.pth" ] || {
	echo "!! checkpoints missing under ~/models/easy_vitpose — run ./scripts/download_models.sh" >&2
	exit 1; }

# Claimed BEFORE starting: the first pose request is what needs the room, and
# freeing after a load has already failed is too late.
if [ "$PRIO" = 1 ] && [ -x "$GPU_ARBITER" ]; then
	"$GPU_ARBITER" prio coach || echo "  (GPU priority claim failed — continuing)"
fi

# Only coach's own port is ever checked. The old free_ports.sh swept 80/443/8080
# and stopped the neighbours to get them; nothing else wants :8080 now.
if [ -x "$ROOT/scripts/free_ports.sh" ]; then
	"$ROOT/scripts/free_ports.sh" || true
fi

if units_available && [ "$MODE" = full ]; then
	echo "=== restarting $APP_UNIT ==="
	systemctl --user restart "$APP_UNIT"
else
	# local mode deliberately runs raw: the unit binds the port the gateway
	# routes to, and the point of local mode is to work without that.
	echo "=== starting app (:$PORT, loopback) ==="
	[ -x "$COACH_PYTHON" ] || {
		echo "!! no python at $COACH_PYTHON — run ./scripts/setup_conda_linux.sh" >&2; exit 1; }
	echo "python: $COACH_PYTHON"
	stop_mine
	sleep 1
	COACH_PORT="$PORT" nohup "$COACH_PYTHON" src/app.py > log/app.log 2>&1 &
fi

until curl -sf --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null; do sleep 1; done
echo "  app :$PORT up"

if [ "$MODE" = local ]; then
	echo
	echo "ready:  http://127.0.0.1:$PORT"
	echo "  logs  $ROOT/log/"
	exit 0
fi

[ -x "$GATEWAY" ] && "$GATEWAY" up

echo
echo "ready:  https://coach-host.example-tailnet.ts.net/coach/"
echo "  logs  $ROOT/log/"
