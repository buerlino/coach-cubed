#!/usr/bin/env bash
# phone-sample.sh OUT.csv [PACKAGE] [SECONDS_BETWEEN]
# Samples the Fairphone (always 4d42e62f) until killed: battery level and
# temperature (tenths of °C), the thermal status and the hottest CPU and GPU sensor, and the package's processes' RSS plus their GPU memory
# (dumpsys gpu --gpumem), so a run's peak memory and heat can be read off.
# Temperatures come from the HAL's current readings only: thermalservice's
# "Cached temperatures" hold the last throttling event's values, not now's.
# `dumpsys battery unplug` (for batterystats) freezes level and temperature.
set -u
OUT="$1"; PKG="${2:-com.brave.browser}"; EVERY="${3:-2}"
echo "epoch_ms,level,battery_dc,rss_kb,gpu_bytes,procs,thermal_status,cpu_max_c,gpu_max_c" > "$OUT"
while true; do
  adb -s 4d42e62f shell "
    b=\$(dumpsys battery); l=\$(echo \"\$b\" | grep '  level:' | tr -dc 0-9); t=\$(echo \"\$b\" | grep temperature | tr -dc 0-9)
    pids=\$(ps -A -o PID,NAME | grep '$PKG' | awk '{print \$1}')
    rss=0; n=0; for p in \$pids; do r=\$(awk '/VmRSS/{print \$2}' /proc/\$p/status 2>/dev/null); rss=\$((rss + \${r:-0})); n=\$((n+1)); done
    g=0; mem=\$(dumpsys gpu --gpumem); for p in \$pids; do v=\$(echo \"\$mem\" | grep \"Proc \$p total\" | awk '{print \$4}'); g=\$((g + \${v:-0})); done
    th=\$(dumpsys thermalservice); st=\$(echo \"\$th\" | grep -m1 'Thermal Status' | tr -dc 0-9)
    th=\$(echo \"\$th\" | sed -n '/Current temperatures from HAL/,/Current cooling devices/p')
    cpu=\$(echo \"\$th\" | grep 'mName=CPU' | sed 's/.*mValue=\\([0-9.]*\\).*/\\1/' | sort -n | tail -1)
    gpu=\$(echo \"\$th\" | grep 'mName=GPU' | sed 's/.*mValue=\\([0-9.]*\\).*/\\1/' | sort -n | tail -1)
    echo \"\$(date +%s%3N),\$l,\$t,\$rss,\$g,\$n,\$st,\$cpu,\$gpu\"" | tr -d '\r' >> "$OUT"
  sleep "$EVERY"
done
