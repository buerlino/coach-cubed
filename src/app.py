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
import json
import os
import threading
import time
from pathlib import Path

from flask import Flask, request, jsonify, Response, send_file

import depth_backend
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
        return jsonify({"error": "Grounding DINO is not installed — run "
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
            raw_total = vitpose_backend.count_frames(video_bytes, suffix=f".{ext}")
            # progress_cb reports frames_processed, which is post-stride (infer_video
            # keeps every Nth frame: idx % frame_stride == 0). The denominator has to
            # match that, or the bar caps at 1/stride and the ETA runs ~stride× long.
            # Count of indices in [0, raw_total) divisible by frame_stride = ceil(raw/stride).
            total = -(-raw_total // frame_stride) if raw_total is not None else None
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
# than offer one that will 503. Only the detector is optional (the pose weights are
# a hard requirement the launch scripts check for), so this is a thin route
# today — but it's the right shape for the next optional model.
@app.route("/api/capabilities")
def api_capabilities():
    return jsonify({"equipment": equipment_backend.available()})


# --- 3D depth anchors -----------------------------------------------------
# The "generate 3D" picker below the video frame. Two routes, mirroring the
# framework's cheap/expensive split (see depth_backend): /methods lists the
# anchors so the picker can populate without loading anything, and /generate
# scores every anchor cheaply for one frame then builds the mesh for exactly
# the one chosen (auto = the highest-confidence one). That's the whole point of
# the split — the page never pays for the anchors it didn't pick.
@app.route("/api/depth/methods")
def api_depth_methods():
    # sign_joints and limb_segments ride along with the method list so the page
    # can build both control blocks in the same startup fetch — which joints are
    # ambiguous and which segments have a length are properties of the lift, not
    # of the clip, so there's nothing to wait for and no second round trip.
    return jsonify({"methods": depth_backend.list_methods(),
                    "sign_joints": depth_backend.sign_joints(),
                    "limb_segments": depth_backend.limb_segments(),
                    "generic_limbs": depth_backend.generic_limb_ratios()})


@app.route("/api/depth/generate", methods=["POST"])
def api_depth_generate():
    payload = request.get_json(silent=True)
    if not payload or "keypoints" not in payload:
        return jsonify({"error": "expected JSON with width/height/keypoints"}), 400
    method = payload.get("method", "auto")
    try:
        scene = depth_backend.Scene.from_payload(payload)
        result = depth_backend.generate(scene, method=method)
    except KeyError as e:                       # unknown method name
        return jsonify({"error": str(e)}), 400
    except Exception as e:                       # a mesh() that blew up
        return jsonify({"error": f"depth generation failed: {e}"}), 500
    return jsonify(result)


@app.route("/api/depth/optimize_limbs", methods=["POST"])
def api_depth_optimize_limbs():
    """Descend the limb ratios on one frame against the humanness penalty.

    Same payload as /generate — it needs the pose, and the profile it should
    start from rides in as bone_ratios exactly as it does for a lift. Returns
    both term breakdowns so the caller can show what the move actually bought
    rather than just handing over four new numbers.

    `iters`, `lr`, `line_search` and `term_tol` are exposed because the interface
    runs this in small steps to convergence rather than in a few big ones: the
    objective is known to descend to the wrong lengths on the fixtures, so the
    trajectory and the per-term history it reports back matter as much as the
    four numbers at the end. `iters` is a cap on that, not a target.
    """
    payload = request.get_json(silent=True)
    if not payload or "keypoints" not in payload:
        return jsonify({"error": "expected JSON with width/height/keypoints"}), 400
    try:
        scene = depth_backend.Scene.from_payload(payload)
        frame = payload.get("frame")
        iters = int(payload.get("iters", depth_backend._OPT_ITERS))
        lr = float(payload.get("lr", depth_backend._OPT_LR))
        tol = float(payload.get("term_tol", depth_backend._OPT_TERM_TOL))
        result = depth_backend.optimize_limbs(
            scene, frame=None if frame is None else int(frame),
            iters=max(1, min(iters, 1000)), lr=lr,
            line_search=bool(payload.get("line_search", True)),
            term_tol=max(0.0, tol))
    except (TypeError, ValueError) as e:
        return jsonify({"error": f"bad optimiser settings: {e}"}), 400
    except Exception as e:
        return jsonify({"error": f"limb optimisation failed: {e}"}), 500
    if result is None:
        return jsonify({"error": "not enough of the pose to optimise on"}), 400
    result["labels"] = depth_backend.HUMANNESS_LABELS
    result["ui_max_iters"] = depth_backend._OPT_UI_MAX
    result["ui_lr"] = depth_backend._OPT_UI_LR
    return jsonify(result)


# --- examples -------------------------------------------------------------
# The test fixtures (tests/fixtures, see tests/README.md) double as a browsable
# example gallery, so a fresh checkout has something to run without uploading
# anything of your own. Each fixture ships vitpose_backend's own cached
# `.track.json` next to its clip, so selecting one loads a full,
# already-analysed lift with zero GPU work — the exact shape /api/pose/video
# returns. The fixture set IS the example set: anything added under
# tests/fixtures/<scope>/ shows up here for free, no separate registry to
# maintain.
#
# Two scopes, same layout (own manifest.json + <stance>/ subfolders):
#   global/  committed — ships with the repo
#   local/   gitignored — your own clips, never pushed
# Example ids are "<scope>/<stance>/<clip-stem>", i.e. the manifest key with
# the scope folder prepended, so one id both names the entry and locates its
# files under FIXTURES_DIR.
FIXTURES_DIR = Path(__file__).parent.parent / "tests" / "fixtures"
FIXTURE_SCOPES = ("global", "local")

# Model sizes the UI offers, largest-effort last. Kept in sync with the #vsize
# <select> so a track named for a size we no longer serve is simply ignored.
MODEL_SIZES = ("l", "h")


def _load_manifest():
    """Every scope's manifest merged into one dict keyed by example id
    ("<scope>/<slug>"), each entry tagged with its "scope". A scope with no
    manifest (a fresh checkout's local/) or an unparsable one contributes
    nothing rather than breaking the gallery."""
    merged = {}
    for scope in FIXTURE_SCOPES:
        manifest = FIXTURES_DIR / scope / "manifest.json"
        try:
            entries = json.loads(manifest.read_text())
        except (ValueError, OSError):
            continue
        if not isinstance(entries, dict):
            continue
        for slug, entry in entries.items():
            if isinstance(entry, dict):
                merged[f"{scope}/{slug}"] = {**entry, "scope": scope}
    return merged


def _example_video(example_id):
    """The clip Path for a manifest key, or None. Membership in the manifest is
    the only gate, so a crafted id can't escape FIXTURES_DIR — it just 404s."""
    entry = _load_manifest().get(example_id)
    if not entry:
        return None
    src = entry.get("source_file")
    if not src:
        return None
    video = FIXTURES_DIR / Path(example_id).parent / src
    return video if video.exists() else None


def _example_tracks(example_id):
    """Map of model-size -> cached track Path for a manifest key. An example can
    carry a track from more than one model: a per-size `<id>.<size>.track.json`
    is the explicit form, and a bare legacy `<id>.track.json` counts as the
    size named by the manifest's model_size. Explicit per-size files win. Empty
    if the id isn't a real example or has no cached track."""
    entry = _load_manifest().get(example_id)
    if not entry:
        return {}
    tracks = {}
    legacy = FIXTURES_DIR / (example_id + ".track.json")
    if legacy.exists() and (entry.get("model_size") in MODEL_SIZES):
        tracks[entry["model_size"]] = legacy
    for size in MODEL_SIZES:
        sized = FIXTURES_DIR / (example_id + "." + size + ".track.json")
        if sized.exists():
            tracks[size] = sized
    return tracks


def _default_size(example_id, tracks):
    """Which cached size to serve when the caller doesn't ask for one: the
    manifest's model_size if it has a track, else the smallest available."""
    preferred = (_load_manifest().get(example_id) or {}).get("model_size")
    if preferred in tracks:
        return preferred
    for size in MODEL_SIZES:
        if size in tracks:
            return size
    return None


@app.route("/api/examples")
def api_examples():
    out = []
    for key, entry in _load_manifest().items():
        tracks = _example_tracks(key)
        if not _example_video(key) or not tracks:
            continue
        out.append({
            "id": key,
            # Shown without the scope folder; the frontend groups by scope.
            "label": key.split("/", 1)[1],
            "scope": entry["scope"],
            "stance": entry.get("stance"),
            "notes": entry.get("notes", ""),
            # Which model sizes have a cached track, in UI order — the frontend
            # greys out the rest and only offers to switch overlay to these.
            "sizes": [s for s in MODEL_SIZES if s in tracks],
        })
    # Committed examples first, then your own; alphabetical within each.
    out.sort(key=lambda e: (FIXTURE_SCOPES.index(e["scope"]), e["id"]))
    return jsonify(out)


@app.route("/api/examples/<path:example_id>/video")
def api_example_video(example_id):
    video = _example_video(example_id)
    if not video:
        return jsonify({"error": "unknown example"}), 404
    return send_file(video)


@app.route("/api/examples/<path:example_id>/track")
def api_example_track(example_id):
    tracks = _example_tracks(example_id)
    size = request.args.get("size") or _default_size(example_id, tracks)
    track = tracks.get(size)
    if not track:
        return jsonify({"error": "unknown example track"}), 404
    return send_file(track, mimetype="application/json")


# --- limb-length profiles ---------------------------------------------------
# Segment lengths as a fraction of torso (pelvis->neck), measured off one
# athlete. They belong to the PERSON, not the clip, which is why the depth lift
# can't just read them off the footage: its own per-clip estimate takes each
# segment's longest projection, and that is only the true length if the athlete
# fully extends that limb on camera. In a lifting clip they often never do, so
# every segment reads short and the lift fabricates the difference as depth.
#
# Stored as `<clip-stem>.limbs.json` beside the clip and its track, in whichever
# scope the clip lives in — same "everything about this example sits together"
# rule the cached track already follows, so no separate registry to keep in sync
# and a copied folder brings its profile along. An example with no file falls
# back to "generic", the population priors.
GENERIC_PROFILE_NAME = "generic"


def _example_limbs_path(example_id):
    """Where a manifest key's limb profile lives, or None for a bogus id.

    Membership in the manifest is the only gate — the same rule _example_video
    uses — so a crafted id can't write outside FIXTURES_DIR.
    """
    if example_id not in _load_manifest():
        return None
    return FIXTURES_DIR / (example_id + ".limbs.json")


def _read_limb_profile(example_id):
    """This example's profile, always a usable {name, ratios} dict.

    Missing, unreadable or malformed all degrade to generic rather than
    erroring: a bad profile should cost you the calibration, not the clip. Any
    segment the file omits is filled from the generic table, so a profile
    written before a new segment existed still loads.
    """
    ratios = depth_backend.generic_limb_ratios()
    name, notes = GENERIC_PROFILE_NAME, ""
    path = _example_limbs_path(example_id)
    if path and path.exists():
        try:
            raw = json.loads(path.read_text())
        except (ValueError, OSError):
            raw = None
        if isinstance(raw, dict):
            got = depth_backend.parse_bone_ratios(raw.get("ratios")) or {}
            ratios.update(got)
            if isinstance(raw.get("name"), str) and raw["name"].strip():
                name = raw["name"].strip()
            if isinstance(raw.get("notes"), str):
                notes = raw["notes"]
    return {"name": name, "notes": notes, "ratios": ratios}


@app.route("/api/examples/<path:example_id>/limbs")
def api_example_limbs(example_id):
    if _example_limbs_path(example_id) is None:
        return jsonify({"error": "unknown example"}), 404
    return jsonify(_read_limb_profile(example_id))


@app.route("/api/examples/<path:example_id>/limbs", methods=["PUT"])
def api_example_limbs_save(example_id):
    """Write the profile back beside the clip.

    Validated through the same parse_bone_ratios the lift uses, so what gets
    persisted is exactly what the reconstruction would accept — a value the
    backend would have dropped can't be silently written to disk and then load
    as something else next session.
    """
    path = _example_limbs_path(example_id)
    if path is None:
        return jsonify({"error": "unknown example"}), 404
    payload = request.get_json(silent=True) or {}
    ratios = depth_backend.parse_bone_ratios(payload.get("ratios"))
    if not ratios:
        return jsonify({"error": "no usable ratios"}), 400
    name = payload.get("name")
    body = {"name": (name.strip() if isinstance(name, str) and name.strip()
                     else GENERIC_PROFILE_NAME),
            "notes": payload.get("notes") if isinstance(payload.get("notes"), str) else "",
            "ratios": ratios}
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(body, indent=1, sort_keys=True) + "\n")
    except OSError as e:
        return jsonify({"error": f"could not save: {e}"}), 500
    return jsonify(_read_limb_profile(example_id))


# --- diagnostics ----------------------------------------------------------
# The lifting diagnostics (cue -> number, scored over a detected phase of the
# lift) live in their own file rather than inline in INDEX_HTML: there will be
# one per coaching cue, and they're the part that gets iterated on. Read per
# request so a JS edit needs only a browser reload — restart.sh is for app.py
# changes. See .claude/skills/lifting-diagnostic/ for the contract.
DIAGNOSTICS_JS = Path(__file__).parent / "diagnostics.js"


# three.js for the 3D viewer, served from the repo rather than a CDN. It used
# to come from unpkg, which quietly made the one part of coach that needs the
# public internet the part most likely to be used without it: the app is a
# tailnet/loopback deploy whose models were all pulled local precisely so it
# runs offline, and a phone on the tailnet with no route out would load the
# page, run the reconstruction, and then silently get no viewer. Vendored, the
# 3D view has the same offline guarantee as everything else.
THREE_JS = Path(__file__).parent / "vendor/three.module.js"


@app.route("/vendor/three.module.js")
def three_module_js():
    if not THREE_JS.exists():
        return jsonify({"error": "three.module.js is not vendored"}), 404
    return send_file(THREE_JS, mimetype="application/javascript")


@app.route("/diagnostics.js")
def diagnostics_js():
    return Response(DIAGNOSTICS_JS.read_text(), mimetype="application/javascript")


@app.route("/")
def index():
    return Response(render_index(), mimetype="text/html")


INDEX_HTML = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>coach</title>
<style>
  :root { --bg:#101211; --surface:#171a18; --surface-raised:#1d211e; --line:#343a35;
          --muted:#9b9d96; --text:#f1f0e8; --accent:#f4b84a; --accent-soft:rgba(244,184,74,.14); }
  body { background:linear-gradient(135deg,#101211 0%,#151916 100%); color:var(--text);
         font-family:"Avenir Next","Helvetica Neue",sans-serif; max-width:1240px; min-height:100vh;
         margin:0 auto; padding:40px 16px 72px; }
  body[data-page="snatch"] { --accent:#f4b84a; --accent-soft:rgba(244,184,74,.14); }
  body[data-page="lateral-raise"] { --accent:#57d3c7; --accent-soft:rgba(87,211,199,.14); }
  body[data-page="image"] { --accent:#a8d96c; --accent-soft:rgba(168,217,108,.14); }
  h1 { font-weight:600; letter-spacing:0; margin:0; }
  .app-header { display:flex; align-items:end; justify-content:space-between; gap:20px; }
  .app-kicker { color:var(--accent); font-size:12px; letter-spacing:0; text-transform:uppercase; margin:0 0 6px; }
  .page-context { color:#c3c2b7; font-size:14px; margin:6px 0 0; }
  h2 { font-weight:600; font-size:18px; border-top:1px solid #333; padding-top:24px; margin-top:32px; }
  input,button,select { font-size:16px; padding:8px; margin:4px 0; }
  img { max-width:100%; margin-top:16px; border-radius:8px; }
  [hidden] { display:none !important; }   /* beats the display: on .tabs etc. */

  /* image | video is a choice, not two stacked sections: only the selected
     medium's view and its settings are in the DOM flow at all. */
  .tabs { display:flex; gap:4px; border-bottom:1px solid #333; margin:24px 0 20px; }
  .tab { font-size:15px; background:none; border:none; border-bottom:2px solid transparent;
         color:#898781; padding:8px 14px; margin:0 0 -1px; cursor:pointer; }
  .tab:hover { color:var(--text); background:var(--accent-soft); }
  .tab[aria-selected="true"] { color:var(--text); border-bottom-color:var(--accent); }

  /* Desktop: the view sits beside its settings + everything derived from it,
     and stays put while the panel scrolls — the diagnostics are read against
     the frame on screen, so scrolling the video out of view defeats them.
     Below 900px it collapses back to the single column. */
  .layout { display:grid; gap:28px; align-items:start; }
  @media (min-width: 900px) {
    .layout { grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); }
    .col-view { position:sticky; top:24px; }
  }
  .panel-h { font-weight:600; font-size:18px; border-top:1px solid var(--line);
             padding-top:20px; margin:28px 0 12px; }
  .panel-h:first-child { border-top:none; padding-top:0; margin-top:0; }
  .settings { display:flex; flex-direction:column; align-items:stretch; gap:8px; }
  .settings label { font-size:14px; color:#c3c2b7; display:flex; align-items:center;
                    gap:8px; flex-wrap:wrap; }
  .settings input[type=file] { max-width:100%; }
  .settings .row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .control-group { border:1px solid var(--line); border-radius:8px; background:rgba(23,26,24,.88); padding:12px 14px; }
  .control-group summary { color:#eee; cursor:pointer; font-size:14px; font-weight:600; }
  .control-group summary::marker { color:#898781; }
  .control-group[open] summary { margin-bottom:10px; }
  .control-help { color:#898781; font-size:12px; margin:2px 0 0; }
  .primary-action { background:var(--accent); color:#111; border:0; font-weight:600; cursor:pointer; }
  .secondary-action { background:#252923; color:var(--text); border:1px solid #4a514b; cursor:pointer; }
  button, select, input { border-radius:5px; border:1px solid #444b45; background:#20241f; color:var(--text); }
  button:hover { filter:brightness(1.08); }
  #videoWrap { position:relative; max-width:100%; width:fit-content; margin-top:16px; padding:7px;
               background:#0b0c0b; border:1px solid var(--line); border-radius:10px; box-shadow:0 18px 45px rgba(0,0,0,.22); }
  #videoWrap video { max-width:100%; display:block; border-radius:5px; }
  #videoWrap canvas { position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; }
  /* diagnostics — dark chart surface + ink tokens from the validated palette */
  #diagWrap { display:none; }
  .diag-toggles { margin:8px 0 0; display:flex; flex-direction:column; gap:4px; }
  .diag-toggle { font-size:13px; color:#c3c2b7; display:flex; align-items:center; gap:6px; cursor:pointer; }
  .diag-toggle input { margin:0; font-size:inherit; padding:0; }
  .diag-tiles { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
  .diag-tile { flex:1 1 120px; background:var(--surface); border:1px solid rgba(255,255,255,0.10);
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
  .diag-block { margin-top:24px; padding-top:20px; border-top:1px solid var(--line); }
  .diag-block:first-child { margin-top:14px; padding-top:0; border-top:none; }
  .diag-block-title { font-size:14px; font-weight:600; color:#c3c2b7; margin:0; }
  .diag-canvas-wrap { background:#1a1a19; border-radius:8px; border:1px solid #333; padding:8px; box-sizing:border-box; }
  .diag-canvas { width:100%; height:auto; display:block; cursor:pointer; }
  .overview-strip { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 14px; }
  .overview-chip { background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:9px 11px; color:#c3c2b7; font-size:12px; }
  .overview-chip strong { display:block; color:#eee; font-size:13px; margin-bottom:2px; }
  .plot-group { margin-top:20px; }
  #vsummary { color:var(--accent) !important; font-size:12px; }
  #vstatus { color:var(--accent); min-height:18px; }
  #diagSections { border-left:2px solid var(--accent); padding-left:14px; }
  .diag-block-title { color:var(--text); }
  .diag-canvas-wrap { background:var(--surface); border-color:var(--line); }
  .plot-group > summary { color:var(--muted); cursor:pointer; }
</style>
</head>
<body>
<header class="app-header">
  <div>
    <p class="app-kicker">movement analysis</p>
    <h1>coach</h1>
    <p id="pageContext" class="page-context"></p>
  </div>
</header>

<!-- One tab per page, generated from the PAGES registry in app.py (see
     render_index / PAGES). Each carries data-page; the mode switch at the
     bottom of the script is driven entirely off that, so adding a lift there
     adds its tab here with no markup change. -->
{{TABS}}

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
    <!-- Generate-3D picker: choose which depth anchor lifts the current frame
         to 3D. "Auto" lets the router pick by confidence; a named method forces
         it so a specific anchor can be inspected. Populated from
         /api/depth/methods; the note reports what ran and how each scored. -->
    <div id="v3dbar" class="row" style="gap:10px;align-items:center;margin:6px 0 2px">
      <label style="white-space:nowrap">3D method
        <select id="v3dmethod" title="Which depth anchor lifts the clip to 3D. Auto picks the highest-confidence available one. Recomputes automatically on load and on change.">
          <option value="auto">Auto (highest confidence)</option>
        </select>
      </label>
      <button id="v3dgen" type="button" disabled title="Recompute the 3D reconstruction for the whole clip">recompute 3D</button>
      <label style="white-space:nowrap;font-size:13px" title="Show the per-joint depth direction controls. A single view cannot tell a limb bending toward the camera from one bending away — the depth magnitude is measured, the direction is chosen.">
        <input id="v3dsignshow" type="checkbox" style="vertical-align:middle;margin:0 4px 0 0"> depth direction
      </label>
      <label style="white-space:nowrap;font-size:13px" title="Show this athlete's limb lengths. Segment length as a fraction of torso — the lift turns the gap between a bone's true length and its on-screen length into depth, so a wrong length is invented depth.">
        <input id="v3dlimbshow" type="checkbox" style="vertical-align:middle;margin:0 4px 0 0"> limb lengths
      </label>
    </div>
    <!-- Per-athlete limb lengths. Fractions of torso (pelvis→neck), built from
         the backend's limb_segments() so this markup never lists segments
         itself. An example ships its profile beside the clip; uploads start
         generic. Editing re-runs the lift immediately, saving writes the file. -->
    <div id="v3dlimbbar" style="display:none;margin:2px 0 6px;padding:8px;background:#1a1a19;border:1px solid #2c2c2a;border-radius:8px">
      <div style="font-size:12px;color:#898781;margin-bottom:6px">
        Segment length as a fraction of torso (hips→shoulders), for this athlete.
        <span style="margin-left:8px;color:#898781">profile <b id="v3dlimbname" style="color:#c3c2b7">generic</b></span>
        <button id="v3dlimbreset" type="button" style="font-size:12px;padding:2px 8px;margin-left:8px" title="Back to the population priors">generic</button>
        <button id="v3dlimbrevert" type="button" style="font-size:12px;padding:2px 8px;margin-left:4px" title="Discard edits and reload the profile stored beside this clip">revert</button>
        <button id="v3dlimbsave" type="button" disabled style="font-size:12px;padding:2px 8px;margin-left:4px" title="Write these ratios beside the clip, so this example loads with them next time">save to example</button>
        <button id="v3dlimbfit" type="button" style="font-size:12px;padding:2px 8px;margin-left:12px" title="Small gradient steps on the FIRST frame, from wherever the ratios are now, minimising five anatomical penalties — runs until every one of the five stops moving. Measured against a known athlete this objective drifts ~0.07 torso off the true lengths and settles there, so read the breakdown rather than trusting it.">optimize</button>
        <span id="v3dlimbsteps" style="font-size:12px;color:#898781;margin-left:6px"></span>
        <span id="v3dlimbnote" style="margin-left:8px"></span>
      </div>
      <!-- What the steps actually bought, per humanness term. Shown rather than
           swallowed because on the fixtures this objective is a BIASED estimate
           of limb length: it reliably finds a lower penalty and reliably does so
           at the wrong lengths, so the numbers are the point. -->
      <div id="v3dlimbfitnote" style="display:none;font-size:12px;color:#898781;margin:6px 0 0;padding-top:6px;border-top:1px solid #2c2c2a"></div>
      <div id="v3dlimbs" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:4px 10px"></div>
    </div>
    <!-- Per-joint depth sign. Only the joints reached by walking a bone appear
         here (the backend's sign_joints()); hips/shoulders/nose are placed in
         the image plane and have no direction to choose. Built from
         /api/depth/methods so this markup never has to list joints itself. -->
    <div id="v3dsignbar" style="display:none;margin:2px 0 6px;padding:8px;background:#1a1a19;border:1px solid #2c2c2a;border-radius:8px">
      <div style="font-size:12px;color:#898781;margin-bottom:6px">
        Which way each limb bends out of the screen. <b>toward</b> = toward the camera.
        <label style="margin-left:8px;color:#c3c2b7" title="Auto works the directions out from the pose: it tries all 16 arrangements of the two elbows and two knees (wrists follow their elbow, ankles their knee) and keeps the one whose non-adjacent joint distances stay anatomically plausible over the whole clip. Changing any selector below switches to manual.">mode
          <select id="v3dsignmode" style="font-size:12px;padding:1px 4px;margin:0">
            <option value="auto" selected>auto (infer)</option>
            <option value="manual">manual</option>
          </select>
        </label>
        <button id="v3dsignreset" type="button" style="font-size:12px;padding:2px 8px;margin-left:8px">all toward</button>
      </div>
      <div id="v3dsigns" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:4px 10px"></div>
    </div>
    <p id="v3dnote" style="font-size:12px;color:#898781;margin:0 0 4px"></p>
    <!-- The 3D view: a second "video" below the real one, showing the depth
         reconstruction the picked anchor produced. Hidden until a generate runs.
         Click-drag turns it (turntable about the vertical axis) so the recovered
         depth is actually visible; it steps in time with the video when the
         chosen method returns a per-frame sequence.
         Clicking a joint flips which way it bends out of the screen. That is the
         same choice as the dropdowns above, put where the mistake is actually
         visible: you see a knee pointing the wrong way in the turntable, and the
         fix is to click the knee — not to work out which of thirteen rows it is. -->
    <div id="v3dpanel" style="display:none;margin:2px 0 6px">
      <div id="v3dcanvasWrap" style="position:relative;width:100%;background:#0d0d0d;border-radius:8px;overflow:hidden;cursor:grab">
        <canvas id="v3dcanvas" style="display:block;width:100%;height:340px"></canvas>
        <div id="v3dhint" style="position:absolute;left:8px;bottom:6px;font-size:11px;color:#6f6e68;pointer-events:none">drag to rotate &middot; click a joint to flip its depth</div>
        <div id="v3dkey" style="position:absolute;right:8px;top:6px;font-size:11px;color:#6f6e68;pointer-events:none">
          <span style="color:#6fd1c5">&#9679;</span> toward &nbsp;<span style="color:#f0a020">&#9679;</span> away &nbsp;<span style="color:#6f6e68">&#9679;</span> no choice
        </div>
      </div>
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
    {{IMAGE_SETTINGS}}
    <p id="status"></p>
  </div>

  <div id="videoPanel">
    <h2 class="panel-h">analysis workspace</h2>
    {{VIDEO_SETTINGS}}
    <p id="vstatus"></p>

    <!-- Diagnostics share the video's time axis, so any point on a curve can be
         put back on the frame that produced it — which is why the frame stays
         pinned beside them on desktop. -->
    <h2 class="panel-h">movement overview</h2>
    <div class="overview-strip">
      <div class="overview-chip"><strong>1</strong>Load a clip or camera recording</div>
      <div class="overview-chip"><strong>2</strong>Run pose analysis</div>
      <div class="overview-chip"><strong>3</strong>Review the active movement cues</div>
    </div>
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

    <details class="plot-group">
      <summary class="panel-h">keypoint plot</summary>
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
  </details>
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
// Last currentTime seen by the timeupdate heartbeat, so a backward jump — the
// loop wrapping from the end back to the start — can be caught the instant it
// happens instead of after the staleness watchdog times out.
let vLastTimeupdate = 0;
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

// The currently-loaded example: its manifest id and which model sizes have a
// cached track. Lets switching #vsize swap the overlay to that model's version
// with no pose run. Both null when the source is an upload or a recording.
let vExampleId = null, vExampleSizes = null;

// The loaded track exactly as computed, kept so a display-stride change can
// decimate a fresh copy of it rather than a previously-decimated one.
let vTrackFull = null;

// Reflect an example's cached sizes onto the #vsize picker: available ones stay
// selectable, the rest grey out with a note. `sizes` null clears the restriction
// (a fresh upload/recording can be run at any size). `selected`, if available,
// becomes the current value.
function vSetSizeAvailability(sizes, selected) {
  for (const opt of $('vsize').options) {
    const ok = !sizes || sizes.includes(opt.value);
    opt.disabled = !ok;
    opt.textContent = opt.dataset.label + (ok ? '' : ' — no cached track');
  }
  if (selected && (!sizes || sizes.includes(selected))) $('vsize').value = selected;
}

// Forget the loaded example and restore every size to selectable — for when the
// source becomes an upload, a recording, or a fresh run.
function vClearExample() {
  vExampleId = null; vExampleSizes = null;
  vSetSizeAvailability(null);
  $('vstride').min = 1;
  $('vstrideNote').textContent = '';
  // An upload or a recording is of someone we know nothing about, so the limb
  // profile goes back to the population priors rather than carrying the last
  // athlete's measurements onto a stranger.
  if (v3dLimbSegments.length) v3dSetLimbs(null, { saved: true });
  const note = $('v3dlimbnote');
  if (note) note.textContent = '';
}

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
  { mount(){}, setPage(){}, setTrack(){}, draw(){}, overlay(){} };
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

// Equipment masks for one processed frame. Deliberately NOT interpolated the
// way the mesh is: a mask is the extent of one segmentation, not a point on a
// trajectory, and sliding one between two frames would draw a region no mask
// ever covered. So this paints the nearest processed frame's masks and holds
// them — an equipment overlay on screen is always one the model actually
// produced.
function drawEquipment(idx) {
  if (!vEquipment) return;
  const eq = vEquipment[String(idx)];
  if (!eq) return;
  const wantBar = $('veqbar').checked, wantPlates = $('veqplates').checked;

  // Fall back to the bounding box when a detection predates polygon support.
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

  // The per-pixel prediction itself: fill the mask outline translucent so the
  // frame reads through it, then trace the edge. This is what the box was only
  // ever approximating.
  const mask = (d, colour, label) => {
    const pts = d.polygon;
    if (!pts || pts.length < 3) { box(d.box, colour, label); return; }
    vctx.beginPath();
    vctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) vctx.lineTo(pts[i][0], pts[i][1]);
    vctx.closePath();
    vctx.save();
    vctx.globalAlpha = 0.28;
    vctx.fillStyle = colour;
    vctx.fill();
    vctx.restore();
    vctx.strokeStyle = colour;
    vctx.lineWidth = 2;
    vctx.stroke();
    if (!label) return;
    // Anchor the label at the mask's topmost vertex, same "above unless it
    // clips the frame" rule as the box label.
    let ax = pts[0][0], ay = pts[0][1];
    for (const [x, y] of pts) if (y < ay) { ay = y; ax = x; }
    vctx.font = '600 15px system-ui';
    vctx.fillStyle = colour;
    vctx.fillText(label, ax, ay > 20 ? ay - 6 : ay + 18);
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
      mask(p, EQ_PLATE,
          `plate ${p.score.toFixed(2)}` + (mmpx ? ` · ~${mmpx} mm/px` : ''));
    }
  }
  if (wantBar && eq.bar) mask(eq.bar, EQ_BAR, `bar ${eq.bar.score.toFixed(2)}`);
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
  // Step the 3D view to the same frame, so the reconstruction plays in sync
  // with the video (no-op until a sequence candidate is loaded).
  if (window.Viewer) window.Viewer.showFrame(idx);

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

// force skips the staleness check: use it for the loop wrap, which is a known
// restart point rather than a suspected stall, so the mesh follows the video
// back to the first frame at once instead of hanging on the last for up to
// OVERLAY_STALL_MS while the watchdog decides the loop is really dead.
function kickOverlayLoop(force) {
  if (vvideo.paused || vvideo.ended) return;
  if (!force && vRafId !== null && performance.now() - vLastDrawMs < OVERLAY_STALL_MS) return;
  vLoopRestarts++;
  startOverlayLoop();
}

vvideo.addEventListener('loadedmetadata', () => {
  syncCanvasSize();
  vvideo.playbackRate = parseFloat($('vspeed').value);
  // Picking an example applies its cached track (and paints the overlay, via
  // applySmoothing) BEFORE the video element has loaded — so the first paint
  // lands on a canvas that this syncCanvasSize then wipes: assigning
  // canvas.width/height clears the surface even when the value is unchanged.
  // Nothing else repaints while the video sits paused at frame 0, so the
  // wireframe just vanished. Repaint here, now that the real dimensions are in.
  // (The upload→run path never hits this: its video loaded long before the run
  // ever produced a track, so no loadedmetadata fires after the paint.)
  if (vKeypoints && (vvideo.paused || vvideo.ended)) drawOverlay();
});
vvideo.addEventListener('play', startOverlayLoop);
vvideo.addEventListener('playing', kickOverlayLoop);
// Both of these leave the playhead somewhere the clock knows nothing about, so
// it is dropped rather than extrapolated from; drawOverlay then falls back to
// currentTime, which is exact while nothing is moving.
vvideo.addEventListener('pause', () => { stopOverlayLoop(); vClock = null; drawOverlay(); });
vvideo.addEventListener('seeked', () => { vLastTimeupdate = vvideo.currentTime; vClock = null; drawOverlay(); kickOverlayLoop(); });
vvideo.addEventListener('timeupdate', () => {
  // A looping <video> wraps silently — no 'play', no 'seeked' — so the only
  // signal that it jumped back to the start is currentTime going backwards.
  // When it does, force the overlay to restart now: the rVFC paint callback is
  // routinely dropped across the wrap, and without this the mesh sits frozen on
  // the last frame over the replayed clip until the staleness watchdog fires.
  const wrapped = vvideo.currentTime < vLastTimeupdate - 0.05;
  vLastTimeupdate = vvideo.currentTime;
  if (wrapped) {
    // Drop the interpolation clock at the wrap. It is only re-anchored by the
    // rVFC callback, which is dropped across the loop, so it stays frozen at the
    // near-end frame it last saw — and the rAF paint loop then cheerfully keeps
    // drawing that end time (clamped to the last frame) over the replayed clip,
    // never going stale. Nulling it makes clockTime() fall back to currentTime
    // (~0 after the wrap) until a fresh presented frame re-anchors it.
    vClock = null;
  }
  if (vvideo.paused) drawOverlay(); else kickOverlayLoop(wrapped);
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
  vEquipment = null; vEqPrompts = null; vRenderEqNote(); v3dReset();
  updatePlotControls();
  Diagnostics.setTrack(null, null);
  $('vsummary').textContent = '';
  $('vsync').textContent = '';
  $('vexample').value = '';
  vClearExample();
  setVideoSrc(f);
};

// Picking an example clip: pull down its committed video and its cached track,
// then load both. No pose run — the track was computed offline and shipped with
// the clip, so the diagnostics appear the moment the video can be scrubbed.
$('vexample').onchange = async () => {
  const id = $('vexample').value;
  if (!id) return;
  const opt = $('vexample').selectedOptions[0];
  const sizes = (opt && opt.dataset.sizes ? opt.dataset.sizes.split(',') : []).filter(Boolean);
  stopCameraStream();
  $('vfile').value = '';
  vSource = null;
  vKeypointsRaw = null; vKeypoints = null; vMeta = null; vSample = null; vClock = null;
  vEquipment = null; vEqPrompts = null; vRenderEqNote(); v3dReset();
  updatePlotControls();
  Diagnostics.setTrack(null, null);
  $('vsummary').textContent = '';
  $('vsync').textContent = '';
  // Keep the current model pick if this example was analysed with it; otherwise
  // fall to whichever size it does ship. Grey the rest out.
  vExampleId = id;
  vExampleSizes = sizes;
  // Before the track loads, so the first automatic generate already has this
  // athlete's limbs rather than reconstructing once with the generic ones.
  $('v3dlimbnote').textContent = '';
  await v3dLoadLimbsFor(id);
  const size = sizes.includes($('vsize').value) ? $('vsize').value : sizes[0];
  vSetSizeAvailability(sizes, size);
  $('vstatus').textContent = 'loading example…';
  try {
    const [vr, tr] = await Promise.all([
      fetch(`/api/examples/${encodeURI(id)}/video`),
      fetch(`/api/examples/${encodeURI(id)}/track?size=${encodeURIComponent(size)}`),
    ]);
    if (!vr.ok || !tr.ok) throw new Error('example not available');
    const blob = await vr.blob();
    const data = await tr.json();
    vSource = { blob, filename: id.split('/').pop() + '.mp4' };
    setVideoSrc(blob);
    applyTrack(data);
    vStrideConstrain(vMeta.frame_stride || 1);
    $('vstatus').textContent = 'loaded example — cached ' + size + ' track, no run needed';
  } catch (e) {
    $('vstatus').textContent = 'error loading example: ' + e.message;
  }
};

// Switching the model while an example is loaded swaps the overlay to that
// model's cached track — no pose run, since the example ships one per available
// size. Greyed-out sizes can't be picked, so a cached hit is guaranteed here.
$('vsize').onchange = async () => {
  if (!vExampleId || !vExampleSizes || !vExampleSizes.includes($('vsize').value)) return;
  const size = $('vsize').value;
  $('vstatus').textContent = 'switching to ' + size + ' overlay…';
  try {
    const r = await fetch(`/api/examples/${encodeURI(vExampleId)}/track?size=${encodeURIComponent(size)}`);
    if (!r.ok) throw new Error('track not available');
    applyTrack(await r.json());
    vStrideConstrain(vMeta.frame_stride || 1);
    $('vstatus').textContent = 'loaded example — cached ' + size + ' track, no run needed';
  } catch (e) {
    $('vstatus').textContent = 'error switching overlay: ' + e.message;
  }
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
  $('vexample').value = '';
  vClearExample();
  vSource = null; vKeypointsRaw = null; vKeypoints = null; vMeta = null; vSample = null; vClock = null;
  vEquipment = null; vEqPrompts = null; vRenderEqNote(); v3dReset();
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
  applyTrack(data);
  $('vstatus').textContent = vMeta.equipment_error
    ? 'done — equipment detection failed: ' + vMeta.equipment_error
    : 'done';
}

// Load a {keypoints, meta} track into every view — the shared tail of a fresh
// pose run (vPoll) and of picking a cached example clip. The caller owns the
// status line; this only touches the track and what's derived from it.
function applyTrack(data) {
  vTrackFull = data;          // the track exactly as computed, at its own stride;
                              // vApplyExampleStride decimates a copy of this for
                              // display when a coarser stride is picked.
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
  vUpdateSummary();
  // Compute the 3D reconstruction for the WHOLE clip now, automatically, so it
  // plays back in step with the video with no manual step. The button re-runs
  // it (e.g. after picking a different method).
  $('v3dgen').disabled = false;
  v3dGenerate();
}

// The one-line track summary under the video. Split out of applyTrack so a
// display-stride change, which rewrites vMeta in place, can refresh it too.
function vUpdateSummary() {
  if (!vMeta) { $('vsummary').textContent = ''; return; }
  $('vsummary').textContent =
    `${vMeta.frames_processed}/${vMeta.frame_count} frames processed (stride ${vMeta.frame_stride}), ` +
    `${vMeta.fps.toFixed(2)} fps · ` + subjectLine(vMeta);
}

// Drop the track to a coarser stride for DISPLAY only — no re-run. Keeps every
// `factor`-th sample of the full track, so a clip analysed at stride 1 can be
// previewed as it would look at stride 2, 3, … A coarser cached track can't be
// refined this way, which is why the picker greys out strides below the base.
function decimateTrack(full, factor) {
  const fm = full.meta;
  const frames = (fm.frame_indices && fm.frame_indices.length)
    ? fm.frame_indices
    : Object.keys(full.keypoints).map(Number).sort((a, b) => a - b);
  const haveTimes = fm.frame_times_ms && fm.frame_times_ms.length === frames.length;
  const keptFrames = [], keptTimes = [], kp = {};
  for (let slot = 0; slot < frames.length; slot += factor) {
    const f = frames[slot];
    keptFrames.push(f);
    if (haveTimes) keptTimes.push(fm.frame_times_ms[slot]);
    const pose = full.keypoints[String(f)];
    if (pose) kp[String(f)] = pose;
  }
  const meta = Object.assign({}, fm, {
    frame_indices: keptFrames,
    frame_stride: (fm.frame_stride || 1) * factor,
    frames_processed: keptFrames.length,
  });
  if (haveTimes) meta.frame_times_ms = keptTimes; else delete meta.frame_times_ms;
  return { keypoints: kp, meta };
}

// Constrain the stride picker to a freshly-loaded example's base stride: set it
// as the value and the floor, since nothing finer can be reconstructed. A base
// above 1 is called out so the greyed-out smaller strides aren't a mystery.
function vStrideConstrain(base) {
  const s = $('vstride');
  s.min = base;
  s.value = base;
  $('vstrideNote').textContent = base > 1
    ? `precomputed at stride ${base} — finer unavailable, coarser previews live`
    : '';
}

// Apply the picked stride to a loaded example's overlay by decimating its cached
// track. Below the base it clamps (the field's min already blocks the spinner,
// but a typed value can still be lower). Non-multiples snap up to the nearest
// multiple of the base and the field is rewritten so it reads honestly.
function vApplyExampleStride() {
  if (!vExampleId || !vTrackFull) return;
  const base = vTrackFull.meta.frame_stride || 1;
  let desired = parseInt($('vstride').value, 10);
  if (!(desired >= base)) desired = base;
  const factor = Math.max(1, Math.round(desired / base));
  $('vstride').value = base * factor;   // reflect the realized (snapped) stride
  const t = factor === 1 ? vTrackFull : decimateTrack(vTrackFull, factor);
  vKeypointsRaw = t.keypoints;
  vMeta = t.meta;
  applySmoothing();
  vUpdateSummary();
}

$('vstride').onchange = () => { if (vExampleId) vApplyExampleStride(); };

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
  // A fresh run supersedes any loaded example: its result is the new overlay, so
  // a later size switch shouldn't quietly swap back to the cached example track.
  vClearExample();
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

// --- pages ----------------------------------------------------------------
// One page at a time. PAGES is generated from the registry in app.py — one
// entry per tab, each { id, label, media: 'image'|'video', diagnostics }. The
// video machine (upload, track, overlay, plot) is shared across every lift
// page; a lift page differs from another only in which diagnostic SET runs,
// so switching between two lifts keeps the loaded clip and just re-scores it.
const PAGES = {{PAGES_JSON}};
const PAGES_BY_ID = {};
for (const p of PAGES) PAGES_BY_ID[p.id] = p;

function setPage(id) {
  const page = PAGES_BY_ID[id] || PAGES[0];
  const video = page.media === 'video';
  document.body.dataset.page = page.id;
  $('pageContext').textContent = video
    ? `${page.label} · video analysis and movement diagnostics`
    : 'single-frame pose inspection';
  $('imageView').hidden = video;
  $('imagePanel').hidden = video;
  $('videoView').hidden = !video;
  $('videoPanel').hidden = !video;
  for (const btn of document.querySelectorAll('.tab')) {
    btn.setAttribute('aria-selected', String(btn.dataset.page === page.id));
  }
  if (video) {
    // The lift's cues. setPage rebuilds the diagnostics panel and re-scores any
    // clip already loaded against this set — a page with no set shows an empty
    // (but working) diagnostics panel.
    Diagnostics.setPage(page.diagnostics);
  } else if (!(vRecorder && vRecorder.state === 'recording')) {
    // Leaving a video page pauses playback. A display:none <video> stops
    // delivering frame callbacks, so the overlay watchdog would otherwise spend
    // the whole time reviving a loop that has nothing to paint on.
    vvideo.pause();
  }
}
// Grounding DINO is an optional download (scripts/download_models.sh offers it),
// so on a machine without it the three equipment controls are turned off and say
// why, rather than being tickable into a 503.
fetch('/api/capabilities').then(r => r.json()).then(c => {
  if (c.equipment) return;
  for (const id of ['veqrun', 'veqbar', 'veqplates']) {
    $(id).checked = false;
    $(id).disabled = true;
    $(id).closest('label').style.opacity = 0.5;
  }
  $('veqnote').textContent =
    'bar & plate detection needs Grounding DINO — run ./scripts/download_models.sh';
}).catch(() => { /* leave the controls alone; a run would report the real error */ });

// --- generate-3D picker ---------------------------------------------------
// The depth framework's cheap/expensive split, surfaced: the picker lists every
// anchor, one click scores them all cheaply then builds the mesh for just the
// chosen (or highest-confidence) one, and the result drives the 3D view below.
let v3dLast = null;

function v3dReset() {
  const g = $('v3dgen'); if (g) g.disabled = true;
  const n = $('v3dnote'); if (n) n.textContent = '';
  const p = $('v3dpanel'); if (p) p.style.display = 'none';
  if (window.Viewer) window.Viewer.clear();
  v3dLast = null;
}

// slot→frame lookup the overlay draws with, so "generate" lifts exactly the
// frame on screen (raw, unsmoothed keypoints — the honest thing the model saw).
function v3dCurrentFrame() {
  if (!vSample) return null;
  return vSample.frames[slotForTime(vvideo.currentTime)];
}

function v3dPoseAt(idx) {
  const pose = vKeypointsRaw ? vKeypointsRaw[String(idx)] : null;
  const people = pose ? Object.values(pose) : [];
  return people.length ? people[0] : null;
}

// The whole track, for the sequence-capable anchors (plate-anchor): every
// processed frame's pose + equipment, so the reconstruction can be built for
// all frames and the viewer can animate. start_frame is the lift's start — for
// now the earliest processed frame that actually has plates (where the snatch
// grip / wrist-above-bar assumption holds); the per-lift start position is a
// later refinement.
function v3dBuildSequence() {
  if (!vKeypointsRaw || !vMeta) return { sequence: null, start: null };
  const idxs = (vMeta.frame_indices && vMeta.frame_indices.length)
    ? vMeta.frame_indices.slice()
    : Object.keys(vKeypointsRaw).map(Number).sort((a, b) => a - b);
  const seq = {}; let start = null;
  for (const f of idxs) {
    const kp = v3dPoseAt(f);
    if (!kp) continue;
    const eq = vEquipment ? (vEquipment[String(f)] || null) : null;
    seq[String(f)] = { keypoints: kp, equipment: eq };
    if (start === null && eq && (eq.plates || []).length) start = f;
  }
  if (start === null) start = idxs.length ? idxs[0] : null;
  return { sequence: seq, start };
}

// --- per-joint depth direction ---------------------------------------------
// The dictionary the selection lives in: {joint index (string): +1 toward the
// camera | -1 away}. Kept keyed by joint rather than as a list so a reordering
// of sign_joints can't silently reassign someone's choices, and deliberately
// NOT cleared by v3dReset — the direction a limb bends is a property of how the
// lift was filmed, so it carries across a re-run and across clips from the same
// camera angle. Posted with every generate and echoed back resolved.
let v3dSigns = {};
let v3dSignJoints = [];   // [{index, label, default}] from /api/depth/methods
// 'auto' posts the string "auto" and lets the backend solve the directions from
// the pose; 'manual' posts the dictionary above verbatim. Auto is the default
// because the old behaviour — everything toward the camera — was a guess that
// happened to be wrong half the time, and a wrong guess is worse than a solved
// one. Touching any selector drops to manual, so an explicit choice is never
// silently overwritten by the next recompute.
let v3dSignMode = 'auto';

function v3dBuildSignControls() {
  const host = $('v3dsigns');
  if (!host || !v3dSignJoints.length) return;
  host.innerHTML = '';
  for (const j of v3dSignJoints) {
    const key = String(j.index);
    if (!(key in v3dSigns)) v3dSigns[key] = j.default;
    const row = document.createElement('label');
    row.style.cssText = 'font-size:13px;color:#c3c2b7;display:flex;align-items:center;gap:6px;justify-content:space-between';
    const name = document.createElement('span');
    name.textContent = j.label;
    const sel = document.createElement('select');
    sel.style.cssText = 'font-size:13px;padding:2px 4px;margin:0';
    for (const [v, txt] of [[1, 'toward'], [-1, 'away']]) {
      const o = document.createElement('option');
      o.value = String(v); o.textContent = txt;
      if (v3dSigns[key] === v) o.selected = true;
      sel.appendChild(o);
    }
    // Recompute on change: the sign feeds the lift itself, so unlike the
    // turntable there is nothing client-side to re-render — the geometry has
    // to come back from the backend.
    sel.onchange = () => {
      v3dSigns[key] = parseInt(sel.value, 10);
      v3dSetSignMode('manual');   // an explicit choice outranks the solver
      if (vMeta) v3dGenerate();
    };
    row.appendChild(name); row.appendChild(sel);
    host.appendChild(row);
  }
}

function v3dSetSignMode(mode) {
  v3dSignMode = mode;
  const sel = $('v3dsignmode');
  if (sel && sel.value !== mode) sel.value = mode;
}

// --- clicking a joint in the 3D view ---------------------------------------
// The dropdowns and the 3D view are two ways into the same dictionary. Both go
// through v3dFlipSign, so there is one definition of what flipping means and
// the controls can't disagree about the current state.

// Which sign control a clicked joint belongs to. Most joints are their own, but
// the trunk is one bit shared by both shoulders and both hips, so `also` (from
// sign_joints()) routes those four to the one control. Returns null for a joint
// with no direction to choose — the nose, which is pinned to the midline.
function v3dSignKeyFor(joint) {
  for (const j of v3dSignJoints) {
    if (j.index === joint || (j.also || []).includes(joint)) return String(j.index);
  }
  return null;
}

// Per-joint sign for the viewer to colour by: +1 toward, -1 away, 0 = no choice.
// Built over `also` too, so both shoulders and both hips show the trunk's state
// rather than only the one joint that happens to key it.
function v3dSignArray() {
  const a = new Array(17).fill(0), labels = new Array(17).fill(null);
  for (const j of v3dSignJoints) {
    const v = v3dSigns[String(j.index)] || j.default;
    for (const i of [j.index].concat(j.also || [])) { a[i] = v; labels[i] = j.label; }
  }
  return { signs: a, labels };
}

function v3dFlipSign(key) {
  if (key === null) return;
  v3dSigns[key] = -(v3dSigns[key] || 1);
  v3dSetSignMode('manual');   // an explicit choice outranks the solver
  v3dBuildSignControls();
  if (vMeta) v3dGenerate();   // the geometry has to come back from the backend
}

// `signed` comes from the candidate: an anchor that doesn't read the sign table
// gets a grey, unclickable skeleton rather than controls that quietly do
// nothing. Which anchors those are is the backend's business, not a method name
// matched in here.
function v3dPushSigns(signed) {
  if (!window.Viewer || !window.Viewer.setSigns) return;
  if (!signed) { window.Viewer.setSigns(null, null); return; }
  const { signs, labels } = v3dSignArray();
  window.Viewer.setSigns(signs, labels);
}

// The viewer announces picks as a DOM event rather than taking a callback: it
// loads as a deferred module, so it does not exist yet when this script runs,
// and an event listener on the wrapper can be attached now regardless.
$('v3dcanvasWrap').addEventListener('v3djointclick', (e) => {
  v3dFlipSign(v3dSignKeyFor(e.detail.joint));
});

$('v3dsignshow').addEventListener('change', () => {
  $('v3dsignbar').style.display = $('v3dsignshow').checked ? '' : 'none';
});

$('v3dlimbshow').addEventListener('change', () => {
  $('v3dlimbbar').style.display = $('v3dlimbshow').checked ? '' : 'none';
});
$('v3dlimbreset').onclick = () => {
  v3dSetLimbs(null);
  $('v3dlimbnote').textContent = '';
  $('v3dlimbfitnote').style.display = 'none';
  if (vMeta) v3dGenerate();
};
$('v3dlimbfit').onclick = async () => {
  $('v3dlimbfit').disabled = true;
  try { await v3dStepLimbs(); if (vMeta) v3dGenerate(); }
  finally { $('v3dlimbfit').disabled = false; }
};
$('v3dlimbrevert').onclick = async () => {
  $('v3dlimbnote').textContent = '';
  $('v3dlimbfitnote').style.display = 'none';
  await v3dLoadLimbsFor(vExampleId);
  if (vMeta) v3dGenerate();
};
// Saving is explicit: editing a ratio re-runs the lift so you can see what it
// does, but nothing reaches disk until you say so — otherwise trying a number
// would quietly rewrite the example for everyone who loads it next.
$('v3dlimbsave').onclick = async () => {
  if (!vExampleId || !v3dLimbs) return;
  const note = $('v3dlimbnote');
  note.style.color = '#898781';
  note.textContent = 'saving…';
  try {
    const r = await fetch(`/api/examples/${encodeURI(vExampleId)}/limbs`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: v3dLimbs.name, notes: v3dLimbs.notes,
                             ratios: v3dLimbs.ratios }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    v3dSetLimbs(d, { saved: true });
    note.textContent = 'saved beside the clip';
  } catch (e) {
    note.style.color = '#f0a020';
    note.textContent = 'save failed: ' + e.message;
  }
};
$('v3dsignmode').onchange = () => {
  v3dSignMode = $('v3dsignmode').value;
  if (vMeta) v3dGenerate();
};
// "all toward" is the old default, and choosing it is itself a manual decision
// — otherwise the next recompute would silently solve the directions again and
// the button would look broken.
$('v3dsignreset').onclick = () => {
  for (const j of v3dSignJoints) v3dSigns[String(j.index)] = j.default;
  v3dSetSignMode('manual');
  v3dBuildSignControls();
  if (vMeta) v3dGenerate();
};

function v3dScores(conf) {
  return Object.entries(conf)
    .map(([k, v]) => `${k} ${v === null ? '—' : v.toFixed(2)}`).join(', ');
}

// --- limb-length profile ---------------------------------------------------
// Segment lengths as a fraction of torso (pelvis->neck), belonging to the
// ATHLETE rather than to the clip. The lift can't just measure them off the
// footage: its per-clip estimate takes each segment's longest projection, which
// is the true length only if the athlete fully extends that limb on camera, and
// in a lifting clip they often never do. Every segment then reads short and the
// lift fabricates the difference as depth.
//
// An example ships its profile beside the clip (`<stem>.limbs.json`); anything
// uploaded starts generic. Edits here are live — each change re-runs the lift —
// and only reach disk on an explicit save, so you can try a number without
// committing to it.
let v3dLimbSegments = [];            // [{key,label,default,min,max}] from /api/depth/methods
let v3dGenericLimbs = {};            // the population priors, the "generic" profile
let v3dLimbs = null;                 // {name, notes, ratios} for the loaded clip
let v3dLimbsSaved = null;            // last value on disk, for the dirty marker

function v3dGenericProfile() {
  return { name: 'generic', notes: '', ratios: { ...v3dGenericLimbs } };
}

// Deep-ish equality over the ratio table only — the name and notes don't change
// what the reconstruction does, so they don't make the profile dirty.
function v3dLimbsDiffer(a, b) {
  if (!a || !b) return !!a !== !!b;
  return v3dLimbSegments.some(s => (a.ratios[s.key] ?? s.default)
                                !== (b.ratios[s.key] ?? s.default));
}

// keepSteps is for the optimiser, which calls this ten steps at a time and owns
// the running count. Everything else — loading a profile, reverting, going
// generic, typing a ratio by hand — starts the descent over, because the count
// is only meaningful relative to where the stepping began.
function v3dSetLimbs(profile, { saved = false, keepSteps = false } = {}) {
  v3dLimbs = profile ? { name: profile.name || 'generic', notes: profile.notes || '',
                         ratios: { ...v3dGenericLimbs, ...(profile.ratios || {}) } }
                     : v3dGenericProfile();
  if (saved) v3dLimbsSaved = JSON.parse(JSON.stringify(v3dLimbs));
  if (!keepSteps) {
    v3dLimbSteps = 0; v3dLimbPenalty0 = null;
    const s = $('v3dlimbsteps');
    if (s) s.textContent = '';
  }
  v3dBuildLimbControls();
}

// The profile that ships with an example. Uploads and recordings get generic:
// we know nothing about whoever is in them, and a stranger's limbs are a worse
// guess than the population's.
async function v3dLoadLimbsFor(exampleId) {
  if (!exampleId) { v3dSetLimbs(null, { saved: true }); return; }
  try {
    const r = await fetch(`/api/examples/${encodeURI(exampleId)}/limbs`);
    v3dSetLimbs(r.ok ? await r.json() : null, { saved: true });
  } catch (e) {
    v3dSetLimbs(null, { saved: true });
  }
}

function v3dBuildLimbControls() {
  const host = $('v3dlimbs');
  if (!host || !v3dLimbSegments.length || !v3dLimbs) return;
  host.innerHTML = '';
  for (const seg of v3dLimbSegments) {
    const row = document.createElement('label');
    row.style.cssText = 'font-size:13px;color:#c3c2b7;display:flex;align-items:center;gap:6px;justify-content:space-between';
    const name = document.createElement('span');
    name.textContent = seg.label;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '0.005';
    inp.min = String(seg.min); inp.max = String(seg.max);
    inp.value = Number(v3dLimbs.ratios[seg.key] ?? seg.default).toFixed(3);
    inp.style.cssText = 'font-size:13px;padding:2px 4px;margin:0;width:78px';
    inp.title = `population prior ${seg.default}`;
    // Commit on change, not on input: typing "0.7" passes through "0." and "0",
    // and re-running the whole clip's lift on each keystroke would both thrash
    // the backend and briefly reconstruct against a nonsense length.
    inp.onchange = () => {
      const v = parseFloat(inp.value);
      if (!isFinite(v) || v < seg.min || v > seg.max) {
        inp.value = Number(v3dLimbs.ratios[seg.key] ?? seg.default).toFixed(3);
        return;
      }
      v3dLimbs.ratios[seg.key] = v;
      inp.value = v.toFixed(3);
      v3dRenderLimbState();
      if (vMeta) v3dGenerate();
    };
    row.appendChild(name); row.appendChild(inp);
    host.appendChild(row);
  }
  v3dRenderLimbState();
}

function v3dRenderLimbState() {
  const el = $('v3dlimbname');
  if (!el || !v3dLimbs) return;
  const dirty = v3dLimbsDiffer(v3dLimbs, v3dLimbsSaved);
  el.textContent = v3dLimbs.name + (dirty ? ' · edited' : '');
  el.style.color = dirty ? '#f0a020' : '#c3c2b7';
  const save = $('v3dlimbsave');
  if (save) save.disabled = !vExampleId || !dirty;
}

// One click descends to convergence — small steps, run until all five humanness
// terms stop moving — starting from whatever the ratios are NOW, so the first
// click starts at the profile and a second one only moves if something else
// changed (a different frame, a hand edit) since.
//
// Applied but never saved: on the fixtures this objective finds a lower penalty
// at the wrong lengths, so committing it to disk stays a deliberate second
// click on "save to example".
let v3dLimbSteps = 0;              // cumulative, reset whenever the profile is
let v3dLimbPenalty0 = null;        // penalty when stepping began, for the delta

async function v3dStepLimbs() {
  if (!vMeta || !v3dLimbs) return;
  const note = $('v3dlimbnote'), out = $('v3dlimbfitnote');
  note.style.color = '#898781';
  note.textContent = 'optimising…';
  try {
    const { sequence, start } = v3dBuildSequence();
    const idx = v3dCurrentFrame();
    const r = await fetch('/api/depth/optimize_limbs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width: vMeta.width, height: vMeta.height,
                             current_frame: idx, keypoints: v3dPoseAt(idx),
                             sequence, start_frame: start,
                             lift: document.body.dataset.page || null,
                             bone_ratios: v3dLimbs.ratios,
                             // Small steps with a backtracking line search, so
                             // the descent is monotone and actually terminates;
                             // iters is the guard on that, not the plan.
                             iters: 400, lr: 0.005, line_search: true }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    if (v3dLimbPenalty0 === null) v3dLimbPenalty0 = d.start_total;
    v3dLimbSteps += d.iterations;
    // Keep the name: these are no longer the measured numbers, and the dirty
    // marker beside it is what says so.
    v3dSetLimbs({ name: v3dLimbs.name, notes: v3dLimbs.notes, ratios: d.ratios },
                { keepSteps: true });
    $('v3dlimbsteps').textContent = `${v3dLimbSteps} steps`;
    // Only "iterations" means it stopped because it ran out of budget; every
    // other reason means it stopped because it had nowhere left to go.
    const capped = d.stop_reason === 'iterations';
    note.textContent = `frame ${d.frame} · penalty ${d.start_total.toFixed(4)}`
      + ` → ${d.total.toFixed(4)} · `
      + (capped ? `stopped at the ${d.iterations}-step cap, not converged`
                : d.iterations === 0 ? 'already converged'
                : `converged in ${d.iterations} steps`);
    note.style.color = capped ? '#f0a020' : '#898781';
    const rows = Object.keys(d.terms).map(k => {
      const a = d.start_terms[k], b = d.terms[k];
      const arrow = b > a + 1e-6 ? '▲' : (b < a - 1e-6 ? '▼' : '·');
      return `${arrow} ${(d.labels && d.labels[k]) || k}: ${a.toFixed(4)} → ${b.toFixed(4)}`;
    });
    // The depth signs are re-chosen at every evaluation, so the run can end on a
    // different toward/away configuration than it began on. Say so: past that
    // point it is fitting lengths to a different reading of the pose.
    const flipped = JSON.stringify(d.start_signs) !== JSON.stringify(d.signs);
    out.style.display = '';
    out.innerHTML =
      `<b>penalty ${v3dLimbPenalty0.toFixed(4)} → ${d.total.toFixed(4)}</b>`
      + ` over ${v3dLimbSteps} steps (torso lengths, 0 = perfect)<br>`
      + (d.iterations === 0 ? 'last run moved nothing: ' : `last run, ${d.iterations} steps: `)
      + rows.join('<br>')
      + (flipped ? `<br><span style="color:#f0a020">toward/away flipped`
                   + ` ${d.sign_flips} time${d.sign_flips === 1 ? '' : 's'} during`
                   + ` the run — it ended on a different depth configuration than`
                   + ` it started on. Check the sign table before reading the`
                   + ` lengths.</span>` : '')
      + `<br><span style="color:#f0a020">A lower penalty is not the same as correct`
      + ` limbs. Checked against an athlete whose lengths are known, this objective`
      + ` converges ~0.07 torso away from them — compare with a measured profile`
      + ` before trusting it.</span>`;
  } catch (e) {
    note.style.color = '#f0a020';
    note.textContent = 'optimize failed: ' + e.message;
  }
}

// Monotonic token for in-flight generates. Clicking two joints quickly puts two
// POSTs in the air, and if the first one lands last it overwrites v3dSigns with
// the table from before the second click — the flip appears to undo itself a
// moment after it happened. Only the newest request is allowed to apply.
let v3dRun = 0;

async function v3dGenerate() {
  const note = $('v3dnote');
  if (!vMeta) { note.textContent = 'run a pose pass first'; return; }
  const run = ++v3dRun;
  const method = $('v3dmethod').value;
  const idx = v3dCurrentFrame();
  const wantSeq = (method === 'plate-anchor' || method === 'auto');
  const body = { method, width: vMeta.width, height: vMeta.height,
                 current_frame: idx, keypoints: v3dPoseAt(idx),
                 equipment: vEquipment ? (vEquipment[String(idx)] || null) : null,
                 // Which lift the user is looking at. The backend uses it for
                 // one thing — whether this clip has a start position whose
                 // joint angles can rule out depth directions (START_POSE_LIFTS)
                 // — and declines to guess when it isn't sent.
                 lift: document.body.dataset.page || null,
                 depth_signs: (v3dSignMode === 'auto' ? 'auto' : v3dSigns) };
  if (v3dLimbs) body.bone_ratios = v3dLimbs.ratios;
  if (wantSeq) {
    const { sequence, start } = v3dBuildSequence();
    body.sequence = sequence; body.start_frame = start;
  }
  $('v3dgen').disabled = true;
  note.textContent = 'generating…';
  try {
    const r = await fetch('/api/depth/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (run !== v3dRun) return;    // a newer click already superseded this one
    if (!r.ok || (d.error && !d.candidate)) {
      note.textContent = (d.error || ('HTTP ' + r.status))
        + (d.confidences ? ` · scores: ${v3dScores(d.confidences)}` : '');
      return;
    }
    v3dLast = d;
    // Adopt the backend's resolved table, so a joint whose posted value was
    // rejected shows the default it actually ran with rather than the value the
    // control still displays.
    if (d.depth_signs) {
      let changed = false;
      for (const [k, v] of Object.entries(d.depth_signs)) {
        if (v3dSigns[k] !== v) { v3dSigns[k] = v; changed = true; }
      }
      if (changed) v3dBuildSignControls();
    }
    const c = d.candidate;
    const nJoints = c.joints3d.filter(p => p).length;
    const nFrames = c.frames ? Object.keys(c.frames).length : 0;
    note.innerHTML =
      `<b>${c.method}</b> (confidence ${c.confidence.toFixed(2)}, `
      + `${c.units}${c.metric ? ', metric' : ''}) — ${nJoints} joints`
      + (nFrames ? `, ${nFrames} frames` : '')
      + ` · scores: ${v3dScores(d.confidences)}`;
    // Hand the candidate to the 3D view and show it.
    if (window.Viewer) {
      $('v3dpanel').style.display = '';
      window.Viewer.load(c);
      v3dPushSigns(c.signed);   // colour the joints by the table that just ran
      window.Viewer.showFrame(idx);
      window.Viewer.resize();   // the panel was display:none until now
    } else {
      // Reported here, on every run, rather than once at page load: this is the
      // branch where the reconstruction succeeded and only the canvas is
      // missing, and without a word here that combination reads as "recompute
      // did nothing" — the numbers above update, and nothing else on the page
      // moves. See viewerFailed() in the module at the bottom of this file.
      note.innerHTML += ` · <span style="color:#e08a8a">3D view unavailable `
        + `(${window.__viewerError || 'three.js/WebGL did not initialise'}) — `
        + `the reconstruction above still ran</span>`;
    }
  } catch (e) {
    if (run === v3dRun) note.textContent = 'error: ' + e;
  } finally {
    // Only the newest run re-enables the button, so a superseded reply can't
    // un-disable it while a later request is still out.
    if (run === v3dRun) $('v3dgen').disabled = false;
  }
}

$('v3dgen').onclick = v3dGenerate;
// Switching method recomputes immediately against the loaded clip.
$('v3dmethod').onchange = () => { if (vMeta) v3dGenerate(); };

// Populate the method dropdown from the registry; unavailable anchors (e.g. a
// body model with no weights) are listed but disabled so the set of methods is
// visible even when one can't run here.
fetch('/api/depth/methods').then(r => r.json()).then(m => {
  // Same response carries the ambiguous-joint list; build the direction
  // controls from it so the markup never hardcodes a joint set.
  v3dSignJoints = m.sign_joints || [];
  v3dBuildSignControls();
  // Same again for the limb ratios: the segment set is a property of the lift,
  // so it arrives with the methods rather than costing a second round trip.
  v3dLimbSegments = m.limb_segments || [];
  v3dGenericLimbs = m.generic_limbs || {};
  if (!v3dLimbs) v3dSetLimbs(null, { saved: true });
  const sel = $('v3dmethod');
  for (const meth of (m.methods || [])) {
    const opt = document.createElement('option');
    opt.value = meth.name;
    opt.textContent = meth.label + (meth.available ? '' : ' — unavailable');
    opt.disabled = !meth.available;
    if (meth.description) opt.title = meth.description;
    sel.appendChild(opt);
  }
}).catch(() => { /* picker stays Auto-only; generate still routes server-side */ });

// Populate the example dropdown from the fixtures, one <optgroup> per scope
// (global = committed with the repo, local = this machine's gitignored clips).
// Stays hidden if none exist in this checkout, so the control never dangles
// empty.
fetch('/api/examples').then(r => r.json()).then(list => {
  if (!Array.isArray(list) || !list.length) return;
  const sel = $('vexample');
  const groups = {};
  for (const ex of list) {
    const scope = ex.scope || 'global';
    if (!groups[scope]) {
      groups[scope] = document.createElement('optgroup');
      groups[scope].label = scope;
      sel.appendChild(groups[scope]);
    }
    const opt = document.createElement('option');
    opt.value = ex.id;
    opt.textContent = ex.label;
    opt.dataset.sizes = (ex.sizes || []).join(',');
    if (ex.notes) opt.title = ex.notes;
    groups[scope].appendChild(opt);
  }
  $('vexampleWrap').style.display = '';
}).catch(() => { /* no gallery is fine — upload/record still work */ });

for (const btn of document.querySelectorAll('.tab')) {
  btn.onclick = () => setPage(btn.dataset.page);
}
setPage('{{DEFAULT_PAGE}}');   // a lift page by default; the image path is the side trip
</script>

<!-- The 3D viewer is the one place coach reaches for a third-party lib: a
     skeleton in perspective with a turntable is exactly what three.js is for,
     and reimplementing a projector by hand would be worse. Loaded as a module
     from a CDN (the box is on the tailnet with internet); if the import fails
     the panel just says so and the text note above still reports the result. -->
<script type="importmap">
{ "imports": { "three": "/vendor/three.module.js" } }
</script>
<script type="module">
const $ = id => document.getElementById(id);

// Every failure below ends the same way — no window.Viewer, so v3dGenerate
// never un-hides #v3dpanel — which is why the reason has to be recorded
// somewhere that outlives this script. It used to be written into #v3dhint,
// and #v3dhint lives INSIDE #v3dpanel: the one element guaranteed to stay
// hidden in exactly the case the message explains. The symptom was a viewer
// that appeared to do nothing at all, with no error anywhere on the page.
function viewerFailed(what, e) {
  window.__viewerError = what + ': ' + ((e && e.message) ? e.message : e);
  console.error('[coach] 3D viewer disabled —', window.__viewerError, e);
}

let THREE;
try {
  THREE = await import('three');
} catch (e) {
  viewerFailed('three.js failed to load', e);
  throw e;   // leave window.Viewer undefined; the text note still works
}

// COCO joint colours: warm for the right side, cool for the left, so the
// turntable's front/back is readable at a glance.
const JOINT_COLOR = 0x6fd1c5, BONE_COLOR = 0x9ec1ff, BAR_COLOR = 0xf0a020;
// Joints are coloured by which way their depth was signed, because that is the
// one property of the reconstruction a viewer can neither see nor verify from
// the turntable alone: two opposite signs give the same silhouette, and until
// they're coloured a wrong one just looks like a strange pose.
const TOWARD_COLOR = 0x6fd1c5, AWAY_COLOR = 0xf0a020,
      FIXED_COLOR = 0x6f6e68, HOVER_COLOR = 0xffffff;

// Built inside a try below, not at top level: new WebGLRenderer() throws when
// the browser has no usable WebGL context (a driver on Firefox's blocklist, a
// remote/software-rendered session, WebGL off in about:config). A second, quite
// different reason for the viewer to be missing, and it used to be entirely
// uncaught — the module just died mid-evaluation and left no trace anywhere.
const buildViewer = () => {
  const canvas = $('v3dcanvas'), wrap = $('v3dcanvasWrap');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  // group holds the figure and is what the turntable rotates; the camera stays
  // put looking down -Z, so rotating the group about its vertical (Y) axis is
  // what makes the reconstructed depth swing into view.
  const group = new THREE.Group();
  scene.add(group);

  const boneGeom = new THREE.BufferGeometry();
  const bones = new THREE.LineSegments(
    boneGeom, new THREE.LineBasicMaterial({ color: BONE_COLOR }));
  const jointGeom = new THREE.BufferGeometry();
  const joints = new THREE.Points(
    jointGeom, new THREE.PointsMaterial({ size: 0.045, sizeAttenuation: true,
                                          vertexColors: true }));
  group.add(bones); group.add(joints);

  // a faint floor grid for a sense of ground/scale
  const grid = new THREE.GridHelper(2, 8, 0x333333, 0x222222);
  grid.position.y = -0.9;
  scene.add(grid);

  let candidate = null;      // the loaded MeshCandidate JSON
  let frameKeys = [];        // sorted numeric frame indices, when a sequence
  let camDist = 3;           // set on load to frame the figure
  // Buffer order -> COCO joint index. The position buffer only carries the
  // joints that were solved, so its indices are NOT joint indices; without this
  // map a click on the 12th drawn point flips whichever joint happens to be
  // 12th in COCO order, which is a different one on almost every frame.
  let jointIdx = [];
  let signOf = new Array(17).fill(0);       // +1 toward, -1 away, 0 = no choice
  let signLabel = new Array(17).fill(null);
  let hover = -1;                           // COCO index under the cursor, or -1

  // mm (x right, y down, z toward camera) -> three.js metres, Y up.
  const toVec = p => new THREE.Vector3(p[0] / 1000, -p[1] / 1000, p[2] / 1000);

  function fit(j3d) {
    let r = 0.4;
    for (const p of j3d) if (p) r = Math.max(r, toVec(p).length());
    camDist = r / Math.tan((camera.fov * Math.PI / 180) / 2) * 1.5;
    camera.position.set(0, 0, camDist);
    camera.lookAt(0, 0, 0);
    // No pick tolerance to set here: picking is done in screen pixels (see
    // pickAt), so it needs nothing from the figure's world scale.
  }

  function paint() {
    const n = jointIdx.length;
    const col = new Float32Array(n * 3), c = new THREE.Color();
    for (let k = 0; k < n; k++) {
      const j = jointIdx[k];
      c.setHex(j === hover ? HOVER_COLOR
               : signOf[j] > 0 ? TOWARD_COLOR
               : signOf[j] < 0 ? AWAY_COLOR : FIXED_COLOR);
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
    jointGeom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    jointGeom.attributes.color.needsUpdate = true;
  }

  function setJoints(j3d) {
    if (!j3d) return;
    const jpos = [], bpos = [];
    jointIdx = [];
    const V = j3d.map(p => (p ? toVec(p) : null));
    for (let i = 0; i < V.length; i++) {
      if (V[i]) { jpos.push(V[i].x, V[i].y, V[i].z); jointIdx.push(i); }
    }
    for (const [a, b] of (candidate.edges || [])) {
      if (V[a] && V[b]) bpos.push(V[a].x, V[a].y, V[a].z, V[b].x, V[b].y, V[b].z);
    }
    jointGeom.setAttribute('position', new THREE.Float32BufferAttribute(jpos, 3));
    boneGeom.setAttribute('position', new THREE.Float32BufferAttribute(bpos, 3));
    jointGeom.attributes.position.needsUpdate = true;
    boneGeom.attributes.position.needsUpdate = true;
    paint();
    render();
  }

  function nearestKey(idx) {
    if (!frameKeys.length) return null;
    let best = frameKeys[0], bd = Math.abs(idx - best);
    for (const k of frameKeys) {
      const d = Math.abs(idx - k);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }

  function render() { renderer.render(scene, camera); }

  function resize() {
    // Both dimensions off the CANVAS, not the width off its wrapper: picking
    // projects through camera.aspect and compares against the canvas's own
    // bounding box, so any disagreement between the two shifts every pick
    // sideways by a fraction of the width.
    const w = canvas.clientWidth || wrap.clientWidth || 640;
    const h = canvas.clientHeight || 340;
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    render();
  }
  window.addEventListener('resize', resize);

  // Which joint is under the pointer, or -1. Done in SCREEN space, in CSS
  // pixels, rather than with a Raycaster and a world-space threshold. The two
  // anchors return wildly different units — millimetres for plate-anchor,
  // pixels-of-torso for the keypoint lift — so any world-space tolerance is
  // either a sub-pixel target in one of them or the whole figure in the other,
  // and it also drifts with camera distance. "Within 16 pixels of the dot you
  // clicked" needs no tuning and means the same thing in both.
  const PICK_PX = 16;
  const _v = new THREE.Vector3();
  function pickAt(clientX, clientY) {
    if (!jointIdx.length) return -1;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return -1;
    const px = clientX - r.left, py = clientY - r.top;
    if (px < 0 || py < 0 || px > r.width || py > r.height) return -1;
    // project() reads camera.matrixWorldInverse, which only the renderer keeps
    // up to date; refresh it here so a pick between renders can't use a stale
    // camera.
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    const pos = jointGeom.getAttribute('position');
    if (!pos) return -1;
    let best = -1, bestD = PICK_PX * PICK_PX;
    for (let k = 0; k < jointIdx.length; k++) {
      _v.fromBufferAttribute(pos, k).applyMatrix4(group.matrixWorld).project(camera);
      const sx = (_v.x * 0.5 + 0.5) * r.width, sy = (-_v.y * 0.5 + 0.5) * r.height;
      const d = (sx - px) * (sx - px) + (sy - py) * (sy - py);
      if (d < bestD) { bestD = d; best = jointIdx[k]; }
    }
    return best;
  }

  // Turntable: horizontal drag yaws the figure about its vertical axis (the
  // one rotation that reveals depth); vertical drag tilts it a little so the
  // pose isn't locked edge-on.
  //
  // Drag and click share the same button, so they are told apart by how far the
  // pointer got from where it went down. Three things this has to get right,
  // each of which made clicking miss before:
  //
  //  * The joint is picked on PRESS and remembered, not re-picked on release.
  //    showFrame() runs off the video draw loop, so while the clip is playing
  //    the skeleton moves under a stationary cursor — re-picking on mouseup
  //    reads whatever drifted into that spot, or nothing.
  //  * Distance from the press ORIGIN, not accumulated path length. Summing
  //    every mousemove made a shaky click that ends where it started look like
  //    a long drag.
  //  * Inside the dead zone the figure does not rotate at all. Rotating from
  //    the first pixel meant every click nudged the view, so the slop had to
  //    stay tiny to be usable, which is what made clicks get swallowed.
  let dragging = false, turning = false, lx = 0, ly = 0, px0 = 0, py0 = 0;
  let pressJoint = -1;
  const CLICK_SLOP = 6;              // CSS px from the press point
  const start = e => {
    dragging = true; turning = false;
    lx = px0 = e.clientX; ly = py0 = e.clientY;
    pressJoint = pickAt(e.clientX, e.clientY);
  };
  const move = e => {
    if (!dragging) return;
    if (!turning) {
      if (Math.hypot(e.clientX - px0, e.clientY - py0) <= CLICK_SLOP) return;
      turning = true;                // past the dead zone: this is a turn
      wrap.style.cursor = 'grabbing';
      lx = e.clientX; ly = e.clientY;
      return;
    }
    group.rotation.y += (e.clientX - lx) * 0.01;
    group.rotation.x = Math.max(-1.2, Math.min(1.2, group.rotation.x + (e.clientY - ly) * 0.005));
    lx = e.clientX; ly = e.clientY; render();
  };
  const end = () => {
    if (!dragging) return;
    dragging = false; wrap.style.cursor = 'grab';
    if (turning) { turning = false; return; }        // that was a turn, not a pick
    const j = pressJoint;
    pressJoint = -1;
    if (j < 0 || !signLabel[j]) return;
    wrap.dispatchEvent(new CustomEvent('v3djointclick',
                                       { detail: { joint: j } }));
  };
  wrap.addEventListener('mousedown', start);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);

  // Hover feedback, so it's discoverable that the joints are live at all.
  // Bound to the wrapper rather than the window on purpose: the drag listener
  // has to be global (a turntable drag that leaves the canvas should keep
  // turning), but hover doesn't, and raycasting on every mouse move anywhere on
  // the page to discover the pointer isn't over the canvas is pure waste.
  const HINT = 'drag to rotate · click a joint to flip its depth';
  function setHover(j) {
    if (j === hover) return;
    hover = j;
    const live = j >= 0 && !!signLabel[j];
    wrap.style.cursor = live ? 'pointer' : 'grab';
    const hint = $('v3dhint');
    if (hint) {
      hint.textContent = live
        ? `${signLabel[j]} — ${signOf[j] > 0 ? 'toward' : 'away'} · click to flip`
        : HINT;
    }
    paint(); render();
  }
  wrap.addEventListener('mousemove', e => {
    if (!dragging) setHover(pickAt(e.clientX, e.clientY));
  });
  wrap.addEventListener('mouseleave', () => { if (!dragging) setHover(-1); });

  return {
    load(c) {
      candidate = c;
      frameKeys = c.frames ? Object.keys(c.frames).map(Number).sort((a, b) => a - b) : [];
      group.rotation.set(0, 0, 0);
      fit(c.joints3d);
      setJoints(c.joints3d);
      resize();
    },
    // The sign table the reconstruction actually ran with, for colouring and
    // for deciding which joints are clickable. A joint with no label is one
    // with no direction to choose, and is drawn grey and ignored by picking.
    setSigns(signs, labels) {
      signOf = signs || new Array(17).fill(0);
      signLabel = labels || new Array(17).fill(null);
      paint(); render();
    },
    showFrame(idx) {
      if (!candidate) return;
      if (!candidate.frames) { return; }   // single-frame candidate stays put
      const k = nearestKey(idx);
      if (k === null) return;
      setJoints(candidate.frames[String(k)]);
    },
    resize,
    clear() {
      candidate = null; frameKeys = []; jointIdx = []; hover = -1;
      jointGeom.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      boneGeom.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      render();
    },
  };
};

let Viewer = null;
try {
  Viewer = buildViewer();
} catch (e) {
  viewerFailed('WebGL unavailable', e);
  throw e;
}
window.Viewer = Viewer;
</script>
</body>
</html>
"""


# --- pages ----------------------------------------------------------------
# The panels coach offers, one per tab, in tab order. This is the single place
# a page is declared: the tabs, the mode switch and the per-page diagnostic set
# are all derived from it. A page is either the image path or a lift on the
# shared video machine; a lift names a diagnostic SET (a key in DIAGNOSTIC_SETS
# in diagnostics.js), which may be empty for a lift whose cues aren't written
# yet. Add a lift by appending an entry here and its set in diagnostics.js —
# see .claude/skills/panel-add/.
PAGES = [
    {"id": "image", "label": "image", "media": "image"},
    {"id": "snatch", "label": "snatch", "media": "video", "diagnostics": "snatch"},
    {"id": "lateral-raise", "label": "lateral raise", "media": "video",
     "diagnostics": "lateral-raise"},
    {"id": "clean-and-jerk", "label": "clean & jerk", "media": "video",
     "diagnostics": "clean-and-jerk"},
]
DEFAULT_PAGE = "snatch"   # the lift shown on load — the diagnostics live here


# --- settings sections (central) ------------------------------------------
# The settings block is the same on every page of a medium, so it is written
# once here rather than inline per panel: edit a control in one place and every
# page that shows it changes. render_index() drops these into each panel. The
# image panel and the (shared) video panel are the two mediums; a new lift page
# reuses VIDEO_SETTINGS verbatim, which is the point.
IMAGE_SETTINGS_HTML = """<div class="settings">
  <p class="control-help">Upload one frame to inspect the detected body pose.</p>
      <input id="file" type="file" accept="image/*">
      <label>model
        <select id="size"><option value="l">l (large, ~1.2GB)</option><option value="h">h (huge, ~2.5GB)</option></select>
      </label>
      <button id="run" class="primary-action">Run pose</button>
    </div>"""

VIDEO_SETTINGS_HTML = """<div class="settings">
      <details class="control-group" open>
        <summary>source</summary>
        <p class="control-help">Choose a clip, record a short camera sample, or load a bundled example.</p>
        <input id="vfile" type="file" accept="video/*">
        <button id="vcam" class="secondary-action" type="button">record from camera</button>
      <!-- The example clips (tests/fixtures/{global,local}) each ship a cached
           track, so picking one loads a fully-analysed lift instantly — no
           upload, no GPU pass. Hidden until /api/examples reports at least one. -->
        <label id="vexampleWrap" style="display:none">example
          <select id="vexample"><option value="">— pick an example —</option></select>
        </label>
      </details>
      <details class="control-group" open>
        <summary>pose analysis</summary>
        <label>model
          <select id="vsize"><option value="l" data-label="l (large, ~1.2GB)">l (large, ~1.2GB)</option><option value="h" data-label="h (huge, ~2.5GB)">h (huge, ~2.5GB)</option></select>
        </label>
        <label>frame stride
          <input id="vstride" type="number" value="1" min="1" style="width:4em">
          <span id="vstrideNote" style="color:#8a8a80;font-size:11px"></span>
        </label>
        <button id="vrun" class="primary-action">Run pose on video</button>
        <button id="vcancel" class="secondary-action" type="button" style="display:none;">Cancel</button>
      <div id="vprogWrap" style="display:none;width:100%;max-width:420px;background:#222;border-radius:6px;overflow:hidden;">
        <div id="vprogBar" style="height:8px;width:0%;background:#4a9;transition:width .2s linear;"></div>
      </div>
      </details>
      <details class="control-group">
        <summary>playback and tracking</summary>
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
      </details>
      <details class="control-group">
        <summary>equipment overlay</summary>
      <!-- Equipment detection is part of the run, not a view setting: it costs
           a second model pass per frame, so it has to be chosen before the run
           rather than toggled after it. The two overlay tickboxes below are the
           view settings, and they only do anything once a run has been made
           with this one on. -->
      <label style="white-space:nowrap" title="Also locate the barbell and its plates on every processed frame, with Grounding DINO. Roughly halves analysis speed.">
        <input id="veqrun" type="checkbox" checked style="vertical-align:middle;margin:0 4px 0 0"> detect bar &amp; plates
      </label>
      <div class="row" style="gap:14px">
        <label style="white-space:nowrap"><input id="veqbar" type="checkbox" style="vertical-align:middle;margin:0 4px 0 0"> overlay bar</label>
        <label style="white-space:nowrap"><input id="veqplates" type="checkbox" style="vertical-align:middle;margin:0 4px 0 0"> overlay plates</label>
      </div>
      <p id="veqnote" style="font-size:12px;color:#898781;margin:2px 0 0"></p>
      </details>
    </div>"""


def _tabs_html():
    """One <button> per page, in registry order, for the tablist."""
    rows = []
    for p in PAGES:
        controls = "imageView" if p["media"] == "image" else "videoView"
        selected = "true" if p["id"] == DEFAULT_PAGE else "false"
        rows.append(
            f'  <button data-page="{p["id"]}" class="tab" type="button" role="tab" '
            f'aria-selected="{selected}" aria-controls="{controls}">{p["label"]}</button>'
        )
    return '<div class="tabs" role="tablist">\n' + "\n".join(rows) + "\n</div>"


def render_index():
    """INDEX_HTML with the registry-derived pieces filled in. The template holds
    everything static; only the tabs, the two settings blocks and the JS page
    list depend on PAGES, so those are the only substitutions."""
    # Only what the JS needs to switch pages — never the diagnostic objects,
    # which live in diagnostics.js. A missing "diagnostics" (the image page)
    # becomes null.
    pages_js = [
        {"id": p["id"], "label": p["label"], "media": p["media"],
         "diagnostics": p.get("diagnostics")}
        for p in PAGES
    ]
    return (
        INDEX_HTML
        .replace("{{TABS}}", _tabs_html())
        .replace("{{IMAGE_SETTINGS}}", IMAGE_SETTINGS_HTML)
        .replace("{{VIDEO_SETTINGS}}", VIDEO_SETTINGS_HTML)
        .replace("{{PAGES_JSON}}", json.dumps(pages_js))
        .replace("{{DEFAULT_PAGE}}", DEFAULT_PAGE)
    )


def preflight():
    lines = []
    for size, ok in vitpose_backend.available().items():
        lines.append(f"  vitpose-{size}-coco: {'ok' if ok else 'MISSING'}")
    if equipment_backend.available():
        lines.append(f"  grounding-dino: ok ({equipment_backend.model_source()})")
    else:
        lines.append("  grounding-dino: not installed (optional) — 'detect bar & plates' "
                     "unavailable, everything else works; add it with "
                     "COACH_DINO=1 ./scripts/download_models.sh")
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

