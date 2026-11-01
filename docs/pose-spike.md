# Pose spike: model, runtime and shell (step 3.7)

**Decided as the working pick (nordmu, 2026-11-01): MoveNet SinglePose
Thunder on TensorFlow.js** ([the decision](#decision-nordmu-2026-11-01-the-working-pick);
[decisions.md](decisions.md#what-010-is)). Phase 5 builds on it; it becomes
final once step 3.6 passes on the validation set (step 3.0), which confirms
it or switches to BlazePose. Since 2026-11-01 the runtime that ships must be
open source and buildable from source (nordmu), so the first round's pick,
MediaPipe on its closed runtime, is out; the open runtimes are the second
round, below. The accuracy numbers come from the four example clips only and
are **provisional** until the validation set exists; the speed, memory and
capture numbers are measured on the Fairphone 6 and stand.

## What was measured where

- **On the Fairphone 6** (LineageOS, Android 16), 2026-10-31/11-01 (the
  first round) and 2026-11-01 evening (the open runtimes): Brave 156
  (Chromium), cross-origin isolated (ONNX Runtime's WebAssembly with 4
  threads in the first round, 1 in the second); the Capacitor WebView
  (`com.android.webview` 153); the camera, MediaRecorder, WebCodecs and the
  heat run. On USB power, a cold page per run, 15 s between runs.
- **On the laptop:** the agreement (spike/pose-bench/compare.mjs: each
  candidate's track against ViTPose-L's, through `diagnostics.js`); the
  check that ViTPose's heatmap decoding matches easy_ViTPose's; the BlazePose
  weight comparison and the ONNX conversion with its check against TF Lite.
- **From docs:** the licences and F-Droid.

The clips: two cable lateral raises (`lateral-raise-cable-1/-2`, 8 scored
verdicts) and two snatches (`athlete-a-trim`, a front view, and
`Session14_01_0h18m07s_made`, 1080p60, 4 scored verdicts). **Far too few to
decide on:** one flipped verdict moves a lift by 12–25 points, and most
flips below sit within a few units of a cue's threshold.

## The open runtimes (2026-11-01)

nordmu's rule of 2026-11-01 ([decisions.md](decisions.md#what-010-is)):
the runtime that ships must be open source and buildable from source, which
MediaPipe Tasks' web runtime isn't. The model and the runtime are separate
choices: BlazePose's weights are Apache-2.0, only Google's runtime is
closed. So this round runs Apache-2.0 weights on open runtimes, behind the
same `estimate()`, on the same four clips, with MediaPipe full on its GPU
delegate re-run the same day as the benchmark.

- **MoveNet SinglePose Thunder (256×256) and Lightning (192×192), v4, on
  TensorFlow.js 4.22.0**, through `@tensorflow-models/pose-detection` 2.1.3
  (its crop from the last pose, low-passed; its keypoint smoothing off, as
  `src/track/` smooths). 17 COCO keypoints straight out, no 33→17 mapping.
- **BlazePose full on TensorFlow.js**, the same package with runtime
  `tfjs`. Which weights: the TF.js landmark model (landmark full v2) holds
  **the same numbers as the Tasks Landmarker's** `pose_landmarks_detector`
  (all 192 weight tensors, to fp16 rounding). Its detector (v1) is a
  different, dense one: the Tasks detector stores 38 tensors sparse, and none
  of the TF.js detector's tensors match it. The legacy `@mediapipe/pose` of
  the baseline's 0/4 wasn't compared.
- **BlazePose full, the Tasks models converted to ONNX, on ONNX Runtime Web
  1.30.0** (step 2b): **it works**, inside the half-day time box. tf2onnx 1.17 converts
  the landmark model as is; the detector stores 38 weight tensors sparse (TF
  Lite's `DENSIFY`), which tf2onnx can't convert, so TF Lite's interpreter
  densifies them first
  ([convert-blazepose.py](../spike/pose-bench/convert-blazepose.py)). Both
  models match TF Lite to 9e-4. The detector, the rotated ROI, the heatmap
  refinement and the ROI tracking are plain JS
  ([blazepose-onnx.mjs](../spike/pose-bench/lib/blazepose-onnx.mjs)). The
  converted weights are fp32: 24 MB against the `.task`'s 9.4.
- Backends: WebGL and WebGPU (TypeScript and shaders, no wasm), and
  WebAssembly on one thread, the way the app's WebView runs it.

### Speed, memory, download

Columns as in the first round below; 30 fps is what the phone's camera
records, "full" is each clip's own rate (25, 30 and two at 60 fps). A 5 s
clip is half the 10 s figure. The worst clip is usually a 3 s one, where
WebGL's shader compiling on the first frames weighs most (BlazePose WebGL:
88 ms/frame p50, 174 ms mean on `cable-1`); an app would warm the engine up
at load.

**Brave** (156, isolated; the four clips):

| Candidate | Runtime | ms/frame, 30 / full | 10 s clip, s | 5 s clip, s | Memory, MB | Download, MB | First load, s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MoveNet Thunder | TF.js WebGL | 70 / 69 | 29 / 46 | 15 / 23 | 300 / 308 | 14 | 0.7 |
| MoveNet Thunder | TF.js WebGPU | 70 / 69 | 24 / 44 | 12 / 22 | 321 / 309 | 13 | 0.6 |
| MoveNet Thunder | TF.js WASM ×1 | 227 / 228 | 70 / 138 | 35 / 69 | 283 / 282 | 14 | 0.7 |
| MoveNet Lightning | TF.js WebGL | 50 / 45 | 25 / 32 | 12 / 16 | 264 / 233 | 6 | 0.5 |
| MoveNet Lightning | TF.js WebGPU | 56 / 55 | 19 / 35 | 9 / 18 | 220 / 171 | 6 | 0.4 |
| MoveNet Lightning | TF.js WASM ×1 | 116 / 115 | 36 / 70 | 18 / 35 | 310 / 234 | 6 | 0.4 |
| BlazePose full | TF.js WebGL | 88 / 86 | 44 / 59 | 22 / 29 | 394 / 366 | 14 | 0.6 |
| BlazePose full | TF.js WebGPU | 71 / 69 | 24 / 46 | 12 / 23 | 303 / 282 | 13 | 0.6 |
| BlazePose full | TF.js WASM ×1 | 138 / 138 | 44 / 84 | 22 / 42 | 290 / 286 | 14 | 0.6 |
| BlazePose full, Tasks → ONNX | ONNX Runtime WebGPU | 64 / 64 | 23 / 43 | 12 / 22 | 581 / 556 | 51 | 3.9 |
| BlazePose full, Tasks → ONNX | ONNX Runtime WASM ×1 | 114 / 114 | 36 / 70 | 18 / 35 | 153 / 170 | 38 | 1.9 |
| MediaPipe full (benchmark) | GPU delegate | 57 / 56 | 22 / 37 | 11 / 19 | 327 / 370 | 23 | 1.2 |

**The Capacitor WebView** (153, not isolated; the bundled APK, the snatch
clip only: 1080p60, 7.4 s, the worst case; download as in Brave; first load
from the APK):

| Candidate | Runtime | ms/frame, 30 / full | 10 s clip, s | 5 s clip, s | Memory, MB | First load, s |
| --- | --- | --- | --- | --- | --- | --- |
| MoveNet Thunder | TF.js WebGL | 84 / 83 | 27 / 52 | 14 / 26 | 312 / 337 | 0.2 |
| MoveNet Thunder | TF.js WebGPU | 73 / 73 | 26 / 49 | 13 / 24 | 325 / 336 | 0.2 |
| MoveNet Thunder | TF.js WASM ×1 | 223 / 222 | 68 / 135 | 34 / 68 | 277 / 283 | 0.3 |
| MoveNet Lightning | TF.js WebGL | 53 / 53 | 18 / 34 | 9 / 17 | 270 / 241 | 0.2 |
| MoveNet Lightning | TF.js WebGPU | 57 / 57 | 21 / 38 | 10 / 19 | 119 / 179 | 0.2 |
| MoveNet Lightning | TF.js WASM ×1 | 112 / 111 | 35 / 68 | 17 / 34 | 309 / 231 | 0.2 |
| BlazePose full | TF.js WebGL | 93 / 91 | 30 / 58 | 15 / 29 | 409 / 405 | 0.2 |
| BlazePose full | TF.js WebGPU | 74 / 74 | 26 / 49 | 13 / 24 | 284 / 320 | 0.3 |
| BlazePose full | TF.js WASM ×1 | 133 / 133 | 41 / 82 | 21 / 41 | 273 / 267 | 0.3 |
| BlazePose full, Tasks → ONNX | ONNX Runtime WebGPU | 71 / 70 | 24 / 45 | 12 / 23 | 471 / 539 | 2.6 |
| BlazePose full, Tasks → ONNX | ONNX Runtime WASM ×1 | 115 / 115 | 36 / 70 | 18 / 35 | 191 / 198 | 0.9 |
| MediaPipe full (benchmark) | GPU delegate | 62 / 61 | 20 / 38 | 10 / 19 | 272 / 259 | 0.5 |

- **Every open configuration fits the budget at 30 fps**, the slowest
  (Thunder on one WASM thread) with 68 s for a 10 s clip; at 60 fps only
  that one doesn't (135 s). Real clips are 2–5 s at 30 fps at most.
- **The WebView gives the same verdicts as Brave** for MoveNet and
  MediaPipe (summary values within 1.0, 2.0 for Lightning on WASM at full
  rate). Every
  BlazePose configuration at full rate flips the snatch's
  `second-pull-triple-extension` between the two (its value moves by about
  1 around the threshold).
- WebGPU works in this WebView (153) and in Brave; TF.js WebGPU is no
  faster than WebGL for Thunder in Brave, 13% faster in the WebView.
- The CPU stayed at 40–55 °C (live readings).

### Agreement with ViTPose-L (provisional: 4 clips)

Smoothed (what counts) / raw; coverage 100% in every row.

| Candidate | Runtime | Lateral raise, 30 fps | Lateral raise, full | Snatch, 30 fps | Snatch, full |
| --- | --- | --- | --- | --- | --- |
| MoveNet Thunder | WebGL, WebGPU, WASM | 8/8 / 8/8 | 8/8 / 8/8 | 4/4 / 4/4 | 4/4 / 4/4 |
| MoveNet Lightning | WebGL, WebGPU | 8/8 / 8/8 | 8/8 / 8/8 | 3/4 / 3/4 | 3/4 / 3/4 |
| MoveNet Lightning | WASM | 8/8 / 8/8 | 8/8 / 8/8 | 2/4 / 3/4 | 2/4 / 3/4 |
| BlazePose full, TF.js | WebGL, WebGPU | 8/8 / 5/8 | 8/8 / 7/8 | 4/4 / 4/4 | 4/4 / 4/4 |
| BlazePose full, TF.js | WASM | 8/8 / 7/8 | 8/8 / 6/8 | 4/4 / 4/4 | 4/4 / 4/4 |
| BlazePose full, Tasks → ONNX | ONNX Runtime WebGPU | 8/8 / 8/8 | 8/8 / 7/8 | 4/4 / 3/4 | 3/4 / 3/4 |
| BlazePose full, Tasks → ONNX | ONNX Runtime WASM ×1 | 8/8 / 7/8 | 8/8 / 8/8 | 4/4 / 4/4 | 3/4 / 4/4 |
| MediaPipe full (benchmark) | GPU delegate | 8/8 / 7/8 | 8/8 / 7/8 | 4/4 / 3/4 | 4/4 / 3/4 |

- **MoveNet Thunder agrees on every verdict, raw too**, on all three
  backends, as only ViTPose-S at 20 fps did in the first round.
- **Every snatch miss is one cue at its threshold:** the snatch's
  `second-pull-triple-extension` on `Session14` (hip deficit 20.0–20.4
  against the reference's 18.6) for Lightning and for BlazePose on ONNX
  Runtime at full rate, and for Lightning on WASM also on `athlete-a-trim`
  (17.9 against 14.3). WASM and the GPU backends round differently.
- **BlazePose on TF.js is jittery raw** (`lateral-raise-tempo` and
  `-elbow-lead` on `cable-2` flip, raw only): with the package's smoothing
  off, its next ROI comes from unsmoothed landmarks, which MediaPipe's
  graph smooths. Smoothed, it agrees fully.
- Same day, MediaPipe full repeats the first round's 8/8 and 4/4 smoothed,
  at 57 against 55 ms/frame.

## The first round: speed, memory, download (Brave)

Engine ms/frame is the p50 over every processed frame, averaged over the
clips. A 10 s clip is the worst clip's seconds per second of video × 10,
fetch, demux, decode, pose and scoring included (the threshold is ≤ 90 s).
Memory is the browser's RSS plus its GPU memory, the peak during the run
minus the level just before it. Download is the runtime's wasm plus the
weights; first load is the engine ready from a cold page (over USB from the
laptop).

| Candidate | Runtime | fps | ms/frame | 10 s clip, s | Memory, MB | Download, MB | First load, s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MediaPipe lite | GPU delegate | 20 / full | 44 / 46 | 12 / 30 | 324 / 180 | 19 | 1.0 |
| MediaPipe full | GPU delegate | 20 / full | 55 / 55 | 14 / 38 | 243 / 296 | 23 | 1.2 |
| MediaPipe heavy | GPU delegate | 20 / full | 92 / 93 | 24 / 61 | 594 / 549 | 44 | 2.0 |
| RTMPose-s + YOLOX-nano | WASM ×4 | 20 / full | 90 / 88 | 20 / 57 | 184 / 158 | 40 | 2.1 |
| RTMPose-m + YOLOX-nano | WASM ×4 | 20 / full | 144 / 143 | 32 / 92 | 286 / 281 | 72 | 3.3 |
| ViTPose-S + YOLOX-nano | WASM ×4 | 20 / full | 268 / 267 | 57 / 164 | 467 / 472 | 115 | 5.0 |
| ViTPose-B + YOLOX-nano | WASM ×4 | 20 / full | 667 / 676 | 137 / 415 | 1423 / 1420 | 378 | 13.9 |

- **The other runtime is slower for every candidate** (snatch clip only):
  MediaPipe on its CPU delegate 50 / 71 / 272 ms/frame (lite, full, heavy);
  ONNX Runtime's WebGPU backend 146 (RTMPose-s), 207 (RTMPose-m), 486
  (ViTPose-S), 967 (ViTPose-B). More than 4 threads is slower (contention).
- **Without cross-origin isolation** (one thread): ViTPose-S 850 ms/frame,
  RTMPose-s 260, about 3× slower.
- **The detector on every 5th frame** (the box in between from the last
  pose): RTMPose-s 39 ms/frame at full rate (32 s for a 10 s clip), same
  verdicts as with the detector on every frame.
- **Decoding is never the bottleneck:** the loop waits 1–3 ms per frame on
  WebCodecs' hardware decoder; software decode ends at the same total.
- **Run to run:** a repeat of MediaPipe full (full rate) and heavy (20 fps)
  gave the same verdicts and times within 7% (55 → 59, 92 → 93 ms/frame).
- Heat: the CPU's hottest sensor reached 78–95 °C during the WASM runs of
  RTMPose-m and ViTPose, and at most 55 °C during MediaPipe's GPU runs (an
  upper bound: these runs' sampler also read thermalservice's cached
  values; the live readings in the WebView were 42–52 °C).

## The first round: inside the Capacitor WebView

[spike/webview-shell/](../spike/webview-shell/README.md): a throwaway
debug APK, the snatch clip only (1080p60, 7.4 s), each candidate on its
best runtime from Brave.

**Android's WebView (153) can't be cross-origin isolated**, however the page
arrives: bundled (Capacitor sends no COOP/COEP), bundled with COOP/COEP
added to every response, or loaded natively from the laptop with the
server's own headers. No `SharedArrayBuffer`, so ONNX Runtime's
WebAssembly runs on one thread in any Capacitor app.

| Candidate | Runtime | ms/frame, 20 fps / full | 10 s clip, s, 20 fps / full | Memory, MB | First load, s |
| --- | --- | --- | --- | --- | --- |
| MediaPipe lite | GPU delegate | 48 / 50 | 13 / 31 | 174 | 0.5 |
| MediaPipe full | GPU delegate | 60 / 62 | 14 / 39 | 230 / 225 | 0.5 |
| MediaPipe heavy | GPU delegate | 97 / 97 | 23 / 61 | 561 | 0.7 |
| RTMPose-s | WASM ×1 | 261 / 260 | 53 / 158 | 169 | 1.0 |
| RTMPose-s | ONNX Runtime WebGPU | 151 / 157 | 33 / 97 | 518 | 4.4 |
| RTMPose-m | WASM ×1 | 423 / 423 | 86 / 256 | – | 1.2 |
| ViTPose-S | WASM ×1 | 848 / 846 | 171 / 509 | 447 | 1.5 |
| ViTPose-S | ONNX Runtime WebGPU | 490 / 491 | 100 / 297 | – | 6.8 |

Times and first load from the bundled app, except the WebGPU rows
(`server.url`, same WebView, weights over USB from the laptop). Memory is the app plus its
WebView renderers (`com.android.webview:sandboxed_process…`, which the
first sampler missed, so it was measured again on a single run each; – not
measured), the peak above the level just before the run; the app's absolute
peak with MediaPipe full was 1.2 GB.

- MediaPipe on the GPU runs within 15% of Brave (full: 62 against 55
  ms/frame, the same 39 s for a 10 s clip); first load is faster from the
  APK. On all four clips, MediaPipe full (20 fps and full rate) and heavy
  (20 fps) give the same verdicts in the WebView as in Brave, down to the
  same values. The capture checks gave the same results as in Brave (30
  fps, MP4 recording, segments and the encoder's cut decode).
- The bundled APK with every candidate but ViTPose-B was 356 MB; one
  candidate's runtime and weights are 19–115 MB (the table above).
- The CPU stayed at 42–52 °C (the sampler's fixed, live reading).

## The first round: agreement with ViTPose-L (provisional: 4 clips)

Smoothed (what counts) / raw, counting only verdicts both sides score. Every
configuration scored every cue the reference scored (coverage 100%). The
thresholds: lateral raise ≥ 85%, snatch ≥ 80%.

| Candidate | Lateral raise, 20 fps | Lateral raise, full | Snatch, 20 fps | Snatch, full |
| --- | --- | --- | --- | --- |
| MediaPipe lite | 6/8 / 7/8 | 6/8 / 7/8 | 3/4 / 2/4 | 2/4 / 2/4 |
| MediaPipe full | 8/8 / 7/8 | 8/8 / 7/8 | 3/4 / 2/4 | 4/4 / 3/4 |
| MediaPipe heavy | 8/8 / 8/8 | 8/8 / 8/8 | 4/4 / 2/4 | 4/4 / 3/4 |
| RTMPose-s | 7/8 / 7/8 | 7/8 / 7/8 | 4/4 / 3/4 | 3/4 / 4/4 |
| RTMPose-m | 7/8 / 7/8 | 7/8 / 7/8 | 4/4 / 3/4 | 3/4 / 3/4 |
| ViTPose-S | 8/8 / 8/8 | 8/8 / 7/8 | 4/4 / 4/4 | 4/4 / 4/4 |
| ViTPose-B | 8/8 / 8/8 | 8/8 / 8/8 | 4/4 / 3/4 | 4/4 / 4/4 |

- RTMPose's one lateral-raise miss is always `lateral-raise-elbow-lead` on
  `cable-2` (elbow over wrist by 0.9–4.3 against the reference's 5.9).
- MediaPipe full at 20 fps scores the snatch's back angle as "chest rises
  early" (sd 23.9 against 0.8): a tracking error the full frame rate doesn't
  make. Prefer the full frame rate.
- The baseline's 0/4 snatch verdicts on the same two clips (legacy
  `@mediapipe/pose`, `<video>` seeking at 20 fps, raw;
  [map.md](map.md#phone-test-2026-10-31)) don't repeat with the Tasks Pose
  Landmarker and WebCodecs (2–3/4 raw, 3–4/4 smoothed). Both clips are front
  or oblique views; a fair snatch test needs the side-view clips of 3.0.

## Capture (step 3.4, Brave)

From [spike/capture-check/](../spike/capture-check/README.md); recordings
stayed in memory on the phone.

- **The camera gives 30 fps at most.** All six cameras (five back, one
  front) offer Chromium at most 30 fps; asking for exactly 60 fails
  (`OverconstrainedError`). 1080p and 720p both deliver 30.0 fps with frame
  intervals of p50 31–34 ms, p95 43–45 ms, at most 46–49 ms. Question 7's
  "60 fps matters for the snatch" can't be met from the browser on this
  phone; a native camera plugin might, untested.
- **A dim room halves that:** with auto-exposure, a dark room stretched each
  frame to 80 ms (12.4 fps). The checks used manual exposure (10 ms); a gym
  is brighter, but the app should show the delivered frame rate.
- **MediaRecorder writes MP4** (H.264, fragmented), WebM (VP8, VP9, AV1) and
  Matroska (H.264). pose-bench's mp4box path reads the MP4 once its
  duration comes from the samples (fixed in `lib/decode.mjs`: a fragmented
  file's moov says ~0.2 s); mediabunny (MPL-2.0) reads all of them, so no
  separate WebM demuxer is needed if the app records MP4. Software VP8 at
  1080p dropped half the frames.
- **Restarted 10 s segments each decode on their own** (299–301 frames,
  3 keyframes each), overlapped by one frame (35–41 ms). One recorder's
  timeslice chunks can't be read alone after the first.
- **WebCodecs' encoder works as a rolling buffer:** hardware H.264 and
  HEVC (VP8/VP9/AV1 are software only), a keyframe every second, 0 frames
  dropped in 6 s; muxed to MP4 by mediabunny, the whole file and a cut from
  the third keyframe on both decode with mp4box and mediabunny.

## Heat (step 3.4, Brave, on USB power)

35 minutes of back-to-back 10 s recordings (1080×1920, 30 fps, MP4), each
demuxed and decoded while the next recorded, and MediaPipe full (GPU, every
frame) running non-stop on the 1080p60 snatch clip meanwhile (the camera
faced an empty, dark room, which only runs MediaPipe's person detector).
95 segments processed, 115 dropped from the backlog: the engine needs 23 s
per clip, so it never idled.

- **No throttling:** 44–47 ms/frame (p50) in every 3-minute window, the
  first segment 49 and the last 43; each recorded segment decoded in 1.7 s.
- Thermal status 1 ("light") throughout; GPU 53–57 °C; CPU at most 64 °C
  (an upper bound: the sampler read thermalservice's cached values too,
  fixed for the WebView runs). Brave held 1.3–1.45 GB (RSS + GPU memory).
- **Battery, as Android's batterystats estimate** (with `dumpsys battery
  unplug` so it counts while on USB): Brave used about 147 mAh in 37
  minutes, about 3.4% of the 4300 mAh battery, screen excluded. The battery
  level itself fell from 69% to 60% while on the laptop's USB.

## The licence gate

[rules-core.md](rules-core.md#licence-compatible-dependencies): every
dependency that ships is permissive or GPL-3.0-compatible, and (nordmu,
2026-11-01) the pose runtime is open source and buildable from source. The
weights ship too, so both are pass/fail gates next to accuracy and time.
Sources: [THIRD_PARTY.md](../THIRD_PARTY.md#fetched-by-the-phase-3-spike-not-shipped).

| Weights | Licence | Gate |
| --- | --- | --- |
| MoveNet SinglePose Thunder / Lightning v4 | Apache-2.0 (model card, and each Kaggle instance) | **passes** |
| BlazePose GHUM 3D: Pose Landmarker lite / full / heavy (`.task`) and full's ONNX conversion; the TF.js detector v1 and landmark full v2 | Apache-2.0 (model card, Kaggle) | **passes** |
| ViTPose-S/B | Backbones MAE-pretrained; MAE's weights are CC BY-NC 4.0 | **not shippable** unless nordmu and Noah accept the risk |
| RTMPose-s/m | No weights licence stated; trained on 7 datasets with unverified terms | **not shippable** unless nordmu and Noah accept the risk |
| YOLOX-nano (person box for ViTPose and RTMPose) | Apache-2.0 (Megvii) | passes; matters only with a top-down model |

| Runtime | Open source, buildable from source? | F-Droid |
| --- | --- | --- |
| TensorFlow.js WebGL, WebGPU (+ pose-detection) | **Yes**: TypeScript and shader strings, Apache-2.0 | The best case: a Node build, no wasm. The recipe would build tfjs and tfjs-models from their tags, and esbuild (Go; Debian packages it) |
| TensorFlow.js WASM | Yes: C++ (XNNPACK) through emscripten and Bazel | A wasm rebuild in the recipe, with the emsdk-vs-Debian mismatch below |
| ONNX Runtime Web (WASM, WebGPU) | Yes: C++ through emscripten | Same mismatch: ORT pins its own emsdk; no recipe builds `onnxruntime-web` |
| MediaPipe Tasks Vision (web) | **No**: "The GPU code and the code that invokes MediaPipe are not open source" (#5791) | Can't build; fails the rule. Benchmark, and a fallback only if nordmu chooses it |
| ONNX Runtime for Android (native, in a Capacitor plugin) | Yes | `de.schliweb.makeacopy` builds it from source in its recipe; a later option, **not tested** |

### The outcome (provisional: 4 clips)

- **Open candidates pass.** MoveNet Thunder on TF.js agrees on 8/8
  lateral-raise and 4/4 snatch verdicts with 100% coverage, and needs
  27 s for a 10 s clip at 30 fps in the WebView on WebGL (90 s allowed).
  BlazePose full passes too, on TF.js (8/8, 4/4 smoothed) and on ONNX
  Runtime at 30 fps (at full rate 3/4 on the snatch). Lightning fails the
  snatch (3/4, 75%) on one cue at its threshold.
- **The stop condition is not hit:** every candidate agrees on 8/8 lateral
  raises.
- **The weights aren't the problem, Google's runtime is:** the TF.js
  BlazePose landmark model is the Tasks Landmarker's, number for number.
- **Four clips can't separate the candidates:** all but Lightning sit at
  100% smoothed. The validation set (3.0) decides between MoveNet Thunder
  and BlazePose, and the snatch.

### Decision (nordmu, 2026-11-01): the working pick

nordmu took this recommendation as the working pick: Phase 5 builds on it,
and 3.6 on the validation set confirms it or switches. A switch costs an
engine module, its weights and a re-run of the validation, not the cues or
the UI: every candidate hands COCO-17 to `diagnostics.js` behind the same
`estimate()`.

- **Model and runtime: MoveNet SinglePose Thunder on TensorFlow.js,
  every frame**, WebGL backend by default (TypeScript and shaders: the
  most portable backend, and no wasm for F-Droid to rebuild); WebGPU where
  the WebView offers it (26 s against 27 for a 10 s clip in the WebView);
  WebAssembly on one thread as the fallback for a phone without a usable
  GPU (68 s for a 10 s clip at 30 fps, inside 90 s). Weights Apache-2.0, 14 MB with the runtime. Every
  frame because the camera gives 30 fps and the first round saw a 20 fps
  misread.
- **Why Thunder over BlazePose:** the same verdicts smoothed, but Thunder
  agrees raw too (BlazePose on TF.js flips up to three raw verdicts on the
  lateral raises) and gives the same verdicts in the WebView as in Brave
  (BlazePose flips the snatch's second pull at full rate); it is as fast on
  WebGPU and faster on WebGL, outputs COCO-17 directly, and is one model with
  a crop from the last pose, no detector or ROI tracking. BlazePose stays the
  second choice, on TF.js or on ONNX Runtime: 33 points (feet, hands) if a
  later cue needs them.
- **Shell:** unchanged, one web app as a PWA and in Capacitor; the WebView
  can't be isolated, which matters only to the WASM fallback (one thread).
- **The strongest counter-argument:** TensorFlow.js is frozen. 4.22.0
  (2024-10) is its last release and pose-detection 2.1.3 (2023-08) its
  last; the TF Hub URLs it ships with are dead (the weights now come from
  Kaggle). coach would carry a runtime nobody maintains and own every fix;
  open source makes that possible, not cheap. ONNX Runtime is maintained
  and runs BlazePose as well (64–71 ms/frame on WebGPU), but needs our own
  pipeline code, 24 MB of fp32 weights and a wasm F-Droid would have to
  rebuild. Google's newer web runtime, LiteRT.js (`@litertjs/core`,
  Apache-2.0, since 2025-08), wasn't tested, nor whether it builds from
  source. And the pick rests on four clips at 100%.
- **If the validation set fails every open candidate:** native ONNX Runtime
  for Android in a Capacitor plugin (open, built from source by an F-Droid
  app already; Android only, untested), or MediaPipe Tasks as an exception
  nordmu chooses knowingly.

## F-Droid (step 3.8, on paper)

Until it passes, 0.1.0 ships as a PWA and a GitHub APK
([decisions.md](decisions.md#what-010-is)). The runtime rule of 2026-11-01
now steers the choice; F-Droid itself still doesn't.

- **MediaPipe Tasks Vision can't be built from source.** On
  [google-ai-edge/mediapipe#5791](https://github.com/google-ai-edge/mediapipe/issues/5791)
  (2024-12-27) a collaborator assigned to the issue wrote: "The GPU code and
  the code that invokes MediaPipe are not open source" and "It is not
  currently possible to build custom Wasm blobs." So F-Droid can't take it;
  its weights would pass as assets.
- **TensorFlow.js on WebGL or WebGPU ships no wasm at all:** TypeScript and
  shader strings, so the scanner's ban on prebuilt `.wasm` doesn't touch it.
  What a recipe would still have to do is build tfjs (4.22.0) and
  tfjs-models (pose-detection 2.1.3) from their tags, and the bundle with
  esbuild; the tfjs repo builds with Bazel and yarn, and whether a recipe
  can run that is **unchecked**. The WASM backend would bring back the wasm
  problem below.
- **ONNX Runtime Web (and TF.js's WASM backend) would need their wasm
  rebuilt in the recipe.** F-Droid's scanner rejects prebuilt `.wasm`
  (fdroidserver MR !1562, 2024-11), and recipes rebuild wasm with Debian's
  `emscripten` package: in `fdroiddata`, `org.jitsi.meet` rebuilds
  `olm.wasm` that way, and no recipe uses emsdk (pascaline's own check
  agrees). ONNX Runtime pins its own emsdk (4.0.23, unverified here) while
  the build server's Debian ships 3.1.69, and no recipe builds
  `onnxruntime-web`. The nearest precedent, `de.schliweb.makeacopy`, builds
  **native** ONNX Runtime for Android from source (`scandelete:
  external/onnxruntime`, `build_onnxruntime_android.sh`), not the web build.
- **Weights are accepted as assets** when their licence is free and their
  provenance documented (per the research: `de.schliweb.makeacopy`,
  `co.rorystandley.rune`, `com.buzbuz.smartautoclicker`,
  `com.benjaminwan.chinesettstflite`); a non-free licence gets the
  `NonFreeAssets` anti-feature, which ViTPose's and RTMPose's would risk.
  MoveNet's and BlazePose's (Apache-2.0, Google's own uploads) pass.

**The tension of the first round is gone:** MoveNet's and BlazePose's
weights pass the gate, and TF.js on WebGL runs them with no wasm to
rebuild. What stays open is whether an F-Droid recipe can build TF.js
itself.
