"""SAM3-backed equipment detection — the same contract as equipment_backend,
behind the COACH_SAM3 flag, so the DINO default is untouched.

Where Grounding DINO is a DETECTOR (boxes only) and CLIPSeg a semantic
SEGMENTER (one diffuse heatmap, no instances), facebook/sam3 is an open-
vocabulary INSTANCE segmenter: a text concept in, and every matching instance
comes back as its own (box, per-pixel mask, score) triple. That mask is exactly
the thing the frontend's drawEquipment renders from `polygon` and the box was
only ever approximating -- so here we DO ship the mask, traced as a polygon.

Object recognition, measured on parked/report/examples/athlete-a-trim.mp4 (frames 50/70):
  * "barbell"     -> one 0.96 instance masking the whole LOADED implement (both
                    stacks + the shaft) and correctly ignoring the floor rack in
                    the background -- the semantic win DINO's plate prompt missed.
  * "weight plate"-> every plate INDIVIDUALLY (loaded stacks + the floor rack),
                    each its own mask. Because each mask is a single disc, its
                    box short side is a real single-plate diameter, not the
                    whole-stack overcount DINO's box gave (458px vs ~157px) -- so
                    diameter_px here is the honest scale reference CLIPSeg failed
                    to produce.
So the barbell instance gives the search REGION for free, and plates are kept
only where they fall inside it -- which is what drops the floor rack without any
pose corridor.

Cost, for the record: ~3.4GB checkpoint (vs DINO ~700MB) and ~2.2s/frame per
prompt on MPS (two prompts -> ~4.4s), heavier than DINO's ~1s. This backend is
the "let's look at the masks" path, not (yet) the default.
"""
import os
import threading

import cv2
import numpy as np
from PIL import Image

import torch

# Reuse the DEVICE pick and, crucially, the ONE shared GPU lock so SAM3's
# forwards can't encode Metal concurrently with ViTPose's (the MPS crash the
# lock exists to prevent). Same lock object, not a second one.
from equipment_backend import DEVICE, gpu_submit, PLATE_DIAMETER_MM

MODEL_ID = os.environ.get("COACH_SAM3_MODEL", "facebook/sam3")

# Noun-phrase concepts, one per object. SAM3 wants concepts, not actions/
# relations ("hand gripping the bar" returned nothing on the fixture); a plain
# "barbell" cleanly isolates the loaded implement, "weight plate" gives the
# discs. Env-overridable like the DINO prompts.
BAR_PROMPT = os.environ.get("COACH_SAM3_BAR_PROMPT", "barbell")
PLATE_PROMPT = os.environ.get("COACH_SAM3_PLATE_PROMPT", "weight plate")

# Instance score gate and the mask binarisation threshold, both env-tunable.
SCORE_THRESHOLD = float(os.environ.get("COACH_SAM3_SCORE_THRESHOLD", "0.4"))
MASK_THRESHOLD = float(os.environ.get("COACH_SAM3_MASK_THRESHOLD", "0.5"))
# Cap how many plate instances we draw so a crowded frame doesn't turn into
# confetti; the top ones by score, after region filtering.
MAX_PLATES = int(os.environ.get("COACH_SAM3_MAX_PLATES", "8"))

_model = None
_processor = None
_load_lock = threading.Lock()
_infer_lock = threading.Lock()


def model_source():
    """The hub id — SAM3 lives in the HuggingFace cache, not ~/models."""
    return MODEL_ID


def available():
    """Whether the SAM3 snapshot is already cached, without loading it.

    Checks for the one file from_pretrained opens (config.json) rather than a
    whole-repo snapshot_download: we fetch model.safetensors and skip the
    redundant sam3.pt, so a strict snapshot check would call a working install
    incomplete.
    """
    try:
        from huggingface_hub import try_to_load_from_cache
        return isinstance(try_to_load_from_cache(MODEL_ID, "config.json"), str)
    except Exception:
        return False


def get_model():
    """Lazy-load SAM3 + processor, resident after the first request."""
    global _model, _processor
    if _model is not None:
        return _model, _processor
    with _load_lock:
        if _model is None:
            from transformers import Sam3Model, Sam3Processor
            proc = Sam3Processor.from_pretrained(MODEL_ID)
            model = Sam3Model.from_pretrained(MODEL_ID)
            # The weight copy is itself a Metal submission on the worker thread
            # while ViTPose runs frame 0 — take the shared lock, same as DINO.
            with gpu_submit():
                model.to(DEVICE).eval()
            _processor, _model = proc, model
    return _model, _processor


def _polygon(mask, max_pts=80):
    """Largest contour of a binary mask -> a light [[x,y],...] polygon.

    approxPolyDP keeps the run JSON small (a full contour is thousands of
    points); the frontend only needs enough to read as the disc/bar outline.
    """
    m = mask.astype(np.uint8)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    c = max(cnts, key=cv2.contourArea)
    if cv2.contourArea(c) < 4:
        return None
    eps = 0.01 * cv2.arcLength(c, True)
    ap = cv2.approxPolyDP(c, eps, True)
    pts = [[int(p[0][0]), int(p[0][1])] for p in ap]
    return pts if len(pts) >= 3 else None


def _run(pil, prompt, h, w):
    """One SAM3 concept pass -> list of {box, score, mask(bool HxW)}.

    CPU-side tokenize/post-process stays outside gpu_submit(); only the .to and
    the forward — the Metal submissions — are inside it.
    """
    model, proc = get_model()
    inputs = proc(images=pil, text=prompt, return_tensors="pt")
    with _infer_lock, gpu_submit():
        inputs = inputs.to(DEVICE)
        with torch.no_grad():
            out = model(**inputs)
    res = proc.post_process_instance_segmentation(
        out, threshold=SCORE_THRESHOLD, mask_threshold=MASK_THRESHOLD,
        target_sizes=[(h, w)])[0]
    scores = res["scores"].cpu().numpy() if len(res["scores"]) else np.array([])
    boxes = res["boxes"].cpu().numpy() if len(res.get("boxes", [])) else np.zeros((0, 4))
    masks = res["masks"].cpu().numpy() if len(res.get("masks", [])) else np.zeros((0, h, w))
    dets = []
    for i in range(len(scores)):
        x0, y0, x1, y1 = (float(v) for v in boxes[i])
        x0 = max(0, min(w, int(round(x0)))); x1 = max(0, min(w, int(round(x1))))
        y0 = max(0, min(h, int(round(y0)))); y1 = max(0, min(h, int(round(y1))))
        if x1 - x0 < 1 or y1 - y0 < 1:
            continue
        m = masks[i]
        m = (m > 0.5) if m.dtype != bool else m
        dets.append({"box": [x0, y0, x1, y1],
                     "score": round(float(scores[i]), 4),
                     "mask": m})
    return dets


def _center_in(box, region, pad=0.15):
    """Is box's centre inside region (padded by a fraction of region size)?"""
    cx = (box[0] + box[2]) / 2.0
    cy = (box[1] + box[3]) / 2.0
    rx0, ry0, rx1, ry1 = region
    px = (rx1 - rx0) * pad
    py = (ry1 - ry0) * pad
    return rx0 - px <= cx <= rx1 + px and ry0 - py <= cy <= ry1 + py


def detect(frame_rgb):
    """SAM3 equipment detection — same return shape as equipment_backend.detect.

    "barbell" gives the bar instance AND the region; "weight plate" gives the
    discs, kept only where they fall inside that region so the background floor
    rack drops out. Every detection carries a `polygon` traced from its mask, so
    the overlay draws the real outline rather than a box.
    """
    h, w = frame_rgb.shape[:2]
    pil = Image.fromarray(frame_rgb)

    bars = _run(pil, BAR_PROMPT, h, w)
    bars.sort(key=lambda d: -d["score"])
    bar = None
    region = [0, 0, w, h]
    if bars:
        b = bars[0]
        region = b["box"]
        bar = {"box": b["box"], "score": b["score"],
               "polygon": _polygon(b["mask"]), "label": BAR_PROMPT}

    plate_dets = _run(pil, PLATE_PROMPT, h, w)
    # Keep only discs inside the barbell region (drops the floor rack), strongest
    # first, capped so a busy frame stays legible.
    plate_dets = [d for d in plate_dets if _center_in(d["box"], region)]
    plate_dets.sort(key=lambda d: -d["score"])
    plate_dets = plate_dets[:MAX_PLATES]
    # Left->right by box centre, a stable index across frames.
    plate_dets.sort(key=lambda d: d["box"][0] + d["box"][2])

    plates = []
    for d in plate_dets:
        x0, y0, x1, y1 = d["box"]
        plates.append({
            "box": d["box"], "score": d["score"],
            "polygon": _polygon(d["mask"]),
            # Each SAM3 mask is a SINGLE disc, so its box short side is a real
            # single-plate diameter — the honest scale reference DINO's whole-
            # stack box couldn't give.
            "diameter_px": int(min(x1 - x0, y1 - y0)),
            "side": None,
            "label": PLATE_PROMPT,
        })

    return {"plates": plates, "bar": bar, "crop": None}


def prompts():
    return {"plates": PLATE_PROMPT, "bar": BAR_PROMPT}
