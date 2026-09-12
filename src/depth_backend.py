"""3D depth-detection framework: many anchors, one that gets to run.

Recovering a 3D pose/mesh of the athlete from a single camera is ambiguous, and
no one cue solves every scene. A side-on lift with the barbell in frame can be
metrically scaled off a 450mm plate; a three-quarter view with the bar occluded
can't, but its limbs are visible enough for a bone-length lift; a clean, large
subject is a candidate for a learned body-model regressor. So instead of one
estimator we keep a SET of "depth anchors", each strong in a different regime,
and pick per scene.

The one rule that shapes this whole module: **confidence must be cheap and must
NOT compute the mesh.** The point of having several anchors is to decide which
one to run *before* paying for any of them. So every DepthDetector splits into

  * confidence(scene) -> float in [0,1]   -- cheap; reads only scene features
                                             (which joints are visible, is there
                                             a metric scale, does the view look
                                             side-on). Never builds geometry.
  * mesh(scene)       -> MeshCandidate     -- the expensive part; only ever
                                             called on the winner.

pick(scene) scores every AVAILABLE anchor (cheap) and returns the best one;
generate(scene) then calls mesh() on that one alone. Adding a heavier method
(HMR/SMPL, a diffusion depth net) costs nothing at scoring time until it's the
one chosen — which is the property we want as more anchors land.

Coordinate + unit conventions:
  * 2D keypoints arrive in ViTPose's native COCO layout and (y, x, conf) order
    (that's what the frontend stores and draws with); Scene.from_payload flips
    them to (x, y, conf) once so every detector reasons in image-x/right,
    image-y/down.
  * joints3d come back root-centred at the pelvis, x right / y DOWN (image
    convention, so it overlays without a flip) / z toward the camera positive.
    Metric detectors set metric=True and units are millimetres; others leave
    metric=False and units are "torso lengths" (pelvis->neck == 1).
"""
import os
from abc import ABC, abstractmethod
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np

# COCO-17, the only dataset coach's ViTPose is pulled for. Indices are the
# contract with the frontend's skeleton edges, so they stay fixed here.
NOSE = 0
L_EYE, R_EYE, L_EAR, R_EAR = 1, 2, 3, 4
L_SHO, R_SHO = 5, 6
L_ELB, R_ELB = 7, 8
L_WRI, R_WRI = 9, 10
L_HIP, R_HIP = 11, 12
L_KNE, R_KNE = 13, 14
L_ANK, R_ANK = 15, 16
N_JOINTS = 17

# Skeleton for the OUTPUT (0-indexed COCO), handed back with every candidate so
# a viewer can draw bones without knowing the dataset.
EDGES = [
    (L_SHO, R_SHO), (L_SHO, L_HIP), (R_SHO, R_HIP), (L_HIP, R_HIP),
    (L_SHO, L_ELB), (L_ELB, L_WRI), (R_SHO, R_ELB), (R_ELB, R_WRI),
    (L_HIP, L_KNE), (L_KNE, L_ANK), (R_HIP, R_KNE), (R_KNE, R_ANK),
    (NOSE, L_EYE), (L_EYE, L_EAR), (NOSE, R_EYE), (R_EYE, R_EAR),
    (NOSE, L_SHO), (NOSE, R_SHO),
]

# A joint counts as "seen" above this. Matches the frontend's CONF_THRESHOLD so
# confidence here agrees with what the user sees drawn.
CONF_SEEN = float(os.environ.get("COACH_DEPTH_CONF_SEEN", "0.3"))

# The scale reference the equipment detector exists to give: a bumper plate is
# 450mm across. Shared with equipment_backend's PLATE_DIAMETER_MM, redeclared
# here so depth_backend has no import-time dependency on the equipment stack.
PLATE_DIAMETER_MM = float(os.environ.get("COACH_PLATE_DIAMETER_MM", "450"))


# --- scene + candidate ------------------------------------------------------

@dataclass
class Scene:
    """Everything a detector reasons over for one frame — assembled once, read
    by every anchor's confidence() and by the winner's mesh().

    kp2d is (17, 3) float in (x, y, conf), image pixels; missing joints are left
    as NaN in x/y with conf 0 so `seen` is the single source of truth for what's
    usable. frame_rgb is optional (H, W, 3) uint8, present only when a
    pixel-hungry anchor is in play — the geometric ones never touch it, so the
    frontend can skip shipping it for them.
    """
    width: int
    height: int
    kp2d: np.ndarray                       # (17, 3) (x, y, conf) — the "current" frame
    equipment: Optional[dict] = None       # {"plates":[...], "bar":{...}|None}
    frame_rgb: Optional[np.ndarray] = None
    dataset: str = "coco"

    # A sequence-capable method (plate-anchor) needs more than the frame on
    # screen: the whole track, and which frame is the lift's START — for a
    # snatch, the first pull, where the wrists sit on the bar. These stay None
    # for single-frame methods, which just read kp2d/equipment above.
    #   sequence: {frame_idx (int): {"kp2d": (17,3), "equipment": dict|None}}
    sequence: Optional[dict] = None
    start_frame: Optional[int] = None
    current_frame: Optional[int] = None

    # Which way each ambiguous limb bends out of the image plane: {joint index:
    # +1 toward the camera, -1 away}. A joint absent from the dict takes
    # DEFAULT_DEPTH_SIGN, so an empty dict reproduces the old behaviour exactly.
    # Per joint rather than one global flip because a lift routinely has both at
    # once — at the catch, one elbow is in front of the bar and the other behind
    # it, and no single choice is right for both.
    depth_signs: dict = field(default_factory=dict)

    # cached cheap features, filled lazily by feature accessors below
    _cache: dict = field(default_factory=dict, repr=False)

    @staticmethod
    def _parse_kp(kps) -> np.ndarray:
        """One frame of ViTPose keypoints -> (17,3) in (x, y, conf).

        Accepts either {person_id: [[y,x,c]...]} or a bare [[y,x,c]...]; takes
        the first person (the app has already reduced to the kept lifter) and
        flips native (y, x) to (x, y). Missing joints stay NaN with conf 0."""
        kp2d = np.full((N_JOINTS, 3), np.nan, dtype=float)
        kp2d[:, 2] = 0.0
        if isinstance(kps, dict):
            kps = next(iter(kps.values()), None) if kps else None
        if kps:
            for i in range(min(N_JOINTS, len(kps))):
                y, x, c = kps[i][0], kps[i][1], kps[i][2]
                kp2d[i] = (float(x), float(y), float(c))
        return kp2d

    @classmethod
    def from_payload(cls, payload: dict) -> "Scene":
        """Build a Scene from the JSON the frontend posts.

        Always carries the current frame (keypoints/equipment). If the payload
        also has a `sequence` (every processed frame's keypoints+equipment) and
        a `start_frame`, the sequence-capable anchors get the whole track."""
        w = int(payload["width"])
        h = int(payload["height"])
        kp2d = cls._parse_kp(payload.get("keypoints"))

        sequence = None
        seq_in = payload.get("sequence")
        if isinstance(seq_in, dict) and seq_in:
            sequence = {}
            for k, v in seq_in.items():
                sequence[int(k)] = {
                    "kp2d": cls._parse_kp(v.get("keypoints")),
                    "equipment": v.get("equipment"),
                }

        start_frame = payload.get("start_frame")
        return cls(width=w, height=h, kp2d=kp2d,
                   equipment=payload.get("equipment"),
                   dataset=payload.get("dataset", "coco"),
                   sequence=sequence,
                   start_frame=None if start_frame is None else int(start_frame),
                   current_frame=payload.get("current_frame"),
                   depth_signs=parse_depth_signs(payload.get("depth_signs")))

    def start_equipment(self) -> Optional[dict]:
        """Equipment on the lift's start frame — what plate-anchor confidence
        reads. Falls back to the current frame's equipment when there's no
        sequence (single-frame call)."""
        if self.sequence and self.start_frame in self.sequence:
            return self.sequence[self.start_frame]["equipment"]
        return self.equipment

    # --- cheap, cached scene features (shared by confidence + mesh) ---------

    @property
    def seen(self) -> np.ndarray:
        """Boolean (17,) — which joints cleared the confidence gate."""
        if "seen" not in self._cache:
            self._cache["seen"] = self.kp2d[:, 2] >= CONF_SEEN
        return self._cache["seen"]

    @property
    def torso_px(self) -> float:
        """Pelvis->neck length in pixels (the body scale for the lift), or NaN
        if either midpoint is missing. Cheap, and both confidence and the lift
        want it, so it's cached."""
        if "torso_px" not in self._cache:
            pelvis = self._mid(L_HIP, R_HIP)
            neck = self._mid(L_SHO, R_SHO)
            self._cache["torso_px"] = (
                float(np.hypot(*(neck - pelvis)))
                if pelvis is not None and neck is not None else float("nan"))
        return self._cache["torso_px"]

    def _mid(self, a, b):
        """Midpoint of two joints in (x, y), or None if either is unseen."""
        if not (self.seen[a] and self.seen[b]):
            return None
        return (self.kp2d[a, :2] + self.kp2d[b, :2]) / 2.0

    def mm_per_px(self) -> Optional[float]:
        """Metric scale from the equipment, or None if there's no plate to read.

        Each SAM3/DINO plate carries diameter_px (the disc's on-screen size); a
        plate is 450mm, so 450/diameter_px is mm-per-pixel. Median over plates
        to shrug off one bad box. This is the whole reason a metric anchor can
        exist for some scenes and not others."""
        if "mm_per_px" not in self._cache:
            val = None
            eq = self.equipment or {}
            diams = [p["diameter_px"] for p in (eq.get("plates") or [])
                     if p.get("diameter_px")]
            if diams:
                val = PLATE_DIAMETER_MM / float(np.median(diams))
            self._cache["mm_per_px"] = val
        return self._cache["mm_per_px"]

    def bar_sideness(self) -> float:
        """0..1 guess at how side-on the view is, from the bar box aspect.

        Seen from the side the loaded bar is a long, short rectangle; seen from
        the front it's short and tall (mostly the near plate). Wide box -> more
        confident this is the plane a metric lift assumes. No bar -> 0."""
        eq = self.equipment or {}
        bar = eq.get("bar")
        if not bar or "box" not in bar:
            return 0.0
        x0, y0, x1, y1 = bar["box"]
        w, h = max(1.0, x1 - x0), max(1.0, y1 - y0)
        aspect = w / h
        # aspect 2 -> 0, aspect 8 -> 1; the bar is typically 4-10x wide side-on.
        return float(np.clip((aspect - 2.0) / 6.0, 0.0, 1.0))


@dataclass
class MeshCandidate:
    """A 3D estimate from one anchor. joints3d always present; a dense body
    model additionally fills vertices/faces. confidence is the SAME number the
    router ranked on, carried through so the caller can show why this won."""
    method: str
    confidence: float
    joints3d: np.ndarray                    # (17, 3) — the representative frame
    edges: list
    metric: bool                            # True -> joints3d in mm
    vertices: Optional[np.ndarray] = None
    faces: Optional[np.ndarray] = None
    notes: str = ""
    # For a sequence method: {frame_idx (int): (17,3)} so the viewer can animate
    # in step with the video. Single-frame methods leave this None and the
    # viewer just shows joints3d.
    frames: Optional[dict] = None

    @staticmethod
    def _joints_json(j):
        # NaN isn't valid JSON; null out unseen joints so the viewer skips them
        # the same way the 2D overlay skips low-confidence points.
        return [None if not np.all(np.isfinite(p)) else
                [round(float(v), 2) for v in p] for p in j]

    def to_json(self) -> dict:
        return {
            "method": self.method,
            "confidence": round(float(self.confidence), 4),
            "metric": self.metric,
            "units": "mm" if self.metric else "torso",
            "joints3d": self._joints_json(self.joints3d),
            "edges": [list(e) for e in self.edges],
            "vertices": None if self.vertices is None else
                        [[round(float(v), 2) for v in p] for p in self.vertices],
            "faces": None if self.faces is None else
                     [[int(i) for i in f] for f in self.faces],
            "frames": None if self.frames is None else
                      {str(k): self._joints_json(v) for k, v in self.frames.items()},
            "notes": self.notes,
        }


# --- the parent -------------------------------------------------------------

class DepthDetector(ABC):
    """One depth anchor. Subclasses implement the cheap/expensive split.

    name/label/description are class attributes so the registry can list the
    picker without instantiating anything heavy. requires_pixels tells the
    frontend whether to bother shipping the frame image for this method.
    """
    name: str = "base"
    label: str = "base"
    description: str = ""
    requires_pixels: bool = False

    def available(self) -> bool:
        """Can this run at all on THIS box — weights on disk, deps importable.
        No load, no network (mirrors the equipment_backend contract). Default
        True for the pure-geometry anchors that need nothing but numpy."""
        return True

    @abstractmethod
    def confidence(self, scene: Scene) -> float:
        """Cheap suitability of this anchor for `scene`, in [0, 1]. MUST NOT
        build the mesh — reads only Scene's cached features. This is what the
        router ranks, so every method's score has to mean the same thing:
        'how much would I trust my own mesh here'."""

    @abstractmethod
    def mesh(self, scene: Scene) -> MeshCandidate:
        """The 3D estimate. Only ever called on the anchor the router picked."""


# --- shared bone-length lift ------------------------------------------------

# Expected 3D bone lengths as a fraction of torso length (pelvis->neck == 1).
# Rough population anthropometry — enough to turn a 2D projection into a depth
# guess, not a biomechanics model. Keyed by (parent, child) in the walk order.
_BONE_RATIO = {
    (L_HIP, L_KNE): 0.85, (L_KNE, L_ANK): 0.85,
    (R_HIP, R_KNE): 0.85, (R_KNE, R_ANK): 0.85,
    (L_SHO, L_ELB): 0.62, (L_ELB, L_WRI): 0.50,
    (R_SHO, R_ELB): 0.62, (R_ELB, R_WRI): 0.50,
    (NOSE, L_EYE): 0.10, (L_EYE, L_EAR): 0.12,
    (NOSE, R_EYE): 0.10, (R_EYE, R_EAR): 0.12,
}
# Walk order: each child reached from an already-placed parent. Hips and
# shoulders and nose are placed directly off the synthetic pelvis/neck first.
_WALK = [
    (L_HIP, L_KNE), (L_KNE, L_ANK), (R_HIP, R_KNE), (R_KNE, R_ANK),
    (L_SHO, L_ELB), (L_ELB, L_WRI), (R_SHO, R_ELB), (R_ELB, R_WRI),
    (NOSE, L_EYE), (L_EYE, L_EAR), (NOSE, R_EYE), (R_EYE, R_EAR),
]


# --- the depth-sign ambiguity ----------------------------------------------
# Every joint reached by walking a bone out from its parent gets a dz whose
# MAGNITUDE the bone-length prior fixes and whose SIGN a single view cannot:
# an elbow foreshortened by 30px is equally consistent with bending toward the
# camera or away from it. These are exactly the children in _WALK — the joints
# placed in-plane (hips, shoulders, nose, pelvis) carry no dz and so no choice.
DEFAULT_DEPTH_SIGN = +1          # toward the camera, the historical behaviour

_JOINT_LABELS = {
    L_KNE: "left knee", L_ANK: "left ankle", R_KNE: "right knee", R_ANK: "right ankle",
    L_ELB: "left elbow", L_WRI: "left wrist", R_ELB: "right elbow", R_WRI: "right wrist",
    L_EYE: "left eye", L_EAR: "left ear", R_EYE: "right eye", R_EAR: "right ear",
}


def sign_joints() -> list:
    """The joints whose depth direction is selectable, for the picker UI.

    Derived from _WALK rather than listed by hand, so adding a bone to the
    prior can't leave the interface silently missing its toggle."""
    return [{"index": child, "label": _JOINT_LABELS.get(child, f"joint {child}"),
             "default": DEFAULT_DEPTH_SIGN}
            for _, child in _WALK]


def parse_depth_signs(raw) -> dict:
    """{joint: ±1} from whatever the frontend posted.

    Tolerant on purpose — this arrives from a UI holding one entry per joint
    and a stale/garbage entry must not cost the whole reconstruction. Anything
    that isn't a known ambiguous joint with a usable sign is dropped, and the
    joint falls back to DEFAULT_DEPTH_SIGN.
    """
    out = {}
    if not isinstance(raw, dict):
        return out
    valid = {child for _, child in _WALK}
    for k, v in raw.items():
        try:
            i = int(k)
            s = int(v)
        except (TypeError, ValueError):
            continue
        if i in valid and s in (-1, 1):
            out[i] = s
    return out


def _bone_length_lift(scene: Scene, scale_px: float):
    """2D keypoints + bone-length priors -> (joints3d (17,3), notes).

    The classic single-view trick: a bone's true 3D length L is known (prior),
    its on-screen length l is measured, so its out-of-plane extent is
    dz = sqrt(max(L^2 - l^2, 0)) under an orthographic camera. We place the
    pelvis at the origin, put hips/neck/shoulders/nose in-plane off it, then
    walk the limbs outward accumulating dz.

    The unavoidable catch is the SIGN of every dz — a single view can't tell
    toward-camera from away. The magnitude is still information, so rather than
    guess globally, each ambiguous joint carries its own choice in
    scene.depth_signs (see DEFAULT_DEPTH_SIGN) and the interface exposes them;
    an empty dict reproduces the old all-toward-camera behaviour. Inferring the
    signs instead of being told them is a temporal/multi-view job, not this
    anchor's. Units are whatever scale_px is expressed in (px for the
    non-metric lift, mm once multiplied through for the metric one)."""
    j = np.full((N_JOINTS, 3), np.nan, dtype=float)
    xy = scene.kp2d[:, :2]
    seen = scene.seen

    pelvis = scene._mid(L_HIP, R_HIP)
    if pelvis is None:
        return j, "no pelvis (both hips unseen) — lift not possible"

    def place_inplane(i):
        """Put a directly-off-root joint in the image plane (z == 0, the
        pelvis's depth) — its bone isn't in the prior and its out-of-plane
        offset from the pelvis is small enough to ignore for a first candidate."""
        if seen[i]:
            j[i] = (xy[i, 0] - pelvis[0], xy[i, 1] - pelvis[1], 0.0)

    # Root and the joints hanging straight off it, all kept in-plane.
    for i in (L_HIP, R_HIP, L_SHO, R_SHO, NOSE):
        place_inplane(i)

    # Limbs: dz from the bone-length prior, direction from the per-joint choice.
    # The sign multiplies only THIS bone's dz; the parent's accumulated depth is
    # carried through unchanged, so flipping a forearm swings the wrist about the
    # elbow instead of teleporting the whole arm.
    ambiguous, flipped = 0, 0
    for parent, child in _WALK:
        if not (seen[parent] and seen[child]) or not np.all(np.isfinite(j[parent])):
            continue
        l2d = float(np.hypot(xy[child, 0] - xy[parent, 0],
                             xy[child, 1] - xy[parent, 1]))
        L = _BONE_RATIO[(parent, child)] * scale_px
        dz = float(np.sqrt(max(L * L - l2d * l2d, 0.0)))
        sign = scene.depth_signs.get(child, DEFAULT_DEPTH_SIGN)
        if dz > 1e-6:
            ambiguous += 1
            if sign < 0:
                flipped += 1
        j[child] = (xy[child, 0] - pelvis[0],
                    xy[child, 1] - pelvis[1],
                    j[parent, 2] + sign * dz)

    if not ambiguous:
        note = "bone-length lift; near-frontal limbs, little out-of-plane depth"
    else:
        note = (f"bone-length lift; {ambiguous} limb(s) out of plane, "
                f"{flipped} set away from camera, {ambiguous - flipped} toward "
                f"(single-view sign ambiguity — chosen, not inferred)")
    return j, note


# --- sequence helpers -------------------------------------------------------
# A method computes the whole clip by running its single-frame lift over every
# frame the track carries — so the viewer animates in step with the video. The
# frontend sends the sequence on load, so this runs once per track, not per
# playhead move.

def _lift_sequence(scene, per_frame):
    """Run per_frame(frame_scene) over every frame in scene.sequence.

    Returns {frame_idx (int): (17,3)}; a frame whose lift yields no finite
    joint (pose dropped, no plate to anchor) is simply absent, and the viewer
    holds the last good frame across the gap."""
    out = {}
    for idx, fr in scene.sequence.items():
        fs = Scene(width=scene.width, height=scene.height, kp2d=fr["kp2d"],
                   equipment=fr["equipment"], dataset=scene.dataset)
        j, _ = per_frame(fs)
        if np.any(np.isfinite(j)):
            out[idx] = j
    return out


def _rep_frame(scene, frames_out):
    """The frame joints3d shows when not animating: the one on screen when
    generate ran, else the lift's start, else the earliest solved frame."""
    for cand in (scene.current_frame, scene.start_frame):
        if cand is not None and cand in frames_out:
            return cand
    return min(frames_out) if frames_out else None


# --- concrete anchors -------------------------------------------------------

class KeypointLiftDetector(DepthDetector):
    """Bone-length lift straight off the 2D pose. The always-available baseline:
    needs no equipment and no pixels, just enough visible joints. Confidence is
    purely how complete and confident the 2D skeleton is."""
    name = "keypoint-lift"
    label = "Keypoint lift (2D→3D bones)"
    description = ("Lifts the ViTPose skeleton to 3D with anthropometric "
                   "bone-length priors. No equipment or scale needed; output "
                   "is unit-torso, not metric.")

    # The joints that carry the lift; head points are optional garnish.
    _CORE = (L_SHO, R_SHO, L_HIP, R_HIP, L_ELB, R_ELB, L_WRI, R_WRI,
             L_KNE, R_KNE, L_ANK, R_ANK)

    def confidence(self, scene: Scene) -> float:
        seen = scene.seen
        core_seen = [i for i in self._CORE if seen[i]]
        coverage = len(core_seen) / len(self._CORE)
        if not core_seen:
            return 0.0
        mean_conf = float(np.mean(scene.kp2d[core_seen, 2]))
        # Need a torso to scale the bones; without it the lift is meaningless.
        torso_ok = 1.0 if np.isfinite(scene.torso_px) and scene.torso_px > 1 else 0.0
        return float(np.clip(coverage * mean_conf * torso_ok, 0.0, 1.0))

    def mesh(self, scene: Scene) -> MeshCandidate:
        note = "bone-length lift, unit-torso"
        frames_out = None
        if scene.sequence:
            frames_out = _lift_sequence(
                scene, lambda fs: _bone_length_lift(fs, scale_px=fs.torso_px))
            rep = _rep_frame(scene, frames_out)
            j = (frames_out[rep] if rep is not None
                 else np.full((N_JOINTS, 3), np.nan))
            note = f"bone-length lift over {len(frames_out)} frames, unit-torso"
        else:
            j, note = _bone_length_lift(scene, scale_px=scene.torso_px)
        return MeshCandidate(self.name, self.confidence(scene), j, EDGES,
                             metric=False, notes=note, frames=frames_out)


# --- plate-anchor geometry --------------------------------------------------
# The metric, barbell-anchored lift. A bumper plate is a 450mm circle of known
# size, so fitting an ellipse to it gives BOTH a metric scale and the bar's 3D
# orientation, and the snatch grip pins the wrists to the bar. From there the
# limbs are reached with population bone lengths, depth signed toward the camera.

PLATE_RADIUS_MM = PLATE_DIAMETER_MM / 2.0

# Absolute limb lengths (mm), population averages, scaled per subject by the
# metric shoulder width the plate hands us. Keyed by the unordered joint pair.
_BONE_MM = {
    frozenset((L_SHO, R_SHO)): 380.0,
    frozenset((L_SHO, L_HIP)): 520.0, frozenset((R_SHO, R_HIP)): 520.0,
    frozenset((L_HIP, R_HIP)): 240.0,
    frozenset((L_SHO, L_ELB)): 320.0, frozenset((R_SHO, R_ELB)): 320.0,
    frozenset((L_ELB, L_WRI)): 260.0, frozenset((R_ELB, R_WRI)): 260.0,
    frozenset((L_HIP, L_KNE)): 420.0, frozenset((R_HIP, R_KNE)): 420.0,
    frozenset((L_KNE, L_ANK)): 420.0, frozenset((R_KNE, R_ANK)): 420.0,
    frozenset((NOSE, L_SHO)): 300.0, frozenset((NOSE, R_SHO)): 300.0,
}
# Undirected skeleton along which depth PROPAGATES outward from the wrists (the
# only joints the bar pins in 3D). BFS handles direction; order is irrelevant.
_PROP_EDGES = [
    (L_WRI, L_ELB), (L_ELB, L_SHO), (R_WRI, R_ELB), (R_ELB, R_SHO),
    (L_SHO, R_SHO), (L_SHO, L_HIP), (R_SHO, R_HIP), (L_HIP, R_HIP),
    (L_HIP, L_KNE), (L_KNE, L_ANK), (R_HIP, R_KNE), (R_KNE, R_ANK),
    (L_SHO, NOSE), (R_SHO, NOSE),
]
_Z_CLAMP_MM = 3000.0    # nothing on a lifter is 3m deep; guards degenerate fits
# A wrist can't be more than ~1m in front of / behind the near plate during a
# lift. The bar-depth formula divides by sin(tilt), which blows up for a
# near-frontal plate (bar pointing at the camera) paired with a wide bar box —
# an inconsistent detection, not a real 3m-deep hand. Bound it physically.
_WRIST_Z_CLAMP_MM = 1000.0


def _fit_ellipse(plate):
    """cv2.fitEllipse over a plate's mask polygon -> dict, or None.

    Gives the centre, full major/minor axis lengths (px), tilt, and the ellipse's
    extreme leftmost/topmost points — the four points the coordinate frame is
    built from. Needs the SAM3 polygon (>=5 pts); falls back to the box as a
    head-on disc when only a box exists (DINO), which loses the tilt but keeps a
    centre and scale."""
    poly = plate.get("polygon")
    if poly and len(poly) >= 5:
        pts = np.array(poly, dtype=np.float32)
        (cx, cy), (a1, a2), ang = cv2.fitEllipse(pts)
        major, minor = max(a1, a2), min(a1, a2)
    else:
        box = plate.get("box")
        if not box:
            return None
        x0, y0, x1, y1 = box
        cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        major = minor = float(min(x1 - x0, y1 - y0))   # short side = a disc
        ang = 0.0
    # Sample the ellipse to read its leftmost (min x) and topmost (min y) points
    # analytically: point(t) = c + R(angle) @ (A cos t, B sin t).
    A, B = major / 2.0, minor / 2.0
    th = np.deg2rad(ang)
    ct, st = np.cos(th), np.sin(th)
    ts = np.linspace(0, 2 * np.pi, 180, endpoint=False)
    xs = cx + A * np.cos(ts) * ct - B * np.sin(ts) * st
    ys = cy + A * np.cos(ts) * st + B * np.sin(ts) * ct
    li, ti = int(np.argmin(xs)), int(np.argmin(ys))
    return {"c": np.array([cx, cy]), "major": major, "minor": minor,
            "angle": ang, "left": np.array([xs[li], ys[li]]),
            "top": np.array([xs[ti], ys[ti]])}


def _plate_frame(plates, bar_box):
    """Pick near + far plates and build the metric 3D bar frame, or None.

    near = the largest ellipse (the plate most face-on to the camera reads as the
    biggest, roundest disc = the outermost of the near stack). far = the valid
    ellipse whose centre is farthest from near along the bar (the innermost of
    the far stack / the other end). With one plate we keep the near frame and
    take the bar direction from the bar box, then the near ellipse minor axis."""
    ell = [_fit_ellipse(p) for p in (plates or [])]
    ell = [e for e in ell if e is not None]
    if not ell:
        return None
    ell.sort(key=lambda e: -e["major"])
    near = ell[0]
    # Metric scale: the plate's true radius maps to the ellipse's major
    # semi-axis (the least-foreshortened radius).
    s = PLATE_RADIUS_MM / max(near["major"] / 2.0, 1e-6)
    # Plate-normal (== bar axis) tilt from the camera axis: a circle tilted by
    # alpha projects to minor/major = cos(alpha).
    cos_a = float(np.clip(near["minor"] / max(near["major"], 1e-6), 0.0, 1.0))
    sin_a = float(np.sqrt(max(1.0 - cos_a * cos_a, 0.0)))

    far = None
    for e in ell[1:]:
        if far is None or (np.hypot(*(e["c"] - near["c"]))
                           > np.hypot(*(far["c"] - near["c"]))):
            far = e
    if far is not None and np.hypot(*(far["c"] - near["c"])) > 3:
        bar_img = far["c"] - near["c"]
    elif bar_box is not None:
        x0, y0, x1, y1 = bar_box
        bar_img = (np.array([float(x1 - x0), 0.0]) if (x1 - x0) >= (y1 - y0)
                   else np.array([0.0, float(y1 - y0)]))
    else:
        th = np.deg2rad(near["angle"])
        bar_img = np.array([np.sin(th), -np.cos(th)])
    nrm = np.hypot(*bar_img)
    bar_dir = bar_img / nrm if nrm > 1e-6 else np.array([1.0, 0.0])
    # 3D bar axis (unit): image projection is sin_a along bar_dir; it recedes
    # from the camera (near faces us, far away) so its z is negative.
    bar_axis = np.array([bar_dir[0] * sin_a, bar_dir[1] * sin_a, -cos_a])
    return {"near": near, "far": far, "s": s, "sin_a": sin_a, "cos_a": cos_a,
            "bar_dir": bar_dir, "bar_axis": bar_axis}


def _plate_anchor_lift(kp2d, seen, plates, bar_box):
    """Metric 3D (mm) from the plate frame + wrists-on-bar + limb propagation.

    Returns (joints3d (17,3), note). Every depth sign defaults toward the camera,
    per the method's spec — the single view can't tell front from back."""
    fr = _plate_frame(plates, bar_box)
    if fr is None:
        return np.full((N_JOINTS, 3), np.nan), "no plate ellipse to anchor to"
    s, C = fr["s"], fr["near"]["c"]
    xy = kp2d[:, :2]
    j = np.full((N_JOINTS, 3), np.nan)

    def bar_depth_at(px):
        """z (mm) of the bar directly below an image point — the depth a wrist
        'vertically above the bar' inherits. Intersect the vertical through px
        with the projected bar line, turn that along-bar image offset into a 3D
        length, take its z. Near-plate centre is the z=0 origin."""
        bx = fr["bar_dir"][0]
        t = ((px[0] - C[0]) / bx if abs(bx) > 1e-3
             else float(np.dot(px - C, fr["bar_dir"])))   # vertical bar: perp foot
        u_mm = (t * s) / max(fr["sin_a"], 1e-3)
        return float(np.clip(u_mm * fr["bar_axis"][2],
                             -_WRIST_Z_CLAMP_MM, _WRIST_Z_CLAMP_MM))

    # Seed depths from the wrists the bar pins. "Wrist vertically above the bar":
    # the wrist keeps its own image x,y and takes the bar's depth beneath it.
    z0 = {w: bar_depth_at(xy[w]) for w in (L_WRI, R_WRI) if seen[w]}
    if not z0:                       # no wrist to pin — anchor the pelvis at z=0
        root = L_HIP if seen[L_HIP] else (R_HIP if seen[R_HIP] else None)
        if root is None:
            return j, "no wrist and no hip visible — nothing to anchor"
        z0[root] = 0.0

    # Per-subject limb scale from the metric shoulder width (falls back to 1.0).
    factor = 1.0
    if seen[L_SHO] and seen[R_SHO]:
        sw = float(np.hypot(*(xy[L_SHO] - xy[R_SHO]))) * s
        factor = float(np.clip(sw / 380.0, 0.5, 2.0))

    adj = {i: [] for i in range(N_JOINTS)}
    for a, b in _PROP_EDGES:
        adj[a].append(b); adj[b].append(a)

    zval = np.full(N_JOINTS, np.nan)
    dq = deque()
    for i, z in z0.items():
        zval[i] = z; dq.append(i)
    while dq:                        # BFS: dz from the bone-length prior
        p = dq.popleft()
        for c in adj[p]:
            if not seen[c] or np.isfinite(zval[c]):
                continue
            L = _BONE_MM.get(frozenset((p, c)), 300.0) * factor
            l2d = float(np.hypot(*(xy[c] - xy[p]))) * s
            dz = float(np.sqrt(max(L * L - l2d * l2d, 0.0)))
            zval[c] = float(np.clip(zval[p] + dz, -_Z_CLAMP_MM, _Z_CLAMP_MM))
            dq.append(c)

    for i in range(N_JOINTS):
        if seen[i] and np.isfinite(zval[i]):
            j[i] = (xy[i, 0] * s, xy[i, 1] * s, zval[i])

    # Root-centre at the pelvis so the viewer frames the lifter wherever they
    # stood in the image.
    pelvis = None
    if seen[L_HIP] and seen[R_HIP]:
        pelvis = (j[L_HIP] + j[R_HIP]) / 2.0
    elif seen[L_HIP] and np.all(np.isfinite(j[L_HIP])):
        pelvis = j[L_HIP]
    elif seen[R_HIP] and np.all(np.isfinite(j[R_HIP])):
        pelvis = j[R_HIP]
    if pelvis is not None and np.all(np.isfinite(pelvis)):
        for i in range(N_JOINTS):
            if np.all(np.isfinite(j[i])):
                j[i] = j[i] - pelvis

    tilt_deg = np.rad2deg(np.arccos(fr["cos_a"]))
    note = (f"plate-anchor: {s:.2f} mm/px off a {PLATE_DIAMETER_MM:.0f}mm plate, "
            f"bar tilt {tilt_deg:.0f}°; wrists pinned to bar, limb depth toward "
            f"camera")
    return j, note


class PlateAnchorDetector(DepthDetector):
    """The plate-first metric anchor (coach's flagship depth method).

    Confidence is SAM3's plate-recognition score on the lift's START frame — how
    sure the segmenter is there's a plate to build the whole reconstruction on.
    When selected it fits ellipses to the near (outermost, camera-facing) and far
    (innermost) plates across every frame, builds a metric coordinate frame from
    the four ellipse points, pins the wrists to the bar (the snatch grip — at the
    first pull the wrist sits vertically above the bar), and reaches the rest of
    the body with population limb lengths, depth signed toward the camera. Output
    is per-frame so the viewer animates with the video."""
    name = "plate-anchor"
    label = "Plate anchor (metric, barbell)"
    description = ("Fits ellipses to the barbell plates for a metric scale and "
                   "the bar's 3D tilt, pins the wrists to the bar, and lifts the "
                   "body with limb-length priors. Confidence = SAM3 plate score "
                   "on the start frame. Needs the SAM3 equipment pass.")

    def _start_plates(self, scene: Scene):
        return (scene.start_equipment() or {}).get("plates") or []

    def confidence(self, scene: Scene) -> float:
        plates = self._start_plates(scene)
        if not plates:
            return 0.0
        # SAM3 recognition confidence on the start frame: the strongest plate.
        return float(np.clip(max(p.get("score", 0.0) for p in plates), 0.0, 1.0))

    @staticmethod
    def _per_frame(fs: Scene):
        eq = fs.equipment or {}
        return _plate_anchor_lift(fs.kp2d, fs.seen, eq.get("plates"),
                                  (eq.get("bar") or {}).get("box"))

    def mesh(self, scene: Scene) -> MeshCandidate:
        conf = self.confidence(scene)
        frames_out = None
        if scene.sequence:
            frames_out = _lift_sequence(scene, self._per_frame)
            rep = _rep_frame(scene, frames_out)
            j = (frames_out[rep] if rep is not None
                 else np.full((N_JOINTS, 3), np.nan))
            note = (f"plate-anchor over {len(frames_out)} frames; "
                    f"start={scene.start_frame}, shown={rep}")
        else:
            j, note = self._per_frame(scene)
        return MeshCandidate(self.name, conf, j, EDGES, metric=True,
                             notes=note, frames=frames_out)


class BodyModelDetector(DepthDetector):
    """Placeholder for a learned parametric body model (HMR/SMPL-style): pixels
    in, a full posed surface out. Kept in the registry to prove the framework is
    pluggable and gated — with no weights on disk available() is False, so it's
    listed-but-disabled in the picker and confidence()==0 keeps the router from
    ever selecting it. Wiring the real regressor is a model-add job; the split
    it has to honour (cheap confidence from bbox/coverage, dense mesh only when
    chosen) is already fixed here."""
    name = "body-model"
    label = "Body model / SMPL (needs weights)"
    description = ("Learned parametric-mesh regressor. Not yet installed — "
                   "download weights to enable; will produce a dense surface, "
                   "not just joints.")
    requires_pixels = True

    def available(self) -> bool:
        return False       # no checkpoint wired yet

    def confidence(self, scene: Scene) -> float:
        return 0.0         # never chosen until available() and a real score land

    def mesh(self, scene: Scene) -> MeshCandidate:
        raise NotImplementedError(
            "body-model anchor has no weights installed yet")


# --- registry + router ------------------------------------------------------

# Instantiated once; these hold no per-frame state, so sharing is fine and keeps
# the router from rebuilding objects every scoring pass.
_REGISTRY = [
    PlateAnchorDetector(),
    KeypointLiftDetector(),
    BodyModelDetector(),
]
_BY_NAME = {d.name: d for d in _REGISTRY}


def list_methods() -> list:
    """For the picker: every anchor with its label/description/availability,
    without loading or running anything."""
    return [{
        "name": d.name,
        "label": d.label,
        "description": d.description,
        "available": d.available(),
        "requires_pixels": d.requires_pixels,
    } for d in _REGISTRY]


def get(name: str) -> DepthDetector:
    if name not in _BY_NAME:
        raise KeyError(f"unknown depth method {name!r}; have {list(_BY_NAME)}")
    return _BY_NAME[name]


def confidences(scene: Scene) -> dict:
    """Score EVERY available anchor for this scene — the cheap pass. Unavailable
    anchors are reported as None so the caller can show 'installed but off'
    distinctly from 'scored zero'."""
    out = {}
    for d in _REGISTRY:
        out[d.name] = d.confidence(scene) if d.available() else None
    return out


def pick(scene: Scene):
    """The whole point: rank all anchors by their CHEAP confidence and return
    (winner, scores) — mesh() is deliberately NOT called here, so nothing
    expensive runs until the caller asks the winner for its geometry."""
    scores = confidences(scene)
    ranked = [(name, s) for name, s in scores.items() if s is not None]
    ranked.sort(key=lambda kv: kv[1], reverse=True)
    winner = get(ranked[0][0]) if ranked and ranked[0][1] > 0 else None
    return winner, scores


def generate(scene: Scene, method: str = "auto") -> dict:
    """Score cheaply, then build the mesh for exactly ONE anchor.

    method="auto" runs the router; an explicit name forces that anchor (so the
    picker can override the router to inspect a specific method). Returns the
    chosen name, the full confidence table, and the candidate — or an error
    string when nothing can run (no usable pose, or a forced unavailable
    method)."""
    scores = confidences(scene)
    if method == "auto":
        chosen, _ = pick(scene)
        if chosen is None:
            return {"chosen": None, "confidences": scores,
                    "candidate": None,
                    "error": "no anchor is confident on this frame "
                             "(too few visible joints?)"}
    else:
        chosen = get(method)
        if not chosen.available():
            return {"chosen": method, "confidences": scores, "candidate": None,
                    "error": f"{method} is not installed on this machine"}

    candidate = chosen.mesh(scene)         # the one expensive call
    return {"chosen": chosen.name, "confidences": scores,
            "candidate": candidate.to_json(), "error": None}
