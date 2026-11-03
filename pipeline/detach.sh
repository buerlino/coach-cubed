#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Start one pipeline run that outlives the session that starts it.
#
#   pipeline/detach.sh <name> <pipeline.sh args...>     # e.g. pipeline/detach.sh c26 c26
#
# The run is a transient systemd user SERVICE, coach-<name>.service, whose parent is the user's systemd, not the caller's
# shell. `systemd-run --scope` is not enough: a scope moves the process into its own cgroup but leaves it the child of the
# shell that started it, so when a Claude session ends (or kills its background command) the run dies with it. That is
# how c26 (run 60) died on 2026-11-03 at 19:57, 33 minutes in, with the phone left in airplane mode.
# OOMPolicy=continue keeps one OOM kill inside the run from stopping the rest (VSCode's units are OOMPolicy=stop).
# Stdout and stderr go to <main checkout>/.coord/detached-<name>.log; the run's own files are in .tasks/ as always.
#   follow:  tail -f .coord/detached-<name>.log      state:  systemctl --user status coach-<name>.service
#   stop:    systemctl --user stop coach-<name>.service   (SIGTERM: pipeline.sh kills its worker and releases its locks)
set -euo pipefail

name="${1:?usage: pipeline/detach.sh <name> <pipeline.sh args...>}"; shift
(( $# > 0 )) || { echo "usage: pipeline/detach.sh <name> <pipeline.sh args...>" >&2; exit 2; }
[[ "$name" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "detach.sh: name '$name' must be letters, digits, _ . -" >&2; exit 2; }
unit="coach-$name.service"

self_dir="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
repo="$(cd "$self_dir/.." && pwd)"
main="$(dirname "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)")"
mkdir -p "$main/.coord"
log="$main/.coord/detached-$name.log"

if systemctl --user is-active --quiet "$unit"; then
  echo "detach.sh: $unit is already running" >&2; exit 2
fi
# A failed unit of the same name keeps its name until it is reset.
systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true

# The user manager's environment is not the caller's: hand over PATH (claude, adb, node) and every COACH_* setting.
envs=(-E "PATH=$PATH")
while IFS='=' read -r k _; do envs+=(-E "$k"); done < <(env | grep -E '^COACH_[A-Z0-9_]*=' || true)

printf '\n== %s started %s: pipeline.sh %s\n' "$unit" "$(date '+%F %T')" "$*" >> "$log"
systemd-run --user --unit="$unit" --collect --working-directory="$repo" "${envs[@]}" \
  -p OOMPolicy=continue -p KillMode=control-group \
  -p StandardOutput="append:$log" -p StandardError="append:$log" \
  -- "$self_dir/pipeline.sh" "$@"
echo "log: $log"
