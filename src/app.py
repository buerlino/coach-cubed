"""coach: a minimal website around the ViTPose model — Flask + waitress behind
Caddy on the tailnet, with a single in-process backend; see vitpose_backend.py
for why there's no separate model server.

app.py's job is deliberately small: an upload endpoint per media type, one
page. Add routes here as the app grows; keep any ML code out of this file
(it imports only vitpose_backend, never torch/cv2/etc. directly).

Unauthenticated by design — Caddy/tailnet is the access boundary, same as
the rest of the deploy.
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, request, jsonify, Response, send_file, send_from_directory, redirect

import depth_backend
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

    # Bar and plate detection was parked on 2026-10-31 (parked/bar-detection/).
    # Say so rather than silently return a track without the boxes asked for.
    if request.form.get("detect_equipment") in ("1", "true", "on"):
        return jsonify({"error": "bar and plate detection is parked "
                                 "(parked/bar-detection/); run without it"}), 400

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
                progress_cb=progress_cb, cancel_cb=cancel_event.is_set)
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
# than offer one that will fail. Nothing is optional since bar detection was
# parked (2026-10-31), so this answers {} — but the fixture scripts
# (batch_extract_tracks.py, sync_clipper_fixtures.py) use it as their "is the
# app up" probe, and it's the right shape for the next optional model.
@app.route("/api/capabilities")
def api_capabilities():
    return jsonify({})


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
                    "default_limbs": depth_backend.default_limb_ratios(),
                    # Which objectives the limb optimiser will fit against, and
                    # which terms each one uses — same reasoning as above, it's a
                    # property of the lift and not of the clip.
                    "objectives": depth_backend.list_objectives(),
                    "default_objective": depth_backend.DEFAULT_OBJECTIVE})


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

    `objective` picks which of the humanness terms are allowed to pull — see
    depth_backend.OBJECTIVES, listed for the picker by /api/depth/methods. The
    terms it leaves out are still measured and still returned.

    `perspective` (the interface's tickbox) re-corrects the projected lengths
    from the current mesh's depths every few steps instead of reading them
    orthographically — see optimize_limbs. It changes the lengths the descent
    lands on, not how the resulting mesh is then lifted.

    `iters`, `lr`, `line_search` and `term_tol` are exposed because the interface
    runs this in small steps to convergence rather than in a few big ones: the
    objective is known to descend to the wrong lengths on the fixtures, so the
    trajectory and the per-term history it reports back matter as much as the
    four numbers at the end. `iters` is a cap on that, not a target.
    """
    payload = request.get_json(silent=True)
    if not payload or "keypoints" not in payload:
        return jsonify({"error": "expected JSON with width/height/keypoints"}), 400
    # Checked here rather than caught below, so an unknown name can't be
    # confused with a KeyError raised somewhere inside from_payload.
    objective = payload.get("objective") or depth_backend.DEFAULT_OBJECTIVE
    if objective not in depth_backend.OBJECTIVES:
        return jsonify({"error": f"unknown objective {objective!r}"}), 400
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
            term_tol=max(0.0, tol), objective=objective,
            perspective=bool(payload.get("perspective", False)))
    except (TypeError, ValueError) as e:
        return jsonify({"error": f"bad optimiser settings: {e}"}), 400
    except Exception as e:
        return jsonify({"error": f"limb optimisation failed: {e}"}), 500
    if result is None:
        return jsonify({"error": "not enough of the pose to optimise on"}), 400
    result["labels"] = depth_backend.TERM_LABELS
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
        if scope == "local":
            entries = _restore_train_links(manifest, entries)
        for slug, entry in entries.items():
            if isinstance(entry, dict):
                merged[f"{scope}/{slug}"] = {**entry, "scope": scope}
    return merged


def _restore_train_links(manifest_path, entries):
    """Put back entries the training data explorer linked that a concurrent
    sync run has since dropped from local/manifest.json (see TRAIN_LINKS_FILE).
    Writes the repaired manifest so the tests see them too."""
    try:
        links = json.loads(TRAIN_LINKS_FILE.read_text())
    except (ValueError, OSError):
        return entries
    if not isinstance(links, dict):
        return entries
    missing = {slug: e for slug, e in links.items()
               if slug not in entries and isinstance(e, dict)
               and (manifest_path.parent / f"{slug}.track.json").exists()}
    if not missing:
        return entries
    entries = {**entries, **missing}
    with _train_lock:
        _write_json_atomic(manifest_path, entries)
    return entries


def _example_video(example_id, entry=None):
    """The clip Path for a manifest key, or None. Membership in the manifest is
    the only gate, so a crafted id can't escape FIXTURES_DIR — it just 404s.
    Callers walking the whole manifest pass each entry in rather than paying
    for a manifest load per example."""
    entry = entry if entry is not None else _load_manifest().get(example_id)
    if not entry:
        return None
    src = entry.get("source_file")
    if not src:
        return None
    video = FIXTURES_DIR / Path(example_id).parent / src
    return video if video.exists() else None


def _example_tracks(example_id, entry=None):
    """Map of model-size -> cached track Path for a manifest key. An example can
    carry a track from more than one model: a per-size `<id>.<size>.track.json`
    is the explicit form, and a bare legacy `<id>.track.json` counts as the
    size named by the manifest's model_size. Explicit per-size files win. Empty
    if the id isn't a real example or has no cached track."""
    entry = entry if entry is not None else _load_manifest().get(example_id)
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
        tracks = _example_tracks(key, entry)
        if not _example_video(key, entry) or not tracks:
            continue
        out.append({
            "id": key,
            # Shown without the scope folder; the frontend groups by scope.
            "label": key.split("/", 1)[1],
            "scope": entry["scope"],
            "stance": entry.get("stance"),
            "notes": entry.get("notes", ""),
            # The hand-review and provenance fields, so a picker can filter on
            # made/miss or labels without parsing the manifests itself.
            "attempt_result": entry.get("attempt_result"),
            "labels": entry.get("labels", []),
            "frame_count": entry.get("frame_count"),
            "generated_at": entry.get("generated_at"),
            # Which model sizes have a cached track, in UI order — the frontend
            # labels the rest as "not cached" and runs the pose pipeline on the
            # example clip if one of them is picked.
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


# --- training data explorer ------------------------------------------------
# Everything clipper has cut, browsable in the app: one row per attempt clip
# under $CLIPPER_OUT (the same variable clipper and sync_clipper_fixtures.py
# read; COACH_TRAIN_DIR overrides it), with whether a ViTPose track is cached
# for it as a fixture, which lift it is, and the few labels (weight category,
# gender) that neither the footage nor clipper can supply. A clip with no
# track is run through the pose pipeline from the explorer and the result is
# linked back as a local fixture — the same files sync_clipper_fixtures.py
# writes, plus its dedup entry, so the next open is instant and a later sync
# pass skips the clip instead of extracting it again.
TRAIN_DIR = Path(os.environ.get("COACH_TRAIN_DIR") or os.environ.get("CLIPPER_OUT")
                 or (Path(__file__).parent.parent / "clipper" / "downloads"))
TRAIN_LABELS_FILE = FIXTURES_DIR / "local" / "train_labels.json"
# Every manifest entry the explorer has linked, by slug. A sync_clipper_fixtures
# run that started with an older copy of the script rewrites local/manifest.json
# from its own stale in-memory dict, dropping whatever was linked here in the
# meantime; _load_manifest puts those entries back from this file.
TRAIN_LINKS_FILE = FIXTURES_DIR / "local" / "train_links.json"
TRAIN_SYNC_STATE = FIXTURES_DIR / "local" / ".clipper_sync_state.json"
# <session>_NN_HhMMmSSs_<made|miss|unknown>.mp4 — src/cut.py in the clipper repo. NN is
# two digits in the docs but long sessions run past 99, so any width.
TRAIN_CLIP_RE = re.compile(
    r"^(?P<session>.+)_(?P<idx>\d+)_(?P<hh>\d+)h(?P<mm>\d{2})m(?P<ss>\d{2})s_"
    r"(?P<result>made|miss|unknown)\.mp4$")
TRAIN_GENDERS = ("", "male", "female")
_train_lock = threading.RLock()   # re-entrant: the link endpoint holds it while _load_manifest repairs


def _train_labels():
    try:
        d = json.loads(TRAIN_LABELS_FILE.read_text())
    except (ValueError, OSError):
        return {}
    return d if isinstance(d, dict) else {}


def _write_json_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, path)


def _train_clip_path(rel):
    """Path for a clip id (its path relative to TRAIN_DIR), or None. Has to
    resolve inside TRAIN_DIR, sit in a clips/ folder and be an .mp4 — the
    only files the explorer lists, so nothing else is reachable through it."""
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        return None
    p = TRAIN_DIR / rel
    try:
        p.resolve().relative_to(TRAIN_DIR.resolve())
    except (ValueError, OSError):
        return None
    if p.suffix.lower() != ".mp4" or p.parent.name != "clips" or not p.is_file():
        return None
    return p


def _lift_page_ids():
    return [p["id"] for p in PAGES if p["media"] == "video"]


def _train_examples_by_source(manifest):
    """source clip filename -> the example (with cached tracks) built from it.
    A local fixture wins over a global one of the same clip only when the
    global has no track."""
    out = {}
    for key, entry in manifest.items():
        src = entry.get("source_file")
        if not src or src in out:
            continue
        tracks = _example_tracks(key, entry)
        if not tracks or not _example_video(key, entry):
            continue
        out[src] = {"id": key, "stance": entry.get("stance"),
                    # The link endpoint falls back to the panel a clip was opened
                    # in when the classifier abstains; that is a default, not a
                    # verdict, and the explorer says so.
                    "defaulted": str(entry.get("notes", "")).startswith("stance NOT classified"),
                    "sizes": [s for s in MODEL_SIZES if s in tracks]}
    return out


@app.route("/api/train/clips")
def api_train_clips():
    if not TRAIN_DIR.is_dir():
        return jsonify({"dir": str(TRAIN_DIR), "clips": [],
                        "error": f"no such directory: {TRAIN_DIR} — set CLIPPER_OUT"})
    by_source = _train_examples_by_source(_load_manifest())
    labels = _train_labels()
    attempts = {}   # session folder -> clips.json list, for durations
    rows = []
    for clip in sorted(TRAIN_DIR.rglob("clips/*.mp4")):
        rel = clip.relative_to(TRAIN_DIR)
        if any(part.startswith(".") for part in rel.parts):
            continue   # clipper's scratch folders
        m = TRAIN_CLIP_RE.match(clip.name)
        session_dir = clip.parent.parent
        event = ("" if session_dir.parent == TRAIN_DIR
                 else session_dir.parent.relative_to(TRAIN_DIR).as_posix())
        sm = re.match(r"^(\d+)-", session_dir.name)
        idx = int(m["idx"]) if m else None
        if session_dir not in attempts:
            try:
                attempts[session_dir] = json.loads((session_dir / "clips.json").read_text())
            except (ValueError, OSError):
                attempts[session_dir] = []
        att = attempts[session_dir]
        duration = None
        if idx and 1 <= idx <= len(att) and isinstance(att[idx - 1], dict):
            try:
                duration = round(float(att[idx - 1]["end"]) - float(att[idx - 1]["start"]), 2)
            except (KeyError, TypeError, ValueError):
                pass
        try:
            st = clip.stat()
        except OSError:
            continue
        ex = by_source.get(clip.name)
        lab = labels.get(rel.as_posix(), {})
        rows.append({
            "path": rel.as_posix(),
            "name": clip.name,
            "event": event,
            "session": session_dir.name,
            "session_idx": int(sm[1]) if sm else None,
            "attempt": idx,
            "t": (int(m["hh"]) * 3600 + int(m["mm"]) * 60 + int(m["ss"])) if m else None,
            "result": m["result"] if m else "unknown",
            "duration": duration,
            "bytes": st.st_size,
            "mtime": int(st.st_mtime),
            "precomputed": bool(ex),
            "example_id": ex["id"] if ex else None,
            "sizes": ex["sizes"] if ex else [],
            # A label set in the explorer beats the stance the track classifier
            # chose; "unknown" is a clip nobody and nothing has decided yet.
            "exercise": lab.get("exercise") or (ex["stance"] if ex else None) or "unknown",
            "exercise_source": ("label" if lab.get("exercise")
                                else ("default" if ex["defaulted"] else "track") if ex else None),
            "track_exercise": ex["stance"] if ex else None,
            "category": lab.get("category") or "",
            "gender": lab.get("gender") or "",
        })
    return jsonify({"dir": str(TRAIN_DIR), "clips": rows, "lifts": _lift_page_ids()})


@app.route("/api/train/clip/<path:rel>")
def api_train_clip(rel):
    clip = _train_clip_path(rel)
    if not clip:
        return jsonify({"error": "unknown clip"}), 404
    return send_file(clip, conditional=True)


@app.route("/api/train/labels/<path:rel>", methods=["PUT"])
def api_train_label(rel):
    clip = _train_clip_path(rel)
    if not clip:
        return jsonify({"error": "unknown clip"}), 404
    body = request.get_json(silent=True) or {}
    patch = {}
    if "exercise" in body:
        ex = body["exercise"] or ""
        if ex not in ("", *_lift_page_ids()):
            return jsonify({"error": f"exercise must be one of {_lift_page_ids()} or empty"}), 400
        patch["exercise"] = ex
    if "gender" in body:
        g = body["gender"] or ""
        if g not in TRAIN_GENDERS:
            return jsonify({"error": f"gender must be one of {TRAIN_GENDERS}"}), 400
        patch["gender"] = g
    if "category" in body:
        c = str(body["category"] or "").strip()[:32]
        patch["category"] = c
    with _train_lock:
        labels = _train_labels()
        entry = {**labels.get(rel, {}), **patch}
        entry = {k: v for k, v in entry.items() if v}
        if entry:
            labels[rel] = entry
        else:
            labels.pop(rel, None)
        _write_json_atomic(TRAIN_LABELS_FILE, labels)
    return jsonify({"path": rel, **{k: entry.get(k, "") for k in ("exercise", "category", "gender")}})


def _classify_stance(track):
    """scripts/pose_stance.py's verdict (stance, reason), or (None, why-not).
    Imported lazily from scripts/ — that module is a pure-Python helper the
    sync script shares, not part of src/."""
    try:
        import sys
        scripts = str(Path(__file__).parent.parent / "scripts")
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        from pose_stance import classify_stance_from_track
        return classify_stance_from_track(track["keypoints"], track["meta"])
    except Exception as e:   # a classifier failure must not lose the track
        return None, f"stance classifier unavailable: {e}"


@app.route("/api/train/link", methods=["POST"])
def api_train_link():
    """Save a track the browser just computed for a training clip as a local
    fixture, so the clip shows up as an example (with its cached track) from
    now on. Same layout as sync_clipper_fixtures.py: the clip copied beside
    <stem>.track.json, a manifest entry keyed <stance>/<stem>, the dedup state
    entry, and a regenerated golden. A second model size for a clip already
    linked lands as <stem>.<size>.track.json next to the first."""
    body = request.get_json(silent=True) or {}
    clip = _train_clip_path(body.get("path") or "")
    if not clip:
        return jsonify({"error": "unknown clip"}), 404
    track = body.get("track") or {}
    if not isinstance(track.get("keypoints"), dict) or not isinstance(track.get("meta"), dict):
        return jsonify({"error": "track must be {keypoints, meta}"}), 400
    size = body.get("size") or vitpose_backend.DEFAULT_SIZE
    if size not in MODEL_SIZES:
        return jsonify({"error": f"size must be one of {MODEL_SIZES}"}), 400
    rel = clip.relative_to(TRAIN_DIR).as_posix()
    lifts = _lift_page_ids()

    with _train_lock:
        manifest = _load_manifest()
        existing = next(((k, e) for k, e in manifest.items()
                         if e.get("source_file") == clip.name), (None, None))
        label = _train_labels().get(rel, {})
        if existing[0]:
            # One fixture per clip: a new size joins the slug that already holds it.
            stance = existing[1].get("stance") or label.get("exercise") or lifts[0]
            note = existing[1].get("notes") or ""
        elif label.get("exercise"):
            stance, note = label["exercise"], "stance set by hand in the training data explorer"
        else:
            stance, reason = _classify_stance(track)
            if stance in lifts:
                note = f"stance auto-detected from pose trajectory: {reason}"
            else:
                fallback = body.get("fallback_exercise")
                stance = fallback if fallback in lifts else lifts[0]
                note = (f"stance NOT classified ({reason}); defaulted to {stance} from the "
                        f"panel it was opened in — relabel in the training data explorer if wrong")

        if existing[0] and existing[1]["scope"] == "global":
            scope, slug = "global", existing[0].split("/", 1)[1]
        else:
            scope, slug = "local", f"{stance}/{clip.stem}"
        out_dir = FIXTURES_DIR / scope
        stance_dir = out_dir / slug.split("/", 1)[0]
        stance_dir.mkdir(parents=True, exist_ok=True)
        if not (stance_dir / clip.name).exists():
            shutil.copyfile(clip, stance_dir / clip.name)

        manifest_path = out_dir / "manifest.json"
        try:
            entries = json.loads(manifest_path.read_text())
        except (ValueError, OSError):
            entries = {}
        entry = entries.get(slug) or {}
        legacy = out_dir / f"{slug}.track.json"
        if not legacy.exists() or entry.get("model_size", size) == size:
            track_path = legacy
            entry["model_size"] = size
        else:
            track_path = out_dir / f"{slug}.{size}.track.json"
        track_path.write_text(json.dumps(track))

        meta = track["meta"]
        m = TRAIN_CLIP_RE.match(clip.name)
        entries[slug] = {
            **entry,
            "stance": stance,
            "source_file": clip.name,
            "model_size": entry.get("model_size", size),
            "frame_stride": int(body.get("frame_stride") or meta.get("frame_stride") or 1),
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "frame_count": meta.get("frame_count"),
            "frames_processed": meta.get("frames_processed"),
            "kept_person": (meta.get("tracks") or {}).get("kept"),
            "labels": entry.get("labels", []),
            "notes": note,
            "diagnostics": entry.get("diagnostics") or stance,
            "attempt_result": m["result"] if m else "unknown",
            "train_clip": rel,
        }
        _write_json_atomic(manifest_path, entries)

        if scope == "local":
            try:
                links = json.loads(TRAIN_LINKS_FILE.read_text())
                assert isinstance(links, dict)
            except (ValueError, OSError, AssertionError):
                links = {}
            links[slug] = entries[slug]
            _write_json_atomic(TRAIN_LINKS_FILE, links)
            # The sync script's dedup is by content hash; register this clip so
            # a later pass skips it instead of extracting it a second time.
            state = {}
            try:
                state = json.loads(TRAIN_SYNC_STATE.read_text())
            except (ValueError, OSError):
                pass
            h = hashlib.sha256()
            with open(clip, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            state[h.hexdigest()] = f"{scope}/{slug}"
            _write_json_atomic(TRAIN_SYNC_STATE, state)

    example_id = f"{scope}/{slug}"
    golden = "skipped"
    if track_path == legacy:
        # Best effort: the diagnostics tests want a golden per fixture, and a
        # missing node or a scoring error here shouldn't fail the link itself.
        try:
            subprocess.run(["node", "tests/update_golden.js", example_id], check=True,
                           cwd=str(FIXTURES_DIR.parent.parent), timeout=120,
                           capture_output=True)
            golden = "ok"
        except Exception as e:
            golden = f"failed: {e}"
    return jsonify({"example_id": example_id, "exercise": stance, "size": size,
                    "sizes": [s for s in MODEL_SIZES if s in _example_tracks(example_id)],
                    "track_file": str(track_path.relative_to(FIXTURES_DIR)),
                    "notes": note, "golden": golden})


# --- named profiles: limb lengths and depth directions ----------------------
# Two things the reconstruction needs that the footage cannot supply, kept as
# NAMED profiles chosen in the interface rather than as files attached to a
# clip:
#
#   limbs  each segment's length as a fraction of torso. Belongs to the ATHLETE:
#          the lift turns the gap between a bone's true length and its
#          projection into depth, so one person's numbers apply to every clip
#          of them and nobody else's apply to any.
#   signs  which way each limb bends out of the screen. Belongs to the SHOT:
#          a single view can't tell toward from away, and the answer is a
#          property of where the camera stood, so one table serves every clip
#          filmed from that spot.
#
# Neither belongs to a clip, which is why storing them beside one was the wrong
# shape: the athlete's profile in athlete-a-trim was unreachable from any other
# clip of her, and a second clip from the same camera had no way to share the
# sign table. They live under
#
#   tests/fixtures/<scope>/profiles/<kind>/<name>.json
#
# in the same global/local split the examples use. `local` is gitignored, and a
# person's measured limb lengths are exactly the kind of thing to keep there,
# so that is where a newly saved profile lands; move the file to `global` to
# commit it. A local file with the same name as a global one shadows it.
#
# A few profiles are BUILT IN and never on disk: `default` limbs are the
# population priors the lift falls back to anyway, and `all-toward` /
# `all-away` are the two trivial sign tables. They can be chosen and edited,
# but a save under their name is refused — the edit goes under a new name.
PROFILE_KINDS = ("limbs", "signs")
PROFILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
DEFAULT_LIMB_PROFILE = "default"


def _builtin_profiles(kind):
    if kind == "limbs":
        return [{"name": DEFAULT_LIMB_PROFILE, "builtin": True, "scope": None,
                 "notes": "Population anthropometry — depth_backend._BONE_RATIO, "
                          "the same numbers the lift uses with no profile at all. "
                          "Nobody has been measured for these.",
                 "ratios": depth_backend.default_limb_ratios()}]
    joints = [row["index"] for row in depth_backend.sign_joints()]
    return [{"name": "all-toward", "builtin": True, "scope": None,
             "notes": "Every limb bends toward the camera — the old fixed default.",
             "signs": {str(j): 1 for j in joints}},
            {"name": "all-away", "builtin": True, "scope": None,
             "notes": "Every limb bends away from the camera; the mirror of all-toward.",
             "signs": {str(j): -1 for j in joints}}]


def _parse_profile(kind, raw):
    """A file's or a request's body -> the validated {notes, ratios|signs} the
    lift would actually run with, or None if it holds nothing usable.

    Goes through the same parse_bone_ratios / parse_depth_signs the lift applies
    to a posted table, so a profile can't contain a value the reconstruction
    would reject and then load as something else next session. A limb profile
    missing a segment is filled from the population value, so one written
    before a new segment existed still loads.
    """
    if not isinstance(raw, dict):
        return None
    notes = raw.get("notes") if isinstance(raw.get("notes"), str) else ""
    if kind == "limbs":
        got = depth_backend.parse_bone_ratios(raw.get("ratios"))
        if not got:
            return None
        ratios = depth_backend.default_limb_ratios()
        ratios.update(got)
        return {"notes": notes, "ratios": ratios}
    signs = depth_backend.parse_depth_signs(raw.get("signs"))
    if not signs:
        return None
    return {"notes": notes, "signs": {str(j): int(v) for j, v in sorted(signs.items())}}


def _profile_path(scope, kind, name):
    return FIXTURES_DIR / scope / "profiles" / kind / (name + ".json")


def _read_profiles(kind):
    """Every profile of one kind: the built-ins first, then each scope's files.

    An unreadable or malformed file is skipped rather than breaking the list —
    a bad profile should cost you that profile, not the picker. Local shadows
    global on a name clash.
    """
    out = {p["name"]: p for p in _builtin_profiles(kind)}
    for scope in FIXTURE_SCOPES:
        folder = FIXTURES_DIR / scope / "profiles" / kind
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*.json")):
            name = path.stem
            if not PROFILE_NAME_RE.match(name) or name in {p["name"] for p in _builtin_profiles(kind)}:
                continue
            try:
                body = _parse_profile(kind, json.loads(path.read_text()))
            except (ValueError, OSError):
                body = None
            if body is None:
                continue
            out[name] = dict(body, name=name, builtin=False, scope=scope)
    return list(out.values())


@app.route("/api/profiles/<kind>")
def api_profiles(kind):
    if kind not in PROFILE_KINDS:
        return jsonify({"error": "unknown profile kind"}), 404
    return jsonify({"profiles": _read_profiles(kind)})


@app.route("/api/profiles/<kind>/<name>", methods=["PUT"])
def api_profile_save(kind, name):
    """Write a profile under a name. Overwrites in whichever scope already holds
    that name; a new name lands in `local`. Built-in names are refused."""
    if kind not in PROFILE_KINDS:
        return jsonify({"error": "unknown profile kind"}), 404
    if not PROFILE_NAME_RE.match(name):
        return jsonify({"error": "profile names are lowercase letters, digits, '.', '_' or '-'"}), 400
    if any(p["name"] == name for p in _builtin_profiles(kind)):
        return jsonify({"error": f"'{name}' is built in — save under another name"}), 400
    body = _parse_profile(kind, request.get_json(silent=True))
    if body is None:
        return jsonify({"error": "no usable " + ("ratios" if kind == "limbs" else "depth directions")}), 400
    scope = next((s for s in FIXTURE_SCOPES if _profile_path(s, kind, name).exists()), "local")
    path = _profile_path(scope, kind, name)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(body, indent=1, sort_keys=True) + "\n")
    except OSError as e:
        return jsonify({"error": f"could not save: {e}"}), 500
    return jsonify(dict(body, name=name, builtin=False, scope=scope))


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


# Header logo: the cropped (margins trimmed) copy of logo/coach_logo_v1.png. The
# page references it as ./logo.png, relative, so it resolves under the /coach/
# prefix the same way ./diagnostics.js does.
LOGO_PNG = Path(__file__).parent.parent / "logo" / "coach_logo_v1_cropped.png"


@app.route("/logo.png")
def logo_png():
    if not LOGO_PNG.exists():
        return jsonify({"error": "logo is missing"}), 404
    return send_file(LOGO_PNG, mimetype="image/png")


@app.route("/squat/")
def squat_lab():
    return send_from_directory(Path(__file__).parent / "squat", "index.html")


@app.route("/squat/<path:filename>")
def squat_lab_asset(filename):
    return send_from_directory(Path(__file__).parent / "squat", filename)


@app.route("/anatomy/<path:filename>")
def anatomy_asset(filename):
    return send_from_directory(Path(__file__).parent / "anatomy", filename)


# In-browser pose (MediaPipe, vendored): the core's on-device path. The squat
# lab imports it as ../pose/pose.mjs.
@app.route("/pose/<path:filename>")
def pose_asset(filename):
    return send_from_directory(Path(__file__).parent / "pose", filename)


@app.route("/diagnostics.js")
def diagnostics_js():
    return Response(DIAGNOSTICS_JS.read_text(), mimetype="application/javascript")


@app.route("/")
def index():
    return Response(render_index(), mimetype="text/html")


# The lift page used to be served here too, but its relative asset paths
# resolve one level too deep under /original/ (diagnostics.js, the anatomy
# modules, the logo and three.js all 404). Old links land on the page instead.
# The Location stays relative so it also works behind the /coach/ prefix.
@app.route('/original/')
def original_workspace():
    return redirect('../')


INDEX_HTML = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
  body[data-page="train-data"] { --accent:#c58cff; --accent-soft:rgba(197,140,255,.14); }
  /* The explorer is a wide table: give it the larger column on desktop. */
  @media (min-width: 900px) {
    body[data-page="train-data"] .layout { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
  }
  .train-toolbar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .train-toolbar select, .train-toolbar input, .train-toolbar button { font-size:13px; padding:5px 6px; margin:0; }
  .train-toolbar label { font-size:13px; color:#c3c2b7; display:flex; align-items:center; gap:4px; }
  .train-list { max-height:72vh; overflow:auto; border:1px solid var(--line); border-radius:8px; background:rgba(23,26,24,.88); }
  #trTable { border-collapse:collapse; width:100%; font-size:12px; }
  #trTable th { position:sticky; top:0; z-index:1; background:#20241f; text-align:left; padding:6px; font-weight:600;
                color:#c3c2b7; cursor:pointer; white-space:nowrap; border-bottom:1px solid var(--line); user-select:none; }
  #trTable th.sorted { color:var(--accent); }
  #trTable td { padding:3px 6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px;
                border-bottom:1px solid rgba(52,58,53,.5); }
  #trTable tbody tr { user-select:none; }   /* double-click opens, it should not select text */
  #trTable tbody tr:hover { background:var(--accent-soft); }
  #trTable tbody tr.selected { background:var(--accent-soft); box-shadow:inset 2px 0 0 var(--accent); }
  #trTable tbody tr:focus { outline:1px solid var(--accent); outline-offset:-1px; }
  .tr-yes { color:#7fd48a; } .tr-no { color:#898781; }
  h1 { font-weight:600; letter-spacing:0; margin:0; }
  .app-header { display:flex; align-items:center; gap:20px; }
  /* The logo is black line art on transparent, so invert it onto the dark page.
     Overrides the global img rule's margin/radius. */
  .app-logo { height:72px; width:auto; margin:0; border-radius:0; filter:invert(1); flex:none; }
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
  /* Time sliders. One under the video, one under the 3D view, and they are the
     same control twice (see SCRUBS in the script) — so they are styled once
     here, thumb width included: the lift markers are positioned against the
     track the thumb slides along, which is the element's width minus one thumb,
     and that arithmetic needs the thumb to be a number this file sets rather
     than whatever each browser's default happens to be. */
  .scrub-row { display:flex; align-items:center; gap:8px; padding:7px 0 2px; }
  .scrub-wrap { position:relative; flex:1; }
  .scrub { -webkit-appearance:none; appearance:none; display:block; width:100%;
           height:16px; margin:0; padding:0; border:0; background:transparent; }
  .scrub::-webkit-slider-runnable-track { height:6px; border-radius:3px; background:#2c2f2b; }
  .scrub::-moz-range-track { height:6px; border-radius:3px; background:#2c2f2b; }
  .scrub::-webkit-slider-thumb { -webkit-appearance:none; width:14px; height:14px; margin-top:-4px;
                                 border:0; border-radius:50%; background:var(--accent); cursor:pointer; }
  .scrub::-moz-range-thumb { width:14px; height:14px; border:0; border-radius:50%; background:var(--accent); cursor:pointer; }
  .scrub-time { font-size:11px; color:#898781; white-space:nowrap; min-width:86px; text-align:right; }
  /* The lift's start/end, laid over the track. Purple, like every other phase
     boundary in coach (see the colour scheme in the lifting-diagnostic skill):
     a marker says WHEN the lift was, not how well it went. pointer-events stay
     off so a marker can never swallow a drag of the slider under it. */
  .scrub-marks { position:absolute; left:0; right:0; top:0; height:16px; pointer-events:none; }
  .scrub-span { position:absolute; top:5px; height:6px; border-radius:3px; background:rgba(179,157,219,0.30); }
  .scrub-mark { position:absolute; top:1px; width:2px; height:14px; margin-left:-1px;
                border-radius:1px; background:#b39ddb; box-shadow:0 0 0 1px rgba(0,0,0,0.55); }
  .scrub-mark::after { content:''; position:absolute; left:-3px; top:-5px;
                       border-left:4px solid transparent; border-right:4px solid transparent;
                       border-top:5px solid #b39ddb; }
  #vliftnote { font-size:12px; color:#898781; margin:0 0 4px; }
  #vliftnote .lift-seek { color:#b39ddb; cursor:pointer; border-bottom:1px dotted #b39ddb; }
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
  <img class="app-logo" src="./logo.png" alt="coach logo">
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
  <!-- training data explorer: one row per clip clipper has cut (see
       /api/train/clips in app.py). Rows are rendered by trRender(); the
       header cells sort, the toolbar filters. Double-click opens a clip in
       its lift's panel. -->
  <div id="trainView" hidden>
    <div class="train-toolbar">
      <input id="trSearch" type="search" placeholder="search…" style="flex:1 1 140px;min-width:110px">
      <select id="trPre"><option value="">precomputed: any</option><option value="1">precomputed: yes</option><option value="0">precomputed: no</option></select>
      <select id="trExercise"><option value="">exercise: any</option></select>
      <select id="trCategory"><option value="">category: any</option></select>
      <select id="trGender"><option value="">gender: any</option><option value="male">male</option><option value="female">female</option><option value="unknown">unknown</option></select>
      <select id="trEvent"><option value="">event: any</option></select>
      <select id="trResult"><option value="">result: any</option><option value="made">made</option><option value="miss">miss</option><option value="unknown">unknown</option></select>
      <label>order
        <select id="trSort">
          <option value="session">event / session / attempt</option>
          <option value="attempt">attempt</option>
          <option value="time">time in session</option>
          <option value="result">result</option>
          <option value="exercise">exercise</option>
          <option value="precomputed">precomputed</option>
          <option value="category">category</option>
          <option value="gender">gender</option>
          <option value="duration">duration</option>
          <option value="size">file size</option>
          <option value="modified">modified</option>
          <option value="name">file name</option>
        </select>
      </label>
      <button id="trDir" type="button" title="sort direction">asc &uarr;</button>
    </div>
    <p id="trCount" class="control-help" style="margin:6px 0"></p>
    <div class="train-list">
      <table id="trTable">
        <thead><tr>
          <th data-sort="event">event</th><th data-sort="session">#</th><th data-sort="attempt">att.</th>
          <th data-sort="time">time</th><th data-sort="result">result</th><th data-sort="exercise">exercise</th>
          <th data-sort="precomputed">track</th><th data-sort="category">category</th><th data-sort="gender">gender</th>
          <th data-sort="duration">dur</th><th data-sort="size">MB</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>
  <div id="videoView">
    <div id="videoWrap">
      <video id="vout" controls muted playsinline loop></video>
      <canvas id="voverlay"></canvas>
    </div>
    <!-- The video's own time bar, beside the native one. A <video controls>
         seek bar is browser chrome: nothing can be drawn on it, and the lift's
         start and end markers are exactly a drawing on a time bar. So the clip
         gets a real slider of its own, the same one the 3D view below has, and
         the native controls stay for play/pause/volume. Hidden until a clip has
         a duration to scrub. -->
    <div id="vscrubrow" class="scrub-row" style="display:none">
      <div class="scrub-wrap">
        <input id="vscrub" class="scrub" type="range" min="0" max="1" step="0.001" value="0" title="Scrub the clip">
        <div id="vscrubmarks" class="scrub-marks"></div>
      </div>
      <span id="vscrubtime" class="scrub-time">0.00s / 0.00s</span>
    </div>
    <!-- What the two markers on the sliders above mean and what put them there.
         A marker with no account of its trigger is the same failure as a score
         with no transparency block: a wrong one looks exactly like a right one.
         Times are click-to-seek, same contract as the plots. -->
    <p id="vliftnote"></p>
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
    </div>
    <!-- Per-athlete limb lengths. Fractions of torso (pelvis→neck), built from
         the backend's limb_segments() so this markup never lists segments
         itself. A NAMED profile, chosen here and remembered across clips and
         reloads — it belongs to the athlete, not to the clip. Editing re-runs
         the lift immediately; saving writes a profile file. Collapsed by
         default, like the other advanced controls — not part of
         the everyday flow. -->
    <details id="v3dlimbbar" class="control-group" style="margin:2px 0 6px">
      <summary title="Segment length as a fraction of torso — the lift turns the gap between a bone's true length and its on-screen length into depth, so a wrong length is invented depth.">limb lengths</summary>
      <p class="control-help">Segment length as a fraction of torso (hips→shoulders), for this athlete.</p>
      <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
        <label style="color:#c3c2b7" title="Whose limbs these are. A profile belongs to the athlete, not the clip, so it stays selected across clips and reloads. 'default' is the population priors.">profile
          <select id="v3dlimbprofile" style="font-size:12px;padding:1px 4px;margin:0"></select>
        </label>
        <b id="v3dlimbname" style="color:#c3c2b7"></b>
        <button id="v3dlimbrevert" type="button" disabled style="font-size:12px;padding:2px 8px" title="Discard edits and go back to the selected profile as saved">revert</button>
        <button id="v3dlimbsave" type="button" style="font-size:12px;padding:2px 8px" title="Save these ratios as a named profile — under the selected name, or a new one. New profiles land in the local (gitignored) scope.">save…</button>
        <label style="margin-left:4px;color:#c3c2b7" title="Which anatomical penalties the descent is allowed to fit against. The terms left out are still measured and still shown below — what a narrower objective does to the facts it stopped steering by is the point of having the choice. Switching objective makes the next optimize start over from the profile, so two objectives are always compared from the same lengths.">fit against
          <select id="v3dlimbobj" style="font-size:12px;padding:1px 4px;margin:0"></select>
        </label>
        <label style="color:#c3c2b7" title="A limb leaning toward the lens images LONGER than its in-plane extent, and the lift credits the difference to depth it doesn't have. With this on, every 3 steps the descent re-measures each bone's projected length against the depth it currently sits at (factor 1 − z/f) and carries on against the corrected lengths. The focal length is guessed from the frame size — nothing in one video measures it — so this is a plausible correction, not a calibrated one. It changes the lengths the fit lands on; the mesh you see is still lifted orthographically.">
          <input type="checkbox" id="v3dlimbpersp" style="margin:0 3px 0 0;vertical-align:-1px">perspective
        </label>
        <button id="v3dlimbfit" type="button" style="font-size:12px;padding:2px 8px" title="Small gradient steps on the FIRST frame, from wherever the ratios are now, minimising the selected objective — runs until every term in it stops moving. Measured against a known athlete this drifts ~0.1 torso off the true lengths and settles there, so read the breakdown rather than trusting it.">optimize</button>
        <span id="v3dlimbsteps" style="font-size:12px;color:#898781"></span>
        <span id="v3dlimbnote"></span>
      </div>
      <!-- What the steps actually bought, per humanness term. Shown rather than
           swallowed because on the fixtures this objective is a BIASED estimate
           of limb length: it reliably finds a lower penalty and reliably does so
           at the wrong lengths, so the numbers are the point. -->
      <div id="v3dlimbfitnote" style="display:none;font-size:12px;color:#898781;margin:6px 0 0;padding-top:6px;border-top:1px solid #2c2c2a"></div>
      <div id="v3dlimbs" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:4px 10px;margin-top:8px"></div>
    </details>
    <!-- Per-joint depth sign. Only the joints reached by walking a bone appear
         here (the backend's sign_joints()); hips/shoulders/nose are placed in
         the image plane and have no direction to choose. Built from
         /api/depth/methods so this markup never has to list joints itself.
         Collapsed by default, same as limb lengths. -->
    <details id="v3dsignbar" class="control-group" style="margin:2px 0 6px">
      <summary title="A single view cannot tell a limb bending toward the camera from one bending away — the depth magnitude is measured, the direction is chosen.">depth direction</summary>
      <p class="control-help">Which way each limb bends out of the screen. <b>toward</b> = toward the camera.</p>
      <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
        <label style="color:#c3c2b7" title="Auto works the directions out from the pose: it tries all 16 arrangements of the two elbows and two knees (wrists follow their elbow, ankles their knee) and keeps the one whose non-adjacent joint distances stay anatomically plausible over the whole clip. Changing any selector below switches to manual.">mode
          <select id="v3dsignmode" style="font-size:12px;padding:1px 4px;margin:0">
            <option value="auto" selected>auto (infer)</option>
            <option value="manual">manual</option>
          </select>
        </label>
        <label style="color:#c3c2b7" title="A saved table of directions. It describes where the camera stood, not the clip, so one profile serves every clip filmed from that spot and stays selected across clips and reloads. Choosing one switches to manual; 'none' leaves the solver to it.">profile
          <select id="v3dsignprofile" style="font-size:12px;padding:1px 4px;margin:0"></select>
        </label>
        <button id="v3dsignrevert" type="button" disabled style="font-size:12px;padding:2px 8px" title="Discard edits and go back to the selected profile as saved">revert</button>
        <button id="v3dsignsave" type="button" style="font-size:12px;padding:2px 8px" title="Save these directions as a named profile — under the selected name, or a new one. New profiles land in the local (gitignored) scope.">save…</button>
        <span id="v3dsignstate" style="font-size:12px;color:#898781"></span>
      </div>
      <div id="v3dsigns" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:4px 10px;margin-top:8px"></div>
    </details>
    <p id="v3dnote" style="font-size:12px;color:#898781;margin:0 0 4px"></p>
    <!-- The 3D view: a second "video" below the real one, showing the depth
         reconstruction the picked anchor produced. Hidden until a generate runs.
         Click-drag turns it (turntable about the vertical axis) so the recovered
         depth is actually visible; it steps in time with the video when the
         chosen method returns a per-frame sequence.
         Clicking a joint flips which way it bends out of the screen. That is the
         same choice as the dropdowns above, put where the mistake is actually
         visible: you see a knee pointing the wrong way in the turntable, and the
         fix is to click the knee — not to work out which of thirteen rows it is.
         When the optional anatomy overlay is set to display in the 3D pane
         (src/anatomy/integration.mjs), it composites its own canvas absolutely
         inside #v3dcanvasWrap on top of #v3dcanvas — a second, independent
         three.js scene sharing this box rather than trying to pixel-align to the
         video, which broke as soon as a differently-shaped video came along. -->
    <details id="wireframe-inspection"><summary>Inspect original 3D reconstruction</summary>
    <div id="v3dpanel" style="display:none;margin:2px 0 6px">
      <div id="v3dcanvasWrap" style="position:relative;width:100%;background:#0d0d0d;border-radius:8px;overflow:hidden;cursor:grab">
        <canvas id="v3dcanvas" style="display:block;width:100%;height:340px"></canvas>
        <button id="v3dplay" type="button" title="Play (syncs the video)" style="position:absolute;left:8px;top:6px;width:26px;height:26px;border-radius:50%;background:rgba(13,13,13,0.78);border:1px solid #3a3a37;color:#c3c2b7;font-size:12px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0">&#9654;</button>
        <div id="v3dhint" style="position:absolute;left:8px;bottom:6px;font-size:11px;color:#6f6e68;pointer-events:none">drag to rotate &middot; click a joint to flip its depth</div>
        <div id="v3dkey" style="position:absolute;right:8px;top:6px;font-size:11px;color:#6f6e68;pointer-events:none">
          <span style="color:#6fd1c5">&#9679;</span> toward &nbsp;<span style="color:#f0a020">&#9679;</span> away &nbsp;<span style="color:#6f6e68">&#9679;</span> no choice
        </div>
      </div>
      <!-- Coupled to the same vvideo element the native controls and the plot's
           click-to-seek already drive — dragging it seeks the video, and it
           follows along during playback or a seek from anywhere else, same as
           the plot's playhead line does (see drawOverlay). -->
      <div id="v3dscrubrow" class="scrub-row">
        <div class="scrub-wrap">
          <input id="v3dscrub" class="scrub" type="range" min="0" max="1" step="0.001" value="0" title="Scrub the clip — syncs the video and the mesh">
          <div id="v3dscrubmarks" class="scrub-marks"></div>
        </div>
        <span id="v3dscrubtime" class="scrub-time">0.00s / 0.00s</span>
      </div>
    </div>
    </details>
    <p id="vsummary" style="font-size:12px;color:#c3c2b7"></p>
    <!-- live sync readout: if the overlay ever looks frozen, this says whether
         playback time is stuck or the frame lookup is. -->
    <p id="vsync" style="font-size:12px;color:#898781"></p>
  </div>
</div>

<div class="col-panel">

  <div id="trainPanel" hidden>
    <h2 class="panel-h">training data</h2>
    <div class="settings">
      <p class="control-help">Every clip clipper has cut, from <code id="trDirNote"></code>. Double-click a row (or press Enter on it) to open the clip in its lift's panel. A clip with a cached track loads instantly; one without is run through ViTPose at that panel's model size, and the result is linked back as a local example so the next open is instant.</p>
      <div class="row"><button id="trReload" class="secondary-action" type="button">reload list</button><span id="trStatus" style="font-size:12px;color:#898781"></span></div>
      <div id="trDetail" class="control-group" hidden>
        <p id="trName" style="font-weight:600;margin:0 0 4px;word-break:break-all"></p>
        <p id="trMeta" class="control-help" style="margin:0 0 4px"></p>
        <p id="trTrack" class="control-help" style="margin:0 0 10px"></p>
        <!-- The three labels the footage can't supply. Exercise empty = let the
             track classifier (or the panel it's opened in) decide. -->
        <label>exercise <select id="trLabelExercise"></select> <span id="trLabelExerciseNote" style="font-size:12px;color:#898781"></span></label>
        <label>category <input id="trLabelCategory" list="trCatList" placeholder="e.g. 73, +109, junior" style="width:11em"><datalist id="trCatList"></datalist></label>
        <label>gender <select id="trLabelGender"><option value="">unknown</option><option value="male">male</option><option value="female">female</option></select></label>
        <button id="trOpen" class="primary-action" type="button">open</button>
      </div>
    </div>
  </div>

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

<script src="./diagnostics.js"></script>
<script>
// Where this page is mounted. Normally '' (served at /), but a reverse proxy
// may mount the app under a path prefix and strip that prefix before
// forwarding, so the server sees '/api/...' either way and only the browser
// has to know. Deriving it from the URL rather than baking it in keeps this
// file unaware of any particular deployment: nothing changes when the app is
// served at the root. Every fetch below goes through it.
//
// The two static tags that can't (this script's src, the three.js importmap)
// are written relative to the document instead. That makes a trailing slash
// on the mount point load-bearing: served at /prefix rather than /prefix/, a
// browser resolves those one level too high, so a proxy that mounts this app
// must redirect the bare path to the slashed one.
//
// The slash sits in a character class rather than being backslash-escaped:
// INDEX_HTML is a plain (not raw) Python string, where a backslash before a
// slash is an invalid escape sequence — harmless at runtime, but it warns on
// every start.
/* Where this page is mounted. This one page used to be served at two paths —
   '/' and '/original/' (now a redirect to '/', see original_workspace()) — and
   a reverse proxy may mount the whole app under a further prefix and strip it
   before forwarding, so the server sees '/api/...' either way and only the
   browser has to know. Since the redirect, the '/original' strip below never
   matches; it is harmless and goes when the frontend leaves app.py.

   Strip the trailing slash, then strip a trailing '/original': that leaves the
   app's own mount point in every combination, which a startsWith('/original')
   test does not. Served at /coach/original/ the pathname is '/coach/original/',
   which does not START with '/original', so the old test fell through to the
   else branch and every fetch went to /coach/original/api/... — a 404 behind the
   proxy while working perfectly at the root, where the test did match.

   The slashes sit in character classes rather than being backslash-escaped:
   this is a plain (not raw) Python string, where a backslash before a slash is
   an invalid escape sequence — harmless at runtime, but it warns on every
   start. */
const BASE = location.pathname.replace(/[/]+$/, '').replace(/[/]original$/, '');
const $ = id => document.getElementById(id);

$('run').onclick = async () => {
  const f = $('file').files[0];
  if (!f) return;
  $('status').textContent = 'running...';
  const fd = new FormData();
  fd.append('image', f);
  fd.append('size', $('size').value);
  const r = await fetch(BASE + '/api/pose', {method:'POST', body: fd});
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
// Throttle for the 'waiting' stall-kick below, so a genuine multi-second stall
// doesn't get re-nudged every tick.
let vLastStallKick = 0;
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

// Per-frame bar/plate boxes cached in a loaded track (meta.equipment), keyed by
// frame index like the keypoints. Bar detection was parked on 2026-10-31
// (parked/bar-detection/), so nothing draws them any more; they are kept only
// as the 3D plate-anchor method's input until 3D is parked too.
let vEquipment = null;

// The currently-loaded example: its manifest id and which model sizes have a
// cached track. Lets switching #vsize swap the overlay to that model's version
// with no pose run. Both null when the source is an upload or a recording.
let vExampleId = null, vExampleSizes = null;

// The loaded track exactly as computed, kept so a display-stride change can
// decimate a fresh copy of it rather than a previously-decimated one.
let vTrackFull = null;

// Reflect an example's cached sizes onto the #vsize picker: every size stays
// selectable, but the ones without a cached track are labelled so the user
// knows picking one starts a pose run on the example clip instead of a swap.
// `sizes` null clears the labels (a fresh upload/recording can be run at any
// size). `selected`, if available, becomes the current value.
function vSetSizeAvailability(sizes, selected) {
  for (const opt of $('vsize').options) {
    const ok = !sizes || sizes.includes(opt.value);
    opt.disabled = false;
    opt.textContent = opt.dataset.label + (ok ? '' : ' — not cached, will run');
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
  // The limb and sign profiles are deliberately NOT touched: they are chosen
  // by name and belong to the athlete and the camera, not to the clip, so
  // whatever is selected carries over to what gets loaded next.
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
  window.CoachAnatomy?.updateTrack({keypoints:vKeypoints, meta:vMeta});
  updatePlotControls();
  drawOverlay();
  Diagnostics.setTrack(vKeypoints, vMeta, { smoothingMs: vSigmaMs });
  // The lift window is part of what setTrack just recomputed, and drawOverlay
  // above ran against the previous one.
  renderLiftMarks();
}

$('vsmooth').addEventListener('input', applySmoothing);
$('vkeepvel').addEventListener('change', applySmoothing);


// --- plot canvas ---
const pcanvas = $('plotCanvas'), pctx = pcanvas.getContext('2d');

// --- diagnostics --- (see diagnostics.js; it owns its own canvas and panels)
// Stubbed if that script failed to load, so a ReferenceError here doesn't take
// the rest of the page's handlers down with it.
const Diagnostics = window.Diagnostics ||
  { mount(){}, setPage(){}, setTrack(){}, draw(){}, overlay(){}, liftWindow(){ return null; } };
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


function drawOverlay(t) {
  vctx.clearRect(0, 0, vcanvas.width, vcanvas.height);
  // Before the early return: clearing the track has to clear the lift markers
  // too, or they keep describing a clip that is no longer loaded. A no-op
  // unless the window actually moved.
  renderLiftMarks();
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
  window.CoachAnatomy?.frame({points: frame ? Object.values(frame)[0] : null, meta: vMeta, time, idx, exercise: document.body.dataset.page});

  drawPlot(time); // Update playhead line on plot canvas
  Diagnostics.draw(time);
  // Phase geometry on the frame itself — no-ops outside the active phase.
  // Given the time rather than the frame index: the marks are drawn on top of
  // the mesh, so they have to be interpolated on the same clock, or the thing
  // measuring the lifter steps while the lifter glides.
  Diagnostics.overlay(vctx, time);
  // Step the 3D view to the same frame, so the reconstruction plays in sync
  // with the video (no-op until a sequence candidate is loaded).
  if (window.Viewer) window.Viewer.showFrame(idx);
  syncScrubs(time);

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
  // metadata.mediaTime has been observed to not reset across a looping
  // <video>'s silent wrap — it keeps counting up from real elapsed time
  // instead of dropping back with currentTime, which the loop genuinely
  // does. A one-gap mismatch is normal presentation jitter; anything wider
  // means mediaTime cannot be trusted this tick, so anchor off currentTime
  // instead of letting the clock (and the mesh) drift off with a number
  // slotForTime will never see again in the sample track.
  if (Math.abs(media - vvideo.currentTime) > 1) media = vvideo.currentTime;
  const gap = (vClock && media > vClock.media) ? media - vClock.media
                                               : (vClock && vClock.gap);
  vClock = { media, wall: performance.now(),
             gap: gap || 1 / ((vMeta && vMeta.fps) || 30) };
}

function clockTime() {
  if (window.CoachAnatomy?.isModelOnly()) return vvideo.currentTime;
  if (!vClock) return vvideo.currentTime;
  // The anchor (anchorLoop's rVFC subscription) is known to go silent across a
  // looping <video>'s wrap. Without this, ahead below clamps to vClock.gap and
  // stays there — clockTime() locks onto one constant frame forever instead of
  // freezing gracefully, since nothing else ever nulls a vClock that old.
  if (performance.now() - vClock.wall > OVERLAY_STALL_MS) { vClock = null; return vvideo.currentTime; }
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
  else if (HAS_RVFC && !vInterp && !window.CoachAnatomy?.isModelOnly()) {
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
// Firefox (confirmed on 140, blob-sourced <video>): play() flips paused=false
// and fires 'playing', but the decoder can drop straight back into 'waiting'
// on the very first frame and then never recover — currentTime sits frozen
// forever even though the whole clip is already in memory, so there is no
// real buffering left to wait for. A seek is what unwedges it (that's why
// dragging the scrubber "fixes" it for users); nudging currentTime by an
// imperceptible amount does the same thing without moving the playhead.
// Debounced so a real stall (rare, but possible on a slow machine) doesn't
// get re-kicked every tick.
vvideo.addEventListener('waiting', () => {
  if (vvideo.paused || vvideo.ended) return;
  const now = performance.now();
  if (now - vLastStallKick < 500) return;
  vLastStallKick = now;
  vvideo.currentTime = Math.min(vvideo.currentTime + 0.0001, vvideo.duration || Infinity);
});
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
  vEquipment = null; v3dReset();
  updatePlotControls();
  Diagnostics.setTrack(null, null);
  $('vsummary').textContent = '';
  $('vsync').textContent = '';
  $('vexample').value = '';
  vClearExample();
  vTrainPath = null;
  setVideoSrc(f);
};

// Picking an example clip: pull down its committed video and its cached track,
// then load both. No pose run — the track was computed offline and shipped with
// the clip, so the diagnostics appear the moment the video can be scrubbed.
$('vexample').onchange = async () => {
  const id = $('vexample').value;
  if (!id) return;
  vTrainPath = null;   // trOpen re-sets it after this for a clip it opened
  const opt = $('vexample').selectedOptions[0];
  const sizes = (opt && opt.dataset.sizes ? opt.dataset.sizes.split(',') : []).filter(Boolean);
  stopCameraStream();
  $('vfile').value = '';
  vSource = null;
  vKeypointsRaw = null; vKeypoints = null; vMeta = null; vSample = null; vClock = null;
  vEquipment = null; v3dReset();
  updatePlotControls();
  Diagnostics.setTrack(null, null);
  $('vsummary').textContent = '';
  $('vsync').textContent = '';
  // Keep the current model pick if this example was analysed with it; otherwise
  // fall to whichever size it does ship. Label the rest as needing a run.
  vExampleId = id;
  vExampleSizes = sizes;
  // Profiles are not per-example, but the chosen ones have to be in place
  // before the first automatic generate, so wait for the startup fetch that
  // restores them rather than reconstructing once with defaults and again a
  // moment later.
  $('v3dlimbnote').textContent = '';
  await v3dReady;
  const size = sizes.includes($('vsize').value) ? $('vsize').value : sizes[0];
  vSetSizeAvailability(sizes, size);
  $('vstatus').textContent = 'loading example…';
  try {
    const [vr, tr] = await Promise.all([
      fetch(`${BASE}/api/examples/${encodeURI(id)}/video`),
      fetch(`${BASE}/api/examples/${encodeURI(id)}/track?size=${encodeURIComponent(size)}`),
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
// model's cached track when the example ships one. For a size with no cached
// track the example's video is sent through the pose pipeline like an upload —
// same as pressing "run" — so every model is usable on every example.
$('vsize').onchange = async () => {
  if (!vExampleId || !vExampleSizes) return;
  const size = $('vsize').value;
  if (!vExampleSizes.includes(size)) {
    if ($('vrun').disabled) {
      $('vstatus').textContent = 'a run is already in progress — wait or cancel it first';
      return;
    }
    $('vstatus').textContent = 'no cached ' + size + ' track for this example — running it now…';
    vStartRun();
    return;
  }
  $('vstatus').textContent = 'switching to ' + size + ' overlay…';
  try {
    const r = await fetch(`${BASE}/api/examples/${encodeURI(vExampleId)}/track?size=${encodeURIComponent(size)}`);
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
  vTrainPath = null;
  vSource = null; vKeypointsRaw = null; vKeypoints = null; vMeta = null; vSample = null; vClock = null;
  vEquipment = null; v3dReset();
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
let vRunParams = null;   // {size, stride, eq} of the run in flight, for linking its result
let vTrainPath = null;   // training clip the loaded video came from (see trOpen)

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
    p = await (await fetch(BASE + '/api/pose/video/progress')).json();
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

  const rr = await fetch(BASE + '/api/pose/video/result');
  const data = await rr.json();
  if (!rr.ok) { $('vstatus').textContent = 'error: ' + data.error; return; }
  applyTrack(data);
  $('vstatus').textContent = 'done';
  if (vTrainPath) trLink(data);
}

// Load a {keypoints, meta} track into every view — the shared tail of a fresh
// pose run (vPoll) and of picking a cached example clip. The caller owns the
// status line; this only touches the track and what's derived from it.
function applyTrack(data) {
  window.CoachAnatomy?.loadTrack(data);
  vTrackFull = data;          // the track exactly as computed, at its own stride;
                              // vApplyExampleStride decimates a copy of this for
                              // display when a coarser stride is picked.
  vKeypointsRaw = data.keypoints;
  vMeta = data.meta;
  vEquipment = vMeta.equipment || null;   // 3D's input only; see its declaration
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

$('vrun').onclick = () => vStartRun();

// Start a pose run on the current source at the picked size and stride. Shared
// by the run button and by picking an uncached model size on a loaded example.
async function vStartRun() {
  if (!vSource) { $('vstatus').textContent = 'pick a video or record from camera first'; return; }
  const fd = new FormData();
  fd.append('video', vSource.blob, vSource.filename);
  fd.append('size', $('vsize').value);
  fd.append('frame_stride', $('vstride').value || '1');
  const r = await fetch(BASE + '/api/pose/video/start', {method:'POST', body: fd});
  const data = await r.json();
  if (!r.ok) { $('vstatus').textContent = 'error: ' + data.error; return; }
  vRunParams = { size: $('vsize').value, stride: parseInt($('vstride').value || '1', 10) };
  // A fresh run supersedes any loaded example: its result is the new overlay, so
  // a later size switch shouldn't quietly swap back to the cached example track.
  vClearExample();
  vSetRunning(true);
  $('vprogBar').style.width = '0%';
  $('vstatus').textContent = 'starting…';
  vPolling = true;
  vPoll();
}

$('vcancel').onclick = async () => {
  if (!confirm('Abort the current video analysis?')) return;
  $('vcancel').disabled = true;
  $('vstatus').textContent = 'cancelling…';
  try {
    await fetch(BASE + '/api/pose/video/cancel', {method:'POST'});
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
  const train = page.media === 'train';
  document.body.dataset.page = page.id;
  if (!train) window.CoachReview?.setPage(page.id);
  $('pageContext').textContent = video
    ? `${page.label} · video analysis and movement diagnostics`
    : train ? 'training data · every clip clipper has cut, and which have a cached pose track'
    : 'single-frame pose inspection';
  $('imageView').hidden = video || train;
  $('imagePanel').hidden = video || train;
  $('trainView').hidden = !train;
  $('trainPanel').hidden = !train;
  $('videoView').hidden = !video;
  $('videoPanel').hidden = !video;
  if (train && !trLoaded) trLoad();
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

// --- generate-3D picker ---------------------------------------------------
// The depth framework's cheap/expensive split, surfaced: the picker lists every
// anchor, one click scores them all cheaply then builds the mesh for just the
// chosen (or highest-confidence) one, and the result drives the 3D view below.
let v3dLast = null;

function v3dReset() {
  window.CoachAnatomy?.reset();
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
  const target = vSample.frames[slotForTime(vvideo.currentTime)];
  if (v3dPoseAt(target)) return target;
  let nearest = null, distance = Infinity;
  for (const frame of vSample.frames) {
    if (!v3dPoseAt(frame)) continue;
    const d = Math.abs(frame - target);
    if (d < distance) { nearest = frame; distance = d; }
  }
  return nearest;
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
// --- named profiles ---------------------------------------------------------
// Both tables below are chosen BY NAME from /api/profiles/<kind>, never read
// off the clip: limb lengths belong to the athlete and depth directions to
// where the camera stood, and neither is a property of the footage. The choice
// is remembered in localStorage so it survives a reload and carries from one
// clip to the next — the next clip is usually the same athlete on the same
// camera. A few profiles are built in on the backend (`default` limbs,
// `all-toward` / `all-away` signs) and can't be saved over.
let v3dProfiles = { limbs: [], signs: [] };
const PROFILE_PREF = { limbs: 'coach.limbProfile', signs: 'coach.signProfile' };

async function v3dFetchProfiles(kind) {
  try {
    const r = await fetch(`${BASE}/api/profiles/${kind}`);
    const d = r.ok ? await r.json() : null;
    v3dProfiles[kind] = (d && Array.isArray(d.profiles)) ? d.profiles : [];
  } catch (e) { v3dProfiles[kind] = []; }
  v3dFillProfileSelect(kind);
  return v3dProfiles[kind];
}

function v3dProfile(kind, name) {
  return v3dProfiles[kind].find(p => p.name === name) || null;
}

// One <optgroup> per origin — built in / global / local — so it's visible
// which names ship with the repo and which live only on this machine. The
// sign picker gets a 'none' entry on top: no profile means the solver runs.
function v3dFillProfileSelect(kind) {
  const sel = $(kind === 'limbs' ? 'v3dlimbprofile' : 'v3dsignprofile');
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = '';
  if (kind === 'signs') {
    const o = document.createElement('option');
    o.value = ''; o.textContent = 'none (solve from the pose)';
    sel.appendChild(o);
  }
  const groups = {};
  for (const p of v3dProfiles[kind]) {
    const g = p.builtin ? 'built in' : (p.scope || 'global');
    if (!groups[g]) {
      groups[g] = document.createElement('optgroup');
      groups[g].label = g;
      sel.appendChild(groups[g]);
    }
    const o = document.createElement('option');
    o.value = p.name; o.textContent = p.name;
    if (p.notes) o.title = p.notes;
    groups[g].appendChild(o);
  }
  sel.value = keep;
}

function v3dRememberProfile(kind, name) {
  try { localStorage.setItem(PROFILE_PREF[kind], name || ''); } catch (e) { /* private mode */ }
}
function v3dRecallProfile(kind) {
  try { return localStorage.getItem(PROFILE_PREF[kind]) || ''; } catch (e) { return ''; }
}

// Save a table under a name. The selected profile's own name is offered unless
// it's built in (the backend refuses those); a new name lands in the local
// scope. One prompt rather than separate save / save-as buttons. `bodyFor`
// builds the payload once the name is known, so an overwrite keeps the
// profile's notes and a new name starts with none.
async function v3dSaveProfile(kind, current, bodyFor, noteEl) {
  const cur = current ? v3dProfile(kind, current) : null;
  const name = (prompt('Save ' + kind + ' profile as (lowercase letters, digits, . _ -):',
                       cur && !cur.builtin ? cur.name : '') || '').trim();
  if (!name) return null;
  noteEl.style.color = '#898781';
  noteEl.textContent = 'saving…';
  try {
    const r = await fetch(`${BASE}/api/profiles/${kind}/${encodeURIComponent(name)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyFor(name)),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    await v3dFetchProfiles(kind);
    noteEl.textContent = `saved as ${name} (${d.scope})`;
    return name;
  } catch (e) {
    noteEl.style.color = '#f0a020';
    noteEl.textContent = 'save failed: ' + e.message;
    return null;
  }
}

// The named sign profile currently applied; '' means none — the solver, or a
// table built by hand. Kept so "revert" has something to go back to and so the
// state line can say whether what's on screen is still the saved table or has
// been edited since.
let v3dSignProfileName = '';

// Apply a named sign profile: its table, in manual mode, because a profile is
// something a person looked at and the solver's answer is a ranked guess.
// '' hands the directions back to the solver.
function v3dApplySignProfile(name, { generate = true } = {}) {
  const p = name ? v3dProfile('signs', name) : null;
  v3dSignProfileName = p ? name : '';
  if (p) {
    v3dSigns = Object.assign({}, p.signs);
    v3dSetSignMode('manual');
  } else {
    v3dSetSignMode('auto');
  }
  const sel = $('v3dsignprofile');
  if (sel && sel.value !== v3dSignProfileName) sel.value = v3dSignProfileName;
  v3dRememberProfile('signs', v3dSignProfileName);
  v3dBuildSignControls();
  if (generate && vMeta) v3dGenerate();
}

// Same edited/saved distinction the limb bar makes, for the same reason: you
// should be able to tell at a glance whether the clip is showing what's on disk.
function v3dSignsDiffer(a, b) {
  if (!a || !b) return false;
  return v3dSignJoints.some(j => (a[String(j.index)] || 0) !== (b[String(j.index)] || 0));
}

function v3dRenderSignState() {
  const el = $('v3dsignstate');
  if (!el) return;
  const p = v3dSignProfileName ? v3dProfile('signs', v3dSignProfileName) : null;
  const dirty = !!p && v3dSignsDiffer(v3dSigns, p.signs);
  el.textContent = p ? (dirty ? 'edited' : (p.builtin ? 'built in' : p.scope))
                     : (v3dSignMode === 'auto' ? 'solved from the pose' : 'manual, unsaved');
  el.style.color = dirty ? '#f0a020' : '#898781';
  const revert = $('v3dsignrevert');
  if (revert) revert.disabled = !dirty;
}

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
      v3dRenderSignState();
      if (vMeta) v3dGenerate();
    };
    row.appendChild(name); row.appendChild(sel);
    host.appendChild(row);
  }
  v3dRenderSignState();
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

// --- 3D panel: play button ---------------------------------------------
// Exactly what the video's own (native) play button does — this just calls
// vvideo.play()/pause(). Nothing else has to be wired for the mesh to follow:
// drawOverlay() already calls Viewer.showFrame(idx) on every video frame (see
// above), whether or not the video is playing, so driving playback from here
// is the entire feature — the sync was already there.
function v3dSyncPlayIcon() {
  const btn = $('v3dplay');
  if (!btn) return;
  const playing = !vvideo.paused && !vvideo.ended;
  btn.textContent = playing ? '\u23F8' : '\u25B6';
  btn.title = playing ? 'Pause' : 'Play (syncs the video)';
}
vvideo.addEventListener('play', v3dSyncPlayIcon);
vvideo.addEventListener('pause', v3dSyncPlayIcon);
vvideo.addEventListener('ended', v3dSyncPlayIcon);
// mousedown must not reach the wrap's own listener — that's the turntable
// drag / joint-pick logic, and a click on this button is neither.
$('v3dplay').addEventListener('mousedown', e => e.stopPropagation());
$('v3dplay').addEventListener('click', e => {
  e.stopPropagation();
  if (vvideo.paused || vvideo.ended) vvideo.play(); else vvideo.pause();
});
v3dSyncPlayIcon();

// --- time sliders ---------------------------------------------------------
// Two of them, and they are the same control twice: one under the video (the
// native seek bar cannot be drawn on, and these carry markers) and one under
// the 3D view. Both are just another way into vvideo.currentTime, alongside the
// native controls and the plot's click-to-seek — dragging one scrubs the video,
// and the video moving for ANY reason (playback, the native seek bar, a plot
// click, the other slider) scrubs both, via syncScrubs below. It is called from
// drawOverlay with the same `time` the mesh and the plot's playhead already
// use: one clock, every display.
const SCRUBS = [
  { input: 'vscrub', time: 'vscrubtime', marks: 'vscrubmarks' },
  { input: 'v3dscrub', time: 'v3dscrubtime', marks: 'v3dscrubmarks' },
];
// Which slider's thumb is currently down, if any. Per-element rather than a
// single flag so a drag on one does not also freeze the other's thumb: they
// show the same clock, and only the one being dragged must not be written to.
let scrubDrag = null;

function syncScrubRange() {
  const dur = (vvideo.duration && isFinite(vvideo.duration)) ? vvideo.duration : null;
  for (const s of SCRUBS) {
    const el = $(s.input);
    if (el) el.max = String(dur || 1);
  }
  // A dead slider on a page with no clip is worse than no slider; the 3D one is
  // inside a panel that is itself hidden until a reconstruction exists.
  $('vscrubrow').style.display = dur ? 'flex' : 'none';
  renderLiftMarks();   // the marker positions are fractions of the duration
}
vvideo.addEventListener('loadedmetadata', syncScrubRange);

// Skipped while the user is actively dragging: reassigning a range input's
// .value out from under an in-progress drag makes the thumb visibly fight the
// pointer on some browsers, even when the reassigned value is correct.
function syncScrubs(time) {
  if (!isFinite(time)) return;
  for (const s of SCRUBS) {
    const el = $(s.input), out = $(s.time);
    if (el && scrubDrag !== s.input) el.value = String(time);
    if (out) out.textContent = `${time.toFixed(2)}s / ${(vvideo.duration || 0).toFixed(2)}s`;
  }
}
for (const s of SCRUBS) {
  const el = $(s.input);
  el.addEventListener('pointerdown', () => { scrubDrag = s.input; });
  el.addEventListener('input', () => {
    const t = parseFloat(el.value);
    if (isFinite(t)) vvideo.currentTime = t;
  });
  // 'change' is the reliable release signal for a range input; the window
  // listener is a fallback for a pointer released off the element.
  el.addEventListener('change', () => { if (scrubDrag === s.input) scrubDrag = null; });
}
window.addEventListener('pointerup', () => { scrubDrag = null; }, true);

// --- lift start/end markers -----------------------------------------------
// The lift itself, on the time bars: where the first pull starts and where the
// lifter finishes locked out (diagnostics.js: liftWindow). Every lift page gets
// them, because the window is computed from the track and not from the page's
// cue set — but not every lift HAS them (no bar off the floor, no lockout to
// hold), so the trigger either fires or says why it didn't, and the tickbox
// turns the whole thing off for a clip where they are noise.
//
// Positioned against the slider's TRACK, not its box: the thumb's centre only
// ever reaches from half a thumb in to half a thumb from the end, so t maps to
// `7px + ratio * (100% - 14px)` for the 14px thumb the stylesheet sets. Written
// as a CSS calc rather than resolved to pixels here so the markers survive a
// resize without anything having to listen for one.
const SCRUB_THUMB = 14;
const markLeft = r => `calc(${(SCRUB_THUMB / 2).toFixed(1)}px + ${(r * 100).toFixed(4)}% - ${(r * SCRUB_THUMB).toFixed(3)}px)`;
const markWidth = r => `calc(${(r * 100).toFixed(4)}% - ${(r * SCRUB_THUMB).toFixed(3)}px)`;

function liftMarkHtml(t0, t1, dur) {
  const r = t => Math.max(0, Math.min(1, t / dur));
  let html = '';
  if (t0 != null && t1 != null) {
    html += `<div class="scrub-span" style="left:${markLeft(r(t0))};width:${markWidth(r(t1) - r(t0))}"></div>`;
  }
  for (const t of [t0, t1]) {
    if (t == null) continue;
    html += `<div class="scrub-mark" style="left:${markLeft(r(t))}"></div>`;
  }
  return html;
}

// Rebuilds both sliders' markers and the note under the video.
//
// Driven from drawOverlay rather than from each of the half-dozen places the
// window can move (a new clip, the smoothing slider, the lifter picker, the
// lift tab, the tickbox): every one of those repaints the overlay already, and
// a marker that silently belongs to the previous track is exactly the failure
// this is meant to prevent. The paint loop runs per frame during playback, so
// the DOM is only touched when the window object, the duration or the tickbox
// actually changed — liftWindow() hands back a fresh object per run(), so
// identity is a sufficient and exact test.
let liftMarksKey = null;
function renderLiftMarks() {
  const note = $('vliftnote');
  const on = $('vliftmarks').checked;
  const win = Diagnostics.liftWindow ? Diagnostics.liftWindow() : null;
  const dur = (vvideo.duration && isFinite(vvideo.duration)) ? vvideo.duration : null;
  if (liftMarksKey && liftMarksKey.win === win && liftMarksKey.dur === dur && liftMarksKey.on === on) return;
  liftMarksKey = { win, dur, on };

  const lift = on ? win : null;
  const t0 = lift && lift.t0 != null ? lift.t0 : null;
  const t1 = lift && lift.t1 != null ? lift.t1 : null;
  const html = (lift && dur) ? liftMarkHtml(t0, t1, dur) : '';
  for (const s of SCRUBS) {
    const el = $(s.marks);
    if (el) el.innerHTML = html;
  }

  if (!lift) { note.innerHTML = ''; return; }
  const seek = (t, label) =>
    `<span class="lift-seek" data-seek="${t}" title="jump to ${t.toFixed(2)}s">${label}</span>`;
  const head = t0 == null
    ? '<b>lift</b> not found'
    : t1 == null
      ? `<b>lift</b> starts ${seek(t0, t0.toFixed(2) + 's')} — no end marker`
      : `<b>lift</b> ${seek(t0, t0.toFixed(2) + 's')} → ${seek(t1, t1.toFixed(2) + 's')} ` +
        `(${(t1 - t0).toFixed(2)}s)`;
  // What fired, in the same breath as the numbers — the markers' transparency
  // block. The trigger wording is the definition, not a restatement: a reader
  // who disagrees with where a marker sits needs to know what it was looking
  // for before they can say it is wrong.
  const tr = lift.triggers;
  const how = tr
    ? ` · start: wrists begin rising toward the bar/knee crossing at ` +
      `${tr.crossT.toFixed(2)}s · end: elbows past ${tr.lockElbow}° ` +
      `(least ${tr.minElbow.toFixed(0)}°) and knees past ${tr.lockKnee}° ` +
      `(least ${tr.minKnee.toFixed(0)}°), body under ${tr.stillSpeed} torso-lengths/s ` +
      `(peak ${tr.peakSpeed.toFixed(2)}) and drifting ${tr.netDrift == null ? '—' : tr.netDrift.toFixed(2)} of ` +
      `${tr.stillDrift}, held ${tr.holdSeconds.toFixed(2)}s over ${tr.holdSamples} samples`
    : '';
  const why = (lift.error ? [lift.error] : []).concat(lift.notes || []);
  note.innerHTML = head + how + (why.length ? `<br>${why.join(' ')}` : '');
}

// Click-to-seek on the times in the note, same contract as the plots: any
// instant named on the page goes back to the frame that produced it.
$('vliftnote').addEventListener('click', e => {
  const el = e.target.closest ? e.target.closest('[data-seek]') : null;
  if (!el) return;
  const t = parseFloat(el.dataset.seek);
  if (isFinite(t)) vvideo.currentTime = t;
});

$('vliftmarks').addEventListener('change', renderLiftMarks);

$('v3dlimbprofile').onchange = () => v3dApplyLimbProfile($('v3dlimbprofile').value);
$('v3dlimbfit').onclick = async () => {
  $('v3dlimbfit').disabled = true;
  try { await v3dStepLimbs(); if (vMeta) v3dGenerate(); }
  finally { $('v3dlimbfit').disabled = false; }
};
$('v3dlimbrevert').onclick = () => v3dApplyLimbProfile(v3dLimbs ? v3dLimbs.name : 'default');
// Saving is explicit: editing a ratio re-runs the lift so you can see what it
// does, but nothing reaches disk until you say so — and then under a name,
// never onto the clip, so trying a number can't quietly rewrite an athlete.
$('v3dlimbsave').onclick = async () => {
  if (!v3dLimbs) return;
  const saved = await v3dSaveProfile('limbs', v3dLimbs.name, name => {
    const cur = v3dProfile('limbs', name);
    return { notes: cur && !cur.builtin ? cur.notes : '', ratios: v3dLimbs.ratios };
  }, $('v3dlimbnote'));
  if (saved) v3dApplyLimbProfile(saved, { generate: false });
};
// Auto and "no profile" are the same state: the solver owns the table. Going
// back to manual keeps whatever is on screen, now as a hand-built table.
$('v3dsignmode').onchange = () => {
  if ($('v3dsignmode').value === 'auto') { v3dApplySignProfile(''); return; }
  v3dSignMode = 'manual';
  v3dRenderSignState();
  if (vMeta) v3dGenerate();
};
$('v3dsignprofile').onchange = () => v3dApplySignProfile($('v3dsignprofile').value);
$('v3dsignrevert').onclick = () => v3dApplySignProfile(v3dSignProfileName);
// Editing re-runs the lift so you can see the change, but nothing reaches disk
// until you say so — and then under a name, never onto the clip.
$('v3dsignsave').onclick = async () => {
  const saved = await v3dSaveProfile('signs', v3dSignProfileName, name => {
    const cur = v3dProfile('signs', name);
    return { notes: cur && !cur.builtin ? cur.notes : '', signs: v3dSigns };
  }, $('v3dnote'));
  if (saved) v3dApplySignProfile(saved, { generate: false });
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
// The profile is chosen by name (see the named-profiles block above) and
// carries across clips. Edits here are live — each change re-runs the lift —
// and only reach disk on an explicit save, so you can try a number without
// committing to it.
let v3dLimbSegments = [];            // [{key,label,default,min,max}] from /api/depth/methods
let v3dDefaultLimbs = {};            // the population priors, the `default` profile
// Which anatomical penalties the optimiser fits against. A CHOICE rather than a
// constant because the five terms are not equally trustworthy: `legs` scores
// correct snatch technique as an error and `hands` reads 0 everywhere measured,
// so the narrow objective (mirror plane only) is sometimes the honest one.
// Remembered like the profiles are — it's a working preference, not a property
// of the clip.
let v3dObjectives = [];              // [{name,label,description,terms,caveat}]
let v3dObjective = '';               // the selected name
const OBJECTIVE_PREF = 'coach.limbObjective';
// Whether the descent corrects each bone's projected length for the depth it
// currently sits at (see the backend's optimize_limbs `perspective`). Off by
// default and remembered per browser, like the objective: it is a different
// camera model, not a better setting, and which one is right is exactly what a
// single video does not tell you.
const PERSP_PREF = 'coach.limbPerspective';
let v3dLimbs = null;                 // {name, notes, ratios} in use
let v3dLimbsSaved = null;            // the selected profile as saved, for the dirty marker

function v3dDefaultProfile() {
  return { name: 'default', notes: '', ratios: { ...v3dDefaultLimbs } };
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
  v3dLimbs = profile ? { name: profile.name || 'default', notes: profile.notes || '',
                         ratios: { ...v3dDefaultLimbs, ...(profile.ratios || {}) } }
                     : v3dDefaultProfile();
  if (saved) v3dLimbsSaved = JSON.parse(JSON.stringify(v3dLimbs));
  if (!keepSteps) {
    v3dLimbSteps = 0; v3dLimbPenalty0 = null;
    const s = $('v3dlimbsteps');
    if (s) s.textContent = '';
  }
  v3dBuildLimbControls();
}

// Apply a named limb profile; an unknown name (a deleted file, a stale
// localStorage entry) falls back to `default` rather than to nothing.
function v3dApplyLimbProfile(name, { generate = true } = {}) {
  const p = v3dProfile('limbs', name) || v3dProfile('limbs', 'default');
  v3dSetLimbs(p, { saved: true });
  const sel = $('v3dlimbprofile');
  if (sel && p && sel.value !== p.name) sel.value = p.name;
  v3dRememberProfile('limbs', p ? p.name : '');
  $('v3dlimbnote').textContent = '';
  $('v3dlimbfitnote').style.display = 'none';
  if (generate && vMeta) v3dGenerate();
}

// Both pickers, once the segment and joint lists exist: every profile of each
// kind, then whatever was selected last time — or `default` limbs and the
// solver for the signs on a first visit. Nothing is generated here; the clip
// that loads next does that with these already in place.
async function v3dInitProfiles() {
  await Promise.all([v3dFetchProfiles('limbs'), v3dFetchProfiles('signs')]);
  v3dApplyLimbProfile(v3dRecallProfile('limbs') || 'default', { generate: false });
  v3dApplySignProfile(v3dRecallProfile('signs'), { generate: false });
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
      // Typing a ratio is choosing where the descent starts, so it outranks the
      // pending revert a new objective would otherwise do.
      v3dRefitFromProfile = false;
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
  const p = v3dProfile('limbs', v3dLimbs.name);
  el.textContent = dirty ? 'edited' : (p ? (p.builtin ? 'built in' : p.scope) : '');
  el.style.color = dirty ? '#f0a020' : '#898781';
  const revert = $('v3dlimbrevert');
  if (revert) revert.disabled = !dirty;
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
// Set when the objective changes: the NEXT optimize starts over from the saved
// profile instead of from wherever the previous objective's descent stopped.
// Two objectives compared from the same starting ratios are a comparison; run
// back to back they are a chain, and the second one's answer depends on the
// first one having been run at all. Deferred to the click rather than done on
// the change so that picking an objective never silently discards ratios — and
// cleared by a hand edit, which is a deliberate choice of where to start.
let v3dRefitFromProfile = false;

// Fill the objective picker and restore the remembered choice. An objective
// that no longer exists (renamed in the backend, stale localStorage) falls back
// to the backend's default rather than posting a name that would 400.
function v3dInitObjectives(list, fallback) {
  v3dObjectives = list;
  const sel = $('v3dlimbobj');
  if (!sel || !list.length) return;
  sel.innerHTML = '';
  for (const o of list) {
    const opt = document.createElement('option');
    opt.value = o.name; opt.textContent = o.label;
    if (o.description) opt.title = o.description;
    sel.appendChild(opt);
  }
  let want = '';
  try { want = localStorage.getItem(OBJECTIVE_PREF) || ''; } catch (e) { /* private mode */ }
  if (!list.some(o => o.name === want)) want = fallback || list[0].name;
  v3dObjective = want;
  sel.value = want;
  sel.onchange = () => {
    v3dObjective = sel.value;
    try { localStorage.setItem(OBJECTIVE_PREF, v3dObjective); } catch (e) { /* private mode */ }
    // The running total is a sum over a different objective now, so the count
    // and the "penalty at the start" it's measured against are both meaningless.
    // Reset rather than carry them across and quietly compare two scales.
    v3dLimbSteps = 0; v3dLimbPenalty0 = null;
    v3dRefitFromProfile = true;
    $('v3dlimbsteps').textContent = '';
    $('v3dlimbnote').textContent = '';
    $('v3dlimbfitnote').style.display = 'none';
  };
}

// The perspective tickbox. Restored from localStorage and, when toggled, it
// resets the running totals and marks the next optimize as a fresh start from
// the profile — for the same reason changing the objective does. Corrected and
// uncorrected lengths are two answers to the same question, and chaining one
// descent onto the other's output makes the second one depend on whether the
// first was ever run.
function v3dInitPerspective() {
  const box = $('v3dlimbpersp');
  if (!box) return;
  try { box.checked = localStorage.getItem(PERSP_PREF) === '1'; }
  catch (e) { /* private mode */ }
  box.onchange = () => {
    try { localStorage.setItem(PERSP_PREF, box.checked ? '1' : '0'); }
    catch (e) { /* private mode */ }
    v3dLimbSteps = 0; v3dLimbPenalty0 = null;
    v3dRefitFromProfile = true;
    $('v3dlimbsteps').textContent = '';
    $('v3dlimbnote').textContent = '';
    $('v3dlimbfitnote').style.display = 'none';
  };
}

async function v3dStepLimbs() {
  if (!vMeta || !v3dLimbs) return;
  const note = $('v3dlimbnote'), out = $('v3dlimbfitnote');
  note.style.color = '#898781';
  note.textContent = 'optimising…';
  // A fresh objective descends from the profile, not from the last objective's
  // answer — otherwise the two can't be compared, and the mirror objective's
  // result would silently depend on whether the wide one had been run first.
  let reverted = '';
  if (v3dRefitFromProfile && v3dLimbsSaved && v3dLimbsDiffer(v3dLimbs, v3dLimbsSaved)) {
    reverted = v3dLimbsSaved.name || 'default';
    v3dSetLimbs(v3dLimbsSaved, { saved: true });
  }
  v3dRefitFromProfile = false;
  try {
    const { sequence, start } = v3dBuildSequence();
    const idx = v3dCurrentFrame();
    const r = await fetch(BASE + '/api/depth/optimize_limbs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ width: vMeta.width, height: vMeta.height,
                             current_frame: idx, keypoints: v3dPoseAt(idx),
                             sequence, start_frame: start,
                             lift: document.body.dataset.page || null,
                             bone_ratios: v3dLimbs.ratios,
                             objective: v3dObjective || undefined,
                             perspective: !!($('v3dlimbpersp') || {}).checked,
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
    note.textContent = (reverted ? `back to ${reverted} first · ` : '')
      + `frame ${d.frame} · penalty ${d.start_total.toFixed(4)}`
      + ` → ${d.total.toFixed(4)} · `
      + (capped ? `stopped at the ${d.iterations}-step cap, not converged`
                : d.iterations === 0 ? 'already converged'
                : `converged in ${d.iterations} steps`);
    note.style.color = capped ? '#f0a020' : '#898781';
    // Every term, not just the ones being fitted. A term at weight 0 still moves
    // — it just moves as a side effect — and whether the narrow objective is
    // dragging the dropped facts along or wrecking them is the whole question.
    const rows = Object.keys(d.terms).map(k => {
      const a = d.start_terms[k], b = d.terms[k];
      const arrow = b > a + 1e-6 ? '▲' : (b < a - 1e-6 ? '▼' : '·');
      const on = (d.weights && d.weights[k]) > 0;
      const label = (d.labels && d.labels[k]) || k;
      const f = d.floors && d.floors[k];
      const floor = (f != null)
        ? ` <span style="color:#6f6d66">(floor ${f.toFixed(4)},`
          + ` fixed by the 2D pose)</span>` : '';
      const line = `${arrow} ${label}: ${a.toFixed(4)} → ${b.toFixed(4)}${floor}`;
      return on ? line : `<span style="color:#6f6d66">${line} — not fitted</span>`;
    });
    // The depth signs are re-chosen at every evaluation, so the run can end on a
    // different toward/away configuration than it began on. Say so: past that
    // point it is fitting lengths to a different reading of the pose.
    const flipped = JSON.stringify(d.start_signs) !== JSON.stringify(d.signs);
    // What the perspective correction actually did, when it was asked for. The
    // size matters more than the fact: a 2% change in projected length is noise
    // next to the length prior's own error, while 15% means the fit is being
    // steered by a focal length nobody measured.
    const p = d.perspective;
    const persp = !p ? ''
      : !p.on ? `<br><span style="color:#f0a020">perspective correction asked`
                + ` for but not applied — this frame carries no pixel size, so`
                + ` there is no focal length to guess from.</span>`
      : `<br><span style="color:#6f6d66">perspective: ${p.passes} correction`
        + `${p.passes === 1 ? '' : 's'} (every ${p.every} steps, damped`
        + ` ${p.damp}), up to ${(p.max_change * 100).toFixed(1)}% off the`
        + ` projected lengths at f = ${Math.round(p.f_px)} px — a guessed focal`
        + ` length, and the mesh is still drawn orthographically.</span>`;
    out.style.display = '';
    const obj = v3dObjectives.find(o => o.name === d.objective);
    out.innerHTML =
      `<b>penalty ${v3dLimbPenalty0.toFixed(4)} → ${d.total.toFixed(4)}</b>`
      + ` over ${v3dLimbSteps} steps, fitting ${obj ? obj.label : d.objective}`
      + ` (torso lengths, 0 = perfect)<br>`
      + (d.iterations === 0 ? 'last run moved nothing: ' : `last run, ${d.iterations} steps: `)
      + rows.join('<br>')
      + persp
      + (flipped ? `<br><span style="color:#f0a020">toward/away flipped`
                   + ` ${d.sign_flips} time${d.sign_flips === 1 ? '' : 's'} during`
                   + ` the run — it ended on a different depth configuration than`
                   + ` it started on. Check the sign table before reading the`
                   + ` lengths.</span>` : '')
      // What THIS objective is measured to get wrong, quoted from the backend so
      // the numbers live next to the weights they describe. The headline holds
      // for all of them: a lower penalty is not the same as correct limbs.
      + `<br><span style="color:#f0a020">A lower penalty is not the same as correct`
      + ` limbs — compare with a measured profile before trusting it.`
      + (obj && obj.caveat ? ' ' + obj.caveat : '') + `</span>`;
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
  const wantSeq = ['plate-anchor', 'keypoint-lift', 'auto'].includes(method);
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
    const r = await fetch(BASE + '/api/depth/generate', {
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
    window.CoachAnatomy?.loadDepth(c);
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

$('wireframe-inspection').addEventListener('toggle',()=>window.Viewer?.resize());
// The anatomy overlay (src/anatomy/integration.mjs) composites its own,
// independent three.js model into #v3dcanvasWrap rather than pixel-aligning
// to the video — this is the hook it uses to reveal that pane on demand. It
// works even if window.Viewer (the original reconstruction) never loaded,
// since the two are separate three.js instances sharing one piece of layout.
window.CoachV3D = {
  ensureVisible() {
    const panel = $('v3dpanel'), details = $('wireframe-inspection');
    if (panel) panel.style.display = '';
    if (details) details.open = true;
    window.Viewer?.resize();
  },
};
$('v3dgen').onclick = v3dGenerate;
// Switching method recomputes immediately against the loaded clip.
$('v3dmethod').onchange = () => { if (vMeta) v3dGenerate(); };

// Populate the method dropdown from the registry; unavailable anchors (e.g. a
// body model with no weights) are listed but disabled so the set of methods is
// visible even when one can't run here.
// Awaited by the example loader: a clip must not lift itself before the
// segment list, the joint list and the remembered profiles are in place.
const v3dReady = fetch(BASE + '/api/depth/methods').then(r => r.json()).then(async m => {
  if (m.error) { $('v3dnote').textContent = m.error; return; }
  // Same response carries the ambiguous-joint list; build the direction
  // controls from it so the markup never hardcodes a joint set.
  v3dSignJoints = m.sign_joints || [];
  v3dBuildSignControls();
  // Same again for the limb ratios: the segment set is a property of the lift,
  // so it arrives with the methods rather than costing a second round trip.
  v3dLimbSegments = m.limb_segments || [];
  v3dDefaultLimbs = m.default_limbs || {};
  v3dInitObjectives(m.objectives || [], m.default_objective || '');
  v3dInitPerspective();
  await v3dInitProfiles();
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
async function vLoadExamples() {
  let list;
  try { list = await (await fetch(BASE + '/api/examples')).json(); }
  catch (e) { return; }   /* no gallery is fine — upload/record still work */
  if (!Array.isArray(list)) return;
  const sel = $('vexample');
  // Rebuilt in place (a link from the training data explorer adds examples at
  // runtime); the current pick survives if it is still listed.
  const keep = sel.value;
  for (const g of [...sel.querySelectorAll('optgroup')]) g.remove();
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
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  $('vexampleWrap').style.display = list.length ? '' : 'none';
}
vLoadExamples();

// --- training data explorer -----------------------------------------------
// One row per clip clipper has cut (/api/train/clips). Double-click (or Enter)
// opens a clip in its lift's panel: a clip with a cached track loads like any
// example; one without is fetched, run through the pose pipeline at the panel's
// model size, and the result linked back as a local fixture (/api/train/link),
// so it is an example from then on. vTrainPath is the training clip the loaded
// video came from — set by trOpen, cleared by an upload, a recording or a pick
// from the example list — and is what makes vPoll link a finished run back.
let trClips = [], trLifts = [], trSelected = null, trSortDir = 1, trLoaded = false;
const TR_NONE = '__none__';   // filter value for "label is empty" (the empty string means "any")
const TR_SORT_KEYS = {
  session: c => [c.event, c.session_idx ?? 0, c.attempt ?? 0],
  event: c => [c.event, c.session_idx ?? 0, c.attempt ?? 0],
  attempt: c => [c.attempt ?? 0, c.event, c.session_idx ?? 0],
  time: c => [c.t ?? 0, c.event, c.session_idx ?? 0],
  result: c => [c.result, c.event, c.session_idx ?? 0, c.attempt ?? 0],
  exercise: c => [c.exercise, c.event, c.session_idx ?? 0, c.attempt ?? 0],
  precomputed: c => [c.precomputed ? 1 : 0, c.sizes.length, c.event, c.session_idx ?? 0, c.attempt ?? 0],
  category: c => [c.category, c.event, c.session_idx ?? 0, c.attempt ?? 0],
  gender: c => [c.gender, c.event, c.session_idx ?? 0, c.attempt ?? 0],
  duration: c => [c.duration ?? -1],
  size: c => [c.bytes],
  modified: c => [c.mtime],
  name: c => [c.name],
};
function trCmp(a, b) {
  for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; }
  return 0;
}
function trFmtT(t) {
  if (t == null) return '';
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function trFillSelect(sel, values, anyLabel) {
  const cur = sel.value;
  sel.replaceChildren();
  const any = document.createElement('option'); any.value = ''; any.textContent = anyLabel; sel.appendChild(any);
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v === '' ? TR_NONE : v;
    o.textContent = v === '' ? '(none)' : v;
    sel.appendChild(o);
  }
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}
function trMatch(filter, value) { return !filter || (filter === TR_NONE ? !value : value === filter); }

async function trLoad() {
  $('trCount').textContent = 'loading clip list…';
  let j;
  try {
    const r = await fetch(BASE + '/api/train/clips');
    j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
  } catch (e) { $('trCount').textContent = 'error: ' + e.message; return; }
  trLoaded = true;
  trClips = j.clips || [];
  trLifts = j.lifts || [];
  $('trDirNote').textContent = j.dir || '';
  const uniq = key => [...new Set(trClips.map(c => c[key] || ''))].sort();
  trFillSelect($('trEvent'), uniq('event'), 'event: any');
  trFillSelect($('trExercise'), [...new Set([...trLifts, ...uniq('exercise')])], 'exercise: any');
  trFillSelect($('trCategory'), uniq('category'), 'category: any');
  $('trCatList').replaceChildren(...uniq('category').filter(Boolean).map(v => { const o = document.createElement('option'); o.value = v; return o; }));
  const lab = $('trLabelExercise');
  lab.replaceChildren(...['', ...trLifts].map(v => { const o = document.createElement('option'); o.value = v; o.textContent = v || '(auto)'; return o; }));
  $('trStatus').textContent = j.error || '';
  trRender();
  if (trSelected) trSelect(trSelected.path);
}

function trFiltered() {
  const q = $('trSearch').value.trim().toLowerCase();
  const pre = $('trPre').value, ex = $('trExercise').value, cat = $('trCategory').value,
        g = $('trGender').value, ev = $('trEvent').value, res = $('trResult').value;
  const sortKey = TR_SORT_KEYS[$('trSort').value] || TR_SORT_KEYS.session;
  const rows = trClips.filter(c =>
    (!pre || (pre === '1') === c.precomputed) &&
    trMatch(ex, c.exercise) && trMatch(cat, c.category) && trMatch(ev, c.event) &&
    (!g || (c.gender || 'unknown') === g) &&
    (!res || c.result === res) &&
    (!q || `${c.path} ${c.exercise} ${c.category} ${c.gender} ${c.result}`.toLowerCase().includes(q)));
  rows.sort((a, b) => trSortDir * trCmp(sortKey(a), sortKey(b)));
  return rows;
}

function trRender() {
  const rows = trFiltered();
  const nPre = rows.filter(c => c.precomputed).length;
  $('trCount').textContent = trClips.length
    ? `${rows.length} of ${trClips.length} clips · ${nPre} with a cached track`
    : 'no clips found';
  for (const th of $('trTable').tHead.rows[0].cells) th.classList.toggle('sorted', th.dataset.sort === $('trSort').value);
  const frag = document.createDocumentFragment();
  for (const c of rows) {
    const tr = document.createElement('tr');
    tr.dataset.path = c.path; tr.tabIndex = 0; tr.title = c.path;
    if (trSelected && trSelected.path === c.path) tr.classList.add('selected');
    const cells = [
      c.event.replace(/-/g, ' '), c.session_idx ?? '', c.attempt ?? '', trFmtT(c.t), c.result,
      c.exercise, c.precomputed ? '✓ ' + c.sizes.join(' ') : '—', c.category, c.gender,
      c.duration != null ? c.duration.toFixed(1) + 's' : '', (c.bytes / 1048576).toFixed(1),
    ];
    for (const v of cells) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); }
    tr.cells[6].className = c.precomputed ? 'tr-yes' : 'tr-no';
    frag.appendChild(tr);
  }
  $('trTable').tBodies[0].replaceChildren(frag);
}

function trSelect(path) {
  trSelected = trClips.find(c => c.path === path) || null;
  for (const tr of $('trTable').tBodies[0].rows) tr.classList.toggle('selected', !!trSelected && tr.dataset.path === path);
  const c = trSelected;
  $('trDetail').hidden = !c;
  if (!c) return;
  $('trName').textContent = c.name;
  $('trMeta').textContent = [c.event, c.session, `attempt ${c.attempt ?? '?'} at ${trFmtT(c.t)}`, c.result,
      c.duration != null ? c.duration.toFixed(1) + ' s' : null, (c.bytes / 1048576).toFixed(1) + ' MB'].filter(Boolean).join(' · ');
  $('trTrack').textContent = c.precomputed
    ? `cached track: ${c.sizes.join(', ')} — example ${c.example_id}`
    : 'no cached track — opening runs ViTPose and links the result to this clip';
  $('trLabelExercise').value = c.exercise_source === 'label' ? c.exercise : '';
  $('trLabelExerciseNote').textContent = c.exercise_source === 'track' ? `classified from the track: ${c.exercise}`
    : c.exercise_source === 'default' ? `NOT classified — defaulted to ${c.exercise}, set it by hand`
    : c.exercise_source === 'label' ? '' : 'unknown — set it, or let the run classify it';
  $('trLabelCategory').value = c.category;
  $('trLabelGender').value = c.gender;
  $('trOpen').textContent = c.precomputed ? `open in ${c.exercise} panel` : `run ${$('vsize').value} & open`;
}

async function trSaveLabel(patch) {
  const c = trSelected;
  if (!c) return;
  try {
    const r = await fetch(`${BASE}/api/train/labels/${encodeURI(c.path)}`,
      {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(patch)});
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    c.category = j.category; c.gender = j.gender;
    c.exercise = j.exercise || c.track_exercise || 'unknown';
    c.exercise_source = j.exercise ? 'label' : (c.track_exercise ? 'track' : null);
    $('trStatus').textContent = 'saved';
    const uniq = key => [...new Set(trClips.map(x => x[key] || ''))].sort();
    trFillSelect($('trCategory'), uniq('category'), 'category: any');
    trFillSelect($('trExercise'), [...new Set([...trLifts, ...uniq('exercise')])], 'exercise: any');
    trRender();
    trSelect(c.path);
  } catch (e) { $('trStatus').textContent = 'label not saved: ' + e.message; }
}

// Open a clip in its lift's panel. Cached track: load it as the example it
// already is. No track: load the clip as the video source and start a run,
// which vPoll links back to the clip when it finishes.
async function trOpen(clip) {
  const current = document.body.dataset.page;
  const lift = (PAGES_BY_ID[clip.exercise] || {}).media === 'video' ? clip.exercise
             : (PAGES_BY_ID[current] || {}).media === 'video' ? current : '{{DEFAULT_PAGE}}';
  if (clip.precomputed && clip.example_id) {
    const sel = $('vexample');
    if (![...sel.options].some(o => o.value === clip.example_id)) await vLoadExamples();
    if ([...sel.options].some(o => o.value === clip.example_id)) {
      setPage(lift);
      sel.value = clip.example_id;
      await sel.onchange();
      vTrainPath = clip.path;   // after onchange, which clears it
      return;
    }
  }
  if ($('vrun').disabled) { $('trStatus').textContent = 'a run is already in progress — wait or cancel it first'; return; }
  $('trStatus').textContent = 'fetching clip…';
  let blob;
  try {
    const r = await fetch(`${BASE}/api/train/clip/${encodeURI(clip.path)}`);
    if (!r.ok) throw new Error('clip not available');
    blob = await r.blob();
  } catch (e) { $('trStatus').textContent = 'error: ' + e.message; return; }
  $('trStatus').textContent = '';
  setPage(lift);
  stopCameraStream();
  $('vfile').value = '';
  $('vexample').value = '';
  vClearExample();
  vKeypointsRaw = null; vKeypoints = null; vMeta = null; vSample = null; vClock = null;
  vEquipment = null; v3dReset();
  updatePlotControls();
  Diagnostics.setTrack(null, null);
  $('vsummary').textContent = '';
  $('vsync').textContent = '';
  vSource = { blob, filename: clip.name };
  setVideoSrc(blob);
  vTrainPath = clip.path;
  $('vstatus').textContent = `no cached track — running ${$('vsize').value} now; the result will be linked to the clip`;
  vStartRun();
}

// The tail of a run started on a training clip: file the track as a local
// fixture and turn the loaded video into that example, so a size switch from
// here behaves exactly as it does for any other example.
async function trLink(data) {
  const path = vTrainPath, run = vRunParams || {};
  $('vstatus').textContent += ' — linking the track to its training clip…';
  try {
    const r = await fetch(BASE + '/api/train/link', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path, size: run.size, frame_stride: run.stride,
                            fallback_exercise: document.body.dataset.page, track: data}),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    vExampleId = j.example_id; vExampleSizes = j.sizes;
    vSetSizeAvailability(j.sizes, j.size);
    $('vstatus').textContent = `done — linked as example ${j.example_id}` + (j.golden === 'ok' ? '' : ` (golden ${j.golden})`);
    if (PAGES_BY_ID[j.exercise] && j.exercise !== document.body.dataset.page) setPage(j.exercise);
    await vLoadExamples();
    $('vexample').value = j.example_id;   // the picker shows what is loaded, as for any example
    if (trLoaded) trLoad();
  } catch (e) { $('vstatus').textContent = 'done, but linking the track failed: ' + e.message; }
}

for (const id of ['trPre', 'trExercise', 'trCategory', 'trGender', 'trEvent', 'trResult', 'trSort']) $(id).onchange = trRender;
$('trSearch').oninput = trRender;
$('trDir').onclick = () => { trSortDir = -trSortDir; $('trDir').innerHTML = trSortDir > 0 ? 'asc &uarr;' : 'desc &darr;'; trRender(); };
for (const th of $('trTable').tHead.rows[0].cells) {
  th.onclick = () => {
    if ($('trSort').value === th.dataset.sort) trSortDir = -trSortDir; else { $('trSort').value = th.dataset.sort; trSortDir = 1; }
    $('trDir').innerHTML = trSortDir > 0 ? 'asc &uarr;' : 'desc &darr;';
    trRender();
  };
}
$('trTable').tBodies[0].onclick = e => { const tr = e.target.closest('tr'); if (tr) trSelect(tr.dataset.path); };
$('trTable').tBodies[0].ondblclick = e => { const tr = e.target.closest('tr'); if (tr) { trSelect(tr.dataset.path); trOpen(trSelected); } };
$('trTable').tBodies[0].onkeydown = e => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  if (e.key === 'Enter') { trSelect(tr.dataset.path); if (trSelected) trOpen(trSelected); e.preventDefault(); }
  else if (e.key === 'ArrowDown' && tr.nextElementSibling) { tr.nextElementSibling.focus(); trSelect(tr.nextElementSibling.dataset.path); e.preventDefault(); }
  else if (e.key === 'ArrowUp' && tr.previousElementSibling) { tr.previousElementSibling.focus(); trSelect(tr.previousElementSibling.dataset.path); e.preventDefault(); }
};
$('trReload').onclick = trLoad;
$('trOpen').onclick = () => trSelected && trOpen(trSelected);
$('trLabelExercise').onchange = () => trSaveLabel({exercise: $('trLabelExercise').value});
$('trLabelGender').onchange = () => trSaveLabel({gender: $('trLabelGender').value});
$('trLabelCategory').onchange = () => trSaveLabel({category: $('trLabelCategory').value});

for (const btn of document.querySelectorAll('.tab')) {
  btn.onclick = () => setPage(btn.dataset.page);
}
window.CoachBridge = {applyTrack, setPage, seek(time){vvideo.pause();vvideo.currentTime=time;drawOverlay(time);}, getTrack:()=>vTrackFull};
setPage('{{DEFAULT_PAGE}}');
window.addEventListener('coach:displaychange',()=>{vClock=null;if(!vvideo.paused&&!vvideo.ended)startOverlayLoop();else drawOverlay();});
if (window.COACH_LOCAL_PREVIEW) import('./pose/local-mode.mjs').then(m => m.setup({applyTrack, video:vvideo}));
window.addEventListener('coach:anatomy-ready', () => {
  if (vTrackFull) {
    window.CoachAnatomy?.loadTrack(vTrackFull);
    window.CoachAnatomy?.updateTrack({keypoints:vKeypoints,meta:vMeta});
  }
  if (v3dLast?.candidate) window.CoachAnatomy?.loadDepth(v3dLast.candidate);
  drawOverlay(vvideo.currentTime);
});   // a lift page by default; the image path is the side trip
</script>

<!-- The 3D viewer is the one place coach reaches for a third-party lib: a
     skeleton in perspective with a turntable is exactly what three.js is for,
     and reimplementing a projector by hand would be worse. Loaded as a module
     from a CDN (the box is on the tailnet with internet); if the import fails
     the panel just says so and the text note above still reports the result. -->
<script type="importmap">
{ "imports": { "three": "./vendor/three.module.js" } }
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
  // The largest joint-to-joint distance seen anywhere in the clip (e.g. an
  // extended arm to the opposite foot) — fixed once per load, same idea as
  // AnatomyViewer.spread in src/anatomy/viewer.mjs, and for the same reason:
  // framing off a fixed anatomical span rather than raw reconstructed units
  // keeps the figure the same apparent size regardless of the clip's own
  // scale. `zoom` is the user's wheel/trackpad multiplier on top of that.
  // `farthest` is a safety floor (see applyCamera): this viewer's origin is
  // wherever the backend's picked anchor put it, not necessarily the point
  // cloud's centroid, so `spread` alone can't guarantee nothing clips out of
  // the frustum the way it can for AnatomyViewer, which re-centers on its
  // own bounding box.
  let spread = 0.8, farthest = 0.4, zoom = 1;
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

  // Scans every frame of a sequence candidate (or just the one set of joints
  // for a single-frame candidate) so the fit doesn't change as the figure
  // moves through the clip — only applyCamera()'s `zoom` moves the camera
  // after this.
  function fit(c) {
    const frameSets = c.frames ? Object.values(c.frames) : [c.joints3d];
    let s = 0, r = 0;
    for (const j3d of frameSets) {
      if (!j3d) continue;
      const pts = j3d.filter(Boolean).map(toVec);
      for (let i = 0; i < pts.length; i++) {
        r = Math.max(r, pts[i].length());
        for (let k = i + 1; k < pts.length; k++) {
          const d = pts[i].distanceTo(pts[k]);
          if (d > s) s = d;
        }
      }
    }
    spread = s || 0.8;
    farthest = r || 0.4;
    zoom = 1;
    applyCamera();
  }
  // Fit `spread` to 3/4 of the panel's height — same formula as AnatomyViewer's
  // orbit camera in src/anatomy/viewer.mjs, so both 3D panes feel consistent —
  // then apply the wheel/trackpad zoom multiplier on top. Also never let the
  // single farthest joint from the origin (camera.lookAt's fixed target) clip
  // out of the frustum: for well-centred reconstructions this never binds,
  // since `spread`'s 3/4-height fit already sits farther back than that, but
  // it keeps an off-centre point cloud safely in frame instead of overflowing.
  function applyCamera() {
    const halfFov = camera.fov * Math.PI / 360;
    camDist = Math.max(spread / (1.5 * Math.tan(halfFov)), farthest / Math.tan(halfFov)) * zoom;
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

  // Multiplicative, not additive: a mouse wheel notch (deltaY ~100) and a
  // trackpad's stream of small scroll/pinch events (deltaY ~1-10 each) both
  // end up feeling like the same "amount" of zoom per gesture this way — see
  // the matching comment on AnatomyViewer's wheel handler in viewer.mjs.
  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    zoom = Math.max(.35, Math.min(3, zoom * Math.pow(1.0015, e.deltaY)));
    applyCamera(); render();
  }, { passive: false });

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
      fit(c);
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
<script type="module" src="./anatomy/integration.mjs"></script>
<script type="module" src="./anatomy/review.mjs"></script>
<script type="module" src="./anatomy/ui.mjs"></script>
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
    {"id": "squat", "label": "squat", "media": "video", "diagnostics": "squat"},
    {"id": "image", "label": "image", "media": "image"},
    {"id": "snatch", "label": "snatch", "media": "video", "diagnostics": "snatch"},
    {"id": "lateral-raise", "label": "lateral raise", "media": "video",
     "diagnostics": "lateral-raise"},
    {"id": "clean-and-jerk", "label": "clean & jerk", "media": "video",
     "diagnostics": "clean-and-jerk"},
    # The dev pane: a file explorer over clipper's output (media "train" has
    # its own view and panel, #trainView / #trainPanel, not the video machine).
    {"id": "train-data", "label": "train data", "media": "train"},
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
      <details class="control-group" open>
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
      <!-- Start and end of the lift, on both time sliders (diagnostics.js:
           liftWindow). On for every lift, because the window is read off the
           track rather than off the page's cue set — but a lift that doesn't
           start with a bar on the floor or finish locked out has no such
           markers, and this is how you turn an answer that doesn't apply off.
           The note under the video says which trigger produced each one. -->
      <label style="white-space:nowrap" title="Mark the start of the lift (the first pull leaving the floor) and its end (elbows past 150° and knees past 170°, with the body neither moving quickly nor still travelling one way, held for half a second) on the video and 3D time sliders.">
        <input id="vliftmarks" type="checkbox" checked style="vertical-align:middle;margin:0 4px 0 0"> lift start/end markers
      </label>
      </details>
    </div>"""


def _tabs_html():
    """One <button> per page, in registry order, for the tablist."""
    rows = []
    for p in PAGES:
        controls = {"image": "imageView", "train": "trainView"}.get(p["media"], "videoView")
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
    lines.append(f"  device: {vitpose_backend.DEVICE}")
    return lines


if __name__ == "__main__":
    print("coach: checkpoints under", vitpose_backend.MODEL_DIR)
    for line in preflight():
        print(line)

    # Loopback only — Caddy is the sole LAN/tailnet facing piece and terminates
    # HTTPS. Override with COACH_HOST=0.0.0.0 if you ever need to hit this
    # directly.
    HOST = os.environ.get("COACH_HOST", "127.0.0.1")
    # Must match the reverse_proxy upstream in whichever Caddy config fronts
    # this app; override with COACH_PORT when 8080 is already taken.
    PORT = int(os.environ.get("COACH_PORT", "8080"))
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
