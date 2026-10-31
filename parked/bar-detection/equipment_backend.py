"""Text-prompted barbell/plate detection: frame in -> boxes out.

In-process and lazily loaded, same contract as vitpose_backend (see its module
docstring for why coach doesn't put a model behind an HTTP hop). Grounding DINO
(IDEA-Research/grounding-dino-base) is ~230M params / ~700MB, so keeping it
resident next to ViTPose costs a fraction of what the pose checkpoints already
do on this box.

Why an open-vocabulary detector rather than a trained barbell model: there is
no barbell detection checkpoint to download, and labelling one is a project of
its own. Grounding DINO turns "what does a barbell look like" into a sentence,
which is the cheapest possible way to get equipment geometry out of a frame --
and geometry is the point. The plates are discs of a KNOWN diameter
(PLATE_DIAMETER_MM) at a KNOWN separation along the bar, so once they're located
in pixels they are a metric ruler pinned to the lift, which is what the 3D work
needs.

  --- boxes, not masks, and why that's enough here ---

Grounding DINO is a DETECTOR: text prompt + frame in, bounding boxes out. It
does not produce a per-pixel mask (its only spatial output is `pred_boxes`;
there is no `pred_masks`), so the overlay draws rectangles rather than traced
disc/bar outlines -- the frontend's drawEquipment already falls back from polygon
to box, so nothing downstream breaks. And the one measurement this exists to
feed, the plate's pixel diameter, is read from the box's short side (diameter_px
below), never from a mask.

  --- why the mask refiner was tried and dropped ---

The obvious next step -- refine each DINO box into a mask by running the old
CLIPSeg segmenter on a crop of it, then fit an ellipse for a tilt-corrected
diameter -- was built and MEASURED on this test lift, and it made things worse,
not better. Two reasons, both about the footage:
  * DINO boxes the whole PLATE STACK, and on a side-on lift the bumpers recede
    along the bar, so the box short side is already ~one plate's diameter while
    an ellipse over the box spans all ~8 plates (measured: 458px vs the correct
    ~157px, "tilt" 0.06 -- nonsense as a single-disc diameter).
  * CLIPSeg's response over a cluttered, multi-colour crop is a diffuse cloud,
    not a crisp disc: thresholding it fragmented into 40+ speckle components and
    the mask leaked onto the platform edge and a background athlete's legs.
A finer mask only helps when a plate FACES the camera (a real disc to fit). A
side-on stack is the orientation problem, which is the 3D reconstruction task
itself -- not something a segmenter bolted onto the box solves. So this stays
box-only; the tilt-aware diameter is deferred to the 3D work, where the bar
vector (from the two plate centres, and the wrists ViTPose already has) says
which regime a frame is in.

  --- one full-frame pass, not the old two-stage crop ---

CLIPSeg, when it was the detector here, couldn't find the bar full-frame: a thin
shaft squashed to a couple of pixels landed on whatever else in the scene was
long and metallic, so the search had to find the plates first and then hunt the
bar in a crop spanning them. Grounding DINO doesn't have that problem -- it
detects small/thin objects at the resolution its own backbone runs (shortest
edge ~800px, far above CLIPSeg's 352 square), so a single prompt over the whole
frame finds both. One call per frame, one GPU submission, and the
plates-first-then-crop scaffolding is gone.

  --- what this does not do yet ---

The NEAR plate stack is the strong, stable detection; its measured diameter is
the scale reference. The FAR stack is dimmer, smaller and usually half behind
the athlete, so it scores lower and on some frames a rack of loose plates on the
floor outscores it. Both stacks come back with their own confidence in "score"
precisely so this is visible rather than assumed -- a low-scoring second box is
a candidate, not a measurement.

Restricting the search to a corridor along the bar (the athlete's two wrists are
ON the bar, and ViTPose has already found them by the time this runs) was
prototyped and does fix the background-plate confusion. It is left out of this
first pass to keep equipment detection independent of pose, which is what lets
the two models run concurrently instead of in lockstep.
"""
import contextlib
import os
import threading
from pathlib import Path

import cv2
import numpy as np

# Let unimplemented MPS (Apple Silicon) ops fall back to CPU instead of raising.
# Set before torch dispatches; harmless on cuda/cpu. Mirrors vitpose_backend.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
import torch

MODEL_ID = os.environ.get("COACH_DINO_MODEL", "IDEA-Research/grounding-dino-base")
# Where scripts/download_models.sh puts the checkpoint. Kept beside the pose
# weights under ~/models rather than left to the HuggingFace cache, for the
# same reason vitpose_backend has a MODEL_DIR: a checkpoint the setup script
# placed deliberately is one you can find, copy to another box, or delete —
# the hub cache is none of those. Must match the script's DINO_DIR.
DINO_DIR = Path(os.environ.get("COACH_DINO_DIR",
                               str(Path.home() / "models/grounding-dino-base")))


def model_source():
    """The local snapshot if setup fetched one, else the hub id.

    Falling back to the id rather than failing keeps a machine that never ran
    download_models.sh working — transformers will pull from the hub on first
    use (slow, and needs network, which is exactly what the local copy avoids).
    """
    return str(DINO_DIR) if (DINO_DIR / "config.json").exists() else MODEL_ID

# Short noun phrases, one per object. Grounding DINO matches free text against
# the frame, so these go into ITS text encoder as a single query built below
# (BAR_PROMPT + ". " + PLATE_PROMPT + "."), the "categories separated by
# periods" format the model was trained on. Each detection comes back tagged
# with the phrase it matched, and _classify() sorts it into bar-vs-plate by the
# keyword in that phrase -- so the prompts must contain "bar" and "plate"
# respectively for that routing to work.
#
# The plate phrase was measured, not guessed, and the wording matters more than
# it looks: the two objects share one query, so a strong "a barbell" match steals
# probability mass from a bland plate phrase. On a real snatch frame the near
# stack scored "colorful bumper plates" 0.54 · "colorful weight plates" 0.50 ·
# "weight plates" 0.21 · "plates" 0.17 -- the last two fall under the 0.25 gate
# and vanish, so the specific, colour-led phrase is what keeps the plates
# visible alongside the bar rather than being crowded out of the same query.
BAR_PROMPT = os.environ.get("COACH_BAR_PROMPT", "a barbell")
PLATE_PROMPT = os.environ.get("COACH_PLATE_PROMPT", "colorful bumper plates")

# IWF competition geometry, in millimetres. Hardcoded because it is legislated:
# a competition plate is 450mm across whatever colour or weight it is, which is
# what makes it usable as a scale reference. Only the plate diameter is read
# today (see diameter_px below); the rest is here because the bar spacing is
# what turns two plate centres into a metric baseline for the 3D anchor.
PLATE_DIAMETER_MM = 450.0     # every colour of competition bumper, by rule
BAR_LENGTH_MM = 2200.0        # men's bar; women's is 2010mm
BAR_INNER_COLLAR_MM = 1310.0  # distance between the inside faces of the collars
BAR_GRIP_DIAMETER_MM = 28.0   # men's shaft; women's is 25mm ("~2-3cm")
BAR_SLEEVE_DIAMETER_MM = 50.0 # the loadable sleeve the plates ride on ("~4-5cm")

# --- thresholds ---
# Grounding DINO scores each box two ways: a box confidence and, per query token,
# how strongly the box matches that word. BOX_THRESHOLD drops low-confidence
# boxes; TEXT_THRESHOLD decides which query words are counted as the box's label
# (see post_process_grounded_object_detection). Both default to the model card's
# 0.25 and are env-overridable so a noisy scene can be tightened without a code
# change.
BOX_THRESHOLD = float(os.environ.get("COACH_DINO_BOX_THRESHOLD", "0.25"))
TEXT_THRESHOLD = float(os.environ.get("COACH_DINO_TEXT_THRESHOLD", "0.25"))

# cuda (incl. ROCm/HIP) -> mps (Apple Silicon) -> cpu. Matches
# vitpose_backend._select_device; see PYTORCH_ENABLE_MPS_FALLBACK there, which
# it sets at import so unimplemented MPS ops fall back rather than raise.
if torch.cuda.is_available():
    DEVICE = "cuda"
elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
    DEVICE = "mps"
else:
    DEVICE = "cpu"

_model = None
_processor = None
_load_lock = threading.Lock()
# The detector runs on the same GPU as ViTPose and from a different thread (see
# vitpose_backend.infer_video's equipment worker), so its own calls are
# serialized here. Deliberately NOT vitpose_backend._infer_lock: the whole
# point of the worker is that the two models overlap, one doing CPU-side pre-
# and post-processing while the other has the GPU.
_infer_lock = threading.Lock()

# ...but that overlap has to stop at the GPU submission itself on Apple Silicon.
# MPSGraph is not thread-safe for concurrent command-buffer encode: two threads
# reaching Metal at once (ViTPose's forward and the detector's, from the pose
# loop and the equipment worker) segfaults inside the driver -- observed as a
# SIGSEGV on the "metal gpu stream" thread, ~15 frames into a run, whenever the
# two happened to line up. So the two models share ONE lock around the forward
# pass, held for as short a span as possible. CUDA/ROCm IS safe for concurrent
# submission from two threads -- that's what makes the worker worth having on the
# deploy box -- so this only serializes on MPS and is a no-op elsewhere, leaving
# the CPU-side pre/post overlap intact on both.
_gpu_submit_lock = threading.Lock()


def gpu_submit():
    """A context manager guarding a single GPU forward pass across both models.

    Real mutual exclusion on MPS (where concurrent Metal submission crashes),
    a no-op on cuda/cpu (where the worker's whole point is to overlap). Acquired
    by BOTH equipment_backend and vitpose_backend around their model call, so on
    MPS the pose forward and the detector forward can never encode at once. Kept
    to the forward itself, not the surrounding CPU work, so the two threads still
    overlap everywhere it's safe to.
    """
    return _gpu_submit_lock if DEVICE == "mps" else contextlib.nullcontext()


def available():
    """Whether the checkpoint is already on disk, for the app's preflight.

    Checked without instantiating anything -- preflight runs at startup and
    must not pay a model load, nor reach out to the network to find out. The
    hub cache counts too: a box that pulled the model before the local layout
    existed shouldn't be told it's missing.
    """
    if (DINO_DIR / "config.json").exists():
        return True
    try:
        from huggingface_hub import snapshot_download
        snapshot_download(MODEL_ID, local_files_only=True)
        return True
    except Exception:
        return False


def get_model():
    """Lazy-load Grounding DINO + its processor, then keep them resident.

    Same "first request pays" contract as vitpose_backend.get_model().
    """
    global _model, _processor
    if _model is not None:
        return _model, _processor
    with _load_lock:
        if _model is None:                 # re-check: lost the race while blocked
            from transformers import (AutoProcessor,
                                       AutoModelForZeroShotObjectDetection)
            src = model_source()
            proc = AutoProcessor.from_pretrained(src)
            model = AutoModelForZeroShotObjectDetection.from_pretrained(src)
            # The weight copy to the GPU is itself a Metal submission, and it
            # happens on the worker thread on frame 0 while ViTPose is running
            # the same frame -- so it has to take the shared lock too, or the
            # very first frame can hit the concurrent-submission crash before
            # any forward pass does. See gpu_submit().
            with gpu_submit():
                model.to(DEVICE).eval()
            _processor, _model = proc, model
    return _model, _processor


def _query_text():
    """The single query string DINO sees, in its "phrases end with periods" form."""
    return f"{BAR_PROMPT}. {PLATE_PROMPT}.".lower()


def _detect_raw(rgb):
    """Run the detector over one RGB array -> a flat list of detections.

    Each detection is {"box": [x0,y0,x1,y1] (ints, clamped to the frame),
    "score": float, "label": str} in the array's OWN pixel coordinates -- the
    processor resizes internally and post_process maps the boxes back, so every
    caller works in the coordinates it passed in. The label is the query phrase
    the box matched, which _classify() routes on.
    """
    model, proc = get_model()
    h, w = rgb.shape[:2]
    # Hand the processor the native frame, not a pre-shrunk copy: DINO's whole
    # advantage over the old segmenter is that it finds thin/small objects at
    # its backbone's resolution (shortest edge ~800px, far above CLIPSeg's 352
    # square), and downsampling first would throw exactly the bar away. The
    # processor does its own resize.
    inputs = proc(images=rgb, text=_query_text(), return_tensors="pt")
    # EVERY GPU touch goes inside gpu_submit(), not just the forward: the
    # host->device copy (.to) and the forward each encode Metal command buffers,
    # and on MPS a buffer encoded on this worker thread while ViTPose's forward
    # encodes one on the pose thread segfaults the driver -- the exact crash the
    # lock exists to prevent (see gpu_submit()). The CPU-side prep above (resize,
    # tokenize) stays outside, where overlapping the other model's GPU work is
    # safe and the point.
    with _infer_lock, gpu_submit():
        inputs = {k: v.to(DEVICE) for k, v in inputs.items()}
        with torch.no_grad():
            outputs = model(**inputs)
        results = proc.post_process_grounded_object_detection(
            outputs,
            inputs["input_ids"],
            threshold=BOX_THRESHOLD,
            text_threshold=TEXT_THRESHOLD,
            target_sizes=[(h, w)],
        )[0]

    out = []
    for score, box, label in zip(results["scores"], results["boxes"],
                                 results["text_labels"]):
        x0, y0, x1, y1 = (float(v) for v in box)
        x0 = max(0, min(w, int(round(x0)))); x1 = max(0, min(w, int(round(x1))))
        y0 = max(0, min(h, int(round(y0)))); y1 = max(0, min(h, int(round(y1))))
        if x1 - x0 < 1 or y1 - y0 < 1:
            continue
        out.append({"box": [x0, y0, x1, y1],
                    "score": round(float(score), 4),
                    "label": label})
    return out


def _classify(dets):
    """Split raw detections into (plates, bars) by the phrase each one matched.

    "plate" is checked before "bar" so a merged phrase can't misroute a plate as
    a bar; "barbell" contains "bar" but not "plate", so the ordering is safe.
    """
    plates, bars = [], []
    for d in dets:
        label = d["label"]
        if "plate" in label:
            plates.append(d)
        elif "bar" in label:
            bars.append(d)
    return plates, bars


def detect(frame_rgb):
    """Find the plates and the bar in one RGB frame.

    Returns {"plates": [...], "bar": {...} or None, "crop": None}, where each
    detection is {"box": [x0,y0,x1,y1], "score": float, "label": str, ...} in
    the frame's own pixel coordinates. At most two plate stacks come back,
    ordered LEFT TO RIGHT by box centre so that "plates[0]" means the same end
    of the bar from frame to frame -- an index that reshuffled whenever one
    stack outgrew the other would be useless to difference across time.

    "crop" is always None now: the bar is found in the same full-frame pass as
    the plates, not in a window derived from them (see the module docstring).
    The key is kept so the overlay's "where did it look" handling and the run
    JSON's shape don't have to change with the model behind them.

    Plates carry diameter_px: the short side of the stack's box, which for a
    disc is its diameter regardless of how many plates are stacked along the
    bar behind it. That is the pixels-per-450mm scale reference, and it is a
    crude one -- a bar tilted away from the camera projects the disc to an
    ellipse whose short axis under-reads the diameter. Recovering that tilt (and
    with it the third dimension) is the 3D work; a segmenter-fitted ellipse was
    tried and rejected for it (see the module docstring). Until then this is an
    estimate and is labelled as one in the UI.
    """
    plates, bars = _classify(_detect_raw(frame_rgb))

    # Two strongest stacks, then ordered left->right for a stable index.
    plates.sort(key=lambda d: -d["score"])
    plates = plates[:2]
    plates.sort(key=lambda p: p["box"][0] + p["box"][2])   # left -> right
    for i, p in enumerate(plates):
        x0, y0, x1, y1 = p["box"]
        # Only nameable when both ends are in hand: one stack on its own could
        # be either end of the bar, and guessing would make a left/right label
        # that flips between frames look like the bar swinging round.
        p["side"] = ("left", "right")[i] if len(plates) == 2 else None
        p["diameter_px"] = int(min(x1 - x0, y1 - y0))

    bar = max(bars, key=lambda d: d["score"]) if bars else None

    return {"plates": plates, "bar": bar, "crop": None}


def prompts():
    """What was asked, for the UI to show. The overlay is only interpretable
    next to the phrase that produced it -- a box labelled 'bar' means something
    different if the prompt was 'a chrome bar'."""
    return {"plates": PLATE_PROMPT, "bar": BAR_PROMPT}


# --- optional SAM3 backend -------------------------------------------------
# COACH_SAM3=1 swaps the detector for facebook/sam3 (instance masks, not just
# boxes) WITHOUT touching the DINO default above. Only the contract functions
# the callers reach for are rebound; gpu_submit()/DEVICE stay this module's, so
# SAM3 shares the exact same GPU lock ViTPose takes (equipment_sam3 imports it
# from here). Done last so equipment_backend is fully initialised before
# equipment_sam3 imports back from it.
if os.environ.get("COACH_SAM3") not in (None, "", "0"):
    from equipment_sam3 import (  # noqa: E402
        detect, available, model_source, prompts, get_model)
