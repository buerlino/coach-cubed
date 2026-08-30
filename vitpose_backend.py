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
import threading
from pathlib import Path

import numpy as np
from PIL import Image

from easy_ViTPose import VitInference

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

_models = {}          # size -> VitInference, populated lazily
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
