# Capture check (Phase 3 spike, step 3.4)

What the gym recording session (milestone B) can count on from the phone's
camera, measured in the browser and in the Capacitor WebView
([restructure-plan.md](../../docs/restructure-plan.md), step 3.4). Not
shipped, not part of `npm test`.

Every check is one async call in `capture.mjs`, exposed as
`window.capture.<name>(opts)`:

| Check | What it measures |
| --- | --- |
| `cameras` | Every camera's label and the sizes, frame rates and exposure times it offers. |
| `camera` | `getUserMedia` from the back camera (or one by `label`; `exposureTime` sets manual exposure, so a dim room doesn't stretch the frames): the frame rate and size actually delivered, frame-interval jitter and late frames (from `MediaStreamTrackProcessor`'s timestamps, so the display's refresh rate doesn't cap them). |
| `recorder` | `MediaRecorder`: the supported types, and whether each recording decodes with pose-bench's `lib/decode.mjs` (mp4box) or with mediabunny's demuxer. |
| `rolling` | Recorders restarted every few seconds, overlapped by a few milliseconds: does each segment decode on its own? And one recorder with a timeslice, whose later chunks can't be read alone. |
| `encoderSupport`, `encoder` | WebCodecs `VideoEncoder` with a keyframe every second, muxed to MP4 or WebM by mediabunny, then a cut from the third keyframe on (the rolling buffer's cut), each read back. |
| `heat` | Back-to-back segments, each demuxed and decoded while the next one records, and the pose engine (pose-bench's worker) run meanwhile, for 30–45 minutes; posts its log after every segment. `poseClip` gives the engine a clip with a lifter in it: a camera facing an empty room only runs MediaPipe's person detector. |

Recordings stay in memory on the phone and are dropped; only timings and
counts reach `results/` (gitignored). Never commit a recording, a frame or a
screenshot.

## Run it

```sh
npm ci --ignore-scripts                     # mediabunny, pinned
node ../pose-bench/serve.mjs 8790           # serves this page too
```

On the Fairphone (`adb -s 4d42e62f`): `adb reverse tcp:8790 tcp:8790`, open
`http://localhost:8790/spike/capture-check/` in Brave, `adb forward
tcp:9333 localabstract:chrome_devtools_remote`, then

```sh
node drive.mjs 9333 capture-check 'capture.camera({ fps: 60 })' results/camera.json --grant http://localhost:8790
node drive.mjs 9333 capture-check 'capture.heat({ minutes: 30 })' --nowait   # posts results/heat.json
```

`--grant` gives the page the camera over the DevTools protocol
(`Browser.grantPermissions`). Brave on Android (156) accepts the call and
prompts anyway, so its prompt has to be allowed on the phone once per page
session ("Remember my decision" off); the Capacitor app gets the camera from
`adb shell pm grant` instead. The phone
samples (heat, memory) come from `../pose-bench/phone-sample.sh`. Remove
every forward and reverse afterwards.

**mediabunny** (MPL-2.0, `1.61.6`) reads WebM, Matroska and fragmented MP4
(MediaRecorder writes all three in Brave 156; mp4box reads only the MP4),
and writes MP4 and WebM: see
[THIRD_PARTY.md](../../THIRD_PARTY.md#fetched-by-the-phase-3-spike-not-shipped).
