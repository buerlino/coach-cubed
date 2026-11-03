#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# ./build.sh MODE [MODEL ...]   MODE: bundled | bundled-isolated | server
# A throwaway debug APK (org.coach.spike) that runs pose-bench and the
# capture check inside Android's WebView (steps 3.4 and 3.5). Not shipped.
#
#   bundled           pose-bench copied in as the web app, served by
#                     Capacitor's local server: no COOP/COEP, so no
#                     SharedArrayBuffer and single-threaded WebAssembly
#   bundled-isolated  the same, with COOP/COEP added to every local response
#                     (patch/MainActivity.java)
#   server            server.url = http://localhost:8790/spike/pose-bench/,
#                     the laptop's serve.mjs through `adb reverse`
#
# MODEL: the weights to bundle (files or TF.js model folders in
# ../pose-bench/models/; default: all but ViTPose-B). The bundled apps carry
# the snatch clip of the speed subset and nothing else from
# tests/fixtures/local/. Output: out/coach-spike-MODE.apk.
# Gradle runs niced with one worker: the laptop is shared.
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:?bundled | bundled-isolated | server}"; shift
MODELS=("$@")
[[ ${#MODELS[@]} -gt 0 ]] || MODELS=(pose_landmarker_lite.task pose_landmarker_full.task pose_landmarker_heavy.task
  rtmpose-s.onnx rtmpose-m.onnx vitpose-s-coco.onnx yolox_nano.onnx)
REPO=../..
BENCH=../pose-bench
CLIP=snatch/Session14_01_0h18m07s_made.mp4

# 1. The web app.
rm -rf www && mkdir -p www
if [[ $MODE == server ]]; then
  echo '<!doctype html><title>coach spike</title><p>Loads the laptop server.</p>' > www/index.html
else
  B=www/spike/pose-bench C=www/spike/capture-check
  mkdir -p $B/lib $B/models $B/node_modules/onnxruntime-web/dist $B/node_modules/mp4box/dist \
    $B/node_modules/@mediapipe/tasks-vision $C/node_modules/mediabunny/dist/bundles \
    $B/bundles $B/node_modules/@tensorflow/tfjs-backend-wasm/dist \
    www/src/track www/src/pose "www/tests/fixtures/local/$(dirname $CLIP)"
  cp $BENCH/{index.html,bench.mjs,pose-worker.mjs} $B/ && cp $BENCH/lib/*.mjs $B/lib/
  cp $BENCH/node_modules/onnxruntime-web/dist/{ort.wasm.min.mjs,ort.webgpu.min.mjs} $B/node_modules/onnxruntime-web/dist/
  cp $BENCH/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.{mjs,wasm} $B/node_modules/onnxruntime-web/dist/
  cp $BENCH/node_modules/mp4box/dist/*.mjs $B/node_modules/mp4box/dist/   # mp4box.all.mjs imports its chunks
  cp -r $BENCH/node_modules/@mediapipe/tasks-vision/{vision_bundle.mjs,wasm} $B/node_modules/@mediapipe/tasks-vision/
  # TensorFlow.js: the bundles (build-tfjs.mjs) and its wasm backend's binaries.
  cp $BENCH/bundles/tfjs-*.mjs $B/bundles/
  cp $BENCH/node_modules/@tensorflow/tfjs-backend-wasm/dist/*.wasm $B/node_modules/@tensorflow/tfjs-backend-wasm/dist/
  for m in "${MODELS[@]}"; do cp -r "$BENCH/models/$m" $B/models/; done
  cp ../capture-check/{index.html,capture.mjs} $C/
  cp ../capture-check/node_modules/mediabunny/dist/bundles/mediabunny.mjs $C/node_modules/mediabunny/dist/bundles/
  cp $REPO/src/diagnostics.js www/src/ && cp $REPO/src/track/*.mjs www/src/track/ && cp $REPO/src/pose/coco17.mjs www/src/pose/
  cp "$REPO/tests/fixtures/local/$CLIP" "www/tests/fixtures/local/$CLIP"
  # serve.mjs builds clips.json on request; here it is a file.
  printf '[{"path":"%s","url":"../../tests/fixtures/local/%s","bytes":%d,"slug":"global/snatch/Session14_01_0h18m07s_made","set":"snatch"}]\n' \
    "$CLIP" "$CLIP" "$(stat -c %s "$REPO/tests/fixtures/local/$CLIP")" > $B/clips.json
  echo '<!doctype html><meta http-equiv="refresh" content="0; url=spike/pose-bench/index.html"><title>coach spike</title>' > www/index.html
fi

# 2. Capacitor's config for this mode.
SERVER='"androidScheme": "https"'
[[ $MODE == server ]] && SERVER='"url": "http://localhost:8790/spike/pose-bench/", "cleartext": true'
cat > capacitor.config.json <<EOF
{
  "appId": "org.coach.spike",
  "appName": "coach spike",
  "webDir": "www",
  "loggingBehavior": "debug",
  "server": { $SERVER },
  "android": { "webContentsDebuggingEnabled": true }
}
EOF

# 3. The Android project, generated once (gitignored), then patched.
[[ -d android ]] || npx --no-install cap add android
grep -q 'android.permission.CAMERA' android/app/src/main/AndroidManifest.xml ||
  sed -i 's#<uses-permission android:name="android.permission.INTERNET" />#&\n    <uses-permission android:name="android.permission.CAMERA" />#' android/app/src/main/AndroidManifest.xml
grep -q noCompress android/app/build.gradle ||
  sed -i "s#^android {#android {\n    androidResources { noCompress += ['onnx', 'task', 'wasm', 'mp4'] }#" android/app/build.gradle
grep -q "'bin'" android/app/build.gradle ||   # TF.js weight shards
  sed -i "s#'mp4'\]#'mp4', 'bin']#" android/app/build.gradle
ACT=android/app/src/main/java/org/coach/spike/MainActivity.java
if [[ $MODE == bundled-isolated ]]; then cp patch/MainActivity.java $ACT
else printf 'package org.coach.spike;\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {}\n' > $ACT; fi
echo "sdk.dir=${ANDROID_HOME:-$HOME/Android/Sdk}" > android/local.properties
npx --no-install cap copy android

# 4. Gradle, niced, one worker. Its incremental packaging rewrites the last
# APK in place and keeps the space of removed files, so start from none.
rm -f android/app/build/outputs/apk/debug/app-debug.apk
(cd android && nice -n 19 ./gradlew --no-daemon --console=plain --max-workers=1 -q assembleDebug < /dev/null)
mkdir -p out && cp android/app/build/outputs/apk/debug/app-debug.apk "out/coach-spike-$MODE.apk"
ls -l "out/coach-spike-$MODE.apk"
