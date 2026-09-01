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
  <p id="vsummary" style="font-size:12px;color:#9c9"></p>
</div>

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
let vKeypoints = null, vMeta = null, vRafId = null;

const PALETTE = ['#e6194b','#3cb44b','#ffe119','#4363d8','#f58231','#911eb4','#46f0f0','#f032e6'];
const CONF_THRESHOLD = 0.3;

function colorForId(id) {
  const n = parseInt(id, 10);
  return PALETTE[(Number.isFinite(n) ? n : 0) % PALETTE.length];
}

function syncCanvasSize() {
  vcanvas.width = vvideo.videoWidth || vMeta?.width || 0;
  vcanvas.height = vvideo.videoHeight || vMeta?.height || 0;
}

function drawOverlay() {
  vctx.clearRect(0, 0, vcanvas.width, vcanvas.height);
  if (!vKeypoints || !vMeta) return;

  let idx = Math.floor(vvideo.currentTime * vMeta.fps);
  idx -= idx % vMeta.frame_stride;
  idx = Math.max(0, Math.min(idx, vMeta.frame_count - 1));
  const frame = vKeypoints[String(idx)];
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

function overlayLoop() {
  drawOverlay();
  if (!vvideo.paused && !vvideo.ended) vRafId = requestAnimationFrame(overlayLoop);
}

vvideo.addEventListener('loadedmetadata', () => { syncCanvasSize(); vvideo.playbackRate = parseFloat($('vspeed').value); });
vvideo.addEventListener('play', () => { cancelAnimationFrame(vRafId); overlayLoop(); });
vvideo.addEventListener('pause', () => { cancelAnimationFrame(vRafId); drawOverlay(); });
vvideo.addEventListener('seeked', drawOverlay);
$('vspeed').onchange = () => { vvideo.playbackRate = parseFloat($('vspeed').value); };

$('vfile').onchange = () => {
  const f = $('vfile').files[0];
  if (!f) return;
  vKeypoints = null; vMeta = null;
  $('vsummary').textContent = '';
  vvideo.src = URL.createObjectURL(f);
};

$('vrun').onclick = async () => {
  const f = $('vfile').files[0];
  if (!f) { $('vstatus').textContent = 'pick a video first'; return; }
  $('vstatus').textContent = 'running (this can take a while — every sampled frame goes through the model)...';
  const fd = new FormData();
  fd.append('video', f);
  fd.append('size', $('vsize').value);
  fd.append('frame_stride', $('vstride').value || '1');
  const r = await fetch('/api/pose/video', {method:'POST', body: fd});
  const data = await r.json();
  if (!r.ok) { $('vstatus').textContent = 'error: ' + data.error; return; }
  vKeypoints = data.keypoints;
  vMeta = data.meta;
  syncCanvasSize();
  drawOverlay();
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
