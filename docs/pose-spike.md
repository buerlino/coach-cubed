# Pose spike: model, runtime and shell (step 3.7)

**Proposed, awaiting nordmu.** Nothing here binds until nordmu confirms it
and it is recorded in [decisions.md](decisions.md#what-010-is). The accuracy
numbers come from the four example clips only and are **provisional** until
the validation set (step 3.0) exists; the speed, memory and capture numbers
are measured on the Fairphone 6 and stand.

## What was measured where

- **On the Fairphone 6** (LineageOS, Android 16), 2026-10-31/11-01: Brave
  156 (Chromium), cross-origin isolated (ONNX Runtime's WebAssembly with 4
  threads); the Capacitor WebView (`com.android.webview` 153); the camera,
  MediaRecorder, WebCodecs and the heat run. On USB power, a cold page per
  run, 15 s between runs.
- **On the laptop:** the agreement (spike/pose-bench/compare.mjs: each
  candidate's track against ViTPose-L's, through `diagnostics.js`); the
  check that ViTPose's heatmap decoding matches easy_ViTPose's.
- **From docs:** the licences and F-Droid.

The clips: two cable lateral raises (`lateral-raise-cable-1/-2`, 8 scored
verdicts) and two snatches (`athlete-a-trim`, a front view, and
`Session14_01_0h18m07s_made`, 1080p60, 4 scored verdicts). **Far too few to
decide on:** one flipped verdict moves a lift by 12–25 points, and most
flips below sit within a few units of a cue's threshold.

## Speed, memory, download (Brave)

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

## Inside the Capacitor WebView

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

## Agreement with ViTPose-L (provisional: 4 clips)

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
dependency that ships is permissive or GPL-3.0-compatible. Weights ship, so
their licence is a pass/fail gate next to accuracy and time, not a footnote.
Sources: [THIRD_PARTY.md](../THIRD_PARTY.md#fetched-by-the-phase-3-spike-not-shipped).

| Candidate | Weights | Gate |
| --- | --- | --- |
| MediaPipe Pose Landmarker (lite, full, heavy) | Apache-2.0, stated on the model card | **passes** |
| ViTPose-S/B | Backbones MAE-pretrained; MAE's weights are CC BY-NC 4.0 | **not shippable** unless nordmu and Noah accept the risk |
| RTMPose-s/m | No weights licence stated; trained on 7 datasets with unverified terms | **not shippable** unless nordmu and Noah accept the risk |
| YOLOX-nano (person box for ViTPose and RTMPose) | Apache-2.0 (Megvii) | passes; matters only with a top-down model |

### The outcome, two ways (provisional: 4 clips)

**If only MediaPipe counts** (the gate as it stands):

- **Lateral raise: MediaPipe full**, GPU delegate, every frame: 8/8
  verdicts smoothed, 100% coverage, a 10 s 1080p60 clip in 38–39 s (Brave
  and the WebView). Heavy agrees as well (8/8) at 61 s and twice the memory;
  lite fails (6/8, 75%).
- **Snatch: provisionally in.** MediaPipe full at full rate agrees on 4/4.
  The expected "snatch moves to 0.2" isn't supported tonight, but the two
  clips are front or oblique views, so the side-view clips of 3.0 decide.
- **The stop condition is not hit:** no candidate is under 70% on the
  lateral raise.

**If nordmu and Noah accepted the ViTPose/RTMPose risk:** the pick stays
MediaPipe full. ViTPose-S agrees best on raw tracks, but in the app (no
isolation) it needs 171 s for a 10 s clip at 20 fps (100 s on ONNX
Runtime's WebGPU). RTMPose-s agrees on 7/8 and 4/4 and needs 53 s at 20 fps
on one thread (33 s on WebGPU). Per frame both are 2.4–14× slower than
MediaPipe full in the WebView, and they download 1.7–5× more. So the outcome
doesn't depend on the risk, and Noah needn't be asked unless the
validation set fails MediaPipe.

### Recommendation (proposed, awaiting nordmu)

- **Model and runtime:** MediaPipe Pose Landmarker full (Tasks Vision
  1.1.1), GPU delegate, every frame; the CPU delegate as the fallback (71
  ms/frame in Brave, 73 in the WebView: a 10 s clip in 45 s; it needs no
  threads, so isolation doesn't matter). Every frame because at 20 fps MediaPipe
  full misread the snatch's back angle once; the phone's camera gives 30
  fps, so a 10 s recording is about 20 s of processing.
- **Shell:** one web app as a PWA and in Capacitor; MediaPipe on the GPU
  needs the same 39 s for a 10 s clip in the WebView as in Brave, and it
  needs no cross-origin isolation, which the WebView can't give. A TWA
  brings nothing a PWA doesn't and needs a Chrome-like browser the test
  phone lacks.
- **The strongest counter-argument:** MediaPipe's web runtime is a closed,
  prebuilt binary (its GPU code isn't open source, see F-Droid below). coach
  can't fix it, can't ship it on F-Droid, and depends on Google's releases.
  And four clips decide nothing yet; the stock Android phone (question 3) is
  untested.

## F-Droid (step 3.8, on paper)

It doesn't steer the choice above. Until it passes, 0.1.0 ships as a PWA and
a GitHub APK ([decisions.md](decisions.md#what-010-is)).

- **MediaPipe Tasks Vision can't be built from source.** On
  [google-ai-edge/mediapipe#5791](https://github.com/google-ai-edge/mediapipe/issues/5791)
  (2024-12-27) a collaborator assigned to the issue wrote: "The GPU code and
  the code that invokes MediaPipe are not open source" and "It is not
  currently possible to build custom Wasm blobs." So F-Droid can't take it;
  its weights would pass as assets.
- **ONNX Runtime Web would need its wasm rebuilt in the recipe.**
  F-Droid's scanner rejects prebuilt `.wasm` (fdroidserver MR !1562,
  2024-11), and recipes rebuild wasm with Debian's `emscripten` package: in
  `fdroiddata`, `org.jitsi.meet` rebuilds `olm.wasm` that way, and no recipe
  uses emsdk (pascaline's own check agrees). ONNX Runtime pins its own emsdk
  (4.0.23, unverified here) while the build server's Debian ships 3.1.69, and
  no recipe builds `onnxruntime-web`. The nearest precedent,
  `de.schliweb.makeacopy`, builds **native** ONNX Runtime for Android from
  source (`scandelete: external/onnxruntime`, `build_onnxruntime_android.sh`),
  not the web build.
- **Weights are accepted as assets** when their licence is free and their
  provenance documented (per the research: `de.schliweb.makeacopy`,
  `co.rorystandley.rune`, `com.buzbuz.smartautoclicker`,
  `com.benjaminwan.chinesettstflite`); a non-free licence gets the
  `NonFreeAssets` anti-feature, which ViTPose's and RTMPose's would risk.

**The tension:** the candidate whose weights pass the licence gate cleanly
(MediaPipe) has the runtime F-Droid can't build, and the runtime F-Droid
could build with work (ONNX Runtime) runs the candidates whose weights don't
pass. An F-Droid build of coach needs either a permissively licensed model
run by ONNX Runtime (rebuilt in the recipe) or a MediaPipe that Google opens.
