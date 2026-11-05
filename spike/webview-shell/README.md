# WebView shell (Phase 3 spike, steps 3.4 and 3.5)

A throwaway Capacitor debug APK, `org.coach.spike`, that runs
[pose-bench](../pose-bench/README.md) and the
[capture check](../capture-check/README.md) inside Android's WebView, where
the app will run. Not the app, not shipped, never signed for release.

`./build.sh MODE` copies the pages into `www/`, generates the Android project
once (`npx cap add android`, gitignored like everything it builds) and builds
`out/coach-spike-MODE.apk` with Gradle niced to one worker. The modes:

| Mode | The page comes from | Cross-origin isolated? (measured, WebView 153) |
| --- | --- | --- |
| `bundled` | the APK, through Capacitor's local server (what the app would ship) | no: Capacitor sends no COOP/COEP |
| `bundled-isolated` | the APK, with COOP/COEP added to every local response by `patch/MainActivity.java` | no: the headers reach the page, and it stays un-isolated with no `SharedArrayBuffer` |
| `server` | `server.url` = the laptop's `serve.mjs` through `adb reverse` | no: Capacitor fetches the HTML itself to inject its bridge (`WebViewLocalServer.handleProxyRequest`) and answers with its own headers; and loaded natively from `http://127.0.0.1:8790/` (not proxied), with the server's own COOP/COEP, it still isn't |

So Android's WebView doesn't do cross-origin isolation at all, and ONNX
Runtime's WebAssembly runs single-threaded in any Capacitor app.

The bundled modes carry the snatch clip of the speed subset and the weights
named on the command line (default: all but ViTPose-B); they can't post
results, so their plans set `post: false` and the timings come back over
the DevTools protocol.

## Run it

```sh
npm ci --ignore-scripts
./build.sh bundled
adb -s 4d42e62f install -r out/coach-spike-bundled.apk
adb -s 4d42e62f shell pm grant org.coach.spike android.permission.CAMERA
adb -s 4d42e62f shell am start -n org.coach.spike/.MainActivity   # opens spike/pose-bench/index.html
adb -s 4d42e62f forward tcp:9334 localabstract:webview_devtools_remote_$(adb -s 4d42e62f shell pidof org.coach.spike)
node ../pose-bench/run-cdp.mjs 9334 plans/webview-bundled.json results/webview-bundled.json pose-bench 15
```

The open-runtime round (2026-11-01) bundled only its own models: `./build.sh
bundled pose_landmarker_full.task movenet-thunder-4 movenet-lightning-4
blazepose-detector-1 blazepose-landmark-full-2 pose_detector_full.onnx
pose_landmarks_full.onnx` (198 MB), then `plans/webview-open.json`. The
TF.js bundles (`node ../pose-bench/build-tfjs.mjs`) and the ONNX models
(`convert-blazepose.py`) must exist first.

Android freezes a WebView in the background: keep the app in the foreground
(the page holds a screen wake lock). Afterwards: `adb -s 4d42e62f uninstall
org.coach.spike`, and remove every forward and reverse.

Pinned: `@capacitor/{core,cli,android}` 8.5.3 (MIT). The Gradle wrapper
comes from Capacitor's template.
