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
from pathlib import Path

from flask import Flask, request, jsonify, Response

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
@app.route("/api/pose/video", methods=["POST"])
def api_pose_video():
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

    video_file = request.files["video"]
    ext = os.path.splitext(video_file.filename or "")[1].lstrip(".").lower()
    if ext not in vitpose_backend.VIDEO_EXTENSIONS:
        return jsonify({
            "error": f"video file extension must be one of {vitpose_backend.VIDEO_EXTENSIONS}"
        }), 400

    video_bytes = video_file.read()
    try:
        keypoints, meta = vitpose_backend.infer_video(
            video_bytes, size=size, frame_stride=frame_stride, suffix=f".{ext}")
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 503
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    return jsonify({"keypoints": keypoints, "meta": meta})


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
  body { background:#111; color:#eee; font-family:system-ui,sans-serif; max-width:640px; margin:40px auto; padding:0 16px; }
  h1 { font-weight:600; }
  h2 { font-weight:600; font-size:18px; border-top:1px solid #333; padding-top:24px; margin-top:32px; }
  input,button,select { font-size:16px; padding:8px; margin:4px 0; }
  img { max-width:100%; margin-top:16px; border-radius:8px; }
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
</style>
</head>
<body>
<h1>coach</h1>

<div id="app">
  <input id="file" type="file" accept="image/*">
  <select id="size"><option value="l">l (large, ~1.2GB)</option><option value="h">h (huge, ~2.5GB)</option></select>
  <button id="run">Run pose</button>
  <p id="status"></p>
  <img id="out">
  <pre id="kp" style="white-space:pre-wrap;font-size:12px;color:#9c9"></pre>
</div>

<h2>video</h2>
<div id="vapp">
  <input id="vfile" type="file" accept="video/*">
  <button id="vcam" type="button">record from camera</button>
  <select id="vsize"><option value="l">l (large, ~1.2GB)</option><option value="h">h (huge, ~2.5GB)</option></select>
  <label style="font-size:14px;color:#9ab">frame stride
    <input id="vstride" type="number" value="1" min="1" style="width:4em">
  </label>
  <button id="vrun">Run pose on video</button>
  <p id="vstatus"></p>
  <div id="videoWrap">
    <video id="vout" controls muted playsinline loop></video>
    <canvas id="voverlay"></canvas>
  </div>
  <label style="font-size:14px;color:#9ab">speed
    <select id="vspeed">
      <option value="0.1">0.1x</option>
      <option value="0.25">0.25x</option>
      <option value="0.5">0.5x</option>
      <option value="1" selected>1x</option>
      <option value="1.5">1.5x</option>
      <option value="2">2x</option>
    </select>
  </label>
  <!-- Gaussian sigma, in milliseconds of video time. Applied client-side to the
       track already in memory, so dragging it is instant — no re-run. -->
  <label style="font-size:14px;color:#9ab;margin-left:12px">time smoothing
    <input id="vsmooth" type="range" min="0" max="300" step="5" value="50" style="vertical-align:middle;width:140px">
    <span id="vsmoothVal" style="display:inline-block;min-width:8em">&sigma; = 50 ms</span>
  </label>
  <p id="vsummary" style="font-size:12px;color:#9c9"></p>
  <!-- live sync readout: if the overlay ever looks frozen, this says whether
       playback time is stuck or the frame lookup is. -->
  <p id="vsync" style="font-size:12px;color:#789"></p>
</div>

<!-- Diagnostics sit directly under the video and share its time axis, so any
     point on the curve can be put back on the frame that produced it. -->
<h2>diagnostics</h2>
<div id="diagWrap">
  <label style="font-size:14px;color:#9ab">lifter
    <select id="diagPersonSelect"></select>
  </label>
  <!-- one tickbox per diagnostic: whether it draws on the video. Scoring and
       the plot below are unaffected. -->
  <div id="diagToggles" class="diag-toggles"></div>
  <div id="diagStats" class="diag-tiles"></div>
  <div style="background:#1a1a19; border-radius:8px; border:1px solid #333; padding:8px; box-sizing:border-box;">
    <canvas id="diagCanvas" width="620" height="240" style="width:100%; height:auto; display:block; cursor:pointer;"></canvas>
  </div>
  <div id="diagNotes"></div>
</div>

<h3>keypoint plot</h3>
<div id="plotControls" style="display:none; margin-bottom:12px;">
  <label style="font-size:14px;color:#9ab">person id
    <select id="plotPersonSelect"></select>
  </label>
  <label style="font-size:14px;color:#9ab;margin-left:12px">keypoint
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
  <label style="font-size:14px;color:#9ab;margin-left:12px">axis
    <select id="plotAxisSelect">
      <option value="y" selected>Y position (vertical)</option>
      <option value="x">X position (horizontal)</option>
    </select>
  </label>
</div>
<div id="plotWrap" style="position:relative; width:100%; max-width:640px; background:#1a1a1a; border-radius:8px; border:1px solid #333; padding:8px; box-sizing:border-box;">
  <canvas id="plotCanvas" width="600" height="200" style="width:100%; height:auto; display:block; cursor:pointer;"></canvas>
</div>

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
// Liveness of the overlay loop: when it last painted, and how often the
// watchdog below has had to revive it. Both surface in the #vsync readout.
let vLastDrawMs = 0, vLoopRestarts = 0;
// vSource is whichever video is queued to run — a picked file or a camera
// recording — normalized to {blob, filename} so the run handler doesn't
// care which one it came from.
let vSource = null, vObjectUrl = null, vCamStream = null, vRecorder = null, vChunks = [], vCamTimerId = null, vRecordStart = 0;

const PALETTE = ['#e6194b','#3cb44b','#ffe119','#4363d8','#f58231','#911eb4','#46f0f0','#f032e6'];
const CONF_THRESHOLD = 0.3;

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

// sigma in seconds; 0 (or less) returns the track untouched.
function smoothKeypoints(raw, meta, sigma) {
  if (!raw || !meta || !(sigma > 0)) return raw;

  const frames = (meta.frame_indices && meta.frame_indices.length)
    ? meta.frame_indices
    : Object.keys(raw).map(Number).sort((a, b) => a - b);
  // Decoder timestamps are the authority when we have them — same reasoning as
  // slotForTime below.
  const times = frames.map((f, slot) =>
    (meta.frame_times_ms && meta.frame_times_ms[slot] != null)
      ? meta.frame_times_ms[slot] / 1000
      : f / (meta.fps || 30));

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
  $('vsmoothVal').innerHTML = vSigmaMs ? 'σ = ' + vSigmaMs + ' ms' : 'off (raw)';
  if (!vKeypointsRaw || !vMeta) { vKeypoints = vKeypointsRaw; return; }
  vKeypoints = smoothKeypoints(vKeypointsRaw, vMeta, vSigmaMs / 1000);
  // Overlay and plot before diagnostics: diagnostics.js is the file under
  // active iteration, and a throw from a half-written cue must not be able to
  // strand the slider looking dead.
  updatePlotControls();
  drawOverlay();
  Diagnostics.setTrack(vKeypoints, vMeta, { smoothingMs: vSigmaMs });
}

$('vsmooth').addEventListener('input', applySmoothing);

// --- plot canvas ---
const pcanvas = $('plotCanvas'), pctx = pcanvas.getContext('2d');

// --- diagnostics --- (see diagnostics.js; it owns its own canvas and panels)
// Stubbed if that script failed to load, so a ReferenceError here doesn't take
// the rest of the page's handlers down with it.
const Diagnostics = window.Diagnostics ||
  { mount(){}, setTrack(){}, draw(){}, overlay(){} };
Diagnostics.mount({
  canvas: $('diagCanvas'),
  stats: $('diagStats'),
  notes: $('diagNotes'),
  select: $('diagPersonSelect'),
  toggles: $('diagToggles'),
  wrap: $('diagWrap'),
  video: () => vvideo,
  redraw: () => drawOverlay(),   // toggling a tickbox has to repaint the
                                 // overlay even while the video is paused
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

function drawPlot() {
  pctx.clearRect(0, 0, pcanvas.width, pcanvas.height);
  if (!vKeypoints || !vMeta) return;

  const personId = $('plotPersonSelect').value;
  const kpIdx = parseInt($('plotKeypointSelect').value, 10);
  const axis = $('plotAxisSelect').value; // 'y' (index 0) or 'x' (index 1)
  const coordIdx = axis === 'y' ? 0 : 1;

  if (!personId) return;

  const frameKeys = Object.keys(vKeypoints).map(Number).sort((a,b) => a - b);
  if (frameKeys.length === 0) return;

  const points = [];
  for (const f of frameKeys) {
    const frameData = vKeypoints[String(f)];
    const p = frameData?.[personId]?.[kpIdx];
    if (p && p[2] >= CONF_THRESHOLD) {
      points.push({ frame: f, val: p[coordIdx], t: f / vMeta.fps });
    }
  }

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

  let minVal = Math.min(...points.map(p => p.val));
  let maxVal = Math.max(...points.map(p => p.val));
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

  // Line color matching person palette
  const color = colorForId(personId);
  pctx.strokeStyle = color;
  pctx.lineWidth = 2;
  pctx.beginPath();

  const getX = (f) => padL + (f / maxFrame) * graphW;
  const getY = (val) => {
    // For Y position, inverted coordinates (0 is top of image)
    if (axis === 'y') {
      return padT + ((val - minVal) / (maxVal - minVal)) * graphH;
    } else {
      return padT + (1 - (val - minVal) / (maxVal - minVal)) * graphH;
    }
  };

  points.forEach((pt, i) => {
    const x = getX(pt.frame);
    const y = getY(pt.val);
    if (i === 0) pctx.moveTo(x, y);
    else pctx.lineTo(x, y);
  });
  pctx.stroke();

  // Draw current playhead position
  if (vvideo && vvideo.duration) {
    const currentFrame = Math.floor(vvideo.currentTime * vMeta.fps);
    const playheadX = getX(currentFrame);

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

function colorForId(id) {
  const n = parseInt(id, 10);
  return PALETTE[(Number.isFinite(n) ? n : 0) % PALETTE.length];
}

function syncCanvasSize() {
  vcanvas.width = vvideo.videoWidth || vMeta?.width || 0;
  vcanvas.height = vvideo.videoHeight || vMeta?.height || 0;
}

// Which processed frame belongs on screen at time t (seconds) -> its position
// in vMeta.frame_indices. Timestamps from the decoder are the authority when
// we have them: idx = t * fps silently desyncs on variable-frame-rate captures
// (phone video, MediaRecorder) and breaks outright when the container lies
// about fps — both of which show up as a mesh frozen on a single pose.
function slotForTime(t) {
  const times = vMeta.frame_times_ms;
  if (!times) {   // no usable timestamps — fall back to nominal fps
    const slot = Math.floor((t * vMeta.fps) / vMeta.frame_stride);
    return Math.max(0, Math.min(slot, vMeta.frame_indices.length - 1));
  }
  const ms = t * 1000;
  let lo = 0, hi = times.length - 1;   // last frame whose pts <= ms
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= ms) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function drawOverlay(t) {
  vctx.clearRect(0, 0, vcanvas.width, vcanvas.height);
  if (!vKeypoints || !vMeta) return;

  const time = (typeof t === 'number' && isFinite(t)) ? t : vvideo.currentTime;
  const slot = slotForTime(time);
  const idx = vMeta.frame_indices[slot];
  $('vsync').textContent =
    `t=${time.toFixed(2)}s → frame ${idx} of ${vMeta.frame_count} ` +
    `(sample ${slot + 1}/${vMeta.frame_indices.length}` +
    `${vMeta.frame_times_ms ? ', decoder timestamps' : ', fps estimate'})` +
    // which smoothing width these joints were built with, so "is this the σ I
    // just dragged to?" is answerable without re-running anything
    ` · σ ${vSigmaMs ? vSigmaMs + 'ms' : 'off'}` +
    `${vLoopRestarts ? ` · overlay revived ${vLoopRestarts}×` : ''}`;
  const frame = vKeypoints[String(idx)];

  drawPlot(); // Update playhead line on plot canvas
  Diagnostics.draw();
  Diagnostics.overlay(vctx, idx);   // phase geometry on the frame itself —
                                    // no-ops outside the active phase

  if (!frame) return;

  for (const [id, points] of Object.entries(frame)) {
    const color = colorForId(id);
    vctx.strokeStyle = color;
    vctx.fillStyle = color;
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

function overlayLoop(now, metadata) {
  const t = metadata ? metadata.mediaTime : undefined;
  vLastDrawMs = performance.now();
  // Re-arm BEFORE drawing, not after: drawOverlay pulls in drawPlot and the
  // diagnostics renderer, and re-arming afterwards means the first exception
  // any of them throws kills the overlay for the rest of the session.
  if (vvideo.paused || vvideo.ended) vRafId = null;
  else vRafId = HAS_RVFC ? vvideo.requestVideoFrameCallback(overlayLoop)
                         : requestAnimationFrame(overlayLoop);
  drawOverlay(t);
}

function stopOverlayLoop() {
  if (vRafId === null) return;
  if (HAS_RVFC) vvideo.cancelVideoFrameCallback(vRafId);
  else cancelAnimationFrame(vRafId);
  vRafId = null;
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
  stopOverlayLoop();
  overlayLoop();
}

vvideo.addEventListener('loadedmetadata', () => { syncCanvasSize(); vvideo.playbackRate = parseFloat($('vspeed').value); });
vvideo.addEventListener('play', () => { stopOverlayLoop(); overlayLoop(); });
vvideo.addEventListener('playing', kickOverlayLoop);
vvideo.addEventListener('pause', () => { stopOverlayLoop(); drawOverlay(); });
vvideo.addEventListener('seeked', () => { drawOverlay(); kickOverlayLoop(); });
vvideo.addEventListener('timeupdate', () => {
  if (vvideo.paused) drawOverlay(); else kickOverlayLoop();
});
$('vspeed').onchange = () => { vvideo.playbackRate = parseFloat($('vspeed').value); };

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
  vKeypointsRaw = null; vKeypoints = null; vMeta = null;
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
  vSource = null; vKeypointsRaw = null; vKeypoints = null; vMeta = null;
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

$('vrun').onclick = async () => {
  if (!vSource) { $('vstatus').textContent = 'pick a video or record from camera first'; return; }
  $('vstatus').textContent = 'running (this can take a while — every sampled frame goes through the model)...';
  const fd = new FormData();
  fd.append('video', vSource.blob, vSource.filename);
  fd.append('size', $('vsize').value);
  fd.append('frame_stride', $('vstride').value || '1');
  const r = await fetch('/api/pose/video', {method:'POST', body: fd});
  const data = await r.json();
  if (!r.ok) { $('vstatus').textContent = 'error: ' + data.error; return; }
  vKeypointsRaw = data.keypoints;
  vMeta = data.meta;
  syncCanvasSize();
  applySmoothing();   // builds vKeypoints and refreshes every view, exactly as
                      // a slider drag does — the run only supplies raw points
  // if the video was already rolling when the run finished, the loop it
  // started was drawing nothing — restart it now that there's a track.
  if (!vvideo.paused && !vvideo.ended) { stopOverlayLoop(); overlayLoop(); }
  const ids = new Set();
  for (const frame of Object.values(vKeypoints)) for (const id of Object.keys(frame)) ids.add(id);
  $('vstatus').textContent = 'done';
  $('vsummary').textContent =
    `${vMeta.frames_processed}/${vMeta.frame_count} frames processed (stride ${vMeta.frame_stride}), ` +
    `${vMeta.fps.toFixed(2)} fps, ${ids.size} distinct tracked id(s)`;
};
</script>
</body>
</html>
"""


def preflight():
    lines = []
    for size, ok in vitpose_backend.available().items():
        lines.append(f"  vitpose-{size}-coco: {'ok' if ok else 'MISSING'}")
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

