"""coach: a minimal website around the ViTPose model, same deploy shape as
tecna (Flask + waitress behind Caddy on the tailnet, see ../tecna/Caddyfile)
but with a single in-process backend instead of ComfyUI — see
vitpose_backend.py for why that split doesn't apply here.

app.py's job is deliberately small: auth, one upload endpoint, one page.
Add routes here as the app grows; keep any ML code out of this file the same
way tecna does (imports only vitpose_backend, never torch/cv2/etc. directly).
"""
import hashlib
import os
from functools import wraps
from pathlib import Path

from flask import Flask, request, jsonify, Response

import vitpose_backend

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20MB max upload

# --- auth: identical scheme to tecna/app.py (sha256 password file + bearer
# tokens held in memory) — kept in lockstep so the two apps stay familiar to
# operate, not because coach needs anything fancier than that. ---------------
PASSWORD_FILE = Path("./.auth_password")


def get_password_hash():
    if PASSWORD_FILE.exists():
        return PASSWORD_FILE.read_text().strip()
    return None


def set_password(password):
    hash_val = hashlib.sha256(password.encode()).hexdigest()
    PASSWORD_FILE.write_text(hash_val)
    PASSWORD_FILE.chmod(0o600)
    return hash_val


def check_password(password):
    stored = get_password_hash()
    return bool(stored) and hashlib.sha256(password.encode()).hexdigest() == stored


def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get("Authorization", "").replace("Bearer ", "")
        if not token or token not in app.tokens:
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated


app.tokens = set()


@app.route("/api/auth/status", methods=["GET"])
def auth_status():
    return jsonify({"needs_setup": get_password_hash() is None})


@app.route("/api/auth/init", methods=["POST"])
def auth_init():
    if get_password_hash() is not None:
        return jsonify({"error": "already initialized"}), 400
    password = (request.json or {}).get("password", "")
    if len(password) < 8:
        return jsonify({"error": "password too short"}), 400
    set_password(password)
    return jsonify({"ok": True})


@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    password = (request.json or {}).get("password", "")
    if not check_password(password):
        return jsonify({"error": "wrong password"}), 401
    token = os.urandom(24).hex()
    app.tokens.add(token)
    return jsonify({"token": token})


# --- pose ---------------------------------------------------------------
@app.route("/api/pose", methods=["POST"])
@require_auth
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

    import base64
    return jsonify({
        "keypoints": keypoints,
        "image": "data:image/jpeg;base64," + base64.b64encode(annotated_jpeg).decode(),
    })


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
  input,button,select { font-size:16px; padding:8px; margin:4px 0; }
  #gate input { width:100%; box-sizing:border-box; }
  img { max-width:100%; margin-top:16px; border-radius:8px; }
  #err { color:#f66; }
</style>
</head>
<body>
<h1>coach</h1>

<div id="gate">
  <p id="gate-msg">Checking...</p>
  <input id="pw" type="password" placeholder="password">
  <button id="gate-btn"></button>
  <p id="err"></p>
</div>

<div id="app" style="display:none">
  <input id="file" type="file" accept="image/*">
  <select id="size"><option value="l">l (large, ~1.2GB)</option><option value="h">h (huge, ~2.5GB)</option></select>
  <button id="run">Run pose</button>
  <p id="status"></p>
  <img id="out">
  <pre id="kp" style="white-space:pre-wrap;font-size:12px;color:#9c9"></pre>
</div>

<script>
let token = null;
const $ = id => document.getElementById(id);

async function refreshGate() {
  const r = await fetch('/api/auth/status');
  const {needs_setup} = await r.json();
  $('gate-msg').textContent = needs_setup ? 'Set a password (first run):' : 'Enter password:';
  $('gate-btn').textContent = needs_setup ? 'Set password' : 'Log in';
  $('gate-btn').onclick = () => needs_setup ? doInit() : doLogin();
}

async function doInit() {
  const password = $('pw').value;
  const r = await fetch('/api/auth/init', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password})});
  if (!r.ok) { $('err').textContent = (await r.json()).error; return; }
  doLogin();
}

async function doLogin() {
  const password = $('pw').value;
  const r = await fetch('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password})});
  if (!r.ok) { $('err').textContent = (await r.json()).error; return; }
  token = (await r.json()).token;
  $('gate').style.display = 'none';
  $('app').style.display = 'block';
}

$('run').onclick = async () => {
  const f = $('file').files[0];
  if (!f) return;
  $('status').textContent = 'running...';
  const fd = new FormData();
  fd.append('image', f);
  fd.append('size', $('size').value);
  const r = await fetch('/api/pose', {method:'POST', headers:{'Authorization':'Bearer ' + token}, body: fd});
  const data = await r.json();
  if (!r.ok) { $('status').textContent = 'error: ' + data.error; return; }
  $('status').textContent = 'done';
  $('out').src = data.image;
  $('kp').textContent = JSON.stringify(data.keypoints, null, 1);
};

refreshGate();
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
        serve(app, host=HOST, port=PORT, threads=4, channel_timeout=300)
    except ImportError:
        print("waitress not installed — falling back to Flask dev server.")
        app.run(host=HOST, port=PORT, debug=False, threaded=True)
