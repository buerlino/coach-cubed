"""Guess snatch vs. clean-and-jerk from an already-extracted pose track,
instead of clip duration (see scripts/sync_clipper_fixtures.py — duration
turned out not to track lift type at all on real footage: a clip's length is
dominated by post-lockout walk-off/celebration time that a --review pass
can't tell apart from a genuine two-phase lift).

The real distinguishing signal is the wrist/bar height trajectory itself: a
snatch is one continuous rise from the floor to an overhead catch; a clean &
jerk is two — a rise to the shoulders, a rack pause while the lifter resets
footing, then a second rise to the overhead jerk catch. That's a real,
physically-grounded shape, and it's already sitting in the keypoints we
extract for the fixture anyway — no extra GPU cost.

No numpy: batch_extract_tracks.py is deliberately a plain HTTP client with no
ML-stack dependency (see its own docstring), and this is meant to run
alongside it without needing coach's conda env.

Validation status, honestly: RISE_GAIN_FRACTION (the minimum prominence a
dip/rise has to clear to count as a separate catch) is tuned against real
snatch footage only — 4 verified-by-eye real snatch clips, chosen because
every candidate clip actually available in the first real dataset tested
against turned out to be a snatch. At this threshold all 4 correctly read as
one continuous rise with zero false splits from tracking jitter, which is
the direction that matters most (a false "clean-and-jerk" silently scores a
clip against the wrong cues). The two-rise branch itself is exercised only
by synthetic trajectories, not a single real clean & jerk — a synthetic
rack-pause dip realistic enough to be physically honest (a brief hold, then
a shallow dip-drive) sits right at or under this same threshold, so it is
plausible the real thing needs a lower one, or a different signal entirely
(e.g. elbow angle / wrist-to-shoulder distance, which a clean's rack position
changes distinctively and a snatch's lockout never does). Treat the first
clean-and-jerk verdicts this produces on real data as unverified until
someone's eyeballed a few — same spirit as clipper's own --review habit.
"""
# COCO-17, matching src/diagnostics.js's KP table.
L_SHO, R_SHO, L_WRI, R_WRI, L_HIP, R_HIP = 5, 6, 9, 10, 11, 12
CONF_GATE = 0.3   # same gate the diagnostics overlay uses

MIN_RANGE_TORSO = 0.15     # below this, there's no real vertical motion to read at all
MAX_RANGE_TORSO = 6.0      # a real overhead reach tops out well under this (~2.8-3.7 seen on
                           # verified real snatch clips) — wider means the track is broken,
                           # not a bigger lift (e.g. hip/shoulder points collapsing, an id swap)
RISE_GAIN_FRACTION = 0.15  # a "rise" must cover at least this much of the clip's own range
SETTLE_WINDOW_S = 0.2      # runs shorter than this are jitter, folded into a neighbour


def _valid(pt):
    return pt is not None and len(pt) >= 3 and pt[2] >= CONF_GATE


def _wrist_height_series(keypoints, person_id):
    """Per frame: (hip_y - wrist_y) / torso_length — bigger means the bar is
    higher above the hips, in body-length units so it's comparable across
    clips and subjects. None for a frame with no usable wrist+hip data;
    torso length is a single per-clip scalar (median over valid frames), not
    recomputed per frame, since a fixed camera shouldn't need that."""
    frame_keys = sorted(keypoints.keys(), key=int)
    raw, torsos = [], []
    for fk in frame_keys:
        pts = (keypoints.get(fk) or {}).get(person_id)
        if not pts or len(pts) <= R_HIP:
            raw.append(None)
            continue
        wrist_ys = [pts[i][0] for i in (L_WRI, R_WRI) if _valid(pts[i])]
        hip_ys = [pts[i][0] for i in (L_HIP, R_HIP) if _valid(pts[i])]
        sho_ys = [pts[i][0] for i in (L_SHO, R_SHO) if _valid(pts[i])]
        if not wrist_ys or not hip_ys:
            raw.append(None)
            continue
        hip_y = sum(hip_ys) / len(hip_ys)
        raw.append(hip_y - sum(wrist_ys) / len(wrist_ys))
        if sho_ys:
            torsos.append(hip_y - sum(sho_ys) / len(sho_ys))
    if not torsos or all(v is None for v in raw):
        return None
    torsos.sort()
    torso = torsos[len(torsos) // 2]
    if torso <= 1:
        return None
    return [(v / torso if v is not None else None) for v in raw]


def _fill_gaps(series):
    out = list(series)
    last = None
    for i, v in enumerate(out):
        if v is None:
            out[i] = last
        else:
            last = v
    first = next((v for v in out if v is not None), None)
    if first is None:
        return None
    for i, v in enumerate(out):
        if v is None:
            out[i] = first
        else:
            break
    return out


def _smooth(series, window):
    n = len(series)
    if window < 2 or n < 2:
        return list(series)
    half = window // 2
    return [sum(series[max(0, i - half):min(n, i + half + 1)]) /
            (min(n, i + half + 1) - max(0, i - half)) for i in range(n)]


def _significant_peaks(h, prominence):
    """Indices of local maxima whose rise-then-fall is at least `prominence`
    deep on both sides — standard hysteresis peak-picking (a.k.a. topographic
    prominence with a fixed cutoff): track a running extreme, only confirm it
    as a peak/trough once the series has moved back by `prominence` from it.
    Immune to per-frame jitter by construction, unlike thresholding the raw
    frame-to-frame velocity (which broke on real footage: a real rise spread
    over enough frames has a per-frame delta smaller than the jitter floor).
    A trailing candidate that never reverses (the series ends still near its
    running extreme) is still reported — that's what lets a peak at the very
    end of the clip count."""
    peaks = []
    direction = 0   # 1 while tracking a rising run's top, -1 for a falling run's bottom
    ext_i, ext_v = 0, h[0]
    for i in range(1, len(h)):
        v = h[i]
        if direction >= 0 and v >= ext_v:
            ext_v, ext_i, direction = v, i, 1
        elif direction <= 0 and v <= ext_v:
            ext_v, ext_i, direction = v, i, -1
        elif direction == 1 and ext_v - v >= prominence:
            peaks.append(ext_i)
            direction, ext_v, ext_i = -1, v, i
        elif direction == -1 and v - ext_v >= prominence:
            direction, ext_v, ext_i = 1, v, i
    if direction != -1:
        peaks.append(ext_i)
    return peaks


def classify_shape(h, fps):
    """(stance, reason) from a gap-filled height series, or (None, reason)
    when the shape doesn't clearly say — including a clip that's cut before
    the lift settles, which duration-based guessing had no way to catch."""
    if len(h) < 4:
        return None, "track too short to read a lift shape from"
    rng = max(h) - min(h)
    if rng < MIN_RANGE_TORSO:
        return None, f"barely any vertical bar motion detected (range {rng:.2f} torso-lengths)"
    if rng > MAX_RANGE_TORSO:
        return None, f"implausible motion range ({rng:.1f} torso-lengths) — likely a tracking glitch, not a real lift"

    window = max(3, round(fps * 0.15))
    hs = _smooth(h, window)
    lo, hi = min(hs), max(hs)
    peak_i = max(range(len(hs)), key=lambda i: hs[i])

    min_run = max(2, round(fps * SETTLE_WINDOW_S))
    if peak_i > len(hs) - 1 - min_run:
        return None, "clip appears to end before the lift settles (possible early cut)"
    # A lift always starts with the bar low (grip/setup), never already near its
    # own peak — this is what actually catches a broken track like the one above:
    # peak_i can legitimately land away from both ends while the track itself is
    # garbage the whole way through.
    if hs[0] > lo + 0.5 * (hi - lo):
        return None, "clip doesn't start with the bar near the bottom of its range — possible tracking issue"

    peaks = _significant_peaks(hs, rng * RISE_GAIN_FRACTION)
    peaks_up_to_global = [i for i in peaks if i <= peak_i] or [peak_i]

    if len(peaks_up_to_global) <= 1:
        return "snatch", f"one continuous rise to the peak (range {rng:.2f} torso-lengths)"
    return "clean-and-jerk", (f"{len(peaks_up_to_global)} distinct catch heights on the way up "
                               f"(range {rng:.2f} torso-lengths) — a rack pause/dip in between")


def classify_stance_from_track(keypoints, meta):
    """(stance, reason) or (None, reason) from a pose-extraction result's own
    "keypoints"/"meta" shape (see /api/pose/video/result)."""
    person_id = (meta.get("tracks") or {}).get("kept")
    if not person_id:
        return None, "no person was tracked in this clip"
    h = _wrist_height_series(keypoints, person_id)
    if h is None:
        return None, "wrist/hip keypoints never met the confidence gate"
    h = _fill_gaps(h)
    if h is None:
        return None, "wrist/hip keypoints never met the confidence gate"
    fps = float(meta.get("fps") or 30.0)
    return classify_shape(h, fps)
