# Phone baseline (2026-10-31)

These scripts produced the phone test in
[docs/map.md](../../docs/map.md#phone-test-2026-10-31). The Phase 3 spike
starts from them. Results go to `results/`, which is gitignored: the files
hold tracks of third-party videos.

| File | What it does |
| --- | --- |
| `cdp.mjs` | `node cdp.mjs PORT URL_PART EXPR_FILE OUT_FILE`: evaluates an async expression in a browser page over the DevTools protocol and writes the result as JSON. |
| `gpu-probe.js` | Checks WebGPU (adapter, device, features), WebCodecs and WebGL2. |
| `mp-run.js` | Runs the existing MediaPipe prototype (`src/squat/pose.mjs`) at 20 fps on every example clip. Returns timings and COCO-17 tracks. |
| `compare.js` | `node compare.js REPO results/mp-results.json`: scores ViTPose-L and phone tracks with the same `diagnostics.js`. |

**How it ran:**
1. Start the local preview: `python launchers/run_original.py --port 8785 --no-browser`.
2. On the Fairphone 6, always addressed with `adb -s 4d42e62f`:
   - `adb reverse tcp:8785 tcp:8785`;
   - open `http://localhost:8785/original/` in Brave;
   - `adb forward tcp:9333 localabstract:chrome_devtools_remote`.
3. For a Capacitor WebView, forward the app's `webview_devtools_remote_<pid>`
   socket while the app is in the foreground (Android freezes it in the
   background).
4. Remove every forward and reverse afterwards.
