#!/bin/bash
# Kept as a name people and docs already type (tests/README.md,
# scripts/batch_extract_tracks.py). It used to be a near-copy of
# coach_launch.sh that preferred .venv over conda — and, being a copy, it also
# carried its own version of the "stop every neighbour and take :443" logic that
# made restarting coach break the other two apps on this box.
#
# coach_launch.sh now prefers .venv itself when ./.venv/bin/python exists, so
# there is nothing left to duplicate. This forwards to it rather than drifting.
exec "$(cd "$(dirname "$0")" && pwd)/coach_launch.sh" "$@"
