#!/bin/bash
# Frees the ports coach needs (80, 443, 8080) so ./coach_launch.sh can bind
# them cleanly — meant to be safe to run anytime, including when nothing is in
# the way (clean no-op), so it can just be a standard pre-step before starting.
#
# Why systemctl, not pkill: tecna's and llm-server's units all carry
# Restart=on-failure, so killing the process directly just gets it respawned
# 5s later — systemd only treats it as an intentional stop (no restart) via
# `systemctl stop`.
#
# Known neighbors (tecna, llm-server) are stopped by name first — no sudo
# prompt in the common case. Anything left on the target ports after that is
# reaped generically via `sudo fuser -k`: identifying an arbitrary process
# bound to a privileged port without root doesn't work on this box —
# `ss -ltnp` / `lsof` / `fuser` can't map port 80/443 to a pid unless run as
# root, because Caddy's cap_net_bind_service file capability (see
# tecna-caddy.service) makes the kernel hide its /proc/<pid>/fd from
# same-user inspectors, the same protection setuid binaries get.
set -e
PORTS=(80 443 8080)
KNOWN_UNITS=(tecna-app llm-server-app tecna-caddy tecna-comfyui)

echo "=== stopping known neighbors ==="
stopped_any=0
for unit in "${KNOWN_UNITS[@]}"; do
	if systemctl --user is-active --quiet "$unit" 2>/dev/null; then
		echo "  systemctl --user stop $unit"
		systemctl --user stop "$unit"
		stopped_any=1
	fi
done
# In case either was started with its own *_launch.sh (a raw process) rather
# than through systemd — the units above cover the normal case.
pkill -f "envs/tecna/bin/python app.py" 2>/dev/null && stopped_any=1
pkill -f "llm-server/.venv/bin/python app.py" 2>/dev/null && stopped_any=1
pkill -f "ComfyUI/main.py" 2>/dev/null && stopped_any=1
[ "$stopped_any" = 1 ] && sleep 1   # let sockets actually release

held() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${1}\$"; }

echo "=== checking target ports: ${PORTS[*]} ==="
status=0
for port in "${PORTS[@]}"; do
	if held "$port"; then
		echo "  :$port held by an unknown process — killing via sudo fuser"
		sudo fuser -k -n tcp "$port" 2>/dev/null || true
		sleep 1
		if held "$port"; then
			echo "  :$port STILL HELD after sudo fuser -k — investigate by hand:" >&2
			echo "      sudo ss -ltnp | grep :$port" >&2
			status=1
		else
			echo "  :$port freed"
		fi
	else
		echo "  :$port free"
	fi
done

exit $status
