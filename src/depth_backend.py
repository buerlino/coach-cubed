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
# The 3D lift carries ONE head point, not the five COCO gives it. It reuses the
# NOSE slot (so joints3d stays a COCO-17 array and the frontend needs no new
# index) but is positioned at the midpoint of the two eyes — see _collapse_head.
HEAD = NOSE
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
    # One head point, joined to both shoulders — the V reads as a neck. The
    # nose-eye-ear chain is gone: five points inside a head's width told the
    # viewer nothing at this scale, and they were four of the thirteen depth
    # directions the interface asked about.
    (HEAD, L_SHO), (HEAD, R_SHO),
]

# A joint counts as "seen" above this. Matches the frontend's CONF_THRESHOLD so
# confidence here agrees with what the user sees drawn.
CONF_SEEN = float(os.environ.get("COACH_DEPTH_CONF_SEEN", "0.3"))

# The scale reference the equipment detector exists to give: a bumper plate is
# 450mm across. Shared with equipment_backend's PLATE_DIAMETER_MM, redeclared
# here so depth_backend has no import-time dependency on the equipment stack.
PLATE_DIAMETER_MM = float(os.environ.get("COACH_PLATE_DIAMETER_MM", "450"))


# --- scene + candidate ------------------------------------------------------

def _collapse_head(kp2d) -> None:
    """Nose + eyes + ears -> one head point, in place.

    The head lands on the midpoint of the two eyes and takes the NOSE slot; the
    other four are cleared to unseen so nothing downstream places them. Applied
    once in _parse_kp, so every anchor and the sign search all agree on what the
    head is without each having to know.

    The eye midpoint rather than the nose because it is the more stable of the
    two under rotation — the nose swings out as the athlete turns their head,
    the point between the eyes barely moves — and because it sits on the body's
    sagittal midline, which is what lets the lift place it at z=0 rather than
    inventing a depth for it. On the example clip the two differ by 0.066 torso.

    Falls back to the nose when both eyes aren't visible, and leaves the head
    unseen when neither is.
    """
    seen = kp2d[:, 2] >= CONF_SEEN
    if seen[L_EYE] and seen[R_EYE]:
        kp2d[HEAD, :2] = (kp2d[L_EYE, :2] + kp2d[R_EYE, :2]) / 2.0
        # The weakest evidence in the average, not the strongest: this point is
        # only as trustworthy as the eye that was hardest to see.
        kp2d[HEAD, 2] = min(kp2d[L_EYE, 2], kp2d[R_EYE, 2])
    elif not seen[HEAD]:
        kp2d[HEAD] = (np.nan, np.nan, 0.0)
    for j in (L_EYE, R_EYE, L_EAR, R_EAR):
        kp2d[j] = (np.nan, np.nan, 0.0)


def _torso_px(kp2d) -> float:
    """Projected pelvis->neck length of one frame's keypoints, or NaN.

    Module-level rather than a Scene method so clip_torso_px can measure every
    frame of a sequence without building 100+ Scenes to do it."""
    seen = kp2d[:, 2] >= CONF_SEEN
    if not (seen[L_HIP] and seen[R_HIP] and seen[L_SHO] and seen[R_SHO]):
        return float("nan")
    pelvis = (kp2d[L_HIP, :2] + kp2d[R_HIP, :2]) / 2.0
    neck = (kp2d[L_SHO, :2] + kp2d[R_SHO, :2]) / 2.0
    return float(np.hypot(*(neck - pelvis)))


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
    # Segment lengths measured off THIS athlete, as {segment name: fraction of
    # torso} over _SEGMENTS — see clip_bones, which prefers these to both the
    # population priors and its own per-clip estimate. None means "you work it
    # out". The way to fill it is a frame where the athlete faces the camera
    # with the limb extended, since then the projection is the length.
    bone_ratios: Optional[dict] = None
    # Which lift this clip is, as the page id the frontend is on ("snatch",
    # "clean-and-jerk", "lateral-raise"). None means "not said", and every
    # lift-specific step then declines to run rather than guessing: the only
    # thing that reads it is the start-position gate, which is only valid for
    # the lifts that HAVE a start position (see START_POSE_LIFTS).
    lift: Optional[str] = None
    # True when the frontend asked for the signs to be worked out rather than
    # dictated (it posts depth_signs: "auto"). generate() resolves this into
    # depth_signs before any mesh is built, so every detector still just reads
    # the table and none of them has to know inference exists.
    infer_signs: bool = False

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
        # Every Scene in this module sees a one-point head. Only the 3D side is
        # affected: the 2D overlay draws from the frontend's own copy of the
        # track, which still has all five.
        _collapse_head(kp2d)
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
                   lift=(str(payload["lift"]) if payload.get("lift") else None),
                   depth_signs=parse_depth_signs(payload.get("depth_signs")),
                   infer_signs=(payload.get("depth_signs") == "auto"),
                   bone_ratios=parse_bone_ratios(payload.get("bone_ratios")))

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
        """Pelvis->neck length in pixels ON THIS FRAME, or NaN if either midpoint
        is missing. Cheap, and both confidence and the lift want it, so it's
        cached. Note this is the PROJECTED torso, which is why the lift itself
        scales off clip_torso_px instead — see there."""
        if "torso_px" not in self._cache:
            self._cache["torso_px"] = _torso_px(self.kp2d)
        return self._cache["torso_px"]

    @property
    def clip_torso_px(self) -> float:
        """The athlete's torso length in pixels, estimated over the WHOLE clip.

        The body scale every bone prior is multiplied by. It has to be one
        number for the clip, not torso_px per frame, because torso_px is a
        projection: the athlete's torso doesn't change length, only its image
        does. On the test lift it runs 141 px at the bottom of the pull against
        251 px stood up — a factor of 1.78. Scaling the priors by the per-frame
        value shrinks every bone by that factor exactly when the athlete bends
        over, while x and y stay in real pixels, so the recovered z is wrong by
        the foreshortening of a completely different body part.

        A projection is never longer than what it projects, so the per-frame
        values are all lower bounds on the same quantity and the largest is the
        best estimate. p95 rather than max because the top of that distribution
        is keypoint noise, and one bad frame would inflate every bone in the
        clip. Assumes the athlete stays at roughly a fixed distance from the
        camera, which is true of a fixed tripod and not of a pan-and-zoom.
        """
        if "clip_torso_px" not in self._cache:
            vals = [t for t in (
                [_torso_px(fr["kp2d"]) for fr in self.sequence.values()]
                if self.sequence else [self.torso_px])
                if np.isfinite(t) and t > 0]
            self._cache["clip_torso_px"] = (
                float(np.percentile(vals, 95)) if vals else self.torso_px)
        return self._cache["clip_torso_px"]

    @property
    def clip_bones(self) -> dict:
        """_BONE_RATIO, re-estimated for THIS athlete from the whole clip.

        Same argument as clip_torso_px one property up, and for the same reason:
        a projection is never longer than what it projects, so every frame's
        measured segment is a lower bound on its true length and the top of the
        distribution is the best estimate available from one view. p95 rather
        than max because the tail is keypoint noise.

        The population priors are not merely imprecise, they are too LONG, and
        that is the dominant error in the whole lift. dz = sqrt(L^2 - l^2) turns
        every excess millimetre of prior into fabricated depth: the 0.85 thigh
        against a 0.69 longest-ever projection forces the knee 0.48 torso out of
        the image plane on the very frame the leg is straightest, and no sign
        search can undo it because all 256 candidates share the magnitude and
        differ only in which side of the plane it lands on. Measured at the
        median frame, the thigh was 59-80% out of plane; this brings three of
        the four clips to 29-35%. Hip flexion of 38 deg on an athlete standing
        still in a cable lateral raise is the same error read as an angle.

        Pooled over left and right, because it is one person: the two femurs are
        the same length even when the pose is not symmetric, so the side that
        happens to extend fully in this clip calibrates the side that never
        does. Clamped to +/-25% of the population value so a clip in which the
        athlete never straightens cannot collapse a bone to nothing.

        A segment named in self.bone_ratios overrides all of that and is used as
        given, unclamped — it is a measurement of this athlete rather than an
        inference about them, and the clamp exists only to bound a guess. The
        estimate still covers any segment the caller didn't measure.
        """
        if "clip_bones" not in self._cache:
            frames = (list(self.sequence.values()) if self.sequence
                      else [{"kp2d": self.kp2d}])
            scale = self.clip_torso_px
            given = self.bone_ratios or {}
            out = {}
            for pair, sides in _BONE_SIDES.items():
                L = _BONE_RATIO[pair]
                ref = given.get(_SEGMENT_OF[pair])
                if ref is not None:
                    out[pair] = float(ref)
                    continue
                vals = [d for (a, b) in sides for d in (
                    float(np.hypot(*(fr["kp2d"][b, :2] - fr["kp2d"][a, :2]))) / scale
                    for fr in frames
                    if fr["kp2d"][a, 2] >= CONF_SEEN and fr["kp2d"][b, 2] >= CONF_SEEN)
                    if np.isfinite(d)]
                est = float(np.percentile(vals, 95)) if vals else L
                out[pair] = float(np.clip(est, 0.75 * L, 1.25 * L))
            self._cache["clip_bones"] = out
        return self._cache["clip_bones"]

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
    # Whether this anchor reads scene.depth_signs at all. The viewer lets a
    # joint be clicked to flip its direction, and that has to be off for an
    # anchor that resolves depth some other way (plate-anchor pins the wrists to
    # the bar and propagates outward) — otherwise the click changes the stored
    # table, the reconstruction doesn't move, and the control looks broken.
    signed: bool = False
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
            "signed": self.signed,
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
}
# Walk order: each child reached from an already-placed parent. Hips, shoulders
# and the head are placed directly off the synthetic pelvis/neck first.
#
# The head is deliberately NOT walked. Reaching it from the neck with a fixed
# prior would treat neck-to-eyes as a rigid segment, and it isn't — the athlete
# looks down through the pull, so on the example clip that distance projects to
# 0.37 torso at the median against 0.59 at its longest. A prior long enough to
# cover the 0.59 invents sqrt(0.62^2-0.37^2)=0.50 torso of depth at a typical
# frame, which is the same manufactured-depth failure the per-frame torso scale
# used to cause. The head sits on the body's sagittal midline instead, where
# z=0 is right by construction and no prior is needed.
_WALK = [
    (L_HIP, L_KNE), (L_KNE, L_ANK), (R_HIP, R_KNE), (R_KNE, R_ANK),
    (L_SHO, L_ELB), (L_ELB, L_WRI), (R_SHO, R_ELB), (R_ELB, R_WRI),
]

# The same segment on the two sides of one body. Named because these names are
# the wire format: a caller that has measured a particular athlete posts
# {"thigh": 0.73, ...} and Scene.clip_bones uses it instead of guessing.
_SEGMENTS = {
    "thigh": ((L_HIP, L_KNE), (R_HIP, R_KNE)),
    "shank": ((L_KNE, L_ANK), (R_KNE, R_ANK)),
    "uarm":  ((L_SHO, L_ELB), (R_SHO, R_ELB)),
    "farm":  ((L_ELB, L_WRI), (R_ELB, R_WRI)),
}
# Keyed both ways so either half of a pair finds its partner. clip_bones pools
# the two sides' measurements, which is the only place the left and right halves
# of this model are coupled at all.
_BONE_SIDES = {p: sides for sides in _SEGMENTS.values() for p in sides}
_SEGMENT_OF = {p: name for name, sides in _SEGMENTS.items() for p in sides}
_SEGMENT_LABELS = {
    "thigh": "thigh (hip→knee)", "shank": "shank (knee→ankle)",
    "uarm": "upper arm (shoulder→elbow)", "farm": "forearm (elbow→wrist)",
}
# A ratio outside this band is not a limb, it is a bug at the other end. Wide on
# purpose: the whole point of measuring an athlete is to leave the population
# priors behind, so this bounds nonsense rather than disagreement.
LIMB_RATIO_RANGE = (0.1, 2.0)


def limb_segments() -> list:
    """The per-athlete limb ratios the UI can edit, in display order.

    Derived from _SEGMENTS and _BONE_RATIO rather than listed by hand, for the
    same reason sign_joints() is: adding a segment to the prior must not leave
    the interface silently missing its field. `default` is the population value,
    which is also exactly the `default` profile.
    """
    return [{"key": name,
             "label": _SEGMENT_LABELS.get(name, name),
             "default": _BONE_RATIO[sides[0]],
             "min": LIMB_RATIO_RANGE[0], "max": LIMB_RATIO_RANGE[1]}
            for name, sides in _SEGMENTS.items()]


def default_limb_ratios() -> dict:
    """The population priors as a profile body — the `default` profile, i.e.
    what the lift runs with when nobody has been measured."""
    return {name: _BONE_RATIO[sides[0]] for name, sides in _SEGMENTS.items()}


# --- the depth-sign ambiguity ----------------------------------------------
# Every joint reached by walking a bone out from its parent gets a dz whose
# MAGNITUDE the bone-length prior fixes and whose SIGN a single view cannot:
# an elbow foreshortened by 30px is equally consistent with bending toward the
# camera or away from it. These are exactly the children in _WALK — the joints
# placed in-plane (hips, shoulders, nose, pelvis) carry no dz and so no choice.
DEFAULT_DEPTH_SIGN = +1          # toward the camera, the historical behaviour

# One row per direction the interface can be asked about. The head is absent on
# purpose: it sits on the sagittal midline, so it has no left/right choice, and
# its depth follows the trunk lean, which is solved rather than chosen (see
# _fit_trunk). That replaces the four rows the eyes and ears used to occupy.
_JOINT_LABELS = {
    L_KNE: "left knee", L_ANK: "left ankle", R_KNE: "right knee", R_ANK: "right ankle",
    L_ELB: "left elbow", L_WRI: "left wrist", R_ELB: "right elbow", R_WRI: "right wrist",
    L_SHO: "torso — left side",
}


def sign_joints() -> list:
    """The depth directions selectable in the UI: the trunk, then each limb
    joint reached by walking a bone.

    Derived from TORSO_SIGN_KEY and _WALK rather than listed by hand, so adding
    a bone to the prior can't leave the interface silently missing its toggle.
    "toward" on the trunk row means the athlete's left side is nearer the
    camera, which is why it carries its own wording in the frontend.

    `also` lists the other joints a click should route to this control, and
    `searched` says whether the solver chooses this one or it just follows the
    trunk — the viewer greys the followers rather than pretending they're free.
    """
    out = [{"index": TORSO_SIGN_KEY, "label": _JOINT_LABELS[TORSO_SIGN_KEY],
            "default": DEFAULT_DEPTH_SIGN}]
    out += [{"index": child, "label": _JOINT_LABELS.get(child, f"joint {child}"),
             "default": DEFAULT_DEPTH_SIGN}
            for _, child in _WALK]
    for row in out:
        row["also"] = list(_SIGN_ALIASES.get(row["index"], ()))
        row["searched"] = row["index"] in _SIGN_FREE
    return out


# --- inferring the signs ----------------------------------------------------
# Every limb joint is free. This used to tie the distal joint to the proximal
# one — the wrist bending the same way as the elbow, the ankle as the knee —
# which cut the search from 2**8 to 2**4 and looked like a cheap way to drop the
# combinations that fold a limb back through itself.
#
# It is correct for a straight limb and exactly backwards for a flexed one, and
# a lift is mostly flexed limbs. In the bottom of a squat the thigh travels
# forward from the hip and the shank travels BACK from the knee; tying the two
# signs makes the two depths add instead of cancel, so the ankle lands roughly a
# thigh plus a shank out of plane. Measured on the test lift that put the two
# feet 1.86 torso — near enough a metre — apart in depth, which is not a stance
# any athlete can take. The feet-together squat wasn't scored badly, it was
# unreachable: no assignment of the four tied bits could express it.
#
# So the distal joints get their own bit. 2**9 = 512 assignments, 256 once
# mirrors are folded out, which is only affordable because the search below is
# vectorised over candidates rather than lifting each one in turn.
#
# The face still follows the trunk (see expand_signs): those joints carry a dz
# of a few millimetres, the head does turn with the shoulders, and searching
# them would quadruple the candidate count to decide nothing.
# How much the anatomical-distance term counts against the balance term. Small
# by design — see _cost. Large enough to break a tie between two candidates the
# balance test scores equally, far too small to overturn its ordering.
_VIOLATION_WEIGHT = 0.001

# How much the stance term counts. Balance and stance are both measured in
# torso lengths of physical implausibility, so they go in at par and this is 1.0
# rather than a tuned knob: anything in 0.5..2.0 picks the same assignment on
# the test lift, and it is the term's presence, not its size, that rules out the
# splayed-feet reconstructions the tied rule used to force. See _cost.
_STANCE_WEIGHT = 1.0

# --- left/right symmetry about the body's own midplane -----------------------
# Balance and stance are both statements about ONE aggregate of the body (where
# its mean sits, how far the two feet are apart), so each of them collapses a
# 9-bit assignment to a single number and leaves most of the assignment
# unconstrained. This term instead asks something of every limb at once: a
# barbell lift is a bilateral movement, so the athlete's left half should be
# very nearly the mirror image of their right half.
#
# The mirror is taken about the plane through the three midpoints the user's
# own anatomy defines — mid-shoulder, mid-hip, mid-knee. Those three points are
# on the body's midline by construction, and the plane through them is the
# sagittal plane, tilted and twisted exactly as the athlete is. Nothing about
# the camera enters, which is what makes it usable when balance is not: it does
# not need the athlete to be standing still, or standing at all.
#
# Reflecting the left joint of a pair about that plane should land on the right
# joint. With m the pair's midpoint, d the left->right vector and n the unit
# normal, the reflection error works out to
#
#     residual^2 = |d|^2 - (d.n)^2  +  4 ((m - hip_mid).n)^2
#                  \-- d must point across the plane --/   \-- and the pair must
#                                                              straddle it --/
#
# Both halves matter and they catch different mistakes: the first says a pair
# cannot be displaced along the body (one knee a foot higher than the other in
# depth), the second that the pair cannot sit bodily off to one side. For the
# shoulders, hips and knees the second term is identically zero — those are the
# three pairs that DEFINE the plane — so they contribute only the first, and the
# elbows, wrists and ankles carry the discriminating weight.
_SYM_PAIRS = ((L_SHO, R_SHO), (L_ELB, R_ELB), (L_WRI, R_WRI),
              (L_HIP, R_HIP), (L_KNE, R_KNE), (L_ANK, R_ANK))

# The plane is undefined when its three points fall on a line, which is not a
# rare corner: stood up at lockout the mid-knee sits almost directly below the
# mid-hip and the mid-shoulder almost directly above it. Candidates whose own
# geometry is that close to collinear are not scored on that frame rather than
# being scored against a normal that is mostly rounding error. sin(6 deg).
_SYM_MIN_SIN = 0.10

# MEASURED, and the reason this term is reported but NOT summed into the cost.
# Scored over all 256 assignments on the four fixture clips, the best-achievable
# residual is 0.44-0.61 torso and the spread across candidates is only 0.15-0.23
# (std), so the thing being minimised is ~4x smaller than the error it sits on.
# Turning the term on changes the chosen assignment on two of the four clips and
# makes one of them measurably worse (max |z| 0.41 -> 0.77 torso on
# lateral-raise-cable-2); on the other two it picks what balance+stance already
# picked. Adding it would be shipping noise.
#
# The residual is not the plane's fault, and that is the useful finding. Brute-
# forcing the mirror plane over a sphere grid — letting it be whatever fits best
# rather than the three midpoints — only brings the floor from ~0.47 to ~0.37
# torso. No sign assignment and no plane makes these reconstructions bilaterally
# symmetric, because the depth MAGNITUDES are wrong before any sign is chosen:
# see _BONE_RATIO, where the longest thigh projection ever observed on a clip of
# a stood-up athlete is 0.69-0.73 torso against the 0.85 prior, and
# dz = sqrt(L^2 - l^2) turns that 20% length error into ~0.5 torso of depth that
# is not there. That fabricated depth is what any sign-scoring measure is trying
# to arrange, and it is three times bigger than the arrangement.
#
# Set this to 1.0 to fold it in; it is deliberately 0.0 until the magnitudes are
# fixed, because ranking cannot repair poses that are wrong for another reason.
_SYMMETRY_WEIGHT = 0.0

# --- the torso is not a flat plate -------------------------------------------
# Shoulders and hips used to be pinned to z == 0, which asserts the trunk is
# exactly parallel to the screen. Filmed from the side that is plainly false,
# and it is not a small error: on the test lift the shoulders sit 0.43 torso
# apart on screen against a true ~0.85, so 0.67 torso of depth was being thrown
# away across that one pair, and 0.45 across the hips — as much as or more than
# the limb depths this module goes to such trouble to sign. Worse, every limb
# is walked outward from those joints, so flattening the trunk put every arm
# and leg in the wrong place before their own signs were ever considered.
#
# Same trick as the bones: a width known in 3D, measured foreshortened in 2D,
# gives the out-of-plane extent. Widths are relative to torso length
# (pelvis->neck).
#
# These come from _BONE_MM, the module's other anthropometry table, so the two
# lifts can't disagree about the same athlete. Its 520mm is the LATERAL
# shoulder->hip run, so the midline torso the ratios are keyed on is
# sqrt(520^2 - ((380-240)/2)^2) = 515mm, giving 380/515 = 0.74 shoulders and
# 240/515 = 0.47 hips.
#
# They were previously 0.85 and 0.72, picked to sit above the largest separation
# seen on one clip. That was too generous by a lot, and the hips especially:
# 0.72 says the pelvis is nearly as wide as the shoulders, which is wrong for
# COCO hip keypoints because they sit on the pelvis rather than the trochanters.
# The cost was a fixed ~0.32 torso of depth on EACH hip and 0.38 on each
# shoulder — on an athlete standing square to the lens — and because
# _depth_plan inherits the parent's row (M[child] = M[parent]) every limb joint
# was displaced by it before its own sign was considered.
#
# Widest separation actually observed, over all four fixture clips:
#     shoulders  0.57 / 0.75 / 0.44 / 0.55      hips  0.36 / 0.48 / 0.44 / 0.50
# so two clips overshoot these widths on 10-14% of frames and clamp to zero
# trunk depth there. That is benign rather than a bug: a pair projects widest
# exactly when it is squarest to the camera, which is when its true out-of-plane
# extent really is ~0. The old values avoided the clamp only by manufacturing
# depth on every other frame to do it.
SHOULDER_WIDTH = float(os.environ.get("COACH_SHOULDER_WIDTH", "0.74"))
HIP_WIDTH = float(os.environ.get("COACH_HIP_WIDTH", "0.47"))

# --- the camera is not orthographic ------------------------------------------
# dz = sqrt(L^2 - l^2) is the ORTHOGRAPHIC relation: it reads the on-screen
# length l as the bone's in-plane extent, which is only true if distance doesn't
# change apparent size. A real camera shrinks what is far away, so a joint that
# sits toward the lens images LONGER than its in-plane extent and the lift
# credits the difference to depth it doesn't have.
#
# For a pinhole, a point at camera distance Z_cam images at u = f*X/Z_cam with u
# measured from the principal point. In px-at-the-pelvis-plane units, with z
# positive toward the camera, that inverts to
#
#     X = u * (1 - z/f_px)
#
# so the correction needs only the focal length in pixels — no separate camera
# distance. z isn't known until the lift runs and the lift needs the corrected
# lengths, hence the fixed point: lift, un-project, lift again.
#
# The map does NOT converge on its own. Toward-camera is positive feedback —
# larger z shortens the apparent bone, which grows dz, which grows z — and
# undamped the step size plateaus at 0.32-0.51 torso in a period-2 limit cycle
# on three of the four fixture clips (the chosen sign string flip-flops between
# two values with the iteration count). Averaging each pass with the previous z
# fixes it: at _PERSP_DAMP = 0.5 every clip settles below 0.005 torso within
# eight passes.
_PERSP_DAMP = 0.5

# Focal length as a multiple of the frame's long side. 1.0 is the usual
# single-view default (~53 deg horizontal on a landscape frame); we cannot
# measure it from the videos, which is the problem with this whole correction —
# see _PERSP_ITERS.
_FOCAL_MUL = float(os.environ.get("COACH_FOCAL_MUL", "1.0"))

# MEASURED, and the reason this defaults to 0 (= today's orthographic lift).
# The mechanism is real and the implementation converges, but switching it on
# makes the reconstructions WORSE on the current priors:
#
#   clip                  sym 0 -> 12 passes   max|z| 0 -> 12    feet 0 -> 12
#   lateral-raise-1          0.47 -> 0.68       1.01 -> 1.21     0.48 -> 0.37
#   lateral-raise-2           n/a -> 0.76       0.96 -> 0.82     0.47 -> 0.35
#   athlete-a                 0.67 -> 0.67       0.46 -> 0.48     0.28 -> 0.26
#   athlete-b c&j                0.61 -> 0.74       0.95 -> 1.14     0.28 -> 0.28
#
# Mirror symmetry degrades on three of four and max depth inflates ~20%, which
# is the feedback direction above: the correction is a GAIN on the current depth
# estimate, and that estimate is mostly fabricated (see _BONE_RATIO — ~0.5 torso
# of thigh depth on an athlete whose legs are straight and near-frontal). Scaling
# up an error makes a bigger error. The feet do come together, but that is the
# one term that was already smallest.
#
# It is also not calibratable: the camera sits 4-16 torso lengths away on these
# clips, so z/f_px runs 0.06-0.25 and the correction is a 6-25% change in bone
# length — the same order as the prior error it is being applied on top of. The
# chosen sign string differs between _FOCAL_MUL 0.75, 1.0 and 2.0 on every clip,
# and nothing in a single video measures which is right.
#
# Revisit once the bone priors are tailored per athlete: the correction is a
# multiplier, so it is only worth applying to a depth estimate that is already
# approximately right. Set to ~12 (with _PERSP_DAMP 0.5) to switch it on.
_PERSP_ITERS = int(os.environ.get("COACH_PERSP_ITERS", "0"))

# Which way the trunk is turned: +1 means the athlete's LEFT side is nearer the
# camera. Keyed on L_SHO so it travels in the same per-joint dict as everything
# else and needs no parallel plumbing. Shoulders and hips share this one bit
# rather than getting one each: independent signs would allow a trunk twisted
# 180 degrees between hip and shoulder, which no one can do. The cost is that
# real (modest) torso twist isn't modelled — the trunk is treated as rigid.
TORSO_SIGN_KEY = L_SHO

# The bits the solver searches: the trunk plus every limb joint, distal ones
# included. TORSO_SIGN_KEY leads so that fixing it to +1 enumerates exactly one
# representative of each mirror pair (see infer_depth_signs). The trunk's LEAN
# is not here: the whole trunk orientation is solved, not searched — see
# _fit_trunk — and the one bit a single view cannot resolve is the twist itself.
_SIGN_FREE = (TORSO_SIGN_KEY, L_ELB, R_ELB, L_WRI, R_WRI,
              L_KNE, R_KNE, L_ANK, R_ANK)

# Every joint that carries a depth sign at all, in the order their bits appear
# in the plan matrix below: the trunk, then each child of the bone walk (which
# adds the four face joints the solver doesn't search). This is the full set the
# UI shows and the full set _bone_length_lift reads.
_SIGN_SLOTS = (TORSO_SIGN_KEY,) + tuple(child for _, child in _WALK)
_SLOT = {j: i for i, j in enumerate(_SIGN_SLOTS)}

# Clicking a joint in the 3D view flips its direction, but not every joint has
# one of its own: the trunk is a single bit shared by both shoulders and both
# hips (see TORSO_SIGN_KEY), so a click on any of the four has to resolve to the
# same control. Declared here so the frontend can pick joints without hardcoding
# the COCO layout, which is the same reason sign_joints() exists at all.
_SIGN_ALIASES = {TORSO_SIGN_KEY: (R_SHO, L_HIP, R_HIP)}

# Plausible 3D distance between joints that share NO bone, as a fraction of
# torso length (pelvis->neck == 1). Both ends matter, and the minimum is what
# does the real work:
#
#   The maximum alone is degenerate. Giving two limbs the same sign puts them
#   at similar depths, which makes every cross-body distance SHORTER — so a
#   max-only cost is minimised by setting everything the same way, which is
#   just the old default wearing a search.
#
#   The minimum is the informative half, because two limbs cannot occupy the
#   same space. Filmed side-on — the usual lifting angle, and the case the
#   default gets wrong — left and right knees project almost on top of each
#   other, so a near-zero 2D separation can only be reconciled with a real body
#   by pushing one leg in front of the other. That forces OPPOSITE signs, and
#   it is exactly the configuration the toward-camera default cannot express.
#
# Only pairs whose separation actually VARIES across candidates are listed. The
# trunk joints are not among them: hips, shoulders and head all ride the twist
# bit, which the mirror fold pins to +1, so a trunk-anchored distance is the
# same in every candidate and would just add a constant to every score.
# Built from the same segment lengths as _BONE_RATIO (thigh/shank 0.85, upper
# arm 0.62, forearm 0.50) plus shoulder width 0.55 and hip width 0.30. The
# maxima are deliberately the LIFTING limit rather than the anatomical one: a
# gymnast's full side split really does put the ankles ~2.7 apart, but nobody
# snatches like that, and a bound loose enough to admit the splits is loose
# enough to admit every wrong sign combination too. That trade is the whole
# reason these numbers discriminate — measured on the test lift, the extreme
# combinations push the ankles to 2.40 and the knees to 1.54 apart, which the
# bounds below reject and the anatomical ones would not.
_NONADJ_RANGE = {
    (L_KNE, R_KNE): (0.15, 1.40),
    (L_ANK, R_ANK): (0.15, 1.90),
    (L_ELB, R_ELB): (0.20, 1.60),
    (L_WRI, R_WRI): (0.20, 2.00),
    (L_ELB, R_WRI): (0.15, 2.00),
    (R_ELB, L_WRI): (0.15, 2.00),
    (L_KNE, R_ANK): (0.15, 2.20),
    (R_KNE, L_ANK): (0.15, 2.20),
    (L_ELB, L_KNE): (0.20, 2.00),
    (R_ELB, R_KNE): (0.20, 2.00),
}


def expand_signs(free: dict, mirror: bool = False) -> dict:
    """The searched signs -> the full per-joint table the lift reads.

    Now the identity apart from the mirror: every joint that carries a depth
    sign is searched. It used to fill in the four face joints (which followed
    the trunk) and the four distal joints (which followed their parent); the
    head is one midline point with no sign at all, and the distal joints carry
    their own bits.

    mirror=True negates EVERY joint. That completeness is the point: flipping
    the body about the image plane is only a symmetry if the whole body flips.
    """
    out = dict(free)
    if mirror:
        out = {k: -v for k, v in out.items()}
    return out


# The trunk, hardcoded as one rigid planar quad in torso units: hips at y == 0
# a HIP_WIDTH apart, shoulders a torso above them a SHOULDER_WIDTH apart. Order
# matches _TRUNK_JOINTS.
#
# This replaces two separate constants that could disagree. dz_hip and dz_sho
# used to be computed in ISOLATION, each from its own 2D separation and its own
# width prior, and that is precisely why the shoulders and hips came out
# non-parallel: a rigid trunk turning about its vertical needs
# dz_sho/dz_hip == SHOULDER_WIDTH/HIP_WIDTH exactly, every frame, and nothing
# enforced it. Measured, that ratio ran 1.29 / 1.99 / 2.82 against the 1.57 it
# owes, which on the clean-and-jerk manufactured 18 deg of shear that is not in
# the image at all (3.6 deg between the axes in 2D, 21.7 deg after the lift).
_TRUNK_JOINTS = (L_HIP, R_HIP, L_SHO, R_SHO)
_TRUNK_MODEL = np.array([[ 0.5, 0.0], [-0.5, 0.0], [ 0.5, -1.0], [-0.5, -1.0]])


def _fit_trunk(xy, seen, scale_px):
    """Orthographic pose of the rigid trunk -> its four depths, or None.

    Returns (17,) of depth PER +1 OF TWIST, nonzero only on _TRUNK_JOINTS, so it
    drops straight into the TORSO_SIGN_KEY column of the plan. The planar
    two-fold ambiguity — reflect the trunk about the image plane and it projects
    identically — is exactly that sign, so the geometry hands back the one bit a
    single view genuinely cannot resolve and resolves everything else itself.

    Closed form, no search. A planar model under orthographic projection maps to
    the image by p = s*R[:2] @ m + t, so least-squares the 2x2 block A, then
    recover the missing third column from orthonormality: with a1, a2 the rows of
    A, s^2 is the larger root of

        s^4 - s^2(|a1|^2 + |a2|^2) + |a1|^2|a2|^2 - (a1.a2)^2 = 0

    whose discriminant is (|a1|^2-|a2|^2)^2 + 4(a1.a2)^2 and so never negative —
    there is always a real trunk consistent with the projection. Depths then come
    off the third row r1 x r2.

    Solving beats scoring here, which is the lesson from every other term in this
    module. Giving the lean a length prior and a sign bit like the limbs get was
    tried and is worse than having no lean at all (mean squareness error 22.7 deg
    against 17.0 for a spine pinned flat): sqrt(torso^2 - projected^2) forces a
    magnitude every frame with no way to say "this athlete is upright", and so
    invented 0.36 torso of hinge on a cable lateral raise. Least-squaring the
    lean alone against the two axes gave 9.0 deg; fitting the whole trunk gives
    6.0, and recovers 0.06/0.17/0.16 torso of lean on the three near-upright
    clips against 0.45 on the clean-and-jerk, the one clip where the athlete
    really does hinge.

    The observed image x/y are KEPT — only z comes from the fit. Reprojecting
    the model would make the constraints exact (parallel to the last decimal)
    by throwing away the one measurement we actually trust. What is left over
    is honest 2D noise: hip-to-shoulder axes still disagree by 3.8-11.8 deg.
    """
    if not (all(seen[j] for j in _TRUNK_JOINTS) and scale_px > 0):
        return None
    P = xy[list(_TRUNK_JOINTS)]
    m = _TRUNK_MODEL * np.array([[SHOULDER_WIDTH, 1.0]]) * scale_px
    # HIP_WIDTH is the only per-row difference, so scale the hip row after.
    m[:2, 0] *= HIP_WIDTH / SHOULDER_WIDTH
    mc, pc = m - m.mean(0), P - P.mean(0)
    A, *_ = np.linalg.lstsq(mc, pc, rcond=None)      # mc @ A ~= pc
    a1, a2 = A[:, 0], A[:, 1]
    n1, n2, dot = float(a1 @ a1), float(a2 @ a2), float(a1 @ a2)
    disc = np.sqrt(max((n1 - n2) ** 2 + 4.0 * dot * dot, 0.0))
    sig = (n1 + n2 + disc) / 2.0                     # the root >= max(n1, n2)
    if not (np.isfinite(sig) and sig > 1e-12):
        return None
    r13 = np.sqrt(max(sig - n1, 0.0))
    r23 = np.sqrt(max(sig - n2, 0.0))
    if dot > 0:                                      # need r13*r23 == -a1.a2
        r23 = -r23
    cross = np.cross(np.array([a1[0], a1[1], r13]), np.array([a2[0], a2[1], r23]))
    z = np.zeros(N_JOINTS)
    z[list(_TRUNK_JOINTS)] = (mc @ cross[:2]) / np.sqrt(sig)
    return z if np.all(np.isfinite(z)) else None


def _depth_plan(kp2d, scale_px: float, xy=None, bones=None):
    """The frame's geometry, factored so depth is LINEAR in the sign bits.

    Returns (M, base, valid) or None, where for any sign vector s over
    _SIGN_SLOTS the out-of-plane coordinate of every joint is exactly

        z = M @ s                                 M is (17, len(_SIGN_SLOTS))

    and base is (17, 2) of pelvis-relative image x/y, valid the joints that got
    placed. The factorisation is free: a sign only ever multiplies its own
    bone's dz, and a joint's depth is the sum of the signed dz along the walk
    from the pelvis, so the whole lift is a matrix product and the SEARCH over
    hundreds of sign assignments becomes one matmul per frame instead of
    hundreds of lifts. That is what makes 512 candidates cost less than the 32
    the tied rule used to enumerate one at a time.

    _bone_length_lift is written on top of this rather than beside it, so there
    is one implementation of the geometry and the solver cannot drift from the
    mesh it is choosing signs for.

    `xy` replaces the image coordinates while still taking confidences from
    kp2d, which is how the perspective fixed point re-solves the same walk on
    un-projected positions without a second copy of the geometry. `bones` is the
    segment-length table, defaulting to the population priors; callers with a
    whole clip pass Scene.clip_bones instead, which is measured off the athlete.
    """
    if not (scale_px and np.isfinite(scale_px) and scale_px > 0):
        return None
    bones = _BONE_RATIO if bones is None else bones
    seen = kp2d[:, 2] >= CONF_SEEN
    xy = kp2d[:, :2] if xy is None else xy
    if not (seen[L_HIP] and seen[R_HIP]):
        return None
    pelvis = (xy[L_HIP] + xy[R_HIP]) / 2.0

    M = np.zeros((N_JOINTS, len(_SIGN_SLOTS)))
    valid = np.zeros(N_JOINTS, dtype=bool)
    base = xy - pelvis

    def pair_depth(a, b, width):
        """Out-of-plane half-extent of a left/right pair of known 3D width.

        Returns the depth to put on ONE side; the other takes its negative, so
        the pair straddles the pelvis plane and the trunk turns about its own
        axis instead of the whole body sliding in depth."""
        if not (seen[a] and seen[b]):
            return 0.0
        d2d = float(np.hypot(xy[a, 0] - xy[b, 0], xy[a, 1] - xy[b, 1]))
        W = width * scale_px
        return float(np.sqrt(max(W * W - d2d * d2d, 0.0))) / 2.0

    # The trunk, as one rigid body (see _fit_trunk). Everything it places lands
    # in the TORSO_SIGN_KEY column, so +1 still means the athlete's left side is
    # nearer the camera and the trunk still costs exactly one bit.
    #
    # The fit gives the whole orientation at once, which is the point: solving
    # the twist and the lean SEPARATELY is what let the shoulders and hips
    # disagree, and pinning the lean to zero (the state before this) held the
    # spine flat in the image plane by algebra rather than by evidence.
    t = _SLOT[TORSO_SIGN_KEY]
    z_trunk = _fit_trunk(xy, seen, scale_px)
    if z_trunk is not None:
        for joint in _TRUNK_JOINTS:
            M[joint, t] = z_trunk[joint]
            valid[joint] = True
        neck_z = (z_trunk[L_SHO] + z_trunk[R_SHO]) / 2.0
    else:
        # Not enough of the trunk in frame to orient it. Fall back to the pair
        # rule, which needs only one pair and asserts no lean.
        for a, b, width in ((L_HIP, R_HIP, HIP_WIDTH),
                            (L_SHO, R_SHO, SHOULDER_WIDTH)):
            dz = pair_depth(a, b, width)
            for joint, sgn in ((a, +1.0), (b, -1.0)):
                if seen[joint]:
                    M[joint, t] = sgn * dz
                    valid[joint] = True
        neck_z = 0.0
    # The head rides the top of the spine on the midline, so it takes the neck's
    # depth and no twist of its own. Walking further to the eyes would need a
    # neck->head prior, and that segment is not rigid — the athlete looks down
    # through the pull — which is the same manufactured-depth trap _WALK avoids.
    if seen[HEAD]:
        M[HEAD, t] = neck_z
        valid[HEAD] = True

    # Limbs: dz from the bone-length prior, direction from the joint's own slot.
    # The row is inherited from the parent and only THIS bone's dz is added, so
    # flipping a forearm swings the wrist about the elbow instead of teleporting
    # the whole arm.
    for parent, child in _WALK:
        if not (seen[parent] and seen[child]) or not valid[parent]:
            continue
        l2d = float(np.hypot(xy[child, 0] - xy[parent, 0],
                             xy[child, 1] - xy[parent, 1]))
        L = bones[(parent, child)] * scale_px
        M[child] = M[parent]
        M[child, _SLOT[child]] += float(np.sqrt(max(L * L - l2d * l2d, 0.0)))
        valid[child] = True
    return M, base, valid


def _sign_vector(signs: dict) -> np.ndarray:
    """{joint: ±1} -> the (len(_SIGN_SLOTS),) vector _depth_plan multiplies."""
    return np.array([signs.get(j, DEFAULT_DEPTH_SIGN) for j in _SIGN_SLOTS],
                    dtype=float)


def _balance(j, scale_px):
    """(horizontal offset, |depth offset|) of the body's mean from above the feet.

    A standing athlete is balanced: the centre of mass sits over the base of
    support, so the mean of the joints should be more or less directly above
    the mean of the ankles. "Directly above" means agreeing in BOTH ground-plane
    axes, and that is what makes this the sharp test for depth sign — the x
    offset is fixed by the 2D pose and identical for every candidate, so the
    entire discriminating power sits in the depth term, which is exactly the
    unknown being solved. A sign pattern that hangs the body off to one side
    in depth is one no athlete could hold.

    The solver does this vectorised over candidates inside infer_depth_signs;
    this scalar form is what the report's notebook and any one-off inspection
    use, and the two agree by construction because both read _depth_plan.

    Returns None when too little of the body was solved to mean anything.
    """
    P = [p for p in j if np.all(np.isfinite(p))]
    feet = [j[i] for i in (L_ANK, R_ANK) if np.all(np.isfinite(j[i]))]
    if len(P) < 8 or not feet or not (scale_px and scale_px > 0):
        return None
    com = np.mean(P, axis=0)
    fm = np.mean(feet, axis=0)
    return (abs(float(com[0] - fm[0])) / scale_px,
            abs(float(com[2] - fm[2])) / scale_px)


def _sign_cost(j, scale_px) -> float:
    """How badly a lifted pose violates the non-adjacent distance ranges.

    Squared violation, in torso units, summed over every pair both of whose
    joints were solved. Pairs with a missing joint are skipped rather than
    penalised — an occluded ankle is not evidence about anything.
    """
    if not (scale_px and scale_px > 0):
        return 0.0
    cost = 0.0
    for (a, b), (lo, hi) in _NONADJ_RANGE.items():
        if not (np.all(np.isfinite(j[a])) and np.all(np.isfinite(j[b]))):
            continue
        d = float(np.linalg.norm(j[a] - j[b])) / scale_px
        if d < lo:
            cost += (lo - d) ** 2
        elif d > hi:
            cost += (d - hi) ** 2
    return cost


def _mirror_residual(base, Z, valid, scale_px):
    """How far from left/right symmetric each candidate's pose is.

    `base` is (17, 2) of image x/y shared by every candidate, `Z` is
    (ncand, 17) of their depths — the factorisation _depth_plan hands back — so
    this runs over all 256 assignments at once. Returns

        (residual (ncand,) in torso lengths, scorable (ncand,) bool)

    or None when the frame cannot define a midplane at all. See _SYM_PAIRS for
    the geometry; `scorable` is False for candidates whose own three midpoints
    came out collinear, and those are left out of the frame's average rather
    than scored against a meaningless normal.

    One implementation serves both the vectorised search and _symmetry below,
    for the same reason _bone_length_lift is written on top of _depth_plan: the
    cost the solver minimises and the number an inspection prints cannot drift
    apart if there is only one of them.
    """
    need = (L_HIP, R_HIP, L_SHO, R_SHO, L_KNE, R_KNE)
    if not (scale_px and scale_px > 0) or not all(valid[i] for i in need):
        return None
    ncand = Z.shape[0]
    P = np.empty((ncand, N_JOINTS, 3))
    P[:, :, :2] = base
    P[:, :, 2] = Z

    def mid(a, b):
        return (P[:, a] + P[:, b]) / 2.0

    hm, sm, km = mid(L_HIP, R_HIP), mid(L_SHO, R_SHO), mid(L_KNE, R_KNE)
    u, v = sm - hm, km - hm
    n = np.cross(u, v)
    ln = np.linalg.norm(n, axis=1)
    # |u x v| = |u||v| sin(angle): the collinearity test, scale-free.
    denom = np.linalg.norm(u, axis=1) * np.linalg.norm(v, axis=1)
    scorable = ln > _SYM_MIN_SIN * np.maximum(denom, 1e-9)
    if not scorable.any():
        return None
    nh = n / np.where(ln > 0.0, ln, 1.0)[:, None]

    total = np.zeros(ncand)
    pairs = 0
    for a, b in _SYM_PAIRS:
        if not (valid[a] and valid[b]):
            continue
        d = P[:, b] - P[:, a]
        off = (P[:, a] + P[:, b]) / 2.0 - hm
        across = np.einsum("ij,ij->i", d, nh)      # d.n  — the wanted part
        aside = np.einsum("ij,ij->i", off, nh)     # how far the pair is off-plane
        total += np.sqrt(np.maximum((d * d).sum(1) - across * across, 0.0)
                         + 4.0 * aside * aside)
        pairs += 1
    if not pairs:
        return None
    return total / (pairs * scale_px), scorable


def _symmetry(j, scale_px):
    """Mirror residual of one lifted pose, in torso lengths, or None.

    The scalar counterpart of the term inside score_signs — same code, one
    candidate — for the report's notebook and one-off inspection.
    """
    valid = np.all(np.isfinite(j), axis=1)
    out = _mirror_residual(j[:, :2], j[None, :, 2], valid, scale_px)
    if out is None or not out[1][0]:
        return None
    return float(out[0][0])


# --- humanness: what a real body does that a wrong reconstruction doesn't ----
# Five statements about anatomy that cost nothing to check and that a pose lifted
# with the wrong limb lengths fails. They exist to be MINIMISED over the limb
# ratios (see optimize_limbs): the lift turns the gap between a bone's true
# length and its on-screen length into depth, so wrong lengths bend the body in
# ways a body doesn't bend, and the amount of un-bodylike-ness is a signal about
# the lengths themselves.
#
# Every term is in torso lengths (or a dimensionless |cos|) and is 0 when
# perfect, so they are comparable and the weights below mean something.
HUMANNESS_TERMS = ("midplane", "symmetry", "hands", "arms", "legs")

# The same mirror plane again, but fitted to both of its conditions at once
# instead of to the midpoints and then handed to the separations. Kept apart
# from the five above because it is a different measurement of the same fact,
# not a sixth fact: see _penalty_terms for what changes and why it matters.
MIRROR_TERMS = ("coplanar", "orthogonal")

# Everything measured on a lifted pose, in the column order _penalty_terms uses.
PENALTY_TERMS = HUMANNESS_TERMS + MIRROR_TERMS
TERM_LABELS = {
    "midplane": "paired joints share one midplane",
    "symmetry": "left mirrors right across it",
    "hands": "hands in front of the shins",
    "arms": "both arms in one plane",
    "legs": "each leg's plane is vertical",
    "coplanar": "six midpoints on one plane",
    "orthogonal": "each pair square to that plane",
}
# Starting weights, all 1.0 — every term is already in the same units and
# nothing yet says one of these facts is more true than another. Tune from
# measurement rather than taste.
HUMANNESS_WEIGHTS = {t: 1.0 for t in HUMANNESS_TERMS}

# Which terms the limb optimiser is allowed to fit against. A term at weight 0
# is still measured and still reported — you want to see what the fit did to the
# facts it wasn't steering by — it just doesn't pull.
#
# Three objectives because the five terms are not equally trustworthy, and it
# shows. `legs` asks each leg's plane to be vertical, which a snatch set-up
# breaks on purpose by tracking the knees out over the toes: scored on the one
# athlete whose lengths are measured, that term alone puts 0.265 of a 0.720
# penalty on her TRUE ratios, and the full objective's global minimum sits 0.097
# torso away from them (0.137 on the thigh). `hands` is a hinge and reads 0 at
# every point tested on both fixtures, so it contributes nothing but a
# discontinuity. The mirror pair is what's left once those are set aside: a body
# is mirror-symmetric whatever the lift, and neither statement asks anything of
# how the athlete has chosen to stand. The third objective is that same pair
# measured properly — one plane fitted to both halves of the statement instead
# of to the midpoints alone.
OBJECTIVES = {
    "humanness": {
        "label": "all five anatomical penalties",
        "terms": HUMANNESS_TERMS,
        "description": (
            "Midplane, symmetry, hands, arms and legs, equally weighted. The "
            "widest objective and the one with the most to say — but `legs` "
            "penalises correct snatch technique and the global minimum lands "
            "~0.1 torso off an athlete's measured lengths."),
        "caveat": (
            "This one does not reliably reach its own minimum: it stalls at "
            "0.234 on the snatch fixture where 0.233 exists, and at 0.320 on "
            "the clean & jerk where 0.125 does. The argmin depth configuration "
            "flips mid-descent and the line search cannot cross the kink."),
    },
    "mirror": {
        "label": "mirror plane only (midplane + symmetry)",
        "terms": ("midplane", "symmetry"),
        "description": (
            "Only the two terms that say the body is mirror-symmetric: the six "
            "left/right midpoints share one plane, and each pair lies square "
            "across it. 15 of the 20 conditions, and the only ones that hold "
            "regardless of what the lift asks the athlete to do."),
        "caveat": (
            "Better behaved, not more accurate. Dropping `legs` and `hands` "
            "removes the kink the wide objective stalls on, and this reaches "
            "its own global minimum on both fixtures — but on the athlete whose "
            "lengths are measured it still settles ~0.11 torso away from them "
            "(0.19 on the shank). And `symmetry` cannot reach 0 at all: see the "
            "floor beside it."),
    },
    "mirror_joint": {
        "label": "one mirror plane, fitted to both conditions",
        "terms": MIRROR_TERMS,
        "description": (
            "The same 15 conditions as `mirror`, but one plane has to satisfy "
            "all of them at once: the six midpoints lie on it AND the six "
            "same-joint separations are square to it. `mirror` fits the plane "
            "to the midpoints alone and only then asks the separations about "
            "it, which lets a badly-determined normal be charged to symmetry."),
        "caveat": (
            "It reaches its own minimum — 0.0673 against a global 0.0665 on "
            "the snatch, 0.0770 against 0.0768 on the clean & jerk — and at "
            "the same lengths it reads below `mirror` (0.202 vs 0.291, 0.185 "
            "vs 0.214), because it is allowed to pick a better plane. Neither "
            "is a claim about accuracy: on the measured athlete it settles "
            "0.109 torso off, the same as `mirror`'s 0.107. And `orthogonal` "
            "has its own floor, 0.039 there, which no lengths can go below."),
    },
}
DEFAULT_OBJECTIVE = "humanness"


def list_objectives() -> list:
    """[{name, label, description, terms, caveat}] for the optimiser's picker.

    `caveat` is what this objective is measured to get wrong. It rides along
    with the list so the number lives in one place and the interface quotes it
    rather than restating it.
    """
    return [{"name": k, "label": v["label"], "description": v["description"],
             "terms": list(v["terms"]), "caveat": v["caveat"]}
            for k, v in OBJECTIVES.items()]


def objective_weights(name: Optional[str]) -> dict:
    """{term: 0 or 1} for a named objective. KeyError on an unknown name."""
    spec = OBJECTIVES[DEFAULT_OBJECTIVE if name is None else str(name)]
    return {t: (1.0 if t in spec["terms"] else 0.0) for t in PENALTY_TERMS}


def symmetry_floor(kp2d, scale_px: float) -> Optional[float]:
    """Lowest `symmetry` ANY depth assignment can reach on this frame, or None.

    Worth reporting because it is not small and it is not the optimiser's fault.
    The term is zero only when every left/right separation runs parallel to one
    shared normal — which forces all six separations to share one direction *in
    the image*, and the ratios only ever move z. So the floor is a property of
    the 2D pose, fixed before the lift runs:

        min over phi of  (1/n) * sum_i |u_i| * |sin(theta_i - phi)|

    a length-weighted angular median of the six image separations. Between
    consecutive directions every |sin| term is a concave arch, so the sum is
    concave there and its minimum can only sit at one of the directions — which
    makes this exact at n evaluations rather than a scan. Measured 0.031 torso
    on the snatch fixture (directions spread 15.4 deg) and 0.027 on the clean &
    jerk (10.0 deg), and minimising the term numerically over all 17 depths free
    reproduces both to four places.
    """
    if not (scale_px and np.isfinite(scale_px) and scale_px > 0):
        return None
    u = [(kp2d[b, :2] - kp2d[a, :2]) / scale_px for a, b in _SYM_PAIRS
         if kp2d[a, 2] >= CONF_SEEN and kp2d[b, 2] >= CONF_SEEN]
    if len(u) < 3:
        return None
    u = np.array(u)
    w = np.hypot(u[:, 0], u[:, 1])
    th = np.arctan2(u[:, 1], u[:, 0])
    cost = np.abs(np.sin(th[None, :] - th[:, None])) @ w / len(u)
    return float(cost.min())


def orthogonal_floor(kp2d, scale_px: float) -> Optional[float]:
    """The same floor for `orthogonal`, which is even shorter to write down.

    Same argument as symmetry_floor — the term is zero only if every left/right
    separation runs along one direction, and depth cannot turn an image
    direction — but the term is an RMS rather than a mean of norms, and that
    version minimises in closed form with no candidate list at all. With the
    depths free the best each pair can do is its image separation's component
    across the plane, so

        floor^2 = min over phi of (1/n) * sum_i |u_i|^2 sin^2(theta_i - phi)

    and sin^2 = (1 - cos 2x)/2 turns the minimisation into one argmax of a
    cosine: 2 phi = atan2(sum |u_i|^2 sin 2 theta_i, sum |u_i|^2 cos 2 theta_i).
    That is the principal direction of the separations, weighted by length
    squared — the RMS's own version of the angular median above.
    """
    if not (scale_px and np.isfinite(scale_px) and scale_px > 0):
        return None
    u = [(kp2d[b, :2] - kp2d[a, :2]) / scale_px for a, b in _SYM_PAIRS
         if kp2d[a, 2] >= CONF_SEEN and kp2d[b, 2] >= CONF_SEEN]
    if len(u) < 3:
        return None
    u = np.array(u)
    w = u[:, 0] ** 2 + u[:, 1] ** 2
    th2 = 2.0 * np.arctan2(u[:, 1], u[:, 0])
    phi2 = np.arctan2(w @ np.sin(th2), w @ np.cos(th2))
    return float(np.sqrt(max((w @ (1.0 - np.cos(th2 - phi2))) / (2.0 * len(u)), 0.0)))


def term_floors(kp2d, scale_px: float) -> dict:
    """{term: lowest reading the 2D pose allows} for the terms that have one.

    Only the two mirror-symmetry terms do. Reported alongside a run because
    without them a fit that reached its floor is indistinguishable from a fit
    that failed, and the difference is the whole question.
    """
    out = {"symmetry": symmetry_floor(kp2d, scale_px),
           "orthogonal": orthogonal_floor(kp2d, scale_px)}
    return {k: v for k, v in out.items() if v is not None}

# A straight leg has no plane and a knee that hasn't travelled has no forward, so
# both of those terms read pure noise in exactly the pose where they have nothing
# to say. These fade them out instead, smoothly — a hard cutoff would put a step
# in the objective and the finite-difference gradient would jump across it.
_KNEE_TRAVEL_EPS = 0.05        # torso lengths of knee travel for a confident front
_LEG_PLANE_EPS = 0.02          # torso^2 of |(knee-hip) x (ankle-knee)| for a plane


def _fit_plane(pts):
    """Least-squares plane through (ncand, k, 3) points.

    Returns (unit normal (ncand, 3), RMS distance to the plane (ncand,)). The
    normal is the smallest-eigenvalue direction of the centred covariance, which
    is the same thing an SVD would give and batches over candidates.
    """
    d = pts - pts.mean(axis=1, keepdims=True)
    cov = np.einsum("nki,nkj->nij", d, d) / max(pts.shape[1], 1)
    w, V = np.linalg.eigh(cov)                  # ascending
    return V[..., 0], np.sqrt(np.maximum(w[..., 0], 0.0))


def _penalty_terms(P, scale_px, valid):
    """(ncand, 17, 3) poses -> (ncand, 7) penalties, a column per PENALTY_TERMS.

    A term whose joints aren't all visible scores 0 rather than being guessed at:
    it is then constant across candidates and across limb ratios, so it drops out
    of both the ranking and the gradient instead of biasing them.
    """
    n = P.shape[0]
    out = np.zeros((n, len(PENALTY_TERMS)))
    up = np.array([0.0, -1.0, 0.0])             # image up; y grows downward

    # 1 + 2. The body is mirror-symmetric about one plane. Every left/right pair
    # puts its midpoint ON that plane (term 1, how well one plane fits all six)
    # and lies square ACROSS it (term 2, the part of each pair's separation that
    # isn't along the normal). Fitted here rather than taken from three midpoints
    # as _mirror_residual does, because with the lengths themselves in play the
    # three-point plane can be fitted through its own error.
    pairs = [(a, b) for a, b in _SYM_PAIRS if valid[a] and valid[b]]
    if len(pairs) >= 3:
        mids = np.stack([(P[:, a] + P[:, b]) / 2.0 for a, b in pairs], axis=1)
        normal, rms = _fit_plane(mids)
        out[:, 0] = rms / scale_px
        tot = np.zeros(n)
        for a, b in pairs:
            d = P[:, b] - P[:, a]
            across = np.einsum("ij,ij->i", d, normal)
            tot += np.sqrt(np.maximum((d * d).sum(1) - across * across, 0.0))
        out[:, 1] = tot / (len(pairs) * scale_px)

        # 6 + 7. The same two statements, fitted together. Above, the normal
        # comes from the midpoints alone and the separations are then graded
        # against whatever it turned out to be — but the six midpoints run up
        # the body and are close to collinear (spread 0.35 / 0.24 / 0.03 torso
        # on the snatch fixture), so the direction they leave undetermined is
        # exactly the one the separations care about. The separations are
        # emphatically not collinear, and they get no vote. Measured, the
        # difference is real: the jointly fitted normal sits ~8 deg off the
        # midpoint-fitted one on both fixtures.
        #
        # Asking one plane to satisfy all 12 conditions at once, in least
        # squares, costs nothing to solve. Writing both residuals about a unit
        # normal n and adding their squares,
        #
        #     (1/m) sum_i ((m_i - mbar).n)^2  +  (1/m) sum_j (|d_j|^2 - (d_j.n)^2)
        #       = n^T (C - D) n + const,   C = cov(midpoints), D = (1/m) sum d d^T
        #
        # so the best plane is the smallest eigenvector of C - D: the direction
        # the midpoints vary least along and the separations most. One eigh per
        # candidate, exact, and no search to land in the wrong basin of. (Checked
        # against a 4000-point sweep of the sphere on every candidate of both
        # fixtures: it is the sweep's minimum, to machine precision.)
        #
        # Reported as RMS rather than the mean of norms used above, because RMS
        # is what this normal minimises and a term should be graded by the thing
        # that chose it.
        c = mids - mids.mean(axis=1, keepdims=True)
        d = np.stack([P[:, b] - P[:, a] for a, b in pairs], axis=1)
        M = (np.einsum("nki,nkj->nij", c, c)
             - np.einsum("nki,nkj->nij", d, d)) / len(pairs)
        nrm = np.linalg.eigh(M)[1][..., 0]
        off = np.einsum("nki,ni->nk", c, nrm)
        across = np.einsum("nki,ni->nk", d, nrm)
        perp = np.maximum((d * d).sum(axis=2) - across * across, 0.0)
        out[:, 5] = np.sqrt((off ** 2).mean(axis=1)) / scale_px
        out[:, 6] = np.sqrt(perp.mean(axis=1)) / scale_px

    # 3. The hands are in front of the shins — a lifter's grip is on a bar, and
    # the bar is not behind their legs. "In front" is along the body's own
    # anterior axis, which is horizontal and square to the hips; its SIGN comes
    # from the knees, because a knee travels forward and never back. Where the
    # legs are straight that signal vanishes and tanh fades the whole term with
    # it, which is also when the hands are nowhere near the shins anyway.
    legs = (L_HIP, R_HIP, L_KNE, R_KNE, L_ANK, R_ANK)
    if all(valid[i] for i in legs):
        a = np.cross(up, P[:, L_HIP] - P[:, R_HIP])
        a /= np.maximum(np.linalg.norm(a, axis=1, keepdims=True), 1e-9)
        mid = lambda x, y: (P[:, x] + P[:, y]) / 2.0
        travel = mid(L_KNE, R_KNE) - (mid(L_HIP, R_HIP) + mid(L_ANK, R_ANK)) / 2.0
        ant = np.tanh(np.einsum("ij,ij->i", travel, a)
                      / (_KNEE_TRAVEL_EPS * scale_px))[:, None] * a
        tot, k = np.zeros(n), 0
        for wri, kne, ank in ((L_WRI, L_KNE, L_ANK), (R_WRI, R_KNE, R_ANK)):
            if not valid[wri]:
                continue
            gap = np.einsum("ij,ij->i", P[:, wri] - mid(kne, ank), ant)
            tot += np.maximum(-gap, 0.0)        # only being BEHIND is a fault
            k += 1
        if k:
            out[:, 2] = tot / (k * scale_px)

    # 4. Both arms lie in one plane. True of a lockout, a catch and a start
    # position — anywhere the two hands share a bar — and the six arm joints
    # over-determine a plane by three, so this says something.
    arm = [j for j in (L_SHO, L_ELB, L_WRI, R_SHO, R_ELB, R_WRI) if valid[j]]
    if len(arm) >= 4:
        out[:, 3] = _fit_plane(P[:, arm])[1] / scale_px

    # 5. Each leg swings in a vertical plane: the knee tracks over the foot
    # rather than out to the side, so hip/knee/ankle span a plane whose normal is
    # horizontal. |cos| against image up, which assumes the camera is level —
    # true of the fixed tripod these clips come from.
    tot, k = np.zeros(n), 0
    for hip, kne, ank in ((L_HIP, L_KNE, L_ANK), (R_HIP, R_KNE, R_ANK)):
        if not all(valid[i] for i in (hip, kne, ank)):
            continue
        nrm = np.cross(P[:, kne] - P[:, hip], P[:, ank] - P[:, kne])
        ln = np.linalg.norm(nrm, axis=1)
        gate = ln / (ln + _LEG_PLANE_EPS * scale_px * scale_px)
        tot += gate * np.abs(nrm @ up) / np.maximum(ln, 1e-9)
        k += 1
    if k:
        out[:, 4] = tot / k
    return out


def humanness(j, scale_px) -> dict:
    """One lifted pose -> {term: penalty, "total": weighted sum}.

    The scalar counterpart of the vectorised term above, for inspection and for
    reporting what an optimisation actually bought. Every term is reported; the
    "total" is still over HUMANNESS_TERMS only, because MIRROR_TERMS re-measure
    two of those and summing both would count the mirror plane twice.
    """
    valid = np.all(np.isfinite(j), axis=1)
    t = _penalty_terms(np.where(valid[:, None], j, 0.0)[None], scale_px, valid)[0]
    out = {name: float(v) for name, v in zip(PENALTY_TERMS, t)}
    out["total"] = float(sum(HUMANNESS_WEIGHTS[n] * out[n] for n in HUMANNESS_TERMS))
    return out


# --- the start-position angle gate ------------------------------------------
# Which lifts have a start position worth trusting. Both of these begin with the
# bar on the floor and the athlete momentarily still, hands on the bar, hips and
# knees flexed — a pose whose joint angles are known within a wide but real band
# before any reconstruction runs. A lateral raise has no such moment, and
# applying these ranges to one scores a standing athlete at 57 torso-degrees of
# "violation", so the guard is load-bearing rather than tidiness.
START_POSE_LIFTS = ("snatch", "clean-and-jerk")

# Interior angle at the middle joint, in degrees, (a, b, c) per side plus the
# range a body can hold in THIS pose. Deliberately wider than any athlete's
# actual setup: the job is to rule out the impossible, not to assert a style.
#   hip      — under a bar on the floor the torso is inclined over it and the hip
#              is deeply flexed: measured 45 and 55 deg on the snatch fixture, 60
#              and 67 on the clean-and-jerk. Past ~85 the athlete is standing up,
#              which is not compatible with where their hands are.
#   knee     — bent, but neither locked straight nor folded shut. The loosest of
#              the four on purpose: setup depth varies (108 deg on the
#              clean-and-jerk against 53 on the snatch), and a bound tight enough
#              to bite would have to cut below 127, which is the reading the
#              clean-and-jerk's own projection supports.
#   elbow    — the arms hang straight from the bar. The most certain of the four,
#              and the one that decides the forearm bit.
#   shoulder — weak, and kept only to rule out an arm folded behind the torso.
#              The angle is set by torso inclination, which varies too much to
#              bound tightly.
# Note the tolerance below: a bound only rules a candidate out once it is about
# 5 deg past it, so these are hard limits with a soft edge, not knife edges.
_SETUP_ANGLES = {
    "hip":      (((L_SHO, L_HIP, L_KNE), (R_SHO, R_HIP, R_KNE)), (15.0, 85.0)),
    "knee":     (((L_HIP, L_KNE, L_ANK), (R_HIP, R_KNE, R_ANK)), (45.0, 145.0)),
    "elbow":    (((L_SHO, L_ELB, L_WRI), (R_SHO, R_ELB, R_WRI)), (140.0, 180.0)),
    "shoulder": (((L_HIP, L_SHO, L_ELB), (R_HIP, R_SHO, R_ELB)), (10.0, 115.0)),
}
# Wrists no higher than this above the ankles, in torso lengths, for the bar to
# count as on the floor. Measured: 0.32 on the clean-and-jerk fixture and 0.34
# on the snatch, against 1.20 and 1.66 on the two standing lateral raises — so
# this separates a floor start from a standing one by a factor of three, and
# catches a clip that was trimmed to begin after lift-off.
_SETUP_MAX_GAP = 0.8
_SETUP_GAP_BAND = 0.25   # how far above the clip's lowest the bar may still be
_SETUP_FRAMES = 5        # how many of the quietest such frames to average over
# How much worse than the best a candidate's angle violation may be and still
# survive the gate, in the units below (a squared degree over the range, /100).
# 0.25 is about 5 degrees of violation — inside the noise of a keypoint.
_SETUP_TOL = 0.25


def setup_frames(scene: "Scene", n: int = _SETUP_FRAMES) -> list:
    """The frames of the start position: bar on the floor, athlete still.

    Found from the 2D pose alone, so it commits to nothing the reconstruction
    then has to justify. Two signals, in order: the wrists are low (the bar is on
    the floor, which standing cannot fake) and the body is barely moving (the set
    position, not the moment of lift-off). Returns [] when the clip has no such
    moment — a clip trimmed to start after the pull has no start position, and
    inventing one is exactly the failure this gate exists to avoid.
    """
    if not scene.sequence:
        return []
    scale = scene.clip_torso_px
    if not (scale and np.isfinite(scale) and scale > 0):
        return []
    fs = sorted(scene.sequence)
    kp = {f: scene.sequence[f]["kp2d"] for f in fs}
    gap, motion = {}, {}
    for i, f in enumerate(fs):
        k = kp[f]
        seen = k[:, 2] >= CONF_SEEN
        wri = [k[j, 1] for j in (L_WRI, R_WRI) if seen[j]]
        ank = [k[j, 1] for j in (L_ANK, R_ANK) if seen[j]]
        if wri and ank:
            gap[f] = float(np.mean(ank) - np.mean(wri)) / scale
        # Both neighbours, so the first frame of a clip is not disqualified from
        # being its start position for want of a predecessor.
        d = []
        for g in (fs[i - 1] if i else None, fs[i + 1] if i + 1 < len(fs) else None):
            if g is None:
                continue
            m = seen & (kp[g][:, 2] >= CONF_SEEN)
            if m.sum() >= 8:
                d.append(float(np.mean(np.linalg.norm(kp[f][m, :2] - kp[g][m, :2], axis=1))) / scale)
        if d:
            motion[f] = float(np.mean(d))
    # Only the opening third: the bar is on the floor again after the lift, and
    # that moment is a finished rep, not a set position.
    early = [f for f in fs[:max(3, len(fs) // 3)] if f in gap and f in motion]
    if not early:
        return []
    lowest = min(gap[f] for f in early)
    if lowest > _SETUP_MAX_GAP:
        return []
    low = [f for f in early if gap[f] <= lowest + _SETUP_GAP_BAND]
    return sorted(sorted(low, key=lambda f: motion[f])[:max(1, int(n))])


def _angle_violation(plan, S):
    """How far each candidate's start-position joint angles fall outside range.

    Returns ((ncand,) cost, {test name: (ncand,) angle in degrees}). Cost is the
    squared overshoot in degrees / 100, summed over every test both sides — so
    one term of 1.0 is a limb ten degrees outside what a body can hold.

    Every angle here is between two vectors, which makes the whole gate
    invariant under the mirror fold (negating every sign reflects the pose and
    leaves all angles untouched) — the same reason _candidate_signs can score
    one member of each mirror pair. So this rules out configurations without
    ever claiming to know which way the athlete faces.
    """
    M, base, valid = plan
    Z = S @ M.T
    cost = np.zeros(len(S))
    angles = {}
    for name, (sides, (lo, hi)) in _SETUP_ANGLES.items():
        for side, (a, b, c) in zip("LR", sides):
            if not (valid[a] and valid[b] and valid[c]):
                continue
            u = np.empty((len(S), 3))
            v = np.empty((len(S), 3))
            u[:, :2] = base[a] - base[b]
            v[:, :2] = base[c] - base[b]
            u[:, 2] = Z[:, a] - Z[:, b]
            v[:, 2] = Z[:, c] - Z[:, b]
            n = np.linalg.norm(u, axis=1) * np.linalg.norm(v, axis=1)
            cos = np.where(n > 0, (u * v).sum(1) / np.where(n > 0, n, 1.0), 1.0)
            theta = np.degrees(np.arccos(np.clip(cos, -1.0, 1.0)))
            cost += (np.clip(lo - theta, 0, None) ** 2
                     + np.clip(theta - hi, 0, None) ** 2) / 100.0
            angles[name + side] = theta
    return cost, angles


def start_pose_gate(scene: "Scene", S=None):
    """Rule out every depth configuration the start position says a body can't be in.

    The lift's one genuinely free choice per limb is toward or away, and nothing
    in a single view decides it — so today it is settled by a cost built from
    balance, stance and inter-joint distances, aggregates that answer "is this
    pose plausible overall" rather than "is this joint bent a way a knee bends".
    At the start of a snatch or a clean the second question has an answer: the
    athlete is still, square to the bar, hips and knees flexed, arms straight.
    Every sign assignment implies a hip, knee, shoulder and elbow angle there,
    and most of the 256 imply one no body can hold.

    So this does not choose — it eliminates, and hands what is left to the
    existing cost. Returns None (no gate, nothing changes) unless the clip is a
    lift with a floor start AND a start position was actually found; otherwise a
    dict with `keep` (the surviving rows of S), `forced` (the joints that take
    the same sign in every survivor — decided by anatomy, not by the cost), and
    the angles themselves so a caller can show its work.
    """
    if scene.lift not in START_POSE_LIFTS:
        return None
    frames = setup_frames(scene)
    if not frames:
        return None
    S = _candidate_signs() if S is None else S
    scale = scene.clip_torso_px
    bones = scene.clip_bones
    total = np.zeros(len(S))
    angles, n = {}, 0
    for f in frames:
        plan = _depth_plan(scene.sequence[f]["kp2d"], scale, bones=bones)
        if plan is None:
            continue
        cost, ang = _angle_violation(plan, S)
        total += cost
        for k, v in ang.items():
            angles[k] = angles.get(k, 0.0) + v
        n += 1
    if not n:
        return None
    total /= n
    angles = {k: v / n for k, v in angles.items()}
    keep = total <= total.min() + _SETUP_TOL
    forced = {}
    for j in _SIGN_FREE[1:]:
        col = S[keep, _SLOT[j]]
        if np.all(col > 0):
            forced[j] = 1
        elif np.all(col < 0):
            forced[j] = -1
    return {"keep": keep, "cost": total, "frames": frames, "forced": forced,
            "angles": angles, "n_keep": int(keep.sum()), "n_cand": int(len(S)),
            "clean": bool(total.min() <= 1e-9), "best": float(total.min())}


def _candidate_signs() -> np.ndarray:
    """(n_candidates, len(_SIGN_SLOTS)) of ±1 — one row per pose worth scoring.

    The trunk bit is pinned to +1, which is not a restriction but the mirror
    fold: negating EVERY sign reflects the reconstruction about the image plane,
    leaving every pairwise distance and every balance offset untouched. So the
    512 assignments are 256 poses, each appearing twice, and no cost built from
    distances can ever separate a pose from its mirror. Scoring one member of
    each pair is what makes the runner-up margin mean something — scoring both
    would report a best-vs-next gap of exactly 0 every time.
    """
    free = _SIGN_FREE[1:]                       # trunk pinned, the rest vary
    n = len(free)
    bits = np.arange(1 << n)[:, None] >> np.arange(n)[None, :] & 1
    S = np.ones((1 << n, len(_SIGN_SLOTS)))
    for k, joint in enumerate(free):
        S[:, _SLOT[joint]] = 1.0 - 2.0 * bits[:, k]
    return S


def score_signs(scene: "Scene"):
    """Cost every distinct sign assignment against the whole clip.

    Returns a dict with the candidate matrix `S` (ncand, slots), the total
    `cost` per candidate and the three terms that make it up, or None when no
    frame could be lifted. Split out of infer_depth_signs so the choosing logic
    and the scoring are separable, and so the report's notebook can plot the
    ranking the app actually uses rather than a re-implementation of it.

    The scoring is vectorised over candidates — per frame, one (256, slots) by
    (slots, 17) matmul gives every candidate's depth for every joint at once
    (see _depth_plan). Lifting the candidates one at a time costs ~80us each and
    would put this search at about 11 seconds on a 107-frame clip; as a matmul
    it lands around 40ms, which is what makes freeing the distal joints
    affordable at all.
    """
    scale = scene.clip_torso_px
    kps = ([fr["kp2d"] for fr in scene.sequence.values()]
           if scene.sequence else [scene.kp2d])
    bones = scene.clip_bones
    plans = [p for p in (_depth_plan(k, scale, bones=bones) for k in kps)
             if p is not None]
    S = _candidate_signs()
    ncand = len(S)
    if not plans:
        return None

    # Which frames to judge balance on. A lift is not balanced throughout — in
    # the pull the athlete is accelerating and the centre of mass is genuinely
    # outside the base of support, so scoring those frames measures the lift,
    # not the reconstruction. The in-plane (x) offset says how balanced the
    # athlete was WITHOUT knowing any sign (x comes straight from the 2D pose
    # and is identical for every candidate), which makes it an unbiased way to
    # pick the quiet moments. On the test lift these run 0.03-0.20 torso against
    # 0.41 at the worst of the pull.
    xoff = {}
    for i, (M, base, valid) in enumerate(plans):
        P = np.flatnonzero(valid)
        feet = [a for a in (L_ANK, R_ANK) if valid[a]]
        if len(P) < 8 or not feet:
            continue
        xoff[i] = abs(float(base[P, 0].mean() - base[feet, 0].mean())) / scale
    quiet = set(sorted(xoff, key=xoff.get)[:max(5, len(xoff) // 3)]) if xoff else set()

    balance = np.zeros(ncand)       # body's mean off the feet, in depth
    stance = np.zeros(ncand)        # how far apart the two feet sit in depth
    viol = np.zeros(ncand)          # non-adjacent distances out of range
    sym = np.zeros(ncand)           # left half vs mirrored right half
    n_sym = np.zeros(ncand)         # frames each candidate's midplane existed on
    n_bal = n_stance = 0
    for i, (M, base, valid) in enumerate(plans):
        Z = S @ M.T                                     # (ncand, 17)
        P = np.flatnonzero(valid)
        feet = [a for a in (L_ANK, R_ANK) if valid[a]]
        for (a, b), (lo, hi) in _NONADJ_RANGE.items():
            if not (valid[a] and valid[b]):
                continue
            dxy = float(np.hypot(*(base[a] - base[b])))
            d = np.sqrt(dxy * dxy + (Z[:, a] - Z[:, b]) ** 2) / scale
            viol += np.clip(lo - d, 0, None) ** 2 + np.clip(d - hi, 0, None) ** 2
        # The stance term, and the reason the distal joints could be freed
        # without the search wandering off: both feet are on the floor, under
        # the athlete. They are never a thigh-plus-shank apart in depth. This
        # is the check that makes the old failure impossible to pass silently,
        # and unlike the ranges above it is a direct statement about the one
        # quantity the reconstruction gets most wrong.
        if valid[L_ANK] and valid[R_ANK]:
            stance += np.abs(Z[:, L_ANK] - Z[:, R_ANK]) / scale
            n_stance += 1
        if (i in quiet or not quiet) and len(P) >= 8 and feet:
            balance += np.abs(Z[:, P].mean(1) - Z[:, feet].mean(1)) / scale
            n_bal += 1
        # The symmetry term, scored on EVERY frame rather than the quiet ones:
        # unlike balance it makes no assumption that the athlete is at rest, and
        # the frames where it says the most are the loaded ones balance has to
        # throw away.
        got = _mirror_residual(base, Z, valid, scale)
        if got is not None:
            r, scorable = got
            sym += np.where(scorable, r, 0.0)
            n_sym += scorable

    # Balance and stance are means over the frames each could be measured on;
    # the distance ranges are weighted down to near-nothing on purpose, because
    # measured against the rendered candidates they rank the answers almost
    # exactly BACKWARDS — giving every limb the same sign packs the body into
    # one depth plane and so shortens every cross-body distance. They are kept
    # only to separate candidates the other two terms score equally.
    balance = balance / max(n_bal, 1)
    stance = stance / max(n_stance, 1)
    # A candidate the midplane test could never be applied to (its own three
    # midpoints collinear on every frame) gets the worst score any candidate
    # earned rather than a free 0 — "unmeasurable" must not beat "measured and
    # symmetric", which is what dividing by max(n, 1) would quietly do.
    scored_any = n_sym > 0
    sym = np.where(scored_any, sym / np.maximum(n_sym, 1), 0.0)
    if scored_any.any() and not scored_any.all():
        sym[~scored_any] = sym[scored_any].max()
    cost = (_SYMMETRY_WEIGHT * sym + balance + _STANCE_WEIGHT * stance
            + _VIOLATION_WEIGHT * viol)
    return {"S": S, "cost": cost, "balance": balance, "stance": stance,
            "sym": sym, "n_sym": n_sym, "viol": viol, "plans": plans,
            "quiet": quiet, "scale": scale, "n_frames": len(plans)}


def infer_depth_signs(scene: "Scene"):
    """Choose every joint's depth direction from the pose alone.

    Scores all 256 distinct sign assignments against the whole clip (see
    score_signs) and keeps one for the clip: the sign is a property of how the
    lift was filmed, the UI stores one value per joint, and choosing per frame
    would make the reconstruction flicker between mirror-image poses as the
    athlete moved.

    On a lift with a start position the anatomy goes first: start_pose_gate
    throws out every arrangement whose start-position joint angles are ones a
    body cannot hold, and the cost then ranks what survives. An aggregate cost
    and a joint angle are not the same kind of evidence — "the athlete looks
    balanced" is a guess about a whole body, "that knee is bent backwards" is a
    fact about one joint — so the second is applied as a filter and the first
    only as a preference among what it leaves.

    Returns (signs, note, margin). margin is the cost gap between the best and
    the runner-up, in torso lengths — near zero means the view genuinely does
    not determine the answer (a straight-on camera, or limbs with no
    out-of-plane extent at all), which is worth saying rather than dressing up
    as a decision.
    """
    scored = score_signs(scene)
    if scored is None:
        return {}, "no frame had both hips — nothing to infer depth from", 0.0
    S, cost = scored["S"], scored["cost"]
    balance, stance, sym = scored["balance"], scored["stance"], scored["sym"]
    quiet, ncand = scored["quiet"], len(S)

    gate = start_pose_gate(scene, S)
    ranked = np.where(gate["keep"], cost, np.inf) if gate else cost
    order = np.argsort(ranked)
    best = int(order[0])
    # The margin is over the survivors, not over all 256: once an arrangement is
    # ruled out anatomically it is not a runner-up, and counting it as one would
    # report a close call that isn't.
    runner = float(ranked[order[1]]) if ncand > 1 else np.inf
    margin = float(runner - cost[best]) if np.isfinite(runner) else 0.0
    # A gate that left exactly one arrangement standing has no runner-up, so the
    # margin above is 0 — which is the opposite of what a 0 margin usually means
    # here. Anatomy decided it; say so rather than falling through to "the view
    # doesn't determine this".
    alone = bool(gate) and gate["n_keep"] == 1

    free = {j: int(S[best, _SLOT[j]]) for j in _SIGN_FREE}
    # Both mirrors of the winner fit the evidence equally well, so pick the one
    # that disagrees with the old default least: most limbs toward the camera,
    # ties broken toward the historical all-toward reading. Which of the two is
    # physically right is a front/back question this method cannot answer — the
    # note says so, and the per-joint controls stay there to flip it.
    cand = [expand_signs(free), expand_signs(free, mirror=True)]
    signs = max(cand, key=lambda t: sum(1 for v in t.values() if v > 0))

    away = sorted(_JOINT_LABELS[j] for j in _SIGN_FREE if signs[j] < 0)
    where = f"{', '.join(away)} away from camera, the rest toward" if away else "all toward camera"
    if gate:
        forced = sorted(_JOINT_LABELS[j] for j in gate["forced"])
        gate_note = (
            f"start position ({len(gate['frames'])} frames from "
            f"{gate['frames'][0]}) ruled out {gate['n_cand'] - gate['n_keep']} of "
            f"{gate['n_cand']} arrangements on joint angle"
            + ("" if gate["clean"] else
               f" — none was fully anatomical, the best still misses by "
               f"{gate['best']:.2f}")
            + (f"; {', '.join(forced)} decided by anatomy alone. " if forced
               else "; no single joint was decided by anatomy alone. "))
    else:
        gate_note = ""
    if margin < 1e-4 and not alone:
        note = (gate_note + "depth direction undetermined by this view — every "
                "arrangement balances equally well (limbs with no out-of-plane "
                "extent, or a straight-on camera). Left at the default, toward camera")
        signs = {}
    else:
        pool = gate["n_keep"] if gate else ncand
        note = (gate_note
                + f"depth direction inferred from {pool} arrangements over "
                f"{len(quiet) or scored['n_frames']} of {scored['n_frames']} frames "
                f"(the steadiest ones): {where}. Body's mean sits {balance[best]:.2f} "
                f"torso off the feet in depth and the feet {stance[best]:.2f} apart; "
                f"left/right halves {sym[best]:.2f} torso from mirror-symmetric "
                f"(reported, not minimised — see _SYMMETRY_WEIGHT). "
                + ("No second arrangement survived the start position. "
                   if alone else f"Next arrangement scores {margin:.3f} worse. ")
                + "The front/back mirror of this is equally balanced — flip "
                "everything if the figure faces the wrong way")
    return signs, note, margin


# Gradient-descent settings for optimize_limbs. Only four parameters, so the
# gradient is taken by central differences rather than by differentiating the
# lift: sqrt(max(L^2 - l^2, 0)) has a clamp in it and the sign search underneath
# is a discrete min, so an analytic derivative would be wrong at exactly the
# places this lands. Eight extra evaluations a step is nothing at this size.
_OPT_STEP = 0.004        # finite-difference step, torso lengths
_OPT_LR = 0.08           # gradient step size
_OPT_ITERS = 120
_OPT_TOL = 1e-6          # stop when an iteration buys less than this
# Convergence: every humanness term individually moving less than this, not just
# their weighted sum. A sum can sit still while two terms trade against each
# other, and those two are exactly the ones worth waiting out.
_OPT_TERM_TOL = 2e-4
# What the interface's "optimize" button does per click: descend until converged,
# in small steps. Small because the trajectory is the point — at 0.005 no single
# step moves a ratio more than 0.005 torso, so the per-term history it reports
# back is legible rather than three jumps. The cap is a guard, not a target.
_OPT_UI_LR = 0.005
_OPT_UI_MAX = 400


def _lift_candidates(kp2d, scale_px, bones, S):
    """(poses (ncand, 17, 3), valid (17,)) for one frame under every sign."""
    plan = _depth_plan(kp2d, scale_px, bones=bones)
    if plan is None:
        return None, None
    M, base, valid = plan
    Z = S @ M.T
    P = np.zeros((S.shape[0], N_JOINTS, 3))
    P[:, :, :2] = np.where(valid[:, None], base, 0.0)
    P[:, :, 2] = np.where(valid, Z, 0.0)
    return P, valid


def optimize_limbs(scene, ratios=None, weights=None, iters=_OPT_ITERS,
                   lr=_OPT_LR, frame=None, line_search=True,
                   term_tol=_OPT_TERM_TOL, objective=DEFAULT_OBJECTIVE):
    """Fit the limb ratios to one frame by minimising the humanness penalty.

    The lift reads a bone's true length off a prior and turns whatever it has
    left over after the on-screen length into depth. That makes the length the
    thing everything else is downstream of — and it is also the one quantity a
    single view cannot measure, so it has to be inferred from consequences. The
    consequences used here are PENALTY_TERMS: lengths that are wrong bend the
    body in ways a body doesn't bend.

    Descends on the four ratios jointly; at every evaluation the sign search runs
    underneath and the best of its candidates is taken, so this is a minimum over
    (lengths, signs) rather than a fit against one frozen guess of the directions.
    That makes the objective piecewise smooth — the argmin sign can switch under
    a step — which is the other reason the gradient is numerical.

    On a lift with a start position, that sign search is confined to the
    arrangements start_pose_gate allows. The gate is computed ONCE, from the
    lengths this started at, and then held: recomputing it as the ratios move
    would let the descent pick lengths that make an impossible configuration
    look possible, which is the failure the gate exists to prevent. Descending
    on the wrong toward/away choice optimises the lengths into it — the found
    minimum is real and the pose it belongs to is not.

    One frame, by design and for now: `frame` defaults to the clip's first. The
    honest limitation is that a single frame can only constrain a segment that
    is doing something in it, so a leg that never leaves full extension in that
    one frame will just sit at whatever the clamp allows.

    `objective` names which terms are allowed to pull (OBJECTIVES); an explicit
    `weights` overrides it per term. The ones left out are still
    evaluated and still returned, because the interesting thing about narrowing
    the objective is what happens to the facts you stopped fitting.

    Stops when every term IN THE OBJECTIVE individually moves less than
    `term_tol` in a step, when the line search can no longer find a downhill
    move, or at `iters` — whichever comes first; `stop_reason` says which, since
    "converged" and "ran out of budget" are very different claims about the
    answer. Only the active terms count towards that: a zeroed term drifts as a
    by-product and waiting for it to settle would be waiting on something the
    descent isn't steering.

    Returns a dict with the start and final ratios, both term breakdowns, and the
    per-iteration objective, so a caller can show what it bought rather than
    having to trust it.
    """
    scale = scene.clip_torso_px
    if not (scale and np.isfinite(scale) and scale > 0):
        return None
    if scene.sequence:
        frame = min(scene.sequence) if frame is None else frame
        kp2d = scene.sequence.get(frame, {}).get("kp2d")
    else:
        kp2d = scene.kp2d
    if kp2d is None:
        return None

    names = list(_SEGMENTS)
    w = dict(objective_weights(objective), **(weights or {}))
    wv = np.array([w[t] for t in PENALTY_TERMS])
    active = wv != 0
    if not active.any():
        return None
    # Start from whatever the scene already believes — its posted profile if it
    # has one, else its own per-clip estimate — so this refines the current
    # answer rather than restarting from the population priors every time.
    start = {n: float(scene.clip_bones[sides[0]]) for n, sides in _SEGMENTS.items()}
    if ratios:
        start.update({k: float(v) for k, v in ratios.items() if k in _SEGMENTS})
    x = np.array([start[n] for n in names], dtype=float)
    lo, hi = LIMB_RATIO_RANGE
    S = _candidate_signs()
    gate = start_pose_gate(scene, S)
    if gate is not None:
        S = S[gate["keep"]]

    def evaluate(vec):
        bones = {p: float(vec[i]) for i, n in enumerate(names)
                 for p in _SEGMENTS[n]}
        P, valid = _lift_candidates(kp2d, scale, bones, S)
        if P is None:
            return np.inf, None, None
        terms = _penalty_terms(P, scale, valid)
        total = terms @ wv
        b = int(np.argmin(total))
        return float(total[b]), terms[b], b

    f0, terms0, sign0 = evaluate(x)
    if not np.isfinite(f0):
        return None
    cur = (x.copy(), f0, terms0, sign0)
    best = cur
    history = [f0]
    steps = 0
    flips = 0
    stop_reason = "iterations"
    for _ in range(int(iters)):
        grad = np.zeros(len(names))
        for i in range(len(names)):
            up_, dn = x.copy(), x.copy()
            up_[i] = min(hi, x[i] + _OPT_STEP)
            dn[i] = max(lo, x[i] - _OPT_STEP)
            span = up_[i] - dn[i]
            if span <= 0:
                continue
            grad[i] = (evaluate(up_)[0] - evaluate(dn)[0]) / span
        gn = float(np.linalg.norm(grad))
        if not np.isfinite(gn) or gn < 1e-12:
            stop_reason = "flat"
            break
        prev = cur
        d = grad / gn                      # unit, so lr IS the move in ratio units
        if line_search:
            # Backtrack rather than trust the step: the objective has kinks
            # where the argmin sign flips, and stepping over one uphill would
            # otherwise stall the descent for good.
            step, moved = lr, False
            for _ in range(12):
                cand = np.clip(x - step * d, lo, hi)
                f, terms, sgn = evaluate(cand)
                if f < cur[1] - _OPT_TOL:
                    x = cand
                    cur = (cand.copy(), f, terms, sgn)
                    moved = True
                    break
                step *= 0.5
            if not moved:
                stop_reason = "stalled"
                break
        else:
            # Fixed step, and an uphill one is TAKEN rather than rejected. This
            # is the mode the interface steps with: hiding the moves that make
            # the penalty worse would hide exactly the behaviour worth watching,
            # since this objective is known to descend to the wrong lengths.
            x = np.clip(x - lr * d, lo, hi)
            f, terms, sgn = evaluate(x)
            cur = (x.copy(), f, terms, sgn)
        steps += 1
        if cur[3] != prev[3]:
            flips += 1
        if cur[1] < best[1]:
            best = cur
        history.append(cur[1])
        # Converged when the terms have stopped moving — all of them. Checked on
        # the breakdown rather than the total so a step that only shuffles
        # penalty from one term to another still counts as movement.
        if float(np.max(np.abs((cur[2] - prev[2])[active]))) < term_tol:
            stop_reason = "converged"
            break

    brk = lambda t: {name: float(v) for name, v in zip(PENALTY_TERMS, t)}
    return {
        "frame": frame,
        "start": {n: float(start[n]) for n in names},
        # Where it actually ENDED, not the best point seen — so stepping the
        # interface ten at a time resumes from the same place it showed you.
        "ratios": {n: float(cur[0][i]) for i, n in enumerate(names)},
        "start_terms": brk(terms0), "start_total": float(f0),
        "terms": brk(cur[2]), "total": float(cur[1]),
        "best_ratios": {n: float(best[0][i]) for i, n in enumerate(names)},
        "best_total": float(best[1]),
        "signs": {int(j): int(S[cur[3], _SLOT[j]]) for j in _SIGN_FREE},
        # The toward/away choice is re-made from scratch at every evaluation, so
        # it can move under the descent. Reported because a run that ended on a
        # different configuration than it started on optimised partly by changing
        # its mind about which way the athlete faces, which is worth knowing
        # before reading the lengths it landed on.
        "start_signs": {int(j): int(S[sign0, _SLOT[j]]) for j in _SIGN_FREE},
        "sign_flips": flips,
        # How much of the toward/away freedom anatomy took away before the
        # descent started. None means no gate applied (not a lift with a start
        # position, or no start position in this clip).
        "gate": (None if gate is None else
                 {"kept": gate["n_keep"], "of": gate["n_cand"],
                  "frames": list(gate["frames"]), "clean": gate["clean"],
                  "forced": {int(j): int(v) for j, v in gate["forced"].items()}}),
        "iterations": steps,
        "stop_reason": stop_reason,
        "converged": stop_reason in ("converged", "stalled", "flat"),
        "term_tol": float(term_tol),
        "history": [float(v) for v in history],
        "objective": (DEFAULT_OBJECTIVE if objective is None else str(objective)),
        "weights": {t: float(w[t]) for t in PENALTY_TERMS},
        # How much of a reading no choice of lengths can remove. Without it a
        # run that reached the floor reads as a run that failed.
        "floors": term_floors(kp2d, scale),
    }


def parse_bone_ratios(raw) -> Optional[dict]:
    """{segment name: fraction of torso} from whatever the frontend posted.

    Keeps only the names in _SEGMENTS and only finite values inside
    LIMB_RATIO_RANGE, so a malformed post degrades to the per-clip estimate
    rather than poisoning the lift.
    """
    if not isinstance(raw, dict):
        return None
    out = {}
    for name, val in raw.items():
        if name not in _SEGMENTS:
            continue
        try:
            v = float(val)
        except (TypeError, ValueError):
            continue
        if np.isfinite(v) and LIMB_RATIO_RANGE[0] <= v <= LIMB_RATIO_RANGE[1]:
            out[name] = v
    return out or None


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
    valid = set(_SIGN_SLOTS)
    for k, v in raw.items():
        try:
            i = int(k)
            s = int(v)
        except (TypeError, ValueError):
            continue
        if i in valid and s in (-1, 1):
            out[i] = s
    return out


def _perspective_refine(scene, scale_px, M, base, valid, z, s, bones=None):
    """Damped fixed point of X = u * (1 - z/f_px). See _PERSP_ITERS.

    Returns the plan and depths unchanged when the correction is off (the
    default) or the frame lacks the pixel dimensions it needs, so the
    orthographic path costs one comparison.

    This refines a pose whose signs are ALREADY chosen. score_signs still ranks
    the 256 candidates orthographically: un-projection makes depth nonlinear in
    the sign bits, which would cost the one-matmul search _depth_plan exists to
    enable. Fine while the correction is a few percent; revisit together with
    _PERSP_ITERS if it is ever switched on.
    """
    if _PERSP_ITERS <= 0 or not (scene.width and scene.height):
        return M, base, valid, z
    f_px = _FOCAL_MUL * max(scene.width, scene.height)
    if not (np.isfinite(f_px) and f_px > 0):
        return M, base, valid, z
    # u is measured from the principal point, not the pelvis: the un-projection
    # is about the optical axis, and getting that wrong would shear the pose.
    u = scene.kp2d[:, :2] - np.array([scene.width, scene.height]) / 2.0
    for _ in range(_PERSP_ITERS):
        plan = _depth_plan(scene.kp2d, scale_px, xy=u * (1.0 - z / f_px)[:, None],
                           bones=bones)
        if plan is None:
            break
        M, base, valid = plan
        z = (1.0 - _PERSP_DAMP) * z + _PERSP_DAMP * (M @ s)
    return M, base, valid, z


def _bone_length_lift(scene: Scene, scale_px: float, bones=None):
    """2D keypoints + bone-length priors -> (joints3d (17,3), notes).

    The classic single-view trick: a bone's true 3D length L is known (prior),
    its on-screen length l is measured, so its out-of-plane extent is
    dz = sqrt(max(L^2 - l^2, 0)) under an orthographic camera. We place the
    pelvis at the origin, turn the trunk about it (one rigid fit gives its
    hip widths and its lean all at once, see _fit_trunk), then walk the limbs
    outward from the
    shoulders and hips accumulating dz.

    The unavoidable catch is the SIGN of every dz — a single view can't tell
    toward-camera from away. The magnitude is still information, so rather than
    guess globally, each ambiguous joint carries its own choice in
    scene.depth_signs (see DEFAULT_DEPTH_SIGN) and the interface exposes them;
    an empty dict reproduces the old all-toward-camera behaviour. Inferring the
    signs instead of being told them is a temporal/multi-view job, not this
    anchor's. Units are whatever scale_px is expressed in (px for the
    non-metric lift, mm once multiplied through for the metric one).

    `bones` is passed in for the same reason scale_px is: _lift_sequence hands
    this a Scene holding ONE frame, so reading Scene.clip_bones off it would
    re-estimate every segment from that frame alone — and a segment measured
    against its own single projection has dz == 0 by construction. The whole
    clip has to do the estimating, so the caller with the clip passes it."""
    j = np.full((N_JOINTS, 3), np.nan, dtype=float)
    bones = scene.clip_bones if bones is None else bones
    plan = _depth_plan(scene.kp2d, scale_px, bones=bones)
    if plan is None:
        return j, "no pelvis (both hips unseen) — lift not possible"
    M, base, valid = plan

    s = _sign_vector(scene.depth_signs)
    z = M @ s
    M, base, valid, z = _perspective_refine(scene, scale_px, M, base, valid, z, s,
                                            bones)
    j[valid] = np.column_stack((base[valid], z[valid]))

    # How much of the pose actually had a choice to make, for the note. A bone's
    # own dz is the entry in its own slot (every other slot on that row was
    # inherited from an ancestor), so the counts read straight off the plan.
    ambiguous, flipped = 0, 0
    for _, child in _WALK:
        if valid[child] and M[child, _SLOT[child]] > 1e-6:
            ambiguous += 1
            if s[_SLOT[child]] < 0:
                flipped += 1

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
        # depth_signs has to come along: without it every frame but the
        # representative one would silently revert to all-toward-camera, and the
        # viewer would show the chosen pose on pause and the default one the
        # moment the clip started animating.
        fs = Scene(width=scene.width, height=scene.height, kp2d=fr["kp2d"],
                   equipment=fr["equipment"], dataset=scene.dataset,
                   depth_signs=scene.depth_signs)
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
        # ONE scale for the clip, not scene.torso_px per frame — the bone priors
        # are fractions of the athlete's torso, and the athlete's torso doesn't
        # get shorter when they bend over, only its projection does. See
        # Scene.clip_torso_px; using the per-frame value shrank every bone by up
        # to 1.78x on the test lift exactly when the pose was most foreshortened,
        # while x and y stayed in real pixels.
        scale = scene.clip_torso_px
        # Same argument, same reason: measured over the clip, not the frame.
        bones = scene.clip_bones
        note = "bone-length lift, unit-torso"
        frames_out = None
        if scene.sequence:
            frames_out = _lift_sequence(
                scene, lambda fs: _bone_length_lift(fs, scale_px=scale,
                                                    bones=bones))
            rep = _rep_frame(scene, frames_out)
            j = (frames_out[rep] if rep is not None
                 else np.full((N_JOINTS, 3), np.nan))
            note = (f"bone-length lift over {len(frames_out)} frames, unit-torso "
                    f"(clip torso {scale:.0f} px)")
        else:
            j, note = _bone_length_lift(scene, scale_px=scale, bones=bones)
        return MeshCandidate(self.name, self.confidence(scene), j, EDGES,
                             metric=False, signed=True, notes=note,
                             frames=frames_out)


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
    # Shoulder to the head point. 330 rather than the 300 this held when the
    # point was the nose: the eye midpoint sits ~30mm further up the head (0.066
    # torso, measured on the example clip).
    frozenset((HEAD, L_SHO)): 330.0, frozenset((HEAD, R_SHO)): 330.0,
}
# Undirected skeleton along which depth PROPAGATES outward from the wrists (the
# only joints the bar pins in 3D). BFS handles direction; order is irrelevant.
_PROP_EDGES = [
    (L_WRI, L_ELB), (L_ELB, L_SHO), (R_WRI, R_ELB), (R_ELB, R_SHO),
    (L_SHO, R_SHO), (L_SHO, L_HIP), (R_SHO, R_HIP), (L_HIP, R_HIP),
    (L_HIP, L_KNE), (L_KNE, L_ANK), (R_HIP, R_KNE), (R_KNE, R_ANK),
    (L_SHO, HEAD), (R_SHO, HEAD),
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

    # Resolve "auto" BEFORE the mesh: inference runs its own cheap lifts to
    # score the 16 candidates, and the winner has to be in scene.depth_signs by
    # the time the real mesh is built.
    sign_note = None
    if scene.infer_signs:
        scene.depth_signs, sign_note, _ = infer_depth_signs(scene)

    candidate = chosen.mesh(scene)         # the one expensive call
    if sign_note:
        candidate.notes = (candidate.notes + " · " + sign_note) if candidate.notes else sign_note
    # The FULL resolved table, not just what was posted: the UI renders one
    # control per joint and needs a value for each, and echoing the resolution
    # rather than the request is what makes a dropped/garbage entry visible
    # (it comes back as the default) instead of silently ignored.
    # Keyed off sign_joints() rather than _WALK so the echo can never drift from
    # the control set the page builds — the torso row was missing here exactly
    # because this listed the bone walk, which the trunk is not part of.
    resolved = {str(s["index"]): scene.depth_signs.get(s["index"], DEFAULT_DEPTH_SIGN)
                for s in sign_joints()}
    return {"chosen": chosen.name, "confidences": scores,
            "candidate": candidate.to_json(), "depth_signs": resolved,
            "error": None}
