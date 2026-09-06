"""coach: a minimal website around the ViTPose model, same deploy shape as
tecna (Flask + waitress behind Caddy on the tailnet, see ../tecna/Caddyfile)
but with a single in-process backend instead of ComfyUI — see
vitpose_backend.py for why that split doesn't apply here.

app.py's job is deliberately small: an upload endpoint per media type, one
page. Add routes here as the app grows; keep any ML code out of this file
the same way tecna does (imports only vitpose_backend, never torch/cv2/etc.
directly).

Unauthenticated by design — Caddy/tailnet is the access boundary, same as
the rest of the deploy.
"""
import base64
import os
import threading
import time
from pathlib import Path

from flask import Flask, request, jsonify, Response

import equipment_backend
import vitpose_backend

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 300 * 1024 * 1024  # 300MB max upload — video needs
                                                        # far more headroom than a single
                                                        # image; applies to every route


# --- pose ---------------------------------------------------------------
@app.route("/api/pose", methods=["POST"])
def api_pose():
    if "image" not in request.files:
        return jsonify({"error": "no image field in upload"}), 400
    size = request.form.get("size", vitpose_backend.DEFAULT_SIZE)
    if size not in vitpose_backend.SIZES:
        return jsonify({"error": f"size must be one of {vitpose_backend.SIZES}"}), 400

    image_bytes = request.files["image"].read()
    try:
        keypoints, annotated_jpeg = vitpose_backend.infer(image_bytes, size=size)
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 503

    return jsonify({
        "keypoints": keypoints,
        "image": "data:image/jpeg;base64," + base64.b64encode(annotated_jpeg).decode(),
    })


# --- pose (video) ---------------------------------------------------------
# Video inference runs in a background thread rather than inline in the
# request, so the frontend can poll progress and cancel mid-run. There's
# still only ever one video job at a time — vitpose_backend already
# serializes video inference behind _infer_lock (one GPU, one model
# instance per size), so a job registry keyed by id would track concurrency
# the backend doesn't actually have. A single global slot matches that.
class _VideoJob:
    def __init__(self):
        self.lock = threading.Lock()
        self.status = "idle"          # idle | counting | running | done | error | cancelled
        self.processed = 0
        self.total = None             # exact frame count from a pre-count pass, or
                                       # None if that pass couldn't open the file either
        self.rate_ema = None          # smoothed frames/sec, for the ETA
        self._last_tick = None        # (monotonic_time, processed) the EMA was last fed from
        self.result = None            # {"keypoints":..., "meta":...} once done
        self.error = None
        self.cancel_event = threading.Event()


_video_job = _VideoJob()
# Weight on each new throughput sample in the ETA's exponential moving
# average. Low, same reasoning as every other smoothed signal in this
# codebase (see diagnostics.js): raw per-frame timing is noisy (frame
# decode cost varies, thermal throttling, a slow frame with more detected
# people), so the ETA reads instantaneous speed through a lag rather than
# swinging with every sample.
_RATE_EMA_ALPHA = 0.25


@app.route("/api/pose/video/start", methods=["POST"])
def api_pose_video_start():
    if "video" not in request.files:
        return jsonify({"error": "no video field in upload"}), 400
    size = request.form.get("size", vitpose_backend.DEFAULT_SIZE)
    if size not in vitpose_backend.SIZES:
        return jsonify({"error": f"size must be one of {vitpose_backend.SIZES}"}), 400

    frame_stride = request.form.get("frame_stride", "1")
    try:
        frame_stride = int(frame_stride)
        assert frame_stride >= 1
    except (ValueError, AssertionError):
        return jsonify({"error": "frame_stride must be an integer >= 1"}), 400

    # Checkbox on the form, so absent means off — the frontend only sends it
    # when ticked.
    detect_equipment = request.form.get("detect_equipment") in ("1", "true", "on")
    # Checked before the run rather than left to fail inside the worker: the
    # worker's failure is only reported once the whole pose pass has finished,
    # which is a long wait to be told about a missing 600MB download.
    if detect_equipment and not equipment_backend.available():
        return jsonify({"error": "CLIPSeg is not installed — run "
                                 "./scripts/download_models.sh"}), 503

    video_file = request.files["video"]
    ext = os.path.splitext(video_file.filename or "")[1].lstrip(".").lower()
    if ext not in vitpose_backend.VIDEO_EXTENSIONS:
        return jsonify({
            "error": f"video file extension must be one of {vitpose_backend.VIDEO_EXTENSIONS}"
        }), 400

    video_bytes = video_file.read()

    job = _video_job
    with job.lock:
        if job.status in ("counting", "running"):
            return jsonify({"error": "a video analysis is already running"}), 409
        job.status = "counting"
        job.processed = 0
        job.total = None
        job.rate_ema = None
        job._last_tick = None
        job.result = None
        job.error = None
        job.cancel_event = threading.Event()
    cancel_event = job.cancel_event   # captured now: a later start() swaps in a new one

    def progress_cb(processed):
        now = time.monotonic()
        with job.lock:
            if job._last_tick is not None:
                dt = now - job._last_tick[0]
                dn = processed - job._last_tick[1]
                if dt > 0 and dn > 0:
                    inst_rate = dn / dt
                    job.rate_ema = inst_rate if job.rate_ema is None else (
                        _RATE_EMA_ALPHA * inst_rate + (1 - _RATE_EMA_ALPHA) * job.rate_ema)
            job._last_tick = (now, processed)
            job.processed = processed

    def worker():
        # Best-effort: an exact denominator makes the progress bar and ETA
        # meaningful, but its own failure isn't fatal — infer_video runs
        # either way and the frontend falls back to a countless spinner.
        try:
            total = vitpose_backend.count_frames(video_bytes, suffix=f".{ext}")
        except Exception:
            total = None
        with job.lock:
            if job.cancel_event is not cancel_event:
                return   # superseded by a newer start() while we were counting
            job.total = total
            job.status = "running"

        try:
            keypoints, meta = vitpose_backend.infer_video(
                video_bytes, size=size, frame_stride=frame_stride, suffix=f".{ext}",
                progress_cb=progress_cb, cancel_cb=cancel_event.is_set,
                detect_equipment=detect_equipment)
            with job.lock:
                if job.cancel_event is cancel_event:
                    job.result = {"keypoints": keypoints, "meta": meta}
                    job.status = "done"
        except vitpose_backend.Cancelled:
            with job.lock:
                if job.cancel_event is cancel_event:
                    job.status = "cancelled"
        except Exception as e:
            with job.lock:
                if job.cancel_event is cancel_event:
                    job.error = str(e)
                    job.status = "error"

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({"status": "started"})


@app.route("/api/pose/video/progress")
def api_pose_video_progress():
    job = _video_job
    with job.lock:
        eta = None
        if job.total is not None and job.rate_ema and job.rate_ema > 0:
            eta = max(0, job.total - job.processed) / job.rate_ema
        payload = {
            "status": job.status,
            "processed": job.processed,
            "total": job.total,
            "rateFps": job.rate_ema,
            "etaSeconds": eta,
        }
        if job.status == "error":
            payload["error"] = job.error
    return jsonify(payload)


@app.route("/api/pose/video/cancel", methods=["POST"])
def api_pose_video_cancel():
    job = _video_job
    with job.lock:
        if job.status not in ("counting", "running"):
            return jsonify({"error": "no analysis is running"}), 409
        job.cancel_event.set()
    return jsonify({"status": "cancelling"})


@app.route("/api/pose/video/result")
def api_pose_video_result():
    job = _video_job
    with job.lock:
        if job.status != "done" or job.result is None:
            return jsonify({"error": "no finished result is available"}), 409
        result = job.result
        job.result = None
        job.status = "idle"
    return jsonify(result)


# --- capabilities ---------------------------------------------------------
# What this install can actually do, so the page can disable a control rather
# than offer one that will 503. Only CLIPSeg is optional (the pose weights are
# a hard requirement the launch scripts check for), so this is a thin route
# today — but it's the right shape for the next optional model.
@app.route("/api/capabilities")
def api_capabilities():
    return jsonify({"equipment": equipment_backend.available()})


# --- diagnostics ----------------------------------------------------------
# The lifting diagnostics (cue -> number, scored over a detected phase of the
# lift) live in their own file rather than inline in INDEX_HTML: there will be
# one per coaching cue, and they're the part that gets iterated on. Read per
# request so a JS edit needs only a browser reload — restart.sh is for app.py
# changes. See .claude/skills/lifting-diagnostic/ for the contract.
DIAGNOSTICS_JS = Path(__file__).parent / "diagnostics.js"


@app.route("/diagnostics.js")
def diagnostics_js():
    return Response(DIAGNOSTICS_JS.read_text(), mimetype="application/javascript")


@app.route("/")
def index():
    return Response(INDEX_HTML, mimetype="text/html")


INDEX_HTML = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>coach</title>
<style>
  body { background:#111; color:#eee; font-family:system-ui,sans-serif; max-width:1240px; margin:40px auto; padding:0 16px; }
  h1 { font-weight:600; }
  h2 { font-weight:600; font-size:18px; border-top:1px solid #333; padding-top:24px; margin-top:32px; }
  input,button,select { font-size:16px; padding:8px; margin:4px 0; }
  img { max-width:100%; margin-top:16px; border-radius:8px; }
  [hidden] { display:none !important; }   /* beats the display: on .tabs etc. */

  /* image | video is a choice, not two stacked sections: only the selected
     medium's view and its settings are in the DOM flow at all. */
  .tabs { display:flex; gap:4px; border-bottom:1px solid #333; margin:24px 0 20px; }
  .tab { font-size:15px; background:none; border:none; border-bottom:2px solid transparent;
         color:#898781; padding:8px 14px; margin:0 0 -1px; cursor:pointer; }
  .tab:hover { color:#c3c2b7; }
  .tab[aria-selected="true"] { color:#eee; border-bottom-color:#eee; }

  /* Desktop: the view sits beside its settings + everything derived from it,
     and stays put while the panel scrolls — the diagnostics are read against
     the frame on screen, so scrolling the video out of view defeats them.
     Below 900px it collapses back to the single column. */
  .layout { display:grid; gap:28px; align-items:start; }
  @media (min-width: 900px) {
    .layout { grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); }
    .col-view { position:sticky; top:24px; }
  }
  .panel-h { font-weight:600; font-size:18px; border-top:1px solid #333;
             padding-top:20px; margin:28px 0 12px; }
  .panel-h:first-child { border-top:none; padding-top:0; margin-top:0; }
  .settings { display:flex; flex-direction:column; align-items:flex-start; gap:6px; }
  .settings label { font-size:14px; color:#c3c2b7; display:flex; align-items:center;
                    gap:8px; flex-wrap:wrap; }
  .settings input[type=file] { max-width:100%; }
  .settings .row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  #videoWrap { position:relative; max-width:100%; width:fit-content; margin-top:16px; }
  #videoWrap video { max-width:100%; display:block; border-radius:8px; }
  #videoWrap canvas { position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; }
  /* diagnostics — dark chart surface + ink tokens from the validated palette */
  #diagWrap { display:none; }
  .diag-toggles { margin:8px 0 0; display:flex; flex-direction:column; gap:4px; }
  .diag-toggle { font-size:13px; color:#c3c2b7; display:flex; align-items:center; gap:6px; cursor:pointer; }
  .diag-toggle input { margin:0; font-size:inherit; padding:0; }
  .diag-tiles { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
  .diag-tile { flex:1 1 120px; background:#1a1a19; border:1px solid rgba(255,255,255,0.10);
               border-radius:8px; padding:10px 12px; }
  .diag-tile-label { font-size:11px; color:#898781; }
  .diag-tile-value { font-size:22px; font-weight:600; margin:2px 0; }
  .diag-tile-sub { font-size:11px; color:#c3c2b7; }
  .diag-cue { font-size:13px; color:#c3c2b7; margin:12px 0 8px; }
  .diag-notes { font-size:12px; color:#898781; padding-left:18px; margin:0; }
  .diag-notes li { margin-bottom:5px; }
  .diag-notes strong { color:#c3c2b7; font-weight:600; }
  .diag-note { font-size:13px; color:#898781; }
  /* one block per diagnostic, stacked — each owns its own tiles/plot/notes */
  .diag-block { margin-top:24px; padding-top:20px; border-top:1px solid #2c2c2a; }
  .diag-block:first-child { margin-top:14px; padding-top:0; border-top:none; }
  .diag-block-title { font-size:14px; font-weight:600; color:#c3c2b7; margin:0; }
  .diag-canvas-wrap { background:#1a1a19; border-radius:8px; border:1px solid #333; padding:8px; box-sizing:border-box; }
  .diag-canvas { width:100%; height:auto; display:block; cursor:pointer; }
</style>
</head>
<body>
<h1>coach</h1>

<div class="tabs" role="tablist">
  <button id="tabImage" class="tab" type="button" role="tab" aria-selected="false" aria-controls="imageView">image</button>
  <button id="tabVideo" class="tab" type="button" role="tab" aria-selected="true" aria-controls="videoView">video</button>
</div>

<div class="layout">

<!-- left: the selected medium, and only the readouts that annotate the frame
     itself. Everything you can turn a knob on lives in the panel beside it. -->
<div class="col-view">
  <div id="imageView" hidden>
    <img id="out">
    <pre id="kp" style="white-space:pre-wrap;font-size:12px;color:#c3c2b7"></pre>
  </div>
  <div id="videoView">
    <div id="videoWrap">
      <video id="vout" controls muted playsinline loop></video>
      <canvas id="voverlay"></canvas>
    </div>
    <p id="vsummary" style="font-size:12px;color:#c3c2b7"></p>
    <!-- live sync readout: if the overlay ever looks frozen, this says whether
         playback time is stuck or the frame lookup is. -->
    <p id="vsync" style="font-size:12px;color:#898781"></p>
  </div>
</div>

<div class="col-panel">

  <div id="imagePanel" hidden>
    <h2 class="panel-h">settings</h2>
    <div class="settings">
      <input id="file" type="file" accept="image/*">
      <label>model
        <select id="size"><option value="l">l (large, ~1.2GB)</option><option value="h">h (huge, ~2.5GB)</option></select>
      </label>
      <button id="run">Run pose</button>
    </div>
    <p id="status"></p>
  </div>

  <div id="videoPanel">
    <h2 class="panel-h">settings</h2>
    <div class="settings">
      <input id="vfile" type="file" accept="video/*">
      <button id="vcam" type="button">record from camera</button>
      <label>model
        <select id="vsize"><option value="l">l (large, ~1.2GB)</option><option value="h">h (huge, ~2.5GB)</option></select>
      </label>
      <label>frame stride
        <input id="vstride" type="number" value="1" min="1" style="width:4em">
      </label>
      <button id="vrun">Run pose on video</button>
      <button id="vcancel" type="button" style="display:none;background:#722;color:#fff;">Cancel</button>
      <div id="vprogWrap" style="display:none;width:100%;max-width:420px;background:#222;border-radius:6px;overflow:hidden;">
        <div id="vprogBar" style="height:8px;width:0%;background:#4a9;transition:width .2s linear;"></div>
      </div>
      <label>speed
        <select id="vspeed">
          <option value="0.1">0.1x</option>
          <option value="0.25">0.25x</option>
          <option value="0.5">0.5x</option>
          <option value="1" selected>1x</option>
          <option value="1.5">1.5x</option>
          <option value="2">2x</option>
        </select>
      </label>
      <!-- Gaussian sigma, in milliseconds of video time. Applied client-side to
           the track already in memory, so dragging it is instant — no re-run. -->
      <label>time smoothing
        <input id="vsmooth" type="range" min="0" max="300" step="5" value="50" style="vertical-align:middle;width:140px">
        <span id="vsmoothVal" style="display:inline-block;min-width:8em">&sigma; = 50 ms</span>
      </label>
      <!-- second pass of the smoothing: keep the smoothed path, re-time the
           points along it so speed follows the raw track (smoothKeypoints). A
           tickbox so the two can be compared on the speed plot below. -->
      <label style="white-space:nowrap">
        <input id="vkeepvel" type="checkbox" checked style="vertical-align:middle;margin:0 4px 0 0"> preserve velocity
      </label>
      <!-- draw the mesh at the playhead's exact time instead of at the nearest
           processed frame (poseAtTime). Off = every painted pose is one the
           model actually produced; on = the in-between poses are inferred. -->
      <label style="white-space:nowrap" title="Interpolate the mesh between processed frames so it glides instead of stepping. In-between poses are computed, not detected.">
        <input id="vinterp" type="checkbox" checked style="vertical-align:middle;margin:0 4px 0 0"> smooth motion
      </label>
      <!-- Equipment detection is part of the run, not a view setting: it costs
           a second model pass per frame, so it has to be chosen before the run
           rather than toggled after it. The two overlay tickboxes below are the
           view settings, and they only do anything once a run has been made
           with this one on. -->
      <label style="white-space:nowrap" title="Also locate the barbell and its plates on every processed frame, with CLIPSeg. Roughly halves analysis speed.">
        <input id="veqrun" type="checkbox" checked style="vertical-align:middle;margin:0 4px 0 0"> detect bar &amp; plates
      </label>
      <div class="row" style="gap:14px">
        <label style="white-space:nowrap"><input id="veqbar" type="checkbox" style="vertical-align:middle;margin:0 4px 0 0"> overlay bar</label>
        <label style="white-space:nowrap"><input id="veqplates" type="checkbox" style="vertical-align:middle;margin:0 4px 0 0"> overlay plates</label>
      </div>
      <p id="veqnote" style="font-size:12px;color:#898781;margin:2px 0 0"></p>
    </div>
    <p id="vstatus"></p>

    <!-- Diagnostics share the video's time axis, so any point on a curve can be
         put back on the frame that produced it — which is why the frame stays
         pinned beside them on desktop. -->
    <h2 class="panel-h">diagnostics</h2>
    <div id="diagWrap">
      <label style="font-size:14px;color:#c3c2b7">lifter
        <select id="diagPersonSelect"></select>
      </label>
      <!-- one tickbox per diagnostic: whether it draws on the video. Scoring and
           its own block below are unaffected. -->
      <div id="diagToggles" class="diag-toggles"></div>
      <!-- one block per diagnostic (tiles + plot + notes), built by
           diagnostics.js from its DIAGNOSTICS registry — the page holds no
           per-diagnostic markup, so adding one there needs no change here. -->
      <div id="diagSections"></div>
    </div>

    <h2 class="panel-h">keypoint plot</h2>
<div id="plotControls" style="display:none; margin-bottom:12px;">
  <label style="font-size:14px;color:#c3c2b7">person id
    <select id="plotPersonSelect"></select>
  </label>
  <label style="font-size:14px;color:#c3c2b7;margin-left:12px">keypoint
    <select id="plotKeypointSelect">
      <option value="0">0: nose</option>
      <option value="1">1: left_eye</option>
      <option value="2">2: right_eye</option>
      <option value="3">3: left_ear</option>
      <option value="4">4: right_ear</option>
      <option value="5">5: left_shoulder</option>
      <option value="6">6: right_shoulder</option>
      <option value="7">7: left_elbow</option>
      <option value="8">8: right_elbow</option>
      <option value="9">9: left_wrist</option>
      <option value="10" selected>10: right_wrist</option>
      <option value="11">11: left_hip</option>
      <option value="12">12: right_hip</option>
      <option value="13">13: left_knee</option>
      <option value="14">14: right_knee</option>
      <option value="15">15: left_ankle</option>
      <option value="16">16: right_ankle</option>
    </select>
  </label>
  <label style="font-size:14px;color:#c3c2b7;margin-left:12px">axis
    <select id="plotAxisSelect">
      <option value="y" selected>Y position (vertical)</option>
      <option value="x">X position (horizontal)</option>
      <option value="v">speed (px/s)</option>
    </select>
  </label>
</div>
<div id="plotWrap" style="position:relative; width:100%; max-width:640px; background:#1a1a1a; border-radius:8px; border:1px solid #333; padding:8px; box-sizing:border-box;">
  <canvas id="plotCanvas" width="600" height="200" style="width:100%; height:auto; display:block; cursor:pointer;"></canvas>
</div>

  </div><!-- /videoPanel -->
</div><!-- /col-panel -->

</div><!-- /layout -->

<script src="/diagnostics.js"></script>
<script>
const $ = id => document.getElementById(id);

$('run').onclick = async () => {
  const f = $('file').files[0];
  if (!f) return;
  $('status').textContent = 'running...';
  const fd = new FormData();
  fd.append('image', f);
  fd.append('size', $('size').value);
  const r = await fetch('/api/pose', {method:'POST', body: fd});
  const data = await r.json();
  if (!r.ok) { $('status').textContent = 'error: ' + data.error; return; }
  $('status').textContent = 'done';
  $('out').src = data.image;
  $('kp').textContent = JSON.stringify(data.keypoints, null, 1);
};

// --- video: overlay is drawn client-side on a <canvas> synced to the
// <video>'s own playback, using per-frame keypoints computed server-side.
// See vitpose_backend.infer_video for why coach doesn't ship an annotated
// video file back instead.
const vvideo = $('vout'), vcanvas = $('voverlay'), vctx = vcanvas.getContext('2d');
// vKeypointsRaw is exactly what the model returned; vKeypoints is the smoothed
// track every consumer (overlay, plot, diagnostics) reads. Keeping the raw one
// means the smoothing width stays adjustable without re-running inference.
let vKeypointsRaw = null, vKeypoints = null, vMeta = null, vRafId = null;
let vSigmaMs = 0;   // smoothing width the painted overlay was built with
let vKeepVel = true;   // ...and whether its timing was re-fitted to the raw speed
let vInterp = true;    // ...and whether poses between samples are interpolated
// {frames, times} of the track in memory, rebuilt whenever the track is (see
// applySmoothing). Every time->pose lookup goes through it.
let vSample = null;
// Liveness of the overlay loop: when it last painted, and how often the
// watchdog below has had to revive it. Both surface in the #vsync readout.
let vLastDrawMs = 0, vLoopRestarts = 0;
// vSource is whichever video is queued to run — a picked file or a camera
// recording — normalized to {blob, filename} so the run handler doesn't
// care which one it came from.
let vSource = null, vObjectUrl = null, vCamStream = null, vRecorder = null, vChunks = [], vCamTimerId = null, vRecordStart = 0;

// Colour means one thing in coach: how well a diagnostic's cue is being met
// (diagnostics.js owns that green->red ramp). The pose track itself is not a
// score and carries no hue — white for every person, so a coloured mark on the
// frame is always a diagnostic and never a track id.
const SKELETON = '#ffffff';
const CONF_THRESHOLD = 0.3;

// Equipment is the third thing that can be on the frame, and it is neither the
// athlete nor a score: it's an object the segmenter located. So it gets its own
// hues, deliberately off the diagnostics' green->red ramp, and stays off it —
// a plate box must never be readable as a cue being met well or badly.
const EQ_PLATE = '#38bdf8';   // sky
const EQ_BAR = '#c084fc';     // violet
const EQ_WINDOW = 'rgba(192,132,252,0.35)';   // where the bar was searched for
// Per-frame equipment boxes from the run, keyed by frame index exactly like the
// keypoints, plus the prompts that produced them.
let vEquipment = null, vEqPrompts = null;

// --- temporal smoothing ---------------------------------------------------
// The model sees each frame independently, with no temporal prior at all, so a
// joint the lifter is holding perfectly still still wanders a few px per frame.
// Every keypoint's trajectory therefore gets a Gaussian-weighted running mean
// over its neighbouring frames before anything draws or measures it.
//
// The window is in TIME, not in samples: under a variable frame rate (phone
// capture, MediaRecorder) or a frame_stride > 1, a fixed number of samples is a
// different number of seconds at different points in the clip, and the same
// slider position would then mean different amounts of smoothing per video.
//
// Two rules keep the mean honest rather than merely pretty:
//   - sub-threshold neighbours are excluded and the rest are weighted by their
//     confidence, so a wrist the model guessed at while occluded doesn't drag
//     the frames either side of it;
//   - the smoothed point keeps its OWN frame's confidence, so smoothing moves
//     points that were already being drawn and never conjures a joint that the
//     confidence gate was hiding.
const SIGMA_CUTOFF = 3;   // truncate the kernel at 3σ; beyond that the weights
                          // are <1.2% of the centre and cost more than they say

// The sampled frames in order, and the video time (seconds) of each. Decoder
// timestamps are the authority when we have them — same reasoning as
// slotForTime below.
function sampleTimes(meta, kp) {
  const frames = (meta.frame_indices && meta.frame_indices.length)
    ? meta.frame_indices
    : Object.keys(kp).map(Number).sort((a, b) => a - b);
  const times = frames.map((f, slot) =>
    (meta.frame_times_ms && meta.frame_times_ms[slot] != null)
      ? meta.frame_times_ms[slot] / 1000
      : f / (meta.fps || 30));
  return { frames, times };
}

// sigma in seconds; 0 (or less) returns the track untouched.
//
// Two passes. The first is the Gaussian mean of each keypoint's position. The
// second (keepVelocity) corrects what that does to speed: averaging positions
// also averages the velocity, so a fast phase — the second pull, the turnover —
// comes out slower and more drawn-out than the raw track had it. The smoothed
// PATH is fine, it's the timing along it that's been blurred. So the second
// pass keeps the path and re-times the points along it: where the raw track
// says the joint was moving faster than the smoothed one does, consecutive
// points are moved apart along the curve, and bunched where it was slower.
function smoothKeypoints(raw, meta, sigma, keepVelocity) {
  if (!raw || !meta || !(sigma > 0)) return raw;

  const { frames, times } = sampleTimes(meta, raw);
  const cutoff = SIGMA_CUTOFF * sigma, denom = 2 * sigma * sigma;
  const out = {};

  for (let k = 0; k < frames.length; k++) {
    const src = raw[String(frames[k])];
    if (!src) continue;
    const dst = out[String(frames[k])] = {};
    for (const [id, points] of Object.entries(src)) {
      dst[id] = points.map((pt, i) => {
        if (!pt || pt[2] < CONF_THRESHOLD) return pt;
        let sy = 0, sx = 0, w = 0;
        // walk outwards from the centre in both directions, stopping as soon as
        // the kernel has decayed past the cutoff
        for (const dir of [1, -1]) {
          for (let j = k; j >= 0 && j < frames.length; j += dir) {
            if (dir === -1 && j === k) continue;   // centre counted once
            const dt = Math.abs(times[j] - times[k]);
            if (dt > cutoff) break;
            const q = raw[String(frames[j])]?.[id]?.[i];
            if (!q || q[2] < CONF_THRESHOLD) continue;
            const g = Math.exp(-(dt * dt) / denom) * q[2];
            sy += g * q[0]; sx += g * q[1]; w += g;
          }
        }
        return w > 0 ? [sy / w, sx / w, pt[2]] : pt;
      });
    }
  }
  if (!keepVelocity) return out;

  // Second pass, one trajectory at a time: every (person, keypoint) that was
  // confident in at least three sampled frames.
  const ids = new Set();
  for (const f of frames) { const fr = out[String(f)]; if (fr) for (const id of Object.keys(fr)) ids.add(id); }
  for (const id of ids) {
    let nKp = 0;
    for (const f of frames) { const p = out[String(f)]?.[id]; if (p) { nKp = p.length; break; } }
    for (let i = 0; i < nKp; i++) {
      const ks = [];
      for (let k = 0; k < frames.length; k++) {
        const q = raw[String(frames[k])]?.[id]?.[i];
        if (q && q[2] >= CONF_THRESHOLD) ks.push(k);
      }
      if (ks.length < 3) continue;
      const R = ks.map(k => raw[String(frames[k])][id][i]);
      const P = ks.map(k => out[String(frames[k])][id][i]);
      const T = ks.map(k => times[k]);
      const Q = retimeAlongPath(R, P, T, sigma);
      ks.forEach((k, m) => { out[String(frames[k])][id][i] = Q[m]; });
    }
  }
  return out;
}

// Slide the smoothed points P back/forward along their own polyline so that the
// speed along it follows the raw track R. Both are [y, x, conf] over the same
// sample times T.
//
// The measure of "how far along" is arc length. Two piecewise-linear curves are
// compared: the smoothed path's arc length A(k), and the raw track's progress
// R(k) — its frame-to-frame displacement projected onto the smoothed path's
// direction, summed. Projecting matters: raw jitter perpendicular to the path
// is not motion along it and is discarded, while jitter along the path
// telescopes away in the sum, so R(k) is not a random walk. Their difference
// e(k) = R(k) − A(k) is how far ahead the raw track is at sample k, and the
// corrected point is the one at arc length A(k) + e(k) on the smoothed path.
//
// e is band-passed before use, and that's where the honesty lives:
//   - frame-scale wobble in e (σ/2 and below) is the raw jitter's along-path
//     component. Handing it back would undo the smoothing along one axis, so
//     it's removed. The velocity restored is the shape of the speed profile at
//     the timescale the Gaussian damaged, not the per-frame noise.
//   - very slow drift in e (E_COARSE·σ and above) is removed too. At a sharp
//     reversal the smoothed path is genuinely shorter than the raw one (it
//     cuts the corner) and e grows by that shortfall on the way in and again on
//     the way out, permanently. Left in, every reversal would shove all later
//     points forward along the path; high-passed, it becomes a local correction
//     that keeps the speed up going into the corner and coming out of it,
//     which is the most the path itself allows. Speed at the apex of a cut
//     corner cannot be restored by moving along a curve that no longer reaches
//     it — that's the limit of this method, by construction.
const E_FINE = 0.5, E_COARSE = 4;

function retimeAlongPath(R, P, T, sigma) {
  const n = P.length;
  const A = new Float64Array(n), ty = new Float64Array(n), tx = new Float64Array(n);
  for (let m = 1; m < n; m++) {
    const dy = P[m][0] - P[m - 1][0], dx = P[m][1] - P[m - 1][1];
    const len = Math.hypot(dy, dx);
    A[m] = A[m - 1] + len;
    if (len > 1e-9) { ty[m] = dy / len; tx[m] = dx / len; }   // unit tangent of segment m-1 → m
  }
  const e = new Float64Array(n);
  let prog = 0;
  for (let m = 1; m < n; m++) {
    prog += (R[m][0] - R[m - 1][0]) * ty[m] + (R[m][1] - R[m - 1][1]) * tx[m];
    e[m] = prog - A[m];
  }
  const fine = gauss1d(e, T, sigma * E_FINE), coarse = gauss1d(e, T, sigma * E_COARSE);

  const total = A[n - 1];
  const Q = new Array(n);
  for (let m = 0; m < n; m++) {
    const target = Math.max(0, Math.min(total, A[m] + (fine[m] - coarse[m])));
    // segment containing that arc length: last s with A[s] <= target
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (A[mid] <= target) lo = mid; else hi = mid - 1; }
    const s = Math.min(lo, n - 2), seg = A[s + 1] - A[s];
    const u = seg > 1e-9 ? (target - A[s]) / seg : 0;
    Q[m] = [P[s][0] + u * (P[s + 1][0] - P[s][0]),
            P[s][1] + u * (P[s + 1][1] - P[s][1]),
            P[m][2]];
  }
  return Q;
}

// Gaussian smoothing of a scalar series over its (possibly uneven) sample times.
function gauss1d(v, T, s) {
  const n = v.length, out = new Float64Array(n);
  if (!(s > 0)) { out.set(v); return out; }
  const cutoff = SIGMA_CUTOFF * s, denom = 2 * s * s;
  for (let k = 0; k < n; k++) {
    let acc = 0, w = 0;
    for (let j = k; j < n; j++) {
      const dt = T[j] - T[k]; if (dt > cutoff) break;
      const g = Math.exp(-(dt * dt) / denom); acc += g * v[j]; w += g;
    }
    for (let j = k - 1; j >= 0; j--) {
      const dt = T[k] - T[j]; if (dt > cutoff) break;
      const g = Math.exp(-(dt * dt) / denom); acc += g * v[j]; w += g;
    }
    out[k] = w > 0 ? acc / w : v[k];
  }
  return out;
}

// The ONLY place vKeypoints is ever built — the run handler calls this too
// rather than smoothing inline, so a slider drag and a fresh model run can't
// disagree about what the overlay is showing.
//
// Everything it needs is already in the browser: vKeypointsRaw and vMeta. No
// request is made and the model is not re-run; changing the width is a pure
// recomputation over the points already computed. Cheap enough (a few hundred
// samples × 17 keypoints × a handful of neighbours) to run straight off the
// slider's input event, which is why the slider is continuous rather than an
// apply button.
function applySmoothing() {
  vSigmaMs = parseFloat($('vsmooth').value) || 0;
  vKeepVel = $('vkeepvel').checked;
  $('vsmoothVal').innerHTML = vSigmaMs ? 'σ = ' + vSigmaMs + ' ms' : 'off (raw)';
  if (!vKeypointsRaw || !vMeta) { vKeypoints = vKeypointsRaw; vSample = null; return; }
  vKeypoints = smoothKeypoints(vKeypointsRaw, vMeta, vSigmaMs / 1000, vKeepVel);
  vSample = sampleTimes(vMeta, vKeypoints);   // the grid slotForTime/poseAtTime
                                              // look poses up on
  // Overlay and plot before diagnostics: diagnostics.js is the file under
  // active iteration, and a throw from a half-written cue must not be able to
  // strand the slider looking dead.
  updatePlotControls();
  drawOverlay();
  Diagnostics.setTrack(vKeypoints, vMeta, { smoothingMs: vSigmaMs });
}

$('vsmooth').addEventListener('input', applySmoothing);
$('vkeepvel').addEventListener('change', applySmoothing);

// Overlay-only, so these repaint rather than recompute — and they have to
// repaint explicitly, since the paint loop isn't running while the video is
// paused, which is exactly when you tick them.
$('veqbar').addEventListener('change', () => drawOverlay());
$('veqplates').addEventListener('change', () => drawOverlay());

// What the boxes on screen mean: the sentences that produced them, and — when
// a run found nothing — that it was asked at all. Without this a missing box is
// ambiguous between "not detected" and "not looked for".
function vRenderEqNote() {
  const note = $('veqnote');
  const on = $('veqbar').checked || $('veqplates').checked;
  if (!vEquipment) {
    note.textContent = on && vMeta
      ? 'no equipment in this run — re-run with "detect bar & plates" ticked'
      : '';
    return;
  }
  const frames = Object.keys(vEquipment).length;
  let withPlates = 0, withBar = 0, twoStacks = 0;
  for (const e of Object.values(vEquipment)) {
    if (e.plates && e.plates.length) withPlates++;
    if (e.plates && e.plates.length > 1) twoStacks++;
    if (e.bar) withBar++;
  }
  note.textContent =
    `plates "${vEqPrompts?.plates}" — found on ${withPlates}/${frames} frames ` +
    `(both stacks on ${twoStacks}) · bar "${vEqPrompts?.bar}" — ${withBar}/${frames}`;
}

// --- plot canvas ---
const pcanvas = $('plotCanvas'), pctx = pcanvas.getContext('2d');

// --- diagnostics --- (see diagnostics.js; it owns its own canvas and panels)
// Stubbed if that script failed to load, so a ReferenceError here doesn't take
// the rest of the page's handlers down with it.
const Diagnostics = window.Diagnostics ||
  { mount(){}, setTrack(){}, draw(){}, overlay(){} };
Diagnostics.mount({
  sections: $('diagSections'),
  select: $('diagPersonSelect'),
  toggles: $('diagToggles'),
  wrap: $('diagWrap'),
  video: () => vvideo,
  redraw: () => drawOverlay(),   // toggling a tickbox has to repaint the
                                 // overlay even while the video is paused
  // The overlay's own interpolator, handed over rather than reimplemented:
  // the diagnostic marks sit on top of the mesh, and two interpolators that
  // drift apart would show up as the measurement sliding off the joint it is
  // measuring. smoothMotion() is the tickbox, so both obey it together.
  smoothMotion: () => vInterp,
  cubic: cubicAt,
});

function updatePlotControls() {
  if (!vKeypoints) {
    $('plotControls').style.display = 'none';
    pctx.clearRect(0, 0, pcanvas.width, pcanvas.height);
    return;
  }
  const personSelect = $('plotPersonSelect');
  const ids = new Set();
  for (const frame of Object.values(vKeypoints)) {
    for (const id of Object.keys(frame)) ids.add(id);
  }
  const currentVal = personSelect.value;
  personSelect.innerHTML = '';
  const sortedIds = Array.from(ids).sort((a,b) => parseInt(a,10) - parseInt(b,10));
  for (const id of sortedIds) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `person ${id}`;
    personSelect.appendChild(opt);
  }
  if (currentVal && ids.has(currentVal)) {
    personSelect.value = currentVal;
  }
  $('plotControls').style.display = 'block';
  drawPlot();
}

// One trace for the keypoint plot: the chosen coordinate, or the point's speed
// in px/s (central difference across its confident neighbours, over decoder
// time, so a variable frame rate doesn't read as a speed change).
function plotSeries(kp, personId, kpIdx, axis) {
  const { frames, times } = sampleTimes(vMeta, kp);
  const pts = [];
  for (let k = 0; k < frames.length; k++) {
    const p = kp[String(frames[k])]?.[personId]?.[kpIdx];
    if (!p || p[2] < CONF_THRESHOLD) continue;
    pts.push({ frame: frames[k], t: times[k], y: p[0], x: p[1] });
  }
  if (axis !== 'v') return pts.map(p => ({ frame: p.frame, t: p.t, val: axis === 'y' ? p.y : p.x }));
  const out = [];
  for (let m = 1; m < pts.length - 1; m++) {
    const a = pts[m - 1], b = pts[m + 1], dt = b.t - a.t;
    if (!(dt > 0)) continue;
    out.push({ frame: pts[m].frame, t: pts[m].t, val: Math.hypot(b.y - a.y, b.x - a.x) / dt });
  }
  return out;
}

// `time` is the playhead position to mark, in seconds. Passed in rather than
// read off the video so the playhead sits where the mesh is: video.currentTime
// is quantized to the displayed frame, which made this line judder against a
// smoothly moving overlay.
function drawPlot(time) {
  pctx.clearRect(0, 0, pcanvas.width, pcanvas.height);
  if (!vKeypoints || !vMeta) return;

  const personId = $('plotPersonSelect').value;
  const kpIdx = parseInt($('plotKeypointSelect').value, 10);
  const axis = $('plotAxisSelect').value; // 'y', 'x', or 'v' (speed)

  if (!personId) return;

  const frameKeys = Object.keys(vKeypoints).map(Number).sort((a,b) => a - b);
  if (frameKeys.length === 0) return;

  const points = plotSeries(vKeypoints, personId, kpIdx, axis);
  // The raw track underneath, faint, whenever smoothing has changed it: this
  // plot is the direct view of what the slider (and the velocity pass) is doing
  // to a trajectory, and on the speed axis it's the only way to check that the
  // re-timing brought the profile back towards the raw one.
  const rawPoints = (vKeypointsRaw && vKeypointsRaw !== vKeypoints)
    ? plotSeries(vKeypointsRaw, personId, kpIdx, axis) : null;

  const w = pcanvas.width, h = pcanvas.height;
  const padL = 40, padR = 15, padT = 20, padB = 25;
  const graphW = w - padL - padR;
  const graphH = h - padT - padB;

  // Background grid
  pctx.strokeStyle = '#2a2a2a';
  pctx.lineWidth = 1;
  pctx.font = '10px system-ui';
  pctx.fillStyle = '#888';

  const maxFrame = vMeta.frame_count || frameKeys[frameKeys.length - 1] || 1;

  if (points.length === 0) {
    pctx.fillStyle = '#888';
    pctx.textAlign = 'center';
    pctx.fillText('No detected data for selected keypoint / person', w / 2, h / 2);
    return;
  }

  const allVals = points.concat(rawPoints || []).map(p => p.val);
  let minVal = Math.min(...allVals);
  let maxVal = Math.max(...allVals);
  if (minVal === maxVal) { minVal -= 10; maxVal += 10; }
  const valMargin = (maxVal - minVal) * 0.05;
  minVal -= valMargin;
  maxVal += valMargin;

  // Draw Y-axis grid lines & labels
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const ratio = i / steps;
    const yPx = padT + graphH * (1 - ratio);
    pctx.beginPath();
    pctx.moveTo(padL, yPx);
    pctx.lineTo(w - padR, yPx);
    pctx.stroke();

    const val = minVal + ratio * (maxVal - minVal);
    pctx.textAlign = 'right';
    pctx.fillText(Math.round(val), padL - 5, yPx + 3);
  }

  // Draw X-axis label (time)
  pctx.textAlign = 'center';
  pctx.fillText('0s', padL, h - 5);
  pctx.fillText(`${(maxFrame / vMeta.fps).toFixed(1)}s`, w - padR, h - 5);

  pctx.textAlign = 'left';
  pctx.fillText(axis === 'v' ? 'px/s' : 'px', padL, padT - 8);

  const getX = (f) => padL + (f / maxFrame) * graphW;
  const getY = (val) => {
    // For Y position, inverted coordinates (0 is top of image)
    if (axis === 'y') {
      return padT + ((val - minVal) / (maxVal - minVal)) * graphH;
    } else {
      return padT + (1 - (val - minVal) / (maxVal - minVal)) * graphH;
    }
  };
  const trace = (pts) => {
    pctx.beginPath();
    pts.forEach((pt, i) => {
      const x = getX(pt.frame), y = getY(pt.val);
      if (i === 0) pctx.moveTo(x, y); else pctx.lineTo(x, y);
    });
    pctx.stroke();
  };

  if (rawPoints) {   // raw first, so the smoothed trace sits on top of it
    pctx.strokeStyle = 'rgba(255,255,255,0.28)';
    pctx.lineWidth = 1;
    trace(rawPoints);
  }
  pctx.strokeStyle = SKELETON;
  pctx.lineWidth = 2;
  trace(points);

  // Draw current playhead position
  if (vvideo && vvideo.duration) {
    const at = (typeof time === 'number' && isFinite(time)) ? time : vvideo.currentTime;
    const playheadX = getX(at * vMeta.fps);   // fractional frame: the playhead
                                              // moves with the mesh, not in
                                              // whole-frame steps

    pctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    pctx.lineWidth = 1.5;
    pctx.setLineDash([4, 4]);
    pctx.beginPath();
    pctx.moveTo(playheadX, padT);
    pctx.lineTo(playheadX, padT + graphH);
    pctx.stroke();
    pctx.setLineDash([]);
  }
}

$('plotPersonSelect').onchange = drawPlot;
$('plotKeypointSelect').onchange = drawPlot;
$('plotAxisSelect').onchange = drawPlot;

// Clicking plot seeks video
pcanvas.onclick = (e) => {
  if (!vMeta) return;
  const rect = pcanvas.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const scale = pcanvas.width / rect.width;
  const padL = 40, padR = 15, graphW = pcanvas.width - padL - padR;
  const relativeX = (clickX * scale) - padL;
  const ratio = Math.max(0, Math.min(1, relativeX / graphW));
  const targetTime = ratio * (vMeta.frame_count / vMeta.fps);
  vvideo.currentTime = targetTime;
};

function syncCanvasSize() {
  vcanvas.width = vvideo.videoWidth || vMeta?.width || 0;
  vcanvas.height = vvideo.videoHeight || vMeta?.height || 0;
}

// Which processed sample belongs on screen at time t (seconds) -> its position
// in vSample. Decoder timestamps are the authority when we have them (that
// choice lives in sampleTimes): idx = t * fps silently desyncs on
// variable-frame-rate captures (phone video, MediaRecorder) and breaks outright
// when the container lies about fps — both of which show up as a mesh frozen on
// a single pose.
function slotForTime(t) {
  const times = vSample.times;
  let lo = 0, hi = times.length - 1;   // last sample whose time <= t
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// --- sub-frame interpolation ----------------------------------------------
// Smoothing fixes where a joint is; this fixes when. The overlay only ever had
// poses at the processed frames, so between them it held the last one and then
// jumped — at 0.25x playback, or with a frame stride above 1, that step is what
// reads as a jumpy mesh. Below, the mesh is evaluated at the playhead's actual
// time and the in-between poses are interpolated.
//
// Cubic, not linear: linear interpolation is continuous in position but not in
// velocity, so the mesh visibly changes direction at every sample — the very
// stepping this is meant to remove, just smaller. A Hermite spline through the
// two bracketing samples with tangents estimated from their neighbours is
// smooth across the joins.
//
// The tangents are clamped the monotone (Fritsch-Carlson) way, which matters
// for exactly the moments a lift is judged on: at the bottom of a squat an
// unclamped spline overshoots the turnaround and draws the athlete deeper than
// any frame shows them. Flattening the tangent at a local extremum keeps the
// curve inside the samples it was built from, so interpolation can never invent
// a new depth, a new lockout, or a new peak speed.
function monoTangent(dA, hA, dB, hB) {
  if (dA * dB <= 0) return 0;   // local extremum: flat, so no overshoot past it
  const m = (dA * hB + dB * hA) / (hA + hB);   // 3-point slope, uneven spacing
  const lim = 3 * Math.min(Math.abs(dA), Math.abs(dB));
  return Math.sign(m) * Math.min(Math.abs(m), lim);
}

// One coordinate on the segment v1..v2, at fraction u. v0/v3 are the outer
// neighbours and may be null at the ends of the track (then that end's tangent
// falls back to the segment's own slope, i.e. the curve just meets it straight).
function cubicAt(v0, v1, v2, v3, t0, t1, t2, t3, u) {
  const h = t2 - t1;
  if (!(h > 1e-9)) return v1;
  const d = (v2 - v1) / h;
  let m1 = d, m2 = d;
  if (v0 != null && t1 - t0 > 1e-9) m1 = monoTangent((v1 - v0) / (t1 - t0), t1 - t0, d, h);
  if (v3 != null && t3 - t2 > 1e-9) m2 = monoTangent(d, h, (v3 - v2) / (t3 - t2), t3 - t2);
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * v1 + (u3 - 2 * u2 + u) * h * m1
       + (-2 * u3 + 3 * u2) * v2 + (u3 - u2) * h * m2;
}

// The pose to draw at time t: {personId: points}, interpolated between samples
// when 'smooth motion' is on and the exact sampled pose when it is off.
//
// Anything the confidence gate is uncertain about is NOT interpolated — a joint
// the model only found on one side of the gap, or a person present in only one
// of the two frames, snaps at the halfway point instead. Fading between a
// detection and a guess would draw a limb sliding through positions the model
// never proposed, which on this overlay is indistinguishable from a real
// movement of the athlete.
function poseAtTime(t, slot) {
  const { frames, times } = vSample;
  const n = frames.length;
  const at = k => (k >= 0 && k < n) ? vKeypoints[String(frames[k])] : null;
  const A = at(slot);
  if (!vInterp || n < 2 || slot + 1 >= n) return A;

  const span = times[slot + 1] - times[slot];
  const u = span > 1e-9 ? Math.min(Math.max((t - times[slot]) / span, 0), 1) : 0;
  const B = at(slot + 1);
  if (!A || !B) return u < 0.5 ? A : B;

  const P = at(slot - 1), Q = at(slot + 2);
  const t0 = times[slot - 1], t1 = times[slot], t2 = times[slot + 1], t3 = times[slot + 2];
  const out = {};
  for (const id of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const pa = A[id], pb = B[id];
    if (!pa || !pb) { const near = u < 0.5 ? pa : pb; if (near) out[id] = near; continue; }
    const p0 = P && P[id], p3 = Q && Q[id];
    const pts = [];
    for (let k = 0; k < pa.length; k++) {
      const a = pa[k], b = pb[k];
      if (!a || !b || a[2] < CONF_THRESHOLD || b[2] < CONF_THRESHOLD) {
        pts.push(u < 0.5 ? a : b);
        continue;
      }
      // Outer neighbours only shape the curve if they were confident too;
      // otherwise this segment is interpolated as if it were at the end of the
      // track, rather than being steered by a joint the model was guessing at.
      const q0 = p0 && p0[k], q3 = p3 && p3[k];
      const c0 = (q0 && q0[2] >= CONF_THRESHOLD) ? q0 : null;
      const c3 = (q3 && q3[2] >= CONF_THRESHOLD) ? q3 : null;
      pts.push([
        cubicAt(c0 && c0[0], a[0], b[0], c3 && c3[0], t0, t1, t2, t3, u),
        cubicAt(c0 && c0[1], a[1], b[1], c3 && c3[1], t0, t1, t2, t3, u),
        // an interpolated joint is only as trustworthy as the weaker end it
        // was drawn from, so the gate keeps applying mid-segment
        Math.min(a[2], b[2]),
      ]);
    }
    out[id] = pts;
  }
  return out;
}

// Equipment boxes for one processed frame. Deliberately NOT interpolated the
// way the mesh is: a box is the extent of a segmentation mask, not a point on a
// trajectory, and sliding one between two frames would draw an outline around a
// region no mask ever covered. So this paints the nearest processed frame's
// boxes and holds them — an equipment box on screen is always one the model
// actually produced.
function drawEquipment(idx) {
  if (!vEquipment) return;
  const eq = vEquipment[String(idx)];
  if (!eq) return;
  const wantBar = $('veqbar').checked, wantPlates = $('veqplates').checked;

  const box = (b, colour, label) => {
    const [x0, y0, x1, y1] = b;
    vctx.strokeStyle = colour;
    vctx.lineWidth = 3;
    vctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    if (!label) return;
    vctx.font = '600 15px system-ui';
    vctx.fillStyle = colour;
    // Above the box, unless that would be off the top of the frame.
    vctx.fillText(label, x0, y0 > 20 ? y0 - 6 : y1 + 18);
  };

  // The search window first, so the boxes sit on top of it. Shown with the bar
  // because it is the bar's own story: the bar is only ever looked for inside
  // this rectangle, so "no bar box" means something different depending on
  // whether the window is where you expected it.
  if (wantBar && eq.crop) {
    const [x0, y0, x1, y1] = eq.crop;
    vctx.save();
    vctx.setLineDash([6, 6]);
    vctx.strokeStyle = EQ_WINDOW;
    vctx.lineWidth = 2;
    vctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    vctx.restore();
  }
  if (wantPlates) {
    for (const p of (eq.plates || [])) {
      // mm-per-pixel from a 450mm disc — the scale reference this whole
      // detection exists to produce. Flagged approximate because the short side
      // of an axis-aligned box under-reads a disc the camera sees at an angle.
      const mmpx = p.diameter_px ? (450 / p.diameter_px).toFixed(2) : null;
      box(p.box, EQ_PLATE,
          `plate ${p.score.toFixed(2)}` + (mmpx ? ` · ~${mmpx} mm/px` : ''));
    }
  }
  if (wantBar && eq.bar) box(eq.bar.box, EQ_BAR, `bar ${eq.bar.score.toFixed(2)}`);
}

function drawOverlay(t) {
  vctx.clearRect(0, 0, vcanvas.width, vcanvas.height);
  if (!vKeypoints || !vMeta || !vSample) return;

  const time = (typeof t === 'number' && isFinite(t)) ? t : vvideo.currentTime;
  const slot = slotForTime(time);
  const idx = vSample.frames[slot];
  $('vsync').textContent =
    `t=${time.toFixed(2)}s → frame ${idx} of ${vMeta.frame_count} ` +
    `(sample ${slot + 1}/${vSample.frames.length}` +
    `${vMeta.frame_times_ms ? ', decoder timestamps' : ', fps estimate'})` +
    // which smoothing width these joints were built with, so "is this the σ I
    // just dragged to?" is answerable without re-running anything
    ` · σ ${vSigmaMs ? vSigmaMs + 'ms' + (vKeepVel ? ', velocity kept' : '') : 'off'}` +
    // and whether what's painted is a detected pose or an interpolated one
    `${vInterp ? ' · interpolated' : ''}` +
    `${vLoopRestarts ? ` · overlay revived ${vLoopRestarts}×` : ''}`;
  const frame = poseAtTime(time, slot);

  drawPlot(time); // Update playhead line on plot canvas
  Diagnostics.draw(time);
  // Phase geometry on the frame itself — no-ops outside the active phase.
  // Given the time rather than the frame index: the marks are drawn on top of
  // the mesh, so they have to be interpolated on the same clock, or the thing
  // measuring the lifter steps while the lifter glides.
  Diagnostics.overlay(vctx, time);
  // Before the early return below: the plates are in frame whether or not the
  // pose track has a person on this frame, and a dropped detection is exactly
  // when you want the equipment still drawn.
  drawEquipment(idx);

  if (!frame) return;

  for (const points of Object.values(frame)) {
    vctx.strokeStyle = SKELETON;
    vctx.fillStyle = SKELETON;
    vctx.lineWidth = 2;

    for (const [a, b] of vMeta.skeleton) {
      const pa = points[a], pb = points[b];
      if (!pa || !pb || pa[2] < CONF_THRESHOLD || pb[2] < CONF_THRESHOLD) continue;
      vctx.beginPath();
      vctx.moveTo(pa[1], pa[0]);
      vctx.lineTo(pb[1], pb[0]);
      vctx.stroke();
    }
    for (const p of points) {
      if (p[2] < CONF_THRESHOLD) continue;
      vctx.beginPath();
      vctx.arc(p[1], p[0], 3, 0, 2 * Math.PI);
      vctx.fill();
    }
  }
}

// requestVideoFrameCallback hands us the exact mediaTime of the frame the
// compositor is about to show, so the skeleton lands on the frame it was
// computed from instead of on whatever currentTime happens to read mid-rAF.
const HAS_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

// --- the playback clock ---------------------------------------------------
// Painting on rVFC means one paint per VIDEO frame: at 0.25x a 30fps clip that
// is 7 mesh updates a second, correct on every frame it draws and still visibly
// stepping — the slower the playback, the worse it looks, which is the opposite
// of what slow motion is for. So with interpolation on, the paint loop runs on
// requestAnimationFrame (display rate) and asks this clock what time it is.
//
// video.currentTime cannot be that clock: it is quantized to the frame on
// screen, so reading it 4 times while one frame is held returns the same number
// 4 times — the staircase we are trying to get off. The clock is instead the
// last frame the compositor reported, plus wall time since, scaled by the
// playback rate.
let vClock = null;   // {media, wall, gap}: the last presented frame's media
                     // time, when it was presented, and the media-time gap from
                     // the frame before it
let vVfcId = null;   // rVFC subscription kept purely to anchor the clock
let vRafKind = null; // which scheduler vRafId belongs to ('vfc' | 'raf'), since
                     // the toggle can change it between arming and cancelling

function noteFrame(media) {
  const gap = (vClock && media > vClock.media) ? media - vClock.media
                                               : (vClock && vClock.gap);
  vClock = { media, wall: performance.now(),
             gap: gap || 1 / ((vMeta && vMeta.fps) || 30) };
}

function clockTime() {
  if (!vClock) return vvideo.currentTime;
  const ahead = (performance.now() - vClock.wall) / 1000 * (vvideo.playbackRate || 1);
  // Centred on the frame being shown rather than running forward from it. A
  // held frame is a still picture, so a mesh that moves during it must part
  // company with the picture; centring splits that into half a frame of lag
  // then half a frame of lead instead of a whole frame of lead, and keeps the
  // mesh on the athlete in the middle of every frame's time on screen.
  // Clamped to one gap so a stalled decoder can't walk the mesh into the
  // future on its own — extrapolation is a guess about frames not yet shown.
  return vClock.media + Math.min(Math.max(ahead, 0), vClock.gap) - vClock.gap / 2;
}

// Runs only while interpolating: rVFC is then no longer the paint loop, but it
// is still the only accurate report of which frame is on screen and when.
function anchorLoop(now, metadata) {
  noteFrame(metadata.mediaTime);
  vVfcId = (vvideo.paused || vvideo.ended) ? null
         : vvideo.requestVideoFrameCallback(anchorLoop);
}

function overlayLoop(now, metadata) {
  vLastDrawMs = performance.now();
  if (metadata) noteFrame(metadata.mediaTime);
  // Re-arm BEFORE drawing, not after: drawOverlay pulls in drawPlot and the
  // diagnostics renderer, and re-arming afterwards means the first exception
  // any of them throws kills the overlay for the rest of the session.
  if (vvideo.paused || vvideo.ended) { vRafId = null; vRafKind = null; }
  else if (HAS_RVFC && !vInterp) {
    vRafKind = 'vfc'; vRafId = vvideo.requestVideoFrameCallback(overlayLoop);
  } else {
    vRafKind = 'raf'; vRafId = requestAnimationFrame(overlayLoop);
  }
  // No rVFC (Firefox): nothing reports presentation, so currentTime stands in.
  // It is useless as a clock but fine as a "a new frame just appeared" edge,
  // which is all noteFrame needs to anchor from.
  if (vInterp && !HAS_RVFC && (!vClock || vvideo.currentTime !== vClock.media)) {
    noteFrame(vvideo.currentTime);
  }
  drawOverlay(vInterp ? clockTime() : (metadata ? metadata.mediaTime : undefined));
}

function startOverlayLoop() {
  stopOverlayLoop();
  if (HAS_RVFC && vInterp) vVfcId = vvideo.requestVideoFrameCallback(anchorLoop);
  overlayLoop();
}

function stopOverlayLoop() {
  if (vVfcId !== null) { vvideo.cancelVideoFrameCallback(vVfcId); vVfcId = null; }
  if (vRafId === null) return;
  if (vRafKind === 'vfc') vvideo.cancelVideoFrameCallback(vRafId);
  else cancelAnimationFrame(vRafId);
  vRafId = null; vRafKind = null;
}

// A looping <video> never fires 'play' again when it wraps — playback just
// continues — so 'play' cannot be the only thing that starts this loop. When
// the per-frame callback is dropped at the wrap, nothing restarts it and the
// last frame's skeleton stays painted over the whole replay.
//
// A pending rVFC handle is not proof of life either: a callback that is never
// delivered leaves vRafId non-null forever. So the test has to be staleness,
// not vRafId === null. 'timeupdate' fires at ~4Hz throughout playback including
// across the wrap, which makes it the heartbeat. Restarting is idempotent, so a
// spurious kick (at 0.1x speed the gap between frames can legitimately exceed
// the threshold) costs nothing.
const OVERLAY_STALL_MS = 500;

function kickOverlayLoop() {
  if (vvideo.paused || vvideo.ended) return;
  if (vRafId !== null && performance.now() - vLastDrawMs < OVERLAY_STALL_MS) return;
  vLoopRestarts++;
  startOverlayLoop();
}

vvideo.addEventListener('loadedmetadata', () => { syncCanvasSize(); vvideo.playbackRate = parseFloat($('vspeed').value); });
vvideo.addEventListener('play', startOverlayLoop);
vvideo.addEventListener('playing', kickOverlayLoop);
// Both of these leave the playhead somewhere the clock knows nothing about, so
// it is dropped rather than extrapolated from; drawOverlay then falls back to
// currentTime, which is exact while nothing is moving.
vvideo.addEventListener('pause', () => { stopOverlayLoop(); vClock = null; drawOverlay(); });
vvideo.addEventListener('seeked', () => { vClock = null; drawOverlay(); kickOverlayLoop(); });
vvideo.addEventListener('timeupdate', () => {
  if (vvideo.paused) drawOverlay(); else kickOverlayLoop();
});
$('vspeed').onchange = () => { vvideo.playbackRate = parseFloat($('vspeed').value); };
// Toggling this swaps which scheduler drives the paint loop (rVFC vs rAF), so
// a running loop has to be restarted, not just left to notice on its next tick.
$('vinterp').addEventListener('change', () => {
  vInterp = $('vinterp').checked;
  if (vvideo.paused || vvideo.ended) drawOverlay(); else startOverlayLoop();
});

function setVideoSrc(blob) {
  if (vObjectUrl) URL.revokeObjectURL(vObjectUrl);
  vvideo.srcObject = null;
  vObjectUrl = URL.createObjectURL(blob);
  vvideo.src = vObjectUrl;
}

function stopCameraStream() {
  if (vCamStream) { vCamStream.getTracks().forEach(t => t.stop()); vCamStream = null; }
}

$('vfile').onchange = () => {
  const f = $('vfile').files[0];
  if (!f) return;
  stopCameraStream();
  vSource = { blob: f, filename: f.name };
  vKeypointsRaw = null; vKeypoints = null; vMeta = null; vSample = null; vClock = null;
  vEquipment = null; vEqPrompts = null; vRenderEqNote();
  updatePlotControls();
  Diagnostics.setTrack(null, null);
  $('vsummary').textContent = '';
  $('vsync').textContent = '';
  setVideoSrc(f);
};

// Record-then-run, same as picking a file: getUserMedia previews live, a
// click on the same button stops MediaRecorder, and the resulting blob
// becomes vSource exactly like an uploaded file — coach never streams
// frames to the model live, it just fills in the file-picker step.
$('vcam').onclick = async () => {
  if (vRecorder && vRecorder.state === 'recording') { vRecorder.stop(); return; }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  } catch (e) {
    $('vstatus').textContent = 'camera error: ' + e.message;
    return;
  }
  vCamStream = stream;
  $('vfile').value = '';
  vSource = null; vKeypointsRaw = null; vKeypoints = null; vMeta = null; vSample = null; vClock = null;
  vEquipment = null; vEqPrompts = null; vRenderEqNote();
  updatePlotControls();
  Diagnostics.setTrack(null, null);
  $('vsummary').textContent = '';
  $('vsync').textContent = '';
  if (vObjectUrl) { URL.revokeObjectURL(vObjectUrl); vObjectUrl = null; }
  vvideo.src = '';
  vvideo.srcObject = stream;
  vvideo.muted = true;
  await vvideo.play();

  const mimeCandidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  const mime = mimeCandidates.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  vChunks = [];
  vRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  vRecorder.ondataavailable = e => { if (e.data.size) vChunks.push(e.data); };
  vRecorder.onstop = () => {
    stopCameraStream();
    clearInterval(vCamTimerId);
    const blob = new Blob(vChunks, { type: vRecorder.mimeType || 'video/webm' });
    const ext = (blob.type.split('/')[1] || 'webm').split(';')[0];
    vSource = { blob, filename: `camera-recording.${ext}` };
    setVideoSrc(blob);
    vvideo.muted = true;
    $('vcam').textContent = 'record from camera';
    $('vstatus').textContent = `recorded ${Math.round((Date.now() - vRecordStart) / 1000)}s — ready to run`;
  };
  vRecordStart = Date.now();
  vRecorder.start();
  $('vcam').textContent = '■ stop (0s)';
  vCamTimerId = setInterval(() => {
    $('vcam').textContent = `■ stop (${Math.round((Date.now() - vRecordStart) / 1000)}s)`;
  }, 500);
};

// --- video analysis: progress + cancel ------------------------------------
// The model run happens in a background thread server-side (see app.py's
// _VideoJob); this just polls a status endpoint and renders it. There's only
// ever one job on the server, so vPolling is a plain flag rather than
// anything keyed by an id.
let vPolling = false;

function vSetRunning(running) {
  $('vrun').disabled = running;
  $('vcancel').style.display = running ? 'inline-block' : 'none';
  $('vcancel').disabled = false;
  $('vprogWrap').style.display = running ? 'block' : 'none';
}

function vRenderProgress(p) {
  const verb = p.status === 'counting' ? 'counting frames' : 'running';
  if (p.total) {
    const pct = Math.max(0, Math.min(100, Math.round(100 * p.processed / p.total)));
    $('vprogBar').style.width = pct + '%';
    let txt = `${verb}… ${p.processed}/${p.total} (${pct}%)`;
    if (p.etaSeconds != null) txt += ` — ~${Math.ceil(p.etaSeconds)}s left`;
    $('vstatus').textContent = txt;
  } else {
    // No total yet (still counting, or the pre-count pass couldn't open the
    // file — infer_video will likely fail too, but let it say why).
    $('vprogBar').style.width = '0%';
    $('vstatus').textContent = p.status === 'counting'
      ? 'counting frames…'
      : `running… ${p.processed} frames processed (no total available)`;
  }
}

// Polls every 400ms — frequent enough for a smooth-looking bar, cheap enough
// that it's not worth a websocket for a single-user tailnet app.
async function vPoll() {
  if (!vPolling) return;
  let p;
  try {
    p = await (await fetch('/api/pose/video/progress')).json();
  } catch (e) {
    setTimeout(vPoll, 800);   // transient fetch error — keep trying, don't drop the job
    return;
  }
  if (p.status === 'counting' || p.status === 'running') {
    vRenderProgress(p);
    setTimeout(vPoll, 400);
    return;
  }

  vPolling = false;
  vSetRunning(false);

  if (p.status === 'cancelled') { $('vstatus').textContent = 'cancelled'; return; }
  if (p.status === 'error') { $('vstatus').textContent = 'error: ' + p.error; return; }
  if (p.status !== 'done') { $('vstatus').textContent = 'idle'; return; }

  const rr = await fetch('/api/pose/video/result');
  const data = await rr.json();
  if (!rr.ok) { $('vstatus').textContent = 'error: ' + data.error; return; }
  vKeypointsRaw = data.keypoints;
  vMeta = data.meta;
  vEquipment = vMeta.equipment || null;
  vEqPrompts = vMeta.equipment_prompts || null;
  // Tick the overlays for them on the run that produced the boxes — having
  // asked for detection and then seen nothing appear is a worse default than
  // showing what was found.
  if (vEquipment) { $('veqbar').checked = true; $('veqplates').checked = true; }
  vRenderEqNote();
  syncCanvasSize();
  applySmoothing();   // builds vKeypoints and refreshes every view, exactly as
                      // a slider drag does — the run only supplies raw points
  // if the video was already rolling when the run finished, the loop it
  // started was drawing nothing — restart it now that there's a track.
  if (!vvideo.paused && !vvideo.ended) startOverlayLoop();
  $('vstatus').textContent = vMeta.equipment_error
    ? 'done — equipment detection failed: ' + vMeta.equipment_error
    : 'done';
  $('vsummary').textContent =
    `${vMeta.frames_processed}/${vMeta.frame_count} frames processed (stride ${vMeta.frame_stride}), ` +
    `${vMeta.fps.toFixed(2)} fps · ` + subjectLine(vMeta);
}

$('vrun').onclick = async () => {
  if (!vSource) { $('vstatus').textContent = 'pick a video or record from camera first'; return; }
  const fd = new FormData();
  fd.append('video', vSource.blob, vSource.filename);
  fd.append('size', $('vsize').value);
  fd.append('frame_stride', $('vstride').value || '1');
  if ($('veqrun').checked) fd.append('detect_equipment', '1');
  const r = await fetch('/api/pose/video/start', {method:'POST', body: fd});
  const data = await r.json();
  if (!r.ok) { $('vstatus').textContent = 'error: ' + data.error; return; }
  vSetRunning(true);
  $('vprogBar').style.width = '0%';
  $('vstatus').textContent = 'starting…';
  vPolling = true;
  vPoll();
};

$('vcancel').onclick = async () => {
  if (!confirm('Abort the current video analysis?')) return;
  $('vcancel').disabled = true;
  $('vstatus').textContent = 'cancelling…';
  try {
    await fetch('/api/pose/video/cancel', {method:'POST'});
  } catch (e) { /* the next poll tick will surface the real state either way */ }
  // vPoll (already running on its own timer) will see status flip to
  // 'cancelled' and call vSetRunning(false) itself.
};

// The backend keeps only the longest-lived tracked body and throws the rest
// away (vitpose_backend._keep_main_person). Say which one survived and what
// went with it — a background body silently deciding the diagnostics is
// exactly the failure this is meant to prevent, so it can't also be invisible.
function subjectLine(meta) {
  const tr = (meta && meta.tracks) || {};
  const dropped = tr.dropped || [];
  if (tr.kept == null) return 'no person detected';
  let s = `subject: person ${tr.kept} (${tr.kept_frames}/${meta.frames_processed} frames)`;
  if (!dropped.length) return s;
  const shown = dropped.slice(0, 4).map(d => `${d.id}:${d.frames}f`).join(', ');
  s += ` · dropped ${dropped.length} other${dropped.length > 1 ? 's' : ''} (` +
       shown + (dropped.length > 4 ? ', …' : '') + ')';
  // A dropped track nearly as long as the kept one usually isn't a bystander —
  // it's the tracker having split the lifter in two, in which case half the
  // lift just went in the bin.
  if (dropped[0].frames >= 0.4 * tr.kept_frames) s += ' ⚠ possible split track';
  return s;
}

// --- image | video mode ---------------------------------------------------
// One medium at a time. The view goes in the left column and its settings —
// plus, for video, everything computed from the track — go in the right one.
function setMode(mode) {
  const video = mode === 'video';
  $('imageView').hidden = video;
  $('imagePanel').hidden = video;
  $('videoView').hidden = !video;
  $('videoPanel').hidden = !video;
  $('tabImage').setAttribute('aria-selected', String(!video));
  $('tabVideo').setAttribute('aria-selected', String(video));
  // Leaving the video tab pauses playback. A display:none <video> stops
  // delivering frame callbacks, so the overlay watchdog would otherwise spend
  // the whole time reviving a loop that has nothing to paint on.
  if (!video && !(vRecorder && vRecorder.state === 'recording')) vvideo.pause();
}
// CLIPSeg is an optional download (scripts/download_models.sh offers it), so on
// a machine without it the three equipment controls are turned off and say why,
// rather than being tickable into a 503.
fetch('/api/capabilities').then(r => r.json()).then(c => {
  if (c.equipment) return;
  for (const id of ['veqrun', 'veqbar', 'veqplates']) {
    $(id).checked = false;
    $(id).disabled = true;
    $(id).closest('label').style.opacity = 0.5;
  }
  $('veqnote').textContent =
    'bar & plate detection needs CLIPSeg — run ./scripts/download_models.sh';
}).catch(() => { /* leave the controls alone; a run would report the real error */ });

$('tabImage').onclick = () => setMode('image');
$('tabVideo').onclick = () => setMode('video');
setMode('video');   // the diagnostics live here; the image path is the side trip
</script>
</body>
</html>
"""


def preflight():
    lines = []
    for size, ok in vitpose_backend.available().items():
        lines.append(f"  vitpose-{size}-coco: {'ok' if ok else 'MISSING'}")
    if equipment_backend.available():
        lines.append(f"  clipseg: ok ({equipment_backend.model_source()})")
    else:
        lines.append("  clipseg: MISSING — 'detect bar & plates' unavailable; "
                     "run ./scripts/download_models.sh")
    lines.append(f"  device: {vitpose_backend.DEVICE}")
    return lines


if __name__ == "__main__":
    print("coach: checkpoints under", vitpose_backend.MODEL_DIR)
    for line in preflight():
        print(line)

    # Loopback only — same reasoning as tecna: Caddy is the sole LAN/tailnet
    # facing piece and terminates HTTPS. Override with COACH_HOST=0.0.0.0 if
    # you ever need to hit this directly.
    HOST = os.environ.get("COACH_HOST", "127.0.0.1")
    PORT = int(os.environ.get("COACH_PORT", "8080"))  # matches Caddyfile's reverse_proxy —
    # same port tecna uses too, fine since the two sites are never run at once
    try:
        from waitress import serve
        print(f"Serving with waitress (WSGI) on http://{HOST}:{PORT}")
        # channel_timeout raised from 300s: a video upload runs every sampled
        # frame through the model synchronously before responding, which can
        # take a while longer than a single image.
        serve(app, host=HOST, port=PORT, threads=4, channel_timeout=900)
    except ImportError:
        print("waitress not installed — falling back to Flask dev server.")
        app.run(host=HOST, port=PORT, debug=False, threaded=True)

