"""Text-prompted barbell/plate detection: frame in -> boxes out.

In-process and lazily loaded, same contract as vitpose_backend (see its module
docstring for why coach doesn't put a model behind an HTTP hop). CLIPSeg is
~150M params / ~600MB, so keeping it resident next to ViTPose costs a fraction
of what the pose checkpoints already do on this box's W7800.

Why a prompted segmenter rather than a trained detector: there is no barbell
detection checkpoint to download, and labelling one is a project of its own.
CLIPSeg turns "what does a barbell look like" into a sentence, which is the
cheapest possible way to get equipment geometry out of a frame — and geometry
is the point. The plates are discs of a KNOWN diameter (PLATE_DIAMETER_MM) at
a KNOWN separation along the bar, so once they're located in pixels they are a
metric ruler pinned to the lift, which is what the 3D work needs.

  --- the two-stage search, and why it isn't one prompt ---

Asking CLIPSeg for the bar on the full frame does not work, and fails in the
worst way: measured on a 1080x1920 snatch frame, every bar-ish prompt scored
0.01-0.15 on the actual shaft, while "the silver shaft between the plates"
scored 0.85 on the EDGE OF THE PLATFORM. A thin bar is a couple of pixels wide
after the processor squashes the frame to 352x352 -- below the resolution the
decoder can express -- so the prompt lands on whatever else in the scene is
long, straight and metallic.

The plates have no such problem (0.73 on the same frame, and the rack of loose
plates on the floor behind the lifter stays dark), so the search goes in that
order and uses the first result to make the second one possible:

  1. plates, on the full frame -> the two largest blobs are the two stacks;
  2. bar, on a CROP spanning those stacks -> the shaft now covers enough of the
     352x352 input to be found. Same prompt that scored 0.15 full-frame scores
     0.67 here.

So the bar is only ever looked for where the plates say a bar must be. If the
plates aren't found, no bar is reported -- a full-frame guess would be the
platform edge, and a confidently wrong bar is worse for a 3D anchor than none.

  --- what this does not do yet ---

The NEAR plate stack is found on essentially every frame of the test lift, and
its measured diameter is stable to within a few percent (225-237px across the
clip), which is what a scale reference has to be. The FAR stack is much
weaker: it is dimmer, smaller and usually half behind the athlete, so it
scores 0.04-0.34 where the near one scores 0.30-0.76, and on some frames the
loose plates racked on the floor behind the lifter outscore it. Both stacks
come back with their own peak response in "score" precisely so this is visible
rather than assumed -- a low-scoring second box is a candidate, not a
measurement.

Restricting the search to a corridor along the bar (the athlete's two wrists
are ON the bar, and ViTPose has already found them by the time this runs) was
prototyped and does fix the background-plate confusion. It is left out of this
first pass to keep equipment detection independent of pose, which is what lets
the two models run concurrently instead of in lockstep.
"""
import os
import threading
from pathlib import Path

import cv2
import numpy as np
import torch

MODEL_ID = os.environ.get("COACH_CLIPSEG_MODEL", "CIDAS/clipseg-rd64-refined")
# Where scripts/download_models.sh puts the checkpoint. Kept beside the pose
# weights under ~/models rather than left to the HuggingFace cache, for the
# same reason vitpose_backend has a MODEL_DIR: a checkpoint the setup script
# placed deliberately is one you can find, copy to another box, or delete —
# the hub cache is none of those. Must match the script's CLIPSEG_DIR.
CLIPSEG_DIR = Path(os.environ.get("COACH_CLIPSEG_DIR",
                                  str(Path.home() / "models/clipseg-rd64-refined")))


def model_source():
    """The local snapshot if setup fetched one, else the hub id.

    Falling back to the id rather than failing keeps a machine that never ran
    download_models.sh working — transformers will pull from the hub on first
    use (slow, and needs network, which is exactly what the local copy avoids).
    """
    return str(CLIPSEG_DIR) if (CLIPSEG_DIR / "config.json").exists() else MODEL_ID

# Ultrashort on purpose. These go through CLIP's text encoder, which was
# trained on caption-length noun phrases -- the long physical description that
# motivates each one ("grip ~2-3cm diameter, plate holder ~4-5cm") makes the
# embedding worse, not better, because the extra tokens dilute the head noun.
# The dimensions live in the constants below, where they can actually be used,
# rather than in a sentence the encoder will average away.
#
# Both were picked by measuring, not by taste -- peak sigmoid on a real lift
# frame, against the alternatives:
#   plates: "a stack of round weight plates" 0.73 · "colorful weight plates on
#           a barbell" 0.61 · "round weight plates" 0.42 (and that one also
#           lights up the loose plates racked on the floor) · "weight plates" 0.04
#   bar:    (on the crop) "a thin metal rod" 0.68 · "a barbell bar" 0.67 ·
#           "a horizontal metal pole" 0.64 · "a chrome bar" 0.17
PLATE_PROMPT = os.environ.get("COACH_PLATE_PROMPT", "a stack of round weight plates")
BAR_PROMPT = os.environ.get("COACH_BAR_PROMPT", "a thin metal rod")

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
# Relative to each frame's own peak, not absolute. CLIPSeg's sigmoid output is
# not calibrated, across prompts OR across frames, and both were measured: the
# plate prompt peaked at 0.76 on one frame of the test lift and 0.11 on
# another where the map was just as clean and just as correctly placed. A
# fixed cutoff would have thrown the second one away. A fraction of the peak
# asks the stable question instead: which pixels did this prompt like nearly
# as much as the best one.
REL_THRESHOLD = 0.30
FLOOR = 0.02            # ...but never threshold below this, so a frame with no
                        # barbell in it can't segment its own background noise
MIN_AREA_FRAC = 3e-4    # blobs smaller than this fraction of the search area
                        # are speckle, not a 450mm disc

# "Did this prompt find anything" has to be scale-free for the same reason, so
# it's peak-over-background rather than peak alone. On the test lift this ran
# 5-20 for frames with a barbell in them (including the 0.11 one, at 9.0),
# against ~1 for a map with no structure -- everything and nothing look alike
# in absolute terms, but not in contrast.
MIN_CONTRAST = 3.0

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

_model = None
_processor = None
_load_lock = threading.Lock()
# CLIPSeg runs on the same GPU as ViTPose and from a different thread (see
# vitpose_backend.infer_video's equipment worker), so its own calls are
# serialized here. Deliberately NOT vitpose_backend._infer_lock: the whole
# point of the worker is that the two models overlap, one doing CPU-side pre-
# and post-processing while the other has the GPU.
_infer_lock = threading.Lock()


def available():
    """Whether the checkpoint is already on disk, for the app's preflight.

    Checked without instantiating anything -- preflight runs at startup and
    must not pay a model load, nor reach out to the network to find out. The
    hub cache counts too: a box that pulled the model before the local layout
    existed shouldn't be told it's missing.
    """
    if (CLIPSEG_DIR / "config.json").exists():
        return True
    try:
        from huggingface_hub import snapshot_download
        snapshot_download(MODEL_ID, local_files_only=True)
        return True
    except Exception:
        return False


def get_model():
    """Lazy-load CLIPSeg + its processor, then keep them resident.

    Same "first request pays" contract as vitpose_backend.get_model().
    """
    global _model, _processor
    if _model is not None:
        return _model, _processor
    with _load_lock:
        if _model is None:                 # re-check: lost the race while blocked
            from transformers import CLIPSegProcessor, CLIPSegForImageSegmentation
            src = model_source()
            proc = CLIPSegProcessor.from_pretrained(src)
            model = CLIPSegForImageSegmentation.from_pretrained(src)
            model.to(DEVICE).eval()
            _processor, _model = proc, model
    return _model, _processor


def _probability_map(rgb, prompt):
    """Run one prompt over one RGB array -> a probability map at ITS size.

    The 352x352 the model works at is an implementation detail that stops here:
    the map is resized back to the input's own pixel grid, so every caller
    below can do its geometry in the coordinates it passed in and a crop only
    has to add its own origin. (The processor squashes to a square without
    preserving aspect ratio, so this undoes exactly that same squash.)
    """
    model, proc = get_model()
    h, w = rgb.shape[:2]
    # Pre-shrink with cv2 rather than handing the processor a 1080p frame: it
    # resizes with PIL, which measured ~10ms/frame at that size against ~1ms
    # here, and the result is identical input to the model either way.
    small = cv2.resize(rgb, (352, 352), interpolation=cv2.INTER_AREA)
    inputs = proc(text=[prompt], images=[small], padding=True, return_tensors="pt")
    inputs = {k: v.to(DEVICE) for k, v in inputs.items()}
    with _infer_lock:
        with torch.no_grad():
            logits = model(**inputs).logits
    # A single-prompt batch comes back as (352, 352), a multi-prompt one as
    # (n, 352, 352) -- normalize so this doesn't depend on the batch shape.
    prob = torch.sigmoid(logits).squeeze().cpu().numpy().astype(np.float32)
    return cv2.resize(prob, (w, h), interpolation=cv2.INTER_LINEAR)


def _boxes_from_prob(prob, max_boxes):
    """Threshold a probability map and return its biggest blobs as boxes.

    Boxes are [x0, y0, x1, y1] in the map's own pixel coordinates, biggest
    blob first. Each carries the peak probability inside it rather than the
    frame's peak, so a second, weaker stack is reported as the weaker thing it
    is instead of inheriting its neighbour's confidence.
    """
    peak = float(prob.max()) if prob.size else 0.0
    background = float(np.percentile(prob, 95)) if prob.size else 0.0
    if peak <= 0 or peak / max(background, 1e-6) < MIN_CONTRAST:
        return []
    mask = (prob >= max(REL_THRESHOLD * peak, FLOOR)).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    min_area = MIN_AREA_FRAC * prob.size
    comps = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= min_area]
    comps.sort(key=lambda i: -stats[i, cv2.CC_STAT_AREA])

    out = []
    for i in comps[:max_boxes]:
        x, y, w, h = (int(stats[i, cv2.CC_STAT_LEFT]), int(stats[i, cv2.CC_STAT_TOP]),
                      int(stats[i, cv2.CC_STAT_WIDTH]), int(stats[i, cv2.CC_STAT_HEIGHT]))
        out.append({
            "box": [x, y, x + w, y + h],
            "score": round(float(prob[labels == i].max()), 4),
            "area": int(stats[i, cv2.CC_STAT_AREA]),
        })
    return out


def _bar_crop_window(plates, width, height):
    """The region to hunt the bar in, from where the plates ended up.

    Two stacks: the band spanning both, which is the shaft plus both sleeves.
    One stack (the two overlap into a single blob from a side-on camera, or one
    is out of frame): a band of the same height centred on it and widened, since
    the bar runs out of that stack in a direction this can't yet know.

    Padded by a share of the span rather than a fixed pixel count so it holds up
    across resolutions, and clipped to the frame.
    """
    xs0 = min(p["box"][0] for p in plates); xs1 = max(p["box"][2] for p in plates)
    ys0 = min(p["box"][1] for p in plates); ys1 = max(p["box"][3] for p in plates)
    if len(plates) == 1:
        # Widen well past the single blob: the bar extends roughly a plate's
        # diameter beyond each stack, and more if the far stack is hiding
        # behind this one.
        pad_x = 1.5 * (xs1 - xs0)
    else:
        pad_x = 0.15 * (xs1 - xs0)
    pad_y = 0.25 * (ys1 - ys0)
    x0 = max(0, int(xs0 - pad_x)); x1 = min(width, int(xs1 + pad_x))
    y0 = max(0, int(ys0 - pad_y)); y1 = min(height, int(ys1 + pad_y))
    if x1 - x0 < 16 or y1 - y0 < 16:
        return None
    return x0, y0, x1, y1


def detect(frame_rgb):
    """Find the plates and the bar in one RGB frame.

    Returns {"plates": [...], "bar": {...} or None, "crop": [...] or None},
    where each detection is {"box": [x0,y0,x1,y1], "score": float, ...} in the
    frame's own pixel coordinates. At most two plate stacks come back, ordered
    LEFT TO RIGHT by box centre so that "plates[0]" means the same end of the
    bar from frame to frame -- an index that reshuffled whenever one stack
    outgrew the other would be useless to difference across time.

    "crop" is the window the bar was searched in, reported so the overlay can
    show where the second stage actually looked rather than leaving a missing
    bar ambiguous between "no bar there" and "never looked there".

    Plates carry diameter_px: the short side of the stack's box, which for a
    disc is its diameter regardless of how many plates are stacked along the
    bar behind it. That is the pixels-per-450mm scale reference, and it is a
    crude one -- a bar tilted away from the camera projects the disc to an
    ellipse whose short axis under-reads the diameter. Fitting that ellipse is
    what recovers the tilt (and with it the third dimension); until then this
    is an estimate and is labelled as one in the UI.
    """
    h, w = frame_rgb.shape[:2]
    plate_prob = _probability_map(frame_rgb, PLATE_PROMPT)
    plates = _boxes_from_prob(plate_prob, max_boxes=2)
    plates.sort(key=lambda p: p["box"][0] + p["box"][2])   # left -> right
    for i, p in enumerate(plates):
        x0, y0, x1, y1 = p["box"]
        # Only nameable when both ends are in hand: one stack on its own could
        # be either end of the bar, and guessing would make a left/right label
        # that flips between frames look like the bar swinging round.
        p["side"] = ("left", "right")[i] if len(plates) == 2 else None
        p["diameter_px"] = int(min(x1 - x0, y1 - y0))

    bar, crop = None, None
    if plates:
        window = _bar_crop_window(plates, w, h)
        if window is not None:
            crop = list(window)
            cx0, cy0, cx1, cy1 = window
            bar_prob = _probability_map(frame_rgb[cy0:cy1, cx0:cx1], BAR_PROMPT)
            found = _boxes_from_prob(bar_prob, max_boxes=1)
            if found:
                bar = found[0]
                bx0, by0, bx1, by1 = bar["box"]
                bar["box"] = [bx0 + cx0, by0 + cy0, bx1 + cx0, by1 + cy0]

    return {"plates": plates, "bar": bar, "crop": crop}


def prompts():
    """What was asked, for the UI to show. The overlay is only interpretable
    next to the sentence that produced it -- a box labelled 'bar' means
    something different if the prompt was 'a chrome bar'."""
    return {"plates": PLATE_PROMPT, "bar": BAR_PROMPT}
