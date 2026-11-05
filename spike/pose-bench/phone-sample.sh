#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# phone-sample.sh [-s SERIAL] OUT.csv [PACKAGE] [SECONDS_BETWEEN]
# Samples a phone until killed: the one -s names, else ANDROID_SERIAL, else
# the Fairphone 6 (4d42e62f), as before c65. Every adb call names it (-s).
# Battery level and
# temperature (tenths of °C), the thermal status and the hottest CPU and GPU sensor, and the package's processes' RSS plus their GPU memory
# (dumpsys gpu --gpumem), so a run's peak memory and heat can be read off.
# The processes: those named after the package, plus every service process
# it binds, which catches Android WebView's renderers (named
# com.android.webview:sandboxed_process..., running under the app's
# isolated uid); Brave's own renderers carry its name anyway.
# Temperatures come from the HAL's current readings only: thermalservice's
# "Cached temperatures" hold the last throttling event's values, not now's.
# Android 9 (the Samsung S8+, c60) has no `dumpsys gpu` and no HAL readings
# or thermal status in thermalservice (from memory: c60 sees): those columns
# are left empty there, never an error or a 0.
# `dumpsys battery unplug` (for batterystats) freezes level and temperature.
set -u
SERIAL="${ANDROID_SERIAL:-4d42e62f}"
if [ "${1:-}" = "-s" ]; then SERIAL="$2"; shift 2; fi
OUT="$1"; PKG="${2:-com.brave.browser}"; EVERY="${3:-2}"
echo "epoch_ms,level,battery_dc,rss_kb,gpu_bytes,procs,thermal_status,cpu_max_c,gpu_max_c" > "$OUT"
while true; do
  adb -s "$SERIAL" shell "
    b=\$(dumpsys battery); l=\$(echo \"\$b\" | grep '  level:' | tr -dc 0-9); t=\$(echo \"\$b\" | grep temperature | tr -dc 0-9)
    pids=\$( (ps -A -o PID,NAME | grep '$PKG' | awk '{print \$1}';
      dumpsys activity services '$PKG' | grep -o 'app=ProcessRecord{[0-9a-f]* [0-9]*' | awk '{print \$2}') | sort -u)
    rss=0; n=0; for p in \$pids; do r=\$(awk '/VmRSS/{print \$2}' /proc/\$p/status 2>/dev/null); rss=\$((rss + \${r:-0})); n=\$((n+1)); done
    g=; mem=\$(dumpsys gpu --gpumem 2>&1)
    case \"\$mem\" in ''|*\"Can't find service\"*) ;; *) g=0; for p in \$pids; do v=\$(echo \"\$mem\" | grep \"Proc \$p total\" | awk '{print \$4}'); g=\$((g + \${v:-0})); done;; esac
    th=\$(dumpsys thermalservice); st=\$(echo \"\$th\" | grep -m1 'Thermal Status' | tr -dc 0-9)
    th=\$(echo \"\$th\" | sed -n '/Current temperatures from HAL/,/Current cooling devices/p')
    cpu=\$(echo \"\$th\" | grep 'mName=CPU' | sed 's/.*mValue=\\([0-9.]*\\).*/\\1/' | sort -n | tail -1)
    gpu=\$(echo \"\$th\" | grep 'mName=GPU' | sed 's/.*mValue=\\([0-9.]*\\).*/\\1/' | sort -n | tail -1)
    echo \"\$(date +%s%3N),\$l,\$t,\$rss,\$g,\$n,\$st,\$cpu,\$gpu\"" | tr -d '\r' >> "$OUT"
  sleep "$EVERY"
done
