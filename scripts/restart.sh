#!/bin/bash
# Restarts just coach's backend (app.py) — for picking up a code change without
# the full coach_launch.sh path (model checks, GPU priority claim, gateway).
# The gateway keeps reverse-proxying straight through the few-second gap.
#
# Prefers the systemd unit: starting a raw process while coach-app.service is
# active leaves two things fighting for the port, and the stale one wins as
# often as not. That split-brain is why this script now asks systemd first.
#
# Usage:  ./scripts/restart.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p log

APP_UNIT=coach-app.service
PORT="${COACH_PORT:-8080}"

if systemctl --user cat "$APP_UNIT" >/dev/null 2>&1; then
	echo "=== systemctl --user restart $APP_UNIT ==="
	systemctl --user restart "$APP_UNIT"
else
	if [ -z "${COACH_PYTHON:-}" ]; then
		if [ -x "$ROOT/.venv/bin/python" ]; then
			COACH_PYTHON="$ROOT/.venv/bin/python"
		else
			CONDA_BASE="$(conda info --base 2>/dev/null || true)"
			[ -n "$CONDA_BASE" ] || { echo "!! conda not found — run ./scripts/setup_conda_linux.sh" >&2; exit 1; }
			COACH_PYTHON="$(conda run -n coach python -c 'import sys; print(sys.executable)' 2>/dev/null || true)"
			[ -x "$COACH_PYTHON" ] || COACH_PYTHON="$CONDA_BASE/envs/coach/bin/python"
		fi
	fi
	[ -x "$COACH_PYTHON" ] || {
		echo "!! no python at $COACH_PYTHON — run ./scripts/setup_conda_linux.sh" >&2; exit 1; }

	echo "=== stopping app.py (if running) ==="
	# Matched on coach's own interpreter + src/app.py: the other two apps on this
	# box each run an app.py the same way, and a bare pattern would kill them.
	if pkill -f "envs/coach/bin/python src/app.py" 2>/dev/null \
	   || pkill -f "$ROOT/.venv/bin/python src/app.py" 2>/dev/null; then
		sleep 1   # let the socket actually release before rebinding
	else
		echo "  wasn't running"
	fi

	echo "=== starting app.py (:$PORT) ==="
	COACH_PORT="$PORT" nohup "$COACH_PYTHON" src/app.py > log/app.log 2>&1 &
fi

until curl -sf --max-time 2 "http://127.0.0.1:$PORT/" > /dev/null; do sleep 1; done
echo "  up (http://127.0.0.1:$PORT)"
