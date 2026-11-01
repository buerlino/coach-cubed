#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Keep the phone awake for a measurement, and undo it afterwards. Ported from pascaline's tools/stay-awake.sh; curie runs it.
#
#   pipeline/stay-awake.sh <serial>            # save the originals (once), keep the screen on, record the device's info
#   pipeline/stay-awake.sh <serial> --restore  # put the saved settings back
#   pipeline/stay-awake.sh <serial> --restore-real  # put back <serial>.orig.real when it exists (the device's own setting)
#
# Only touches global stay_on_while_plugged_in and system screen_off_timeout. The originals live next to the machine's shared locks
# (pipeline/devlock.sh: by default pascaline's .coord/devices), so coach and pascaline restore the same saved values. pascaline keeps
# the Fairphone's <serial>.orig as its NIGHT setting (stay on while charging) and <serial>.orig.real as the phone's own: by day,
# restore with --restore-real, which falls back to .orig when there is no .orig.real.
set -euo pipefail

SERIAL="${1:?usage: stay-awake.sh <serial> [--restore|--restore-real]}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMON="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)"
MAIN_REPO="$(dirname "$COMMON")"
if [[ -n "${COACH_SHARED_LOCKS:-}" ]]; then DIR="$(dirname "$COACH_SHARED_LOCKS")/devices"
elif [[ -d "$MAIN_REPO/../pascaline/.coord" ]]; then DIR="$(cd "$MAIN_REPO/../pascaline/.coord" && pwd)/devices"
else DIR="${COACH_COORD:-$MAIN_REPO/.coord}/devices"; fi
mkdir -p "$DIR"
ORIG="$DIR/$SERIAL.orig"
sh_() { adb -s "$SERIAL" shell "$@" | tr -d '\r'; }

state="$(adb -s "$SERIAL" get-state 2>&1 || true)"
if [[ "$state" != device ]]; then
  echo "$SERIAL is not ready ($state). If 'unauthorized', someone must tap 'Allow USB debugging' on the device." >&2
  exit 2
fi
put() { # namespace key value ("null" deletes)
  if [[ "$3" == null ]]; then sh_ settings delete "$1" "$2" >/dev/null; else sh_ settings put "$1" "$2" "$3"; fi
}

if [[ "${2:-}" == --restore || "${2:-}" == --restore-real ]]; then
  FROM="$ORIG"; [[ "$2" == --restore || ! -f "$ORIG.real" ]] || FROM="$ORIG.real"
  [[ -f "$FROM" ]] || { echo "no saved settings in $FROM" >&2; exit 1; }
  # shellcheck disable=SC1090
  source "$FROM"
  put global stay_on_while_plugged_in "$STAY_ON"
  put system screen_off_timeout "$SCREEN_OFF"
  echo "restored $SERIAL from $FROM: stay_on_while_plugged_in=$STAY_ON screen_off_timeout=$SCREEN_OFF"
  exit 0
fi

if [[ ! -f "$ORIG" ]]; then
  printf 'STAY_ON=%q\nSCREEN_OFF=%q\n' \
    "$(sh_ settings get global stay_on_while_plugged_in)" "$(sh_ settings get system screen_off_timeout)" > "$ORIG"
fi
put global stay_on_while_plugged_in 7       # stay awake while on AC, USB or wireless charging
put system screen_off_timeout 2147483647    # and as long as allowed when on battery
sh_ input keyevent KEYCODE_WAKEUP || true
sh_ wm dismiss-keyguard >/dev/null 2>&1 || true   # only works without a secure lock screen

{
  echo "serial: $SERIAL"
  echo "model: $(sh_ getprop ro.product.manufacturer) $(sh_ getprop ro.product.model)"
  echo "android: $(sh_ getprop ro.build.version.release) (SDK $(sh_ getprop ro.build.version.sdk))"
  echo "webview: $(sh_ dumpsys webviewupdate | grep -iE 'current webview package' | head -1 | sed 's/^ *//')"
  echo "battery: $(sh_ dumpsys battery | grep -E 'level|temperature|AC powered|USB powered' | tr -s ' \n' ' ')"
  echo "recorded: $(date -Iseconds)"
} | tee "$DIR/$SERIAL.coach.info"
echo "stay-awake on for $SERIAL (originals in $ORIG)"
