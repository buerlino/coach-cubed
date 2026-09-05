"""In-process ViTPose backend: image in -> keypoints + annotated image out.

Why in-process rather than a separate server (unlike tecna's comfy_backend.py /
llm_backend.py, which both talk to an out-of-process service over HTTP). Those
exist because ComfyUI and llama.cpp own real scheduling problems this app
doesn't want to reimplement: a multi-node execution graph with its own queue,
and per-slot KV-cache lifecycle. ViTPose has neither — a single forward pass
through YOLOv8 (detect) + ViTPose (keypoints) takes well under a second and
there's no state to hold between calls beyond the weights themselves. Running
it as a subprocess would only add an HTTP hop and a second thing to keep alive
for no benefit, so the model is just loaded once here and called directly.

Models load lazily (first request for a given size pays the load cost, same
"selecting it is what brings it up" contract as tecna's chat model) and then
stay resident — VRAM cost per size is roughly the checkpoint size (l: ~1.2GB,
h: ~2.5GB), cheap enough on this box's W7800 to keep both warm at once.

torch.cuda.* is the right namespace even though the actual backend is ROCm —
PyTorch's ROCm build maps 'cuda' devices onto HIP, no separate API.
"""
import io
import os
import tempfile
import threading
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from easy_ViTPose import VitInference
from easy_ViTPose.vit_utils.visualization import joints_dict

# Where the just-downloaded checkpoints live — see the huggingface pull that
# grabbed torch/coco/vitpose-{l,h}-coco.pth and yolov8/yolov8s.pt (not the
# onnx/tensorrt copies on the HF repo: those are just export.py output from
# these same torch weights, not independent artifacts, and the tensorrt
# .engine files there are compiled for someone else's GPU/driver anyway).
MODEL_DIR = Path(os.environ.get("COACH_MODEL_DIR",
                                 str(Path.home() / "models/easy_vitpose")))
YOLO_PATH = Path(os.environ.get("COACH_YOLO_PATH",
                                 str(MODEL_DIR / "yolov8/yolov8s.pt")))
DATASET = "coco"  # only dataset variant we pulled; wholebody/animal etc. would
                   # need their own torch/<dataset>/vitpose-<size>-<dataset>.pth
SIZES = ("l", "h")
DEFAULT_SIZE = os.environ.get("COACH_DEFAULT_SIZE", "l")

DEVICE = "cuda" if __import__("torch").cuda.is_available() else "cpu"

VIDEO_EXTENSIONS = ("mp4", "mov", "avi", "webm", "mkv")

_models = {}          # size -> VitInference, populated lazily
# Separate cache from _models: is_video flips on VitInference's SORT tracker
# at construction time and can't be toggled after, so a video-mode instance
# can't be reused for single-image requests (and vice versa).
_video_models = {}    # size -> VitInference (is_video=True), populated lazily
_load_lock = threading.Lock()
# ViTInference/YOLO aren't documented thread-safe and there's one GPU behind
# them; serialize inference the same way tecna's gpu_lock serializes Comfy jobs.
_infer_lock = threading.Lock()


def _ckpt_path(size):
    return MODEL_DIR / f"torch/{DATASET}/vitpose-{size}-{DATASET}.pth"


def available():
    """Report which sizes have a checkpoint on disk, for the app's preflight."""
    return {size: _ckpt_path(size).exists() for size in SIZES}


def get_model(size=None):
    size = size or DEFAULT_SIZE
    if size not in SIZES:
        raise ValueError(f"unknown size {size!r}, expected one of {SIZES}")
    if size in _models:
        return _models[size]
    with _load_lock:
        if size not in _models:            # re-check: lost the race while blocked
            ckpt = _ckpt_path(size)
            if not ckpt.exists():
                raise FileNotFoundError(
                    f"missing checkpoint {ckpt} — see the download step in "
                    f"~/models/easy_vitpose")
            _models[size] = VitInference(
                model=str(ckpt),
                yolo=str(YOLO_PATH),
                model_name=size,
                dataset=DATASET,
                yolo_size=320,
                device=DEVICE,
                is_video=False,
            )
    return _models[size]


def get_video_model(size=None):
    """Same lazy-load/cache dance as get_model(), but for a video-mode
    instance (is_video=True turns on the SORT tracker so person ids stay
    consistent across frames instead of being reassigned every call)."""
    size = size or DEFAULT_SIZE
    if size not in SIZES:
        raise ValueError(f"unknown size {size!r}, expected one of {SIZES}")
    if size in _video_models:
        return _video_models[size]
    with _load_lock:
        if size not in _video_models:      # re-check: lost the race while blocked
            ckpt = _ckpt_path(size)
            if not ckpt.exists():
                raise FileNotFoundError(
                    f"missing checkpoint {ckpt} — see the download step in "
                    f"~/models/easy_vitpose")
            _video_models[size] = VitInference(
                model=str(ckpt),
                yolo=str(YOLO_PATH),
                model_name=size,
                dataset=DATASET,
                yolo_size=320,
                device=DEVICE,
                is_video=True,
                single_pose=False,   # keep the tracker on; coach doesn't know
                                      # ahead of time whether a video has one
                                      # person or several
                yolo_step=1,          # run YOLO every frame — the "subset of
                                      # frames" knob the app exposes is
                                      # frame_stride below, not this one
            )
    return _video_models[size]


def infer(image_bytes, size=None):
    """Run detection + pose on one image.

    Returns (keypoints, annotated_jpeg_bytes) where keypoints maps a
    per-image person id -> Nx3 array of (y, x, confidence) — that's
    VitInference's native layout, left as-is rather than remapped here so the
    API mirrors the upstream library exactly.
    """
    model = get_model(size)
    img = np.array(Image.open(io.BytesIO(image_bytes)).convert("RGB"))

    with _infer_lock:
        keypoints = model.inference(img)
        # draw() juggles BGR/RGB internally (cv2 drawing calls need BGR) but
        # its final line flips back — despite the misleading param name, what
        # comes out is RGB already ("Return RGB as original" in its source).
        annotated = model.draw(show_yolo=True)

    out = Image.fromarray(annotated)
    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=90)

    keypoints_json = {
        str(pid): kp.tolist() for pid, kp in keypoints.items()
    }
    return keypoints_json, buf.getvalue()


def _keep_main_person(keypoints_by_frame):
    """Drop every tracked person except the one detected in the most frames.

    A gym has other people in it. YOLO finds the spotter, the lifter waiting
    behind the platform, someone walking past — and it also invents bodies out
    of racked plates and equipment silhouettes. All of them arrive as extra
    person ids alongside the lifter, and every one of them is noise for a
    diagnostic: they crowd the overlay, they show up in the keypoint plot's
    person picker, and a background body that happens to outlive a dropped
    detection can be picked up as the subject.

    Longevity is the discriminator that works here. The lifter is in frame for
    the whole clip because the clip exists to show the lift; a passer-by is in
    it for a second, and a hallucinated body flickers. Ties break on total
    keypoint confidence — between two tracks of equal length, the one the model
    was more sure about.

    The failure this can't see: SORT sometimes splits one person across two
    ids (an occlusion, a fast turnover). The lifter is then two shorter tracks
    and only the longer half survives. The dropped-track report in meta is how
    that stays visible — two long tracks in one clip is the signature.

    Mutates nothing; returns (filtered, report).
    """
    counts, conf = {}, {}
    for frame in keypoints_by_frame.values():
        for pid, kp in frame.items():
            counts[pid] = counts.get(pid, 0) + 1
            conf[pid] = conf.get(pid, 0.0) + sum(float(p[2]) for p in kp)

    if not counts:
        return keypoints_by_frame, {"kept": None, "kept_frames": 0, "dropped": []}

    kept = max(counts, key=lambda pid: (counts[pid], conf[pid]))
    # Keep every processed frame as a key even when the subject is missing from
    # it: frames_processed is len() of this, and the frontend reads a missing
    # person in a present frame as a dropped detection to interpolate across.
    filtered = {
        idx: ({kept: frame[kept]} if kept in frame else {})
        for idx, frame in keypoints_by_frame.items()
    }
    report = {
        "kept": kept,
        "kept_frames": counts[kept],
        "dropped": sorted(
            ({"id": pid, "frames": n} for pid, n in counts.items() if pid != kept),
            key=lambda d: -d["frames"],
        ),
    }
    return filtered, report


def infer_video(video_bytes, size=None, frame_stride=1, suffix=".mp4"):
    """Run tracked pose estimation over a video's frames.

    Deliberately doesn't re-encode and return an annotated video: the coach
    box's opencv/ffmpeg build has no licensed H.264 encoder (only mp4v/MPEG-4
    Part 2, which Chrome/Firefox won't play back in <video>), so instead of
    fighting codecs coach hands the frontend the original file (which the
    browser already has and can play natively) plus a keypoints-per-frame
    track. The frontend draws the skeleton on a <canvas> synced to video
    playback — same verification goal, no server-side video encoding at all.

    frame_stride lets a caller process every Nth frame instead of all of
    them; defaults to 1 (every frame) per the "set up all for now" starting
    point — trading it off against framerate/runtime is a frontend decision
    for later.

    Only one person survives: everything the tracker found other than the
    longest-lived body is discarded before returning (see _keep_main_person).
    What was thrown away is reported in meta["tracks"] rather than silently.

    Returns (keypoints_by_frame, meta):
      keypoints_by_frame: {frame_index (str): {person_id (str): Nx3 keypoints}},
        present only for frames that were actually run through the model, and
        holding at most the one kept person.
      meta: fps/width/height of the source video and its actual frame_count
        (counted while reading, not trusted from container metadata — see
        below), the skeleton edge list for the dataset in use (pairs of
        keypoint indices, 0-indexed to match the keypoints arrays),
        frame_stride, frames_processed, and tracks (kept id + dropped ones).
    """
    if frame_stride < 1:
        raise ValueError("frame_stride must be >= 1")

    model = get_video_model(size)

    with tempfile.TemporaryDirectory() as tmpdir:
        in_path = Path(tmpdir) / f"in{suffix}"
        in_path.write_bytes(video_bytes)

        cap = cv2.VideoCapture(str(in_path))
        if not cap.isOpened():
            cap.release()
            raise ValueError("could not open the uploaded file as a video")

        fps = cap.get(cv2.CAP_PROP_FPS)
        if not fps or fps != fps or fps <= 0:   # 0, None or NaN from the container
            fps = 30.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        # NOT cv2.CAP_PROP_FRAME_COUNT: that's container metadata, and it's
        # garbage (seen: a huge negative number) for streamed/index-less
        # webm like MediaRecorder output — there's no seek index to read a
        # count from. Count frames by actually reading them below instead.

        keypoints_by_frame = {}
        frame_indices = []      # indices of the frames actually run, in order
        frame_times_ms = []     # each of those frames' own presentation time
        with _infer_lock:
            model.reset()   # fresh tracker + frame counter — model instances
                             # are cached and reused across requests
            idx = 0
            while True:
                ok, frame_bgr = cap.read()
                if not ok:
                    break
                if idx % frame_stride == 0:
                    # Queried *after* read(): that's the pts of the frame just
                    # decoded (before read() it's still the previous frame's,
                    # and it reads 0 twice at the start).
                    frame_times_ms.append(cap.get(cv2.CAP_PROP_POS_MSEC))
                    frame_indices.append(idx)
                    frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
                    keypoints = model.inference(frame_rgb)
                    keypoints_by_frame[str(idx)] = {
                        str(pid): kp.tolist() for pid, kp in keypoints.items()
                    }
                idx += 1
        cap.release()
        frame_count = idx   # actual count, not the (possibly bogus) metadata one

    # Filter here, not in the frontend: the overlay, the keypoint plot and the
    # diagnostics each pick a person independently, so leaving the extras in
    # the payload lets them disagree about who the lifter is.
    keypoints_by_frame, tracks = _keep_main_person(keypoints_by_frame)

    # Timestamps are what the frontend lines the overlay up with, so only hand
    # them over if the decoder actually produced a usable (strictly increasing,
    # non-degenerate) track — some containers report 0.0 for every frame, and
    # silently syncing against that would pin the overlay to one pose. The
    # frontend falls back to index = time * fps when this is null.
    usable_times = (
        len(frame_times_ms) > 1
        and all(b > a for a, b in zip(frame_times_ms, frame_times_ms[1:]))
        and frame_times_ms[-1] > 0
    )

    meta = {
        "fps": fps,
        "width": width,
        "height": height,
        "frame_count": frame_count,
        "frames_processed": len(keypoints_by_frame),
        "frame_stride": frame_stride,
        "frame_indices": frame_indices,
        "frame_times_ms": frame_times_ms if usable_times else None,
        "skeleton": joints_dict()[DATASET]["skeleton"],
        "tracks": tracks,
    }
    return keypoints_by_frame, meta
