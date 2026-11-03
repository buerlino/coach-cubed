#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Frees the ONE port coach binds (8080 by default), so coach_launch.sh can
# rebind it cleanly. Safe to run anytime, including when nothing is in the way.
#
# WHAT CHANGED. This used to sweep 80, 443 and 8080 and stop every other app on
# the box to get them, because only one app could run at a time and they all
# wanted :8080 and :443. That is no longer true: each app has its own port and
# its own path prefix behind one shared gateway (see ~/Caddyfile), so they run
# side by side. 80 and 443 belong to the gateway, which must be left alone —
# stopping it took every other app on the box off the network as collateral,
# which is how restarting coach came to break its neighbours.
#
# So this now stops exactly one thing: a stale coach. Either its unit, or a raw
# app.py left behind by a previous launch — both of which would hold the port
# against the process about to start.
set -e
PORT="${COACH_PORT:-8080}"
APP_UNIT=coach-app.service

held() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${1}\$"; }

if ! held "$PORT"; then
	echo ":$PORT free"
	exit 0
fi

echo ":$PORT held — stopping coach's own processes"
# The unit first. It carries Restart=on-failure, so a bare pkill just gets the
# process respawned 5s later; only `systemctl stop` counts as intentional.
if systemctl --user is-active --quiet "$APP_UNIT" 2>/dev/null; then
	echo "  systemctl --user stop $APP_UNIT"
	systemctl --user stop "$APP_UNIT"
fi
# Then a raw one, matched on coach's own interpreter + src/app.py. The other two
# apps on this box each run an app.py the same way, so a bare "python app.py"
# pattern here would kill a neighbour — which is exactly what this rewrite is
# removing.
pkill -f "envs/coach/bin/python src/app.py" 2>/dev/null || true
pkill -f "coach/.venv/bin/python src/app.py" 2>/dev/null || true
sleep 1

if held "$PORT"; then
	# Not coach, then. Deliberately NOT reaped: on this box an unknown process
	# on a port we merely want is more likely to be something that matters than
	# something to kill, and the old `sudo fuser -k` here is what made this
	# script dangerous. Name it and stop.
	echo "  :$PORT STILL HELD, and not by coach — investigate before starting:" >&2
	echo "      sudo ss -ltnp | grep :$PORT" >&2
	echo "      ~/gpu.sh list        # if it is one of the model apps" >&2
	exit 1
fi
echo "  :$PORT freed"
