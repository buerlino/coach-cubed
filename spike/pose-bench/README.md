# Pose bench (Phase 3 spike)

One standalone page that runs a pose model on a clip the way the offline app
would ([restructure-plan.md](../../docs/restructure-plan.md), steps 3.1–3.6):

1. demux the MP4 with mp4box.js and decode it with WebCodecs (no `<video>`
   seeking);
2. run the model in a Web Worker behind one async call,
   `estimate(frame) → COCO-17 [y, x, conf]` (`lib/pose-client.mjs`);
3. smooth and score the track with the app's own `src/track/` and
   `src/diagnostics.js`, as the old page does;
4. post the track (fixture format) and the timings to `results/`.

Not shipped, not part of `npm test`. Weights (`models/`), the npm installs
(`node_modules/`) and `results/` are gitignored: results hold tracks of
third-party clips.

## Run it

```sh
cd spike/pose-bench
npm ci --ignore-scripts      # the pinned runtimes below
./fetch-models.sh            # the weights, each checked against its SHA-256
node serve.mjs 8790          # http://127.0.0.1:8790/spike/pose-bench/
```

On the Fairphone 6 (always `adb -s 4d42e62f`): `adb reverse tcp:8790
tcp:8790`, open `http://localhost:8790/spike/pose-bench/` in Brave, `adb
forward tcp:9333 localabstract:chrome_devtools_remote`, then
`node run-cdp.mjs 9333 plans/brave-matrix.json results/brave-matrix.json
pose-bench 15` (15 s to cool down between runs) with `./phone-sample.sh
results/samples.csv` alongside for memory and heat. Remove every forward and
reverse afterwards. `node compare.mjs` scores everything in `results/`
against the ViTPose-L references (step 3.6); `node summarize.mjs
results/brave-matrix.json results/samples.csv --md` gives the numbers table
(ms/frame, decoder wait, a 10 s clip, peak memory above idle, download, first
load, heat).

| File | What it does |
| --- | --- |
| `index.html`, `bench.mjs` | The page and one run: fetch, demux, decode (hardware or software, `decode`), sample frames at 20 fps or all of them, the engine, scoring, timings. `window.bench.run(opts)` for CDP. |
| `pose-worker.mjs`, `lib/pose-client.mjs` | The worker and its one async interface. |
| `lib/engines.mjs` | The candidates: MediaPipe Pose Landmarker; ViTPose and RTMPose behind a person detector (`lib/detector.mjs`), cropped and decoded as their reference code does. |
| `lib/decode.mjs` | mp4box.js demux and WebCodecs decode, in order, with backpressure. |
| `lib/heatmap.mjs` | ViTPose heatmaps → keypoints, ported from easy_ViTPose (DARK + UDP); `check-heatmap.mjs` compares it with the Python original. |
| `lib/image.mjs` | Crop and resize through a canvas, normalise to planar floats. |
| `serve.mjs` | Static server for the repo's `spike/pose-bench/`, `src/` and `tests/fixtures/` (read-only), with COOP/COEP; takes results. |
| `run-cdp.mjs`, `plans/` | Runs a plan over the DevTools protocol, one cold page per run. |
| `phone-sample.sh` | Battery, temperatures, RSS and GPU memory of the browser, every few seconds. |
| `compare.mjs` | Step 3.6: verdicts, phase windows and values against the references, and the thresholds. |
| `summarize.mjs` | A plan's runs joined with `phone-sample.sh`'s samples inside each run's window: the numbers table. |
| `fetch-models.sh` | Pinned weight downloads with SHA-256 checks. |

## Dependencies and candidates

The runtimes (pinned in `package.json`), the weights (pinned with SHA-256s
in `fetch-models.sh`), their licences and what was left out and why:
[THIRD_PARTY.md](../../THIRD_PARTY.md#fetched-by-the-phase-3-spike-not-shipped).

The bench takes ViTPose's published ONNX exports rather than running
`export.py` (same tool, same author; no CPU-heavy export on a shared
laptop). `check-heatmap.mjs` pins the decoding to the Python original, and
the tracks are compared with ViTPose-L's, frame by frame.
