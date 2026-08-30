#!/bin/bash
# Frees the ports coach needs (80, 443, 8080) so ./run_coach.sh can bind them
# cleanly — meant to be safe to run anytime, including when nothing is in the
# way (clean no-op), so it can just be a standard pre-step before starting.
#
# Why systemctl, not pkill: tecna's units all carry Restart=on-failure, so
# killing the process directly just gets it respawned 5s later — systemd only
# treats it as an intentional stop (no restart) via `systemctl stop`.
#
# Why this can't be fully generic (any process, any port): identifying an
# arbitrary process bound to a privileged port without root doesn't work on
# this box — `ss -ltnp` / `lsof` / `fuser` can't map port 80/443 to a pid
# unless run as root, because Caddy's cap_net_bind_service file capability
# (see tecna-caddy.service) makes the kernel hide its /proc/<pid>/fd from
# same-user inspectors, the same protection setuid binaries get. So this
# script knows about the specific neighbors this box actually runs (tecna)
# rather than trying to reap whatever it finds.
set -e
PORTS=(80 443 8080)
KNOWN_UNITS=(tecna-app tecna-caddy tecna-comfyui)

echo "=== stopping known neighbors ==="
stopped_any=0
for unit in "${KNOWN_UNITS[@]}"; do
	if systemctl --user is-active --quiet "$unit" 2>/dev/null; then
		echo "  systemctl --user stop $unit"
		systemctl --user stop "$unit"
		stopped_any=1
	fi
done
[ "$stopped_any" = 1 ] && sleep 1   # let sockets actually release

echo "=== checking target ports: ${PORTS[*]} ==="
status=0
for port in "${PORTS[@]}"; do
	if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$"; then
		echo "  :$port STILL HELD — not a known unit; investigate by hand, e.g.:" >&2
		echo "      sudo ss -ltnp | grep :$port" >&2
		status=1
	else
		echo "  :$port free"
	fi
done

exit $status
