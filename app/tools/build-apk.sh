#!/usr/bin/env bash
# app/tools/build-apk.sh [all|web|apk]
#
# The debug APK of the app (package c20), from a clean checkout:
#   web  app/node_modules (npm ci, when Capacitor or esbuild is missing), the
#        TF.js bundle (build-tfjs.mjs; its clones are cached outside the repo,
#        in $XDG_CACHE_HOME/coach/), MoveNet's weights (fetch-models.sh, SHA-256
#        checked, its archive cached there too), then assemble.mjs --debug into
#        app/dist/: the app, the bundle, the weights and the check page
#        (debug/check.html, debug builds only), and `cap sync android`;
#   apk  Gradle's assembleDebug, niced, one worker, no daemon (the laptop is
#        shared), copied to app/out/coach-debug.apk;
#   all  both (the default).
# Debug only: signed with Android's own debug key (~/.android/), never for
# release, under the placeholder app ID org.coach.placeholder (app/README.md,
# "The Android shell"). The outputs (dist/, out/, android/**/build/, the copied
# web assets) are gitignored; app/android/ itself is committed.
# On the shared laptop, run each half as a slice of its own:
#   pipeline/devlock.sh slice apk-web app/tools/build-apk.sh web
#   pipeline/devlock.sh slice apk-gradle app/tools/build-apk.sh apk
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
STEP="${1:-all}"
case "$STEP" in all|web|apk) ;; *) echo "usage: build-apk.sh [all|web|apk]" >&2; exit 2;; esac
cd "$APP"

if [[ $STEP != apk ]]; then
  if [[ ! -x node_modules/.bin/cap || ! -d node_modules/esbuild ]]; then
    npm ci --prefer-offline --no-audit --no-fund
  fi
  node tools/build-tfjs.mjs
  tools/fetch-models.sh
  node tools/assemble.mjs --debug
  npx --no-install cap sync android
fi

if [[ $STEP != web ]]; then
  [[ -f dist/debug/check.html ]] || { echo "build-apk.sh: dist/ isn't a debug assemble; run build-apk.sh web first" >&2; exit 1; }
  [[ -d android/capacitor-cordova-android-plugins ]] || { echo "build-apk.sh: cap sync hasn't run; run build-apk.sh web first" >&2; exit 1; }
  echo "sdk.dir=${ANDROID_HOME:-$HOME/Android/Sdk}" > android/local.properties
  # Gradle's incremental packaging rewrites the last APK in place and keeps the
  # space of removed files (spike/webview-shell/build.sh): start from none.
  rm -f android/app/build/outputs/apk/debug/app-debug.apk
  (cd android && nice -n 19 ./gradlew --no-daemon --console=plain --max-workers=1 -q assembleDebug < /dev/null)
  mkdir -p out
  cp android/app/build/outputs/apk/debug/app-debug.apk out/coach-debug.apk
  ls -l out/coach-debug.apk
fi
