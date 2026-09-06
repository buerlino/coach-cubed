#!/bin/bash
# Restarts just the backend (app.py) — for picking up a code change without
# the full coach_launch.sh stop/start dance, which would also tear down and
# re-mint Caddy/TLS. Safe to run anytime: no-ops the kill if app.py isn't
# running, and any Caddy already up keeps reverse-proxying straight through
# the few-second gap while the model reloads.
#
# Usage:  ./restart.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p log

if [ -z "$COACH_PYTHON" ]; then
	CONDA_BASE="$(conda info --base 2>/dev/null || true)"
	[ -n "$CONDA_BASE" ] || { echo "!! conda not found — run ./scripts/setup_conda_linux.sh" >&2; exit 1; }
	COACH_PYTHON="$CONDA_BASE/envs/coach/bin/python"
fi
[ -x "$COACH_PYTHON" ] || {
	echo "!! no python at $COACH_PYTHON — run ./scripts/setup_conda_linux.sh" >&2; exit 1; }

echo "=== stopping app.py (if running) ==="
# Matched by the env's own interpreter path, same as coach_launch.sh's own
# stop mode — a loose "python app.py" pattern would also catch tecna/llm-server.
if pkill -f "envs/coach/bin/python src/app.py" 2>/dev/null; then
	sleep 1   # let the socket actually release before rebinding
else
	echo "  wasn't running"
fi

echo "=== starting app.py ==="
nohup "$COACH_PYTHON" src/app.py > log/app.log 2>&1 &
PORT="${COACH_PORT:-8080}"
until curl -sf --max-time 2 "http://127.0.0.1:$PORT/" > /dev/null; do
	if ! kill -0 $! 2>/dev/null; then
		echo "!! app.py died on startup — check log/app.log" >&2
		tail -n 20 log/app.log >&2
		exit 1
	fi
	sleep 1
done
echo "  up (pid $!, http://127.0.0.1:$PORT)"
