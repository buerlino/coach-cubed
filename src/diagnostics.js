/* coach: lifting diagnostics — one coaching cue -> one number, computed from
 * the pose track the frontend already has.
 *
 * Served verbatim at /diagnostics.js (app.py re-reads this file per request, so
 * editing it needs only a browser reload, not ./scripts/restart.sh).
 *
 * Every diagnostic is written in the same three parts, and the object below
 * has exactly that shape:
 *
 *   1. description   — the cue, and the scalar standing in for it
 *   2. phase()       — the window of the lift where the cue applies, from
 *                      triggers computable from keypoints. Scoring a cue
 *                      outside its phase is noise: the back angle is *supposed*
 *                      to change once the bar passes the knee.
 *   3. measure() + the shared renderer — the plot the lifter reads, plus
 *                      everything they need to distrust it.
 *
 * See .claude/skills/lifting-diagnostic/ for the full contract and for the
 * per-diagnostic notes.
 *
 * Keypoints are [y, x, confidence] with y growing DOWNWARD — elevation is -y,
 * and "A is above B" is A.y < B.y. Everything here is pixels in the image
 * plane; there is no metric scale, so every distance/speed threshold is
 * normalized by torso length.
 *
 * Every diagnostic gets its own plot, stat tiles and notes block, always —
 * the tickbox above each plot gates only whether that diagnostic's overlay()
 * draws on the video (so several diagnostics' overlays don't compete for the
 * same frame). Rendering is shared: DIAGNOSTICS is iterated to build one
 * section per entry (see buildSections/run/redrawAll below).
 */
(function () {
'use strict';

// COCO-17, as produced by vitpose_backend. Odd = left, even = right.
const KP = {
  lSho: 5, rSho: 6, lElb: 7, rElb: 8, lWri: 9, rWri: 10,
  lHip: 11, rHip: 12, lKnee: 13, rKnee: 14, lAnk: 15, rAnk: 16,
};
const USED = [KP.lSho, KP.rSho, KP.lElb, KP.rElb, KP.lWri, KP.rWri,
              KP.lHip, KP.rHip, KP.lKnee, KP.rKnee, KP.lAnk, KP.rAnk];

const DIAG_CONF = 0.3;   // same gate the overlay uses
const FILL_WIN = 5;      // how far a gap fill may reach for neighbours

// Validated dark palette (see the dataviz skill's references/palette.md).
//
// Three roles, three fixed treatments, and nothing else gets a hue:
//
//   white   the pose track — a measurement of the lifter, not a judgement
//   ramp    how well the cue is being met, green->amber->red (scoreColor)
//   purple  where the phase starts and ends — a boundary, not a score, so it
//           must not read as green ("good") or red ("bad") at its edges
//
// The grid, axes, playhead and annotations stay neutral. One series per plot,
// so no legend box — the band is uncertainty, not a second series.
const C = {
  good: '#0ca30c', warning: '#fab219', critical: '#d03b3b',
  phase: '#b39ddb',
  ink: '#ffffff', ink2: '#c3c2b7', muted: '#898781',
  grid: '#2c2c2a', axis: '#383835', surface: '#1a1a19',
};

const rgbOf = h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16));
const RAMP_RGB = [C.good, C.warning, C.critical].map(rgbOf);
const PHASE_RGB = rgbOf(C.phase);

// C.phase at an alpha, for the fills and hairlines that mark the phase out.
function phaseColor(alpha) {
  return 'rgba(' + PHASE_RGB.join(',') + ',' + (alpha == null ? 1 : alpha) + ')';
}

// t is badness in [0,1]: 0 = the cue is met, 1 = it is not. Each diagnostic maps
// its own measurement onto that (see .score) so this ramp reads the same way
// across all of them. Null/NaN lands mid-ramp rather than looking like a pass.
function scoreColor(t, alpha) {
  t = (t == null || !isFinite(t)) ? 0.5 : Math.max(0, Math.min(1, t));
  const seg = t >= 0.5 ? 1 : 0;
  const f = t * 2 - seg;
  const a = RAMP_RGB[seg], b = RAMP_RGB[seg + 1];
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * f));
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (alpha == null ? 1 : alpha) + ')';
}

const fmt = (v, d) => (v == null || !isFinite(v)) ? '—' : v.toFixed(d == null ? 1 : d);


// --- track preparation --------------------------------------------------

// One entry per sampled frame in which this person was detected, in order.
function buildTrack(kpByFrame, meta, personId) {
  const frames = (meta.frame_indices && meta.frame_indices.length)
    ? meta.frame_indices
    : Object.keys(kpByFrame).map(Number).sort((a, b) => a - b);
  const samples = [];
  frames.forEach((f, slot) => {
    const perFrame = kpByFrame[String(f)];
    const kp = perFrame && perFrame[personId];
    if (!kp) return;
    // Decoder timestamps are the authority when present — deriving time from
    // fps desyncs on variable-frame-rate capture (see slotForTime in app.py).
    const t = (meta.frame_times_ms && meta.frame_times_ms[slot] != null)
      ? meta.frame_times_ms[slot] / 1000
      : f / (meta.fps || 30);
    samples.push({ frame: f, t, kp });
  });
  return samples;
}

// Drop sub-threshold keypoints, then fill the holes that leaves.
//
// Deliberately NOT a second smoothing pass. The trajectories arriving here have
// already been smoothed in time by the frontend's "time smoothing" control
// (app.py: smoothKeypoints), and averaging each present point with its
// neighbours again here would quietly mute that control: a fixed 5-frame mean
// removes most of the per-frame jitter on its own, so the plot barely moved
// between σ=off and σ=300ms and the number the lifter reads was mostly set by a
// constant they can't see. A point that survived the confidence gate is now
// taken at the value the slider produced for it.
//
// The fill is still needed: a keypoint that dips below confidence for a frame or
// two would otherwise punch a hole in the middle of the phase. Filled points are
// flagged .interp so the transparency block can count them — they are not
// measurements.
function preparePoints(samples) {
  for (const s of samples) {
    s.raw = {};
    for (const i of USED) {
      const q = s.kp[i];
      s.raw[i] = (q && q[2] >= DIAG_CONF) ? { x: q[1], y: q[0], c: q[2] } : null;
    }
  }
  const half = (FILL_WIN - 1) >> 1;
  for (let k = 0; k < samples.length; k++) {
    const p = {};
    for (const i of USED) {
      const here = samples[k].raw[i];
      if (here) { p[i] = { x: here.x, y: here.y, interp: false }; continue; }
      let sx = 0, sy = 0, n = 0;
      const lo = Math.max(0, k - half), hi = Math.min(samples.length - 1, k + half);
      for (let j = lo; j <= hi; j++) {
        const q = samples[j].raw[i];
        if (!q) continue;
        sx += q.x; sy += q.y; n++;
      }
      p[i] = n ? { x: sx / n, y: sy / n, interp: true } : null;
    }
    samples[k].p = p;
  }
}

// Median hip->shoulder length. The body scale every px threshold is divided by,
// so a threshold survives the lifter standing closer to the camera.
function torsoScale(samples) {
  const d = [];
  for (const s of samples) {
    const v = [];
    for (const [h, sh] of [[KP.lHip, KP.lSho], [KP.rHip, KP.rSho]]) {
      const a = s.p[h], b = s.p[sh];
      if (a && b) v.push(Math.hypot(a.x - b.x, a.y - b.y));
    }
    if (v.length) d.push(v.reduce((x, y) => x + y, 0) / v.length);
  }
  if (!d.length) return null;
  d.sort((a, b) => a - b);
  return d[d.length >> 1] || null;
}


// --- geometry -----------------------------------------------------------

function centroid(p, idxs) {
  let sx = 0, sy = 0, n = 0;
  for (const i of idxs) {
    const q = p[i];
    if (!q) continue;
    sx += q.x; sy += q.y; n++;
  }
  return n ? { x: sx / n, y: sy / n } : null;
}

const kneePoint = p => centroid(p, [KP.lKnee, KP.rKnee]);
const hipPoint = p => centroid(p, [KP.lHip, KP.rHip]);
const wristCentroid = p => centroid(p, [KP.lWri, KP.rWri]);


// --- the bar axis -------------------------------------------------------
//
// One direction per clip: where "along the bar" points in the image, and hence
// where "up" is.
//
// Read off the LIFTER, not the bar. Every left/right pair — shoulders, hips,
// knees, ankles — is separated across the platform, i.e. along the bar, so each
// pair is an independent reading of the same direction. The wrists are a pair
// too and are deliberately not used: the hands are what the plates hide, and a
// wrist that has snapped to a plate rim tilts its line by tens of degrees.
//
// From ONE frame — the setup, the last still frame before the bar moves — and
// not an average over the clip. The direction is constant, but the body is not:
// the lifter twists, joints occlude each other and then reappear, and each of
// those turns into a wrong slope that an average over frames mixes in rather
// than cancels out. At the setup the lifter is square to the camera, motionless
// and unoccluded, which makes it the one frame in the clip worth trusting.
// Several pairs at that instant give the redundancy that several frames were
// supposed to give, without the movement.
//
// Everything downstream measures against this axis rather than the image axes —
// heights (the bar/knee crossing, peak hip elevation), the trunk's inclination,
// and every rule drawn across the frame — so a camera that isn't quite level
// doesn't tilt the numbers or the marks that explain them.
const AXIS_PAIRS = [
  [KP.lSho, KP.rSho, 'shoulders'],
  [KP.lHip, KP.rHip, 'hips'],
  [KP.lKnee, KP.rKnee, 'knees'],
  [KP.lAnk, KP.rAnk, 'ankles'],
];
const AXIS_MIN_SEP = 0.05;   // torso-lengths a pair must span before its line carries a direction
const AXIS_PAIR_TOL = 12;    // degrees a pair may sit from the median before it is an outlier
const AXIS_MIN_PAIRS = 2;    // pairs that must agree before the frame can set the axis
const AXIS_SEARCH = 5;       // frames forward to try if the setup frame can't
const AXIS_MAX_TILT = 25;    // degrees; beyond this the estimate is not believed at all

function axisFrom(deg, info) {
  const th = deg * Math.PI / 180;
  return Object.assign({
    deg,
    ux: Math.cos(th), uy: Math.sin(th),    // unit vector along the bar, pointing right
    dx: -Math.sin(th), dy: Math.cos(th),   // unit vector "down" — perpendicular to it
    fallback: false, reason: null,
  }, info);
}

// The image axes themselves: what every height meant before this existed, and
// what they fall back to when the body can't say otherwise.
const IMAGE_AXIS = axisFrom(0, { fallback: true, reason: 'not-estimated', pairs: [], used: [] });

// Every left/right pair visible in one frame, as an angle off the image
// horizontal plus the baseline it was measured over.
function pairSlopes(raw, scale) {
  const out = [];
  for (const [li, ri, name] of AXIS_PAIRS) {
    // Raw detections only: a gap-filled point is the mean of its neighbours, so
    // it would vote for a direction it never independently saw.
    const a = raw[li], b = raw[ri];
    if (!a || !b) continue;
    let dx = b.x - a.x, dy = b.y - a.y;
    const sep = Math.hypot(dx, dy);
    // A pair a few px wide is jitter pointing somewhere random, and its angular
    // error is unbounded rather than merely large.
    if (sep < AXIS_MIN_SEP * scale) continue;
    if (dx < 0) { dx = -dx; dy = -dy; }   // the bar has no left end; keep one orientation
    out.push({ name, deg: Math.atan2(dy, dx) * 180 / Math.PI, sep });
  }
  return out;
}

// `anchorIdx` is the setup frame. If it can't produce two pairs that agree, the
// next few frames are tried before giving up — a single dropped detection at the
// setup shouldn't cost the whole clip its axis — and how far it had to walk is
// reported, since a frame taken mid-pull is a weaker claim than the setup.
function bodyAxis(samples, scale, anchorIdx, anchored) {
  const start = Math.max(0, anchorIdx);
  let reason = 'no-pairs';
  for (let k = start; k < Math.min(samples.length, start + AXIS_SEARCH + 1); k++) {
    const found = pairSlopes(samples[k].raw, scale);
    if (found.length < AXIS_MIN_PAIRS) continue;

    // Median, then drop what sits far from it: with three or four pairs one
    // badly-placed joint would otherwise drag a plain mean along with it.
    const sorted = found.map(f => f.deg).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    // A majority of the pairs that ARE visible has to agree, not just two of
    // them: with four pairs on the frame, two happening to line up while the
    // other two point elsewhere is a coincidence, not a direction.
    const keep = found.filter(f => Math.abs(f.deg - med) <= AXIS_PAIR_TOL);
    if (keep.length < AXIS_MIN_PAIRS || keep.length * 2 <= found.length) { reason = 'inconsistent'; continue; }

    // The filter is one-sided around the median, so what survives it can still
    // span twice the tolerance. What matters is whether the pairs that remain
    // agree with each OTHER: two joints pointing 20° apart have not identified a
    // direction, they have averaged two wrong ones.
    const degs = keep.map(f => f.deg);
    const spread = Math.max.apply(null, degs) - Math.min.apply(null, degs);
    if (spread > AXIS_PAIR_TOL) { reason = 'inconsistent'; continue; }

    // Weighted by baseline: a pair's angular error goes as its pixel error over
    // its separation, so the shoulders outvote the ankles when the ankles are
    // nearly on top of each other.
    const wsum = keep.reduce((a, f) => a + f.sep, 0);
    const deg = keep.reduce((a, f) => a + f.deg * f.sep, 0) / wsum;
    const info = {
      frame: samples[k].frame, slot: k, walked: k - start, anchored: !!anchored,
      pairs: found.map(f => f.name), used: keep.map(f => f.name), spread,
    };
    if (!isFinite(deg) || Math.abs(deg) > AXIS_MAX_TILT) {
      return Object.assign({}, IMAGE_AXIS, info, { reason: 'implausible', measuredDeg: deg });
    }
    return axisFrom(deg, info);
  }
  return Object.assign({}, IMAGE_AXIS, { reason, anchored: !!anchored, frame: samples[start] ? samples[start].frame : null });
}

// The same bullet in every diagnostic's transparency block: they all measure
// against this one direction, so they all have to expose which frame and which
// joints set it, and how well those joints agreed.
function axisNote(ax) {
  const head = '<strong>Bar axis</strong> — ';
  const list = a => a.length < 2 ? (a[0] || 'nothing')
    : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  if (!ax || ax.fallback) {
    const why = !ax || ax.reason === 'no-pairs'
      ? 'no frame at the start of the lift had two left/right joint pairs detected far enough apart to carry a direction'
      : ax.reason === 'inconsistent'
        ? 'the left/right pairs at the start of the lift disagreed with each other by more than ' +
          fmt(AXIS_PAIR_TOL, 0) + '°, which is what an occluded joint looks like'
        : 'the pairs settled on ' + fmt(ax.measuredDeg, 1) + '°, past the ' +
          fmt(AXIS_MAX_TILT, 0) + '° of camera roll this is willing to believe';
    return head + 'not estimated — ' + why + '. Heights and rules fall back to the image horizontal, ' +
      'which is right if the camera was level and wrong by exactly its tilt if it was not.';
  }
  return head + 'the bar reads ' + fmt(ax.deg, 1) + '° off the image horizontal, from the ' +
    list(ax.used) + ' at frame ' + ax.frame + ' — ' +
    (ax.anchored
      ? (ax.walked ? 'the ' + ax.walked + ' frame(s) after the setup, the setup itself not having enough joints visible'
                   : 'the setup, the last still frame before the bar moves')
      : 'the start of the clip, the setup not having been found') +
    '. Those pairs agreed to within ' + fmt(ax.spread, 1) + '°' +
    (ax.used.length < ax.pairs.length
      ? ', after dropping the ' + list(ax.pairs.filter(n => ax.used.indexOf(n) < 0)) +
        (ax.pairs.length - ax.used.length > 1 ? ' as outliers' : ' as an outlier') : '') +
    '. Measured on one frame, not averaged over the clip: left/right pairs are only square to the bar while ' +
    'the lifter is set over it. One direction for the whole clip — heights, the trunk angle and every rule ' +
    'drawn on the frame are measured against it.';
}

// A point in bar coordinates: .x along the bar, .y down from it. Identical to
// the image coordinates when the axis is the image's own.
const toBar = (pt, ax) => ({ x: pt.x * ax.ux + pt.y * ax.uy, y: pt.x * ax.dx + pt.y * ax.dy });
const fromBar = (a, h, ax) => ({ x: a * ax.ux + h * ax.dx, y: a * ax.uy + h * ax.dy });

// Height, still growing downward like image y — so every existing comparison
// ("A is above B" is A < B) reads the same as it did.
const elev = (pt, ax) => pt ? (pt.x * ax.dx + pt.y * ax.dy) : null;

// ViTPose has no bar keypoint. The hand wraps the bar, so the bar centre sits
// below the wrist joint centre by roughly a sixth of the forearm length —
// "below" along the bar axis's own down, not the image's. Averaged over
// whichever sides are visible.
function barPoint(p, ax) {
  const est = [];
  let noForearm = false;
  for (const [w, e] of [[KP.lWri, KP.lElb], [KP.rWri, KP.rElb]]) {
    const pw = p[w];
    if (!pw) continue;
    const pe = p[e];
    if (pe) {
      const d = Math.hypot(pw.x - pe.x, pw.y - pe.y) / 6;
      est.push({ x: pw.x + ax.dx * d, y: pw.y + ax.dy * d });
    } else { est.push({ x: pw.x, y: pw.y }); noForearm = true; }
  }
  if (!est.length) return null;
  return {
    x: est.reduce((a, b) => a + b.x, 0) / est.length,
    y: est.reduce((a, b) => a + b.y, 0) / est.length,
    sides: est.length,
    noForearm,
  };
}

// Angle of the hip->shoulder segment to the floor, in the image plane, where
// "the floor" is the bar axis rather than the image's bottom edge. 0deg =
// trunk parallel to the bar, 90deg = perpendicular to it. |dx| makes it
// independent of which way the lifter faces, so left- and right-facing videos
// score alike.
function trunkAngle(hip, sho, ax) {
  if (!hip || !sho) return null;
  const h = toBar(hip, ax), s = toBar(sho, ax);
  return Math.atan2(h.y - s.y, Math.abs(s.x - h.x)) * 180 / Math.PI;
}

// Interior angle at `joint` between rays to `a` and `b`, in degrees. 180deg
// means joint/a/b are collinear — a straight line through the joint, i.e. that
// joint is fully extended — regardless of how the segments are oriented in the
// image plane. Unlike trunkAngle this needs no reference axis, so it is the
// right measure for a joint angle (hip, knee) rather than a segment's tilt.
function jointAngle(joint, a, b) {
  if (!joint || !a || !b) return null;
  const v1x = a.x - joint.x, v1y = a.y - joint.y;
  const v2x = b.x - joint.x, v2y = b.y - joint.y;
  const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
  if (!m1 || !m2) return null;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (m1 * m2)));
  return Math.acos(cos) * 180 / Math.PI;
}

// Wrist-centroid speed in torso-lengths per second.
//
// Deliberately measured on an extra-smoothed centroid over a wider baseline
// than one frame: a few px of per-frame pose jitter divided by a 1/30s step
// reads as ~0.5 torso-lengths/s — several times the onset threshold — so a
// one-frame difference finds "motion" in a lifter standing perfectly still.
// Over ±2 samples of a 9-wide mean, that same jitter lands around 0.07 while
// an actual pull runs ~2, which is the margin the trigger needs.
const SPEED_SMOOTH = 9, SPEED_HALF = 2;

// The smoothing window that finds a peak has to be fixed in TIME, not in
// samples. Nine samples is 0.3s at 30fps and stride 1, which is what it was
// tuned as; at stride 3 the same nine samples span 27 frames, which flattens the
// peak they are being used to find and pushes the phase end most of a second
// late. Expressed in seconds it means the same thing at every stride.
const SMOOTH_SECONDS = SPEED_SMOOTH / 30;

function smoothWindow(samples) {
  const dts = [];
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].t - samples[i - 1].t;
    if (d > 0) dts.push(d);
  }
  if (!dts.length) return SPEED_SMOOTH;
  dts.sort((a, b) => a - b);
  const n = Math.round(SMOOTH_SECONDS / dts[dts.length >> 1]);   // median spacing
  return Math.max(3, n % 2 ? n : n + 1);                         // odd, at least 3
}

// A centred mean of a scalar-per-sample signal, tolerant of holes, over `win`
// samples (see smoothWindow). Used for a position signal (hip elevation) whose
// extremum is a trigger, so how wide this is directly sets how late that
// trigger fires.
function smoothSeries(raw, win) {
  const half = ((win || SPEED_SMOOTH) - 1) >> 1;
  return raw.map((_, k) => {
    let sum = 0, n = 0;
    for (let j = Math.max(0, k - half); j <= Math.min(raw.length - 1, k + half); j++) {
      if (raw[j] == null) continue;
      sum += raw[j]; n++;
    }
    return n ? sum / n : null;
  });
}

function wristSpeed(samples, scale) {
  const raw = samples.map(s => wristCentroid(s.p));
  const half = (SPEED_SMOOTH - 1) >> 1;
  const c = raw.map((_, k) => {
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(0, k - half); j <= Math.min(raw.length - 1, k + half); j++) {
      if (!raw[j]) continue;
      sx += raw[j].x; sy += raw[j].y; n++;
    }
    return n ? { x: sx / n, y: sy / n } : null;
  });
  const out = new Array(samples.length).fill(null);
  for (let i = SPEED_HALF; i < samples.length - SPEED_HALF; i++) {
    const a = c[i - SPEED_HALF], b = c[i + SPEED_HALF];
    const dt = samples[i + SPEED_HALF].t - samples[i - SPEED_HALF].t;
    if (!a || !b || !(dt > 0)) continue;
    out[i] = Math.hypot(b.x - a.x, b.y - a.y) / dt / scale;
  }
  return out;
}

const RUN = 3;             // samples a threshold (or its release) must hold for
const MOVE_ONSET = 0.15;   // torso-lengths/s — provisional

// The bar (wrist + 1/6 forearm) crossing from below knee height to above it,
// confirmed by persistence. This single event is both the end of the first
// pull and the start of the second by definition, so both diagnostics anchor
// on the same computation rather than each re-deriving it.
function barKneeCrossing(samples, ax) {
  const bar = samples.map(s => barPoint(s.p, ax));
  const knee = samples.map(s => kneePoint(s.p));
  // Compared as heights along the bar axis, not as image y: on a camera that
  // isn't level the two are not the same crossing, and this one is the event
  // both diagnostics' phases are defined by.
  const above = i => bar[i] && knee[i] && elev(bar[i], ax) < elev(knee[i], ax);
  const below = i => bar[i] && knee[i] && elev(bar[i], ax) > elev(knee[i], ax);

  // Start scanning from where the bar is actually below the knee, so a clip
  // that opens with the bar already overhead doesn't "end" at sample 0.
  let first = -1;
  for (let i = 0; i < samples.length; i++) if (below(i)) { first = i; break; }
  if (first < 0) return { bar, knee, idx: -1, reason: 'no-below' };

  for (let i = first + 1; i < samples.length; i++) {
    if (!above(i)) continue;
    let holds = true;   // require persistence: one stray frame is not a crossing
    for (let j = i; j < Math.min(i + RUN, samples.length); j++) if (!above(j)) { holds = false; break; }
    if (holds) return { bar, knee, idx: i, reason: null };
  }
  return { bar, knee, idx: -1, reason: 'no-cross' };
}

// The first pull's window: the bar/knee crossing that ends it, and the last
// stillness before that crossing, which is where the lift starts.
//
// Anchored on the END trigger, which is a crisp geometric crossing, then
// searched backwards for the start, which is a soft threshold on noisy velocity.
// Searching forwards from frame 0 for "the hands start moving" finds the setup
// instead — grip adjustments, the hook re-set, the lifter rocking into position
// all clear a motion threshold before the pull starts.
//
// Shared rather than left inside diagnostic 1, because the bar axis is read at
// the start frame this returns: two versions of "where the lift starts" drifting
// apart would put the axis on a different frame than the phase it belongs to,
// and each would look right on its own.
function firstPullWindow(samples, scale, ax) {
  const cross = barKneeCrossing(samples, ax);
  if (cross.idx < 0) return { cross, startIdx: -1, endIdx: -1, clamped: false, onsetSpeed: null };
  const endIdx = cross.idx;
  const speed = wristSpeed(samples, scale);

  let startIdx = -1;
  for (let i = endIdx - 1; i >= RUN - 1; i--) {
    let quiet = true;
    for (let j = 0; j < RUN; j++) {
      const v = speed[i - j];
      if (v == null || v >= MOVE_ONSET) { quiet = false; break; }
    }
    if (quiet) { startIdx = i; break; }
  }
  const clamped = startIdx < 0;   // clip probably starts mid-pull
  if (clamped) startIdx = 0;

  let onsetSpeed = null;
  for (let i = startIdx + 1; i <= endIdx; i++) {
    if (speed[i] != null && speed[i] >= MOVE_ONSET) { onsetSpeed = speed[i]; break; }
  }
  return { cross, startIdx, endIdx, clamped, onsetSpeed };
}

// A rule through `pt` spanning the frame, parallel to the bar — the drawn form
// of a height. Purple in every diagnostic that uses it: a rule says which
// heights a trigger compared, not how the lift went. Drawn from the axis rather
// than as a horizontal line so the mark agrees with the number it explains.
function barRule(ctx, pt, ax, dash, alpha, width) {
  if (!pt) return;
  const span = ctx.canvas.width + ctx.canvas.height;   // crosses the frame at any tilt
  ctx.save();
  ctx.strokeStyle = phaseColor(alpha);
  ctx.setLineDash(dash || []);
  if (width) ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(pt.x - ax.ux * span, pt.y - ax.uy * span);
  ctx.lineTo(pt.x + ax.ux * span, pt.y + ax.uy * span);
  ctx.stroke();
  ctx.restore();
}


// --- diagnostic 1: first pull, constant back angle ----------------------

const TRAIL = 4;           // sampled frames of history drawn behind the current one
const TRAIL_ALPHA = 0.22;  // alpha of the newest trail frame; older ones fade from it
const SD_GOOD = 2.5, SD_WARN = 5.0;   // degrees — provisional, see the note

// The cue is that the back angle HOLDS, so the colour tracks change, not the
// angle itself: a lifter who sets up at 25° and one who sets up at 45° are both
// doing it right, and colouring the absolute value marked the second one red for
// their build and their bar height.
//
// It is one constant per lift — total drift over the pull, 0° green to 90° red —
// not a per-frame value. Recolouring frame by frame made the mark flicker
// through the ramp during playback and invited reading a single frame's colour
// as a verdict; what the cue is actually about is how far the trunk ended up
// from where it started, which is a property of the whole pull.
const DRIFT_RED = 90;   // degrees of drift at the red end of the ramp
const driftScore = summary =>
  (!summary || summary.drift == null || !isFinite(summary.drift)) ? null
    : Math.max(0, Math.min(1, Math.abs(summary.drift) / DRIFT_RED));

const firstPullBackAngle = {
  id: 'first-pull-back-angle',
  title: 'First pull — constant back angle',
  phaseLabel: 'first pull',
  cue: 'Through the first pull the back angle to the floor stays constant: the knees open and the bar rises, but the trunk keeps its inclination.',
  unit: '°',

  // Active phase: floor to bar-past-knee — both triggers come from
  // firstPullWindow, which is shared with the bar-axis estimate (see there for
  // why the start is searched backwards from the end).
  phase(samples, scale, ax) {
    const notes = [];
    const w = firstPullWindow(samples, scale, ax);
    if (w.cross.idx < 0) {
      return { error: w.cross.reason === 'no-below'
        ? 'The bar never sits below knee height in this clip — there is no first pull to score.'
        : 'The bar never crosses knee height — the first pull has no end trigger in this clip.' };
    }
    const { startIdx, endIdx } = w, bar = w.cross.bar, knee = w.cross.knee;
    if (w.clamped) {
      notes.push('No still period was found before the bar reached the knee — the clip probably starts mid-pull. The phase start is clamped to the first frame, so the beginning of the first pull may be missing.');
    }
    if (endIdx - startIdx < RUN) {
      return { error: `The first pull resolved to only ${endIdx - startIdx + 1} sampled frame(s) — too short to score. Try a lower frame stride.` };
    }

    const gapPx = elev(knee[endIdx], ax) - elev(bar[endIdx], ax);
    return {
      startIdx, endIdx, notes,
      triggers: {
        onsetSpeed: w.onsetSpeed,
        clamped: w.clamped,
        crossGapPx: gapPx,
        crossGapTorso: gapPx / scale,
      },
      bar, knee,
    };
  },

  // Two independent estimates from disjoint keypoints: left hip->shoulder and
  // right hip->shoulder. Their mean is the reported angle; their absolute
  // difference is the uncertainty band.
  measure(samples, phase, ax) {
    const notes = [];
    const series = [];
    let both = 0, interp = 0, noForearm = 0;

    for (let i = phase.startIdx; i <= phase.endIdx; i++) {
      const p = samples[i].p;
      const aL = trunkAngle(p[KP.lHip], p[KP.lSho], ax);
      const aR = trunkAngle(p[KP.rHip], p[KP.rSho], ax);
      const vals = [aL, aR].filter(v => v != null);
      if (!vals.length) continue;
      if (vals.length === 2) both++;
      if ([KP.lHip, KP.lSho, KP.rHip, KP.rSho].some(k => p[k] && p[k].interp)) interp++;
      if (phase.bar[i] && phase.bar[i].noForearm) noForearm++;
      series.push({
        idx: i,
        frame: samples[i].frame,
        t: samples[i].t,
        value: vals.reduce((a, b) => a + b, 0) / vals.length,
        lo: Math.min.apply(null, vals),
        hi: Math.max.apply(null, vals),
        spread: vals.length === 2 ? Math.abs(aL - aR) : null,
      });
    }
    if (series.length < RUN) {
      return { error: 'Neither hip–shoulder pair stayed above the confidence threshold for long enough inside the first pull.' };
    }

    const vals = series.map(s => s.value);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) * (v - mean), 0) / vals.length);
    const spreads = series.map(s => s.spread).filter(v => v != null);
    const summary = {
      mean, sd,
      range: Math.max.apply(null, vals) - Math.min.apply(null, vals),
      drift: vals[vals.length - 1] - vals[0],
      meanSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null,
      n: series.length,
      bothSides: both / series.length,
      interpFrac: interp / series.length,
      duration: series[series.length - 1].t - series[0].t,
    };

    if (mean > 75) {
      notes.push('The trunk reads near-vertical for the whole pull, which usually means the clip is filmed front-on rather than side-on. The angle saturates near 90° in that view and this score is not meaningful.');
    }
    if (summary.meanSpread != null && summary.meanSpread > 8) {
      notes.push('The two sides disagree by ' + fmt(summary.meanSpread) + '° on average. A steady offset means the camera is not square to the lifter (or the lifter is twisted on the bar) — real signal, not error. A jittery one means the pose track is unreliable; check the band on the plot.');
    }
    if (noForearm > series.length * 0.25) {
      notes.push('An elbow dropped below confidence on ' + Math.round(100 * noForearm / series.length) + '% of frames, so the bar estimate fell back to the bare wrist there — the phase end may be a frame or two early.');
    }
    return { series, summary, notes };
  },

  // A missing summary scores null (mid-ramp) rather than a false pass.
  score: driftScore,

  verdict(summary) {
    if (summary.sd <= SD_GOOD) return { label: 'holds well', status: 'good' };
    if (summary.sd <= SD_WARN) return { label: 'some rise', status: 'warning' };
    return { label: 'chest rises early', status: 'critical' };
  },

  // Dashed reference line: the phase's own mean, since the cue is about
  // constancy relative to the lift itself, not a fixed external target.
  referenceLine(summary) {
    return { value: summary.mean, label: 'mean ' + fmt(summary.mean) + '°' };
  },

  tiles(summary, verdict) {
    return [
      { label: 'Back-angle constancy', value: fmt(summary.sd) + '°',
        sub: verdict.label + ' · SD over the pull', status: verdict.status },
      // The tile that names the number the ramp is built from carries the ramp
      // colour itself, so the plot's hue has a legend somewhere.
      { label: 'Drift', value: (summary.drift >= 0 ? '+' : '') + fmt(summary.drift) + '°',
        sub: 'end minus start', status: scoreColor(driftScore(summary)) },
      { label: 'Mean angle', value: fmt(summary.mean) + '°', sub: 'to the floor' },
      { label: 'L/R disagreement', value: summary.meanSpread == null ? '—' : '±' + fmt(summary.meanSpread) + '°', sub: 'uncertainty' },
    ];
  },

  transparencyLines(res, samples, ctxExtra) {
    const s = res.summary, ph = res.phase, tr = ph.triggers;
    const pct = v => Math.round(v * 100) + '%';
    return [
      '<strong>Phase</strong> — frames ' + samples[ph.startIdx].frame + '–' +
        samples[ph.endIdx].frame + ', ' + fmt(s.duration, 2) + 's, ' + s.n + ' sampled frames measured.',
      '<strong>Start trigger</strong> — last stillness before the pull' +
        (tr.clamped ? ' (not found; clamped to the first frame)'
                    : ', wrist speed then rising past ' + fmt(MOVE_ONSET, 2) + ' torso-lengths/s (measured ' + fmt(tr.onsetSpeed, 2) + ').'),
      '<strong>End trigger</strong> — estimated bar (wrist + 1/6 forearm) crossed knee height, clearing it by ' +
        fmt(tr.crossGapPx, 0) + 'px (' + fmt(tr.crossGapTorso, 2) + ' torso-lengths).',
      '<strong>Measurement</strong> — left and right hip→shoulder scored separately; ' +
        pct(s.bothSides) + ' of frames had both sides visible, ' + pct(s.interpFrac) +
        ' relied on a detection filled in from neighbouring frames.',
      axisNote(ctxExtra.axis),
      '<strong>Time smoothing</strong> — ' + (ctxExtra.smoothingMs
        ? 'trajectories were smoothed with a Gaussian of σ = ' + ctxExtra.smoothingMs +
          ' ms before scoring (the slider under the video). Widening it lowers the SD ' +
          'above whether or not the back angle actually held, so compare lifts at one setting.'
        : 'off — scored on raw per-frame detections, so pose jitter is counted as ' +
          'back-angle movement and the SD reads high.'),
      '<strong>Caveat</strong> — angles are in the image plane, so this assumes a side-on camera. The good/warning bands (' +
        fmt(SD_GOOD, 1) + '° / ' + fmt(SD_WARN, 1) + '° SD) are provisional and not fitted to labelled lifts. ' +
        'The green-to-red colour is a separate reading — total drift, full red at ' + fmt(DRIFT_RED, 0) +
        '° — so a lift can score red on constancy while the colour stays green, if the angle wandered and came back.',
    ].concat(res.notes.map(n => '<strong>Note</strong> — ' + n));
  },

  // Everything the two triggers and the measurement rest on, drawn on the frame
  // itself while the playhead is inside the phase.
  //
  // `view` is the track at the playhead's actual time (see pointsAtTime), not a
  // sampled frame: view.p are the points now, view.at(t) the points at any other
  // instant inside the phase, view.dt the mean spacing of processed frames.
  overlay(ctx, view, phase, res, size) {
    const p = view.p, ax = view.axis;
    // Recomputed from the points being drawn rather than indexed out of the
    // phase arrays. At a processed frame these are the same two points — same
    // functions, same axis — and in between them the rules track the bar
    // instead of holding the last frame's height, so the crossing the phase end
    // is defined by is visible at the moment it happens.
    const bar = barPoint(p, ax), knee = kneePoint(p);
    const lw = Math.max(2, size / 260);

    // Both hip->shoulder segments carry the lift's colour: the mark that IS the
    // measurement is also the readout of it, so the frame and the plot cannot
    // disagree about how the pull scored.
    const segments = pp => [[KP.lHip, KP.lSho], [KP.rHip, KP.rSho]]
      .map(([h, sh]) => [pp[h], pp[sh]])
      .filter(([a, b]) => a && b);
    const stroke = pp => {
      for (const [a, b] of segments(pp)) {
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    };
    const col = alpha => scoreColor(this.score(res.summary), alpha);

    // A short trail of the previous few sampled frames, in the same colour at a
    // fading alpha: a chest that rises leaves a spreading fan, one that holds
    // leaves a tight bundle. Kept faint and clipped to the phase — it is context
    // for the current frame, not a second reading of it, and it must not compete
    // with the white pose track underneath.
    //
    // Spaced one processed frame apart in TIME rather than taken at the last
    // few sample indices, so the whole fan slides with the playhead instead of
    // popping a new segment in each time a frame is crossed.
    if (view.dt > 0) {
      ctx.save();
      ctx.lineWidth = lw * 1.2;
      for (let k = TRAIL; k >= 1; k--) {
        const pp = view.at(view.t - k * view.dt);   // null before the phase starts
        if (!pp) continue;
        ctx.strokeStyle = col(TRAIL_ALPHA * (1 - k / (TRAIL + 1)));
        stroke(pp);
      }
      ctx.restore();
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = lw * 3.2;   // ring for legibility
    stroke(p);
    ctx.strokeStyle = col(1); ctx.lineWidth = lw * 1.8;
    stroke(p);

    // Phase-end trigger: the two heights it compares, each as a hairline right
    // across the frame, parallel to the bar. Purple, not ramped — these say WHEN
    // the phase ends, they are not a judgement of the lift, and hue is what
    // separates the two roles. Solid at full strength is the bar estimate the
    // trigger actually uses (wrist dropped by a sixth of the forearm); dashed is
    // the bare wrist it was corrected from, so the size of that correction is
    // visible rather than taken on trust; the knee reference sits behind both at
    // half strength. Unlabelled — with all three spanning the frame it's weight,
    // not length, that separates the measurement from its reference.
    const wrist = wristCentroid(p);
    const thin = Math.max(1, lw * 0.35);
    barRule(ctx, knee, ax, [], 0.5, thin);
    // Skip the uncorrected rule when it would land under the corrected one — on
    // a frame where the elbow was missing they are the same estimate.
    if (wrist && bar && Math.abs(elev(wrist, ax) - elev(bar, ax)) > Math.max(thin * 2, size / 200)) {
      barRule(ctx, wrist, ax, [thin * 4, thin * 4], 0.55, thin);
    }
    barRule(ctx, bar, ax, [], 1, thin);
  },
};


// --- diagnostic 2: second pull, full triple extension --------------------

// Fraction of a torso-length the smoothed hip elevation must give back from its
// running minimum, and hold given back for RUN samples, before that minimum
// counts as the peak. Same "require persistence" idea as the first pull's
// motion trigger, applied to confirming a peak instead of a threshold crossing
// — a still-rising hip that dips one noisy sample must not end the phase.
const EXT_CONFIRM_RISE = 0.08;
const EXT_GOOD = 10, EXT_WARN = 20;   // degrees short of full extension — provisional

// One constant per lift for the shared green->amber->red ramp, same contract as
// diagnostic 1's driftScore: the worst of the two measured joints, since
// "triple extension" is not met by extending only the hip. Full red at a joint
// left this far short of straight — a pull abandoned around the hip crease.
const EXT_RED = 45;
const extensionScore = summary => {
  if (!summary) return null;
  const d = [summary.hipDeficit, summary.kneeDeficit].filter(v => v != null && isFinite(v));
  if (!d.length) return null;
  return Math.max(0, Math.min(1, Math.max.apply(null, d) / EXT_RED));
};

const secondPullTripleExtension = {
  id: 'second-pull-triple-extension',
  title: 'Second pull — full triple extension',
  phaseLabel: 'second pull',
  cue: 'At the top of the second pull the hips and knees open fully — "triple extension" — before the arms bend into the turnover.',
  unit: '°',

  // Active phase: bar-past-knee (the first pull's own end trigger) to peak hip
  // elevation.
  //
  // Anchored on the same bar/knee crossing diagnostic 1 ends on — it is the
  // same event by definition, so both diagnostics compute it once via
  // barKneeCrossing rather than risking two triggers drifting apart. The end
  // trigger here is softer: hip elevation is a smoothed extremum, not a crisp
  // crossing, so it needs the persistence check described above rather than a
  // single "is this the max so far" test, which would fire on the first noisy
  // sample that happens to jitter upward.
  phase(samples, scale, ax) {
    const notes = [];
    const cross = barKneeCrossing(samples, ax);
    if (cross.idx < 0) {
      return { error: 'The bar never crosses knee height — there is no second pull to score without the first pull\'s end trigger.' };
    }
    const startIdx = cross.idx;
    // Height along the bar axis, not image y: on a tilted camera a hip that
    // travels sideways would otherwise read as rising or falling.
    const hips = samples.map(s => hipPoint(s.p));
    const win = smoothWindow(samples);
    const height = smoothSeries(hips.map(h => elev(h, ax)), win);   // smaller = higher hip

    let bestIdx = -1, bestY = Infinity, endIdx = -1;
    for (let i = startIdx; i < samples.length; i++) {
      if (height[i] == null) continue;
      if (height[i] < bestY) { bestY = height[i]; bestIdx = i; continue; }
      if (bestIdx < 0 || height[i] - bestY <= EXT_CONFIRM_RISE * scale) continue;
      let holds = true;
      for (let j = i; j < Math.min(i + RUN, samples.length); j++) {
        if (height[j] == null || height[j] - bestY <= EXT_CONFIRM_RISE * scale) { holds = false; break; }
      }
      if (holds) { endIdx = bestIdx; break; }
    }
    if (endIdx < 0) {
      if (bestIdx < 0) {
        return { error: 'The hips were never confidently tracked after the bar passed the knee — there is no second pull to score.' };
      }
      // The clip may simply end at or near peak extension — report the best
      // point found so far rather than nothing, flagged as unconfirmed.
      endIdx = bestIdx;
      notes.push('The hip never confirmed a descent after its highest point in this clip — it may end right at peak extension. The phase end is the highest point found so far, not a confirmed peak, so it may be a little early.');
    }
    if (endIdx - startIdx < RUN) {
      return { error: `The second pull resolved to only ${endIdx - startIdx + 1} sampled frame(s) — too short to score. Try a lower frame stride.` };
    }

    return {
      startIdx, endIdx, notes,
      // Where the rule marking the peak is drawn: the hip as MEASURED at the
      // frame the trigger chose. The smoothed signal's job is to pick that frame
      // without a noisy sample stealing it; its value is a mean over the
      // window either side, which sits below the hip by however far the hip
      // travelled during it — and a rule labelled "peak hip height" drawn below
      // the hips is just wrong.
      peakPoint: hips[endIdx] || null,
      smoothWin: win,
      triggers: {
        crossGapPx: (cross.bar[startIdx] && cross.knee[startIdx])
          ? (elev(cross.knee[startIdx], ax) - elev(cross.bar[startIdx], ax)) : null,
        confirmed: !notes.length,
      },
    };
  },

  // Hip angle (shoulder–hip–knee) is the headline, scored per side — two
  // independent estimates sharing no keypoints, same contract as diagnostic 1.
  // Knee angle (hip–knee–ankle) is tracked alongside it as the second of the
  // three joints "triple extension" names; ankle/plantarflexion is not
  // measured at all (see the note below — COCO-17 has no foot keypoint).
  measure(samples, phase) {
    const notes = [];
    const series = [];
    const kneeSeries = [];
    let both = 0, interp = 0;

    for (let i = phase.startIdx; i <= phase.endIdx; i++) {
      const p = samples[i].p;
      const hL = jointAngle(p[KP.lHip], p[KP.lSho], p[KP.lKnee]);
      const hR = jointAngle(p[KP.rHip], p[KP.rSho], p[KP.rKnee]);
      const hVals = [hL, hR].filter(v => v != null);
      if (!hVals.length) continue;
      if (hVals.length === 2) both++;
      if ([KP.lHip, KP.lSho, KP.lKnee, KP.rHip, KP.rSho, KP.rKnee].some(k => p[k] && p[k].interp)) interp++;
      series.push({
        idx: i, frame: samples[i].frame, t: samples[i].t,
        value: hVals.reduce((a, b) => a + b, 0) / hVals.length,
        lo: Math.min.apply(null, hVals),
        hi: Math.max.apply(null, hVals),
        spread: hVals.length === 2 ? Math.abs(hL - hR) : null,
      });

      const kL = jointAngle(p[KP.lKnee], p[KP.lHip], p[KP.lAnk]);
      const kR = jointAngle(p[KP.rKnee], p[KP.rHip], p[KP.rAnk]);
      const kVals = [kL, kR].filter(v => v != null);
      kneeSeries.push({ t: samples[i].t, value: kVals.length ? kVals.reduce((a, b) => a + b, 0) / kVals.length : null });
    }
    if (series.length < RUN) {
      return { error: 'Neither hip could be tracked with its shoulder and knee for long enough inside the second pull.' };
    }

    // Peak values are read from the last few samples of the phase rather than
    // the single last one: the phase end itself comes from a smoothed signal,
    // so one raw sample at that index can be noisy.
    const tailN = Math.min(3, series.length);
    const hipPeak = series.slice(-tailN).reduce((a, s) => a + s.value, 0) / tailN;
    const kneeTail = kneeSeries.slice(-tailN).filter(s => s.value != null);
    const kneePeak = kneeTail.length ? kneeTail.reduce((a, s) => a + s.value, 0) / kneeTail.length : null;

    // Synchrony: how far apart in time the hip and the knee each reach their
    // own maximum extension within the phase. "Triple extension" names a
    // simultaneous event — a lifter who extends the knees well before (or
    // after) the hips has split what the cue asks to happen together, even if
    // each joint individually reaches a good angle.
    let hipPeakIdx = 0, hipPeakVal = -Infinity;
    series.forEach((s, k) => { if (s.value > hipPeakVal) { hipPeakVal = s.value; hipPeakIdx = k; } });
    let kneePeakIdx = -1, kneePeakVal = -Infinity;
    kneeSeries.forEach((s, k) => { if (s.value != null && s.value > kneePeakVal) { kneePeakVal = s.value; kneePeakIdx = k; } });
    const syncGap = kneePeakIdx >= 0 ? Math.abs(series[hipPeakIdx].t - kneeSeries[kneePeakIdx].t) : null;

    const spreads = series.map(s => s.spread).filter(v => v != null);
    const summary = {
      hipPeak, kneePeak,
      hipDeficit: 180 - hipPeak,
      kneeDeficit: kneePeak == null ? null : 180 - kneePeak,
      syncGap,
      kneeLeadsHip: syncGap != null ? (kneeSeries[kneePeakIdx].t < series[hipPeakIdx].t) : null,
      meanSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null,
      n: series.length,
      bothSides: both / series.length,
      interpFrac: interp / series.length,
      duration: series[series.length - 1].t - series[0].t,
    };

    notes.push('Ankle extension (rising onto the toes) is not measured: ViTPose\'s COCO-17 output has no foot keypoint, so only two of the three joints in "triple extension" — hip and knee — are scored here.');
    if (summary.kneeDeficit == null) {
      notes.push('The knee angle could not be measured for enough of the phase (hip, knee or ankle confidence too low near the top) — only hip extension is scored this time.');
    }
    if (summary.meanSpread != null && summary.meanSpread > 8) {
      notes.push('The two sides\' hip angles disagree by ' + fmt(summary.meanSpread) + '° on average. A steady offset points to the camera not being square to the lifter (or the lifter twisted on the bar); a jittery one points to an unreliable pose track — check the band on the plot.');
    }
    return { series, summary, notes };
  },

  score: extensionScore,

  verdict(summary) {
    const deficits = [summary.hipDeficit].concat(summary.kneeDeficit != null ? [summary.kneeDeficit] : []);
    const worst = Math.max.apply(null, deficits);
    if (worst <= EXT_GOOD) return { label: 'full extension', status: 'good' };
    if (worst <= EXT_WARN) return { label: 'partial extension', status: 'warning' };
    return { label: 'pull cut short', status: 'critical' };
  },

  // Dashed reference line at the anatomical target itself (a straight joint),
  // not at the phase's own mean — unlike diagnostic 1, the cue here is
  // distance from a fixed reference, not internal constancy.
  referenceLine() {
    return { value: 180, label: 'full extension' };
  },

  tiles(summary, verdict) {
    return [
      { label: 'Hip extension', value: fmt(summary.hipDeficit) + '° short',
        sub: verdict.label, status: verdict.status },
      { label: 'Knee extension', value: summary.kneeDeficit == null ? '—' : fmt(summary.kneeDeficit) + '° short',
        sub: 'from full extension' },
      { label: 'Synchrony', value: summary.syncGap == null ? '—' : fmt(summary.syncGap * 1000, 0) + ' ms',
        sub: summary.kneeLeadsHip == null ? 'hip/knee peak gap' : (summary.kneeLeadsHip ? 'knee leads hip' : 'hip leads knee') },
      { label: 'L/R disagreement', value: summary.meanSpread == null ? '—' : '±' + fmt(summary.meanSpread) + '°', sub: 'hip angle uncertainty' },
    ];
  },

  transparencyLines(res, samples, ctxExtra) {
    const s = res.summary, ph = res.phase, tr = ph.triggers;
    const pct = v => Math.round(v * 100) + '%';
    return [
      '<strong>Phase</strong> — frames ' + samples[ph.startIdx].frame + '–' +
        samples[ph.endIdx].frame + ', ' + fmt(s.duration, 2) + 's, ' + s.n + ' sampled frames measured.',
      '<strong>Start trigger</strong> — bar (wrist + 1/6 forearm) crossing knee height' +
        (tr.crossGapPx != null ? ', clearing it by ' + fmt(tr.crossGapPx, 0) + 'px' : '') +
        ' — the same event that ends the first pull.',
      '<strong>End trigger</strong> — hip elevation, smoothed over ' + ph.smoothWin +
        ' sampled frames (' + fmt(SMOOTH_SECONDS, 2) + 's, fixed in time so the frame stride ' +
        'does not move it), reaching its highest point' +
        (tr.confirmed
          ? ', confirmed by the hip dropping back at least ' + fmt(EXT_CONFIRM_RISE, 2) + ' torso-lengths afterward.'
          : ' (unconfirmed in this clip — see note below).'),
      '<strong>Measurement</strong> — hip angle (shoulder–hip–knee) scored per side; knee angle (hip–knee–ankle) scored per side alongside it. ' +
        pct(s.bothSides) + ' of frames had both hip-side estimates, ' + pct(s.interpFrac) + ' relied on a detection filled in from neighbouring frames.',
      axisNote(ctxExtra.axis),
      '<strong>Peak reading</strong> — the extension numbers are the mean of the last ' + Math.min(3, s.n) +
        ' sampled frames of the phase, not one raw sample, since the phase end itself comes from a smoothed signal.',
      '<strong>Time smoothing</strong> — ' + (ctxExtra.smoothingMs
        ? 'trajectories were smoothed with a Gaussian of σ = ' + ctxExtra.smoothingMs + ' ms before scoring (the slider under the video).'
        : 'off — scored on raw per-frame detections.'),
      '<strong>Caveat</strong> — angles are in the image plane (side-on camera assumed) and ankle extension is not measured (no foot keypoint). The extension bands (' +
        fmt(EXT_GOOD, 0) + '°/' + fmt(EXT_WARN, 0) + '° short of straight) are provisional and not fitted to labelled lifts. ' +
        'The green-to-red colour is the worse of the hip and knee deficits, full red at ' + fmt(EXT_RED, 0) +
        '° short, so it can read redder than the headline hip number when the knees are what stayed bent.',
    ].concat(res.notes.map(n => '<strong>Note</strong> — ' + n));
  },

  // The shoulder-hip-knee-ankle chain on each side, plus a full-width
  // reference line at the peak hip height the end trigger found — so the
  // extremum the phase ended on is visible on the frame, the same way
  // diagnostic 1 draws its knee/bar rules.
  //
  // `view` is the track at the playhead's actual time, not a sampled frame —
  // see diagnostic 1's overlay and pointsAtTime.
  overlay(ctx, view, phase, res, size) {
    const p = view.p;
    const lw = Math.max(2, size / 260);
    // The chain IS the measurement (both joint angles are read off it), so it
    // carries the ramp, exactly as the trunk segments do in diagnostic 1.
    const col = alpha => scoreColor(this.score(res.summary), alpha);

    for (const [sh, hip, knee, ank] of [[KP.lSho, KP.lHip, KP.lKnee, KP.lAnk], [KP.rSho, KP.rHip, KP.rKnee, KP.rAnk]]) {
      const chain = [p[sh], p[hip], p[knee], p[ank]];
      if (chain.some(pt => !pt)) continue;
      for (const [w, style] of [[lw * 3.2, 'rgba(0,0,0,0.55)'], [lw * 1.8, col(1)]]) {
        ctx.strokeStyle = style; ctx.lineWidth = w;
        ctx.beginPath(); ctx.moveTo(chain[0].x, chain[0].y);
        for (let k = 1; k < chain.length; k++) ctx.lineTo(chain[k].x, chain[k].y);
        ctx.stroke();
      }
    }

    // Purple, like diagnostic 1's trigger rules: this height is where the phase
    // ends, not a judgement of the lift. Parallel to the bar rather than to the
    // frame's bottom edge — it marks a height, and a height is only horizontal
    // if the camera was level.
    if (phase.peakPoint) {
      const ax = view.axis, pk = phase.peakPoint;
      barRule(ctx, pk, ax, [lw, lw * 1.5], 0.85, Math.max(1, lw * 0.6));
      // Sits on the rule at the left edge, so the label doesn't drift off it as
      // the tilt grows.
      const x = 6;
      ctx.fillStyle = phaseColor(1);
      ctx.font = Math.max(9, size / 62) + 'px system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText('peak hip height', x, pk.y + (x - pk.x) * (ax.uy / ax.ux) - 4);
    }
  },
};

const DIAGNOSTICS = [firstPullBackAngle, secondPullTripleExtension];

// Which diagnostics draw on the video. Only gates the overlay — a diagnostic
// that's switched off is still computed, plotted and scored, since the tickbox
// is about the frame getting crowded, not about what's being measured.
// Default on: a new diagnostic is invisible until you go looking for it
// otherwise.
const enabled = new Set(DIAGNOSTICS.map(d => d.id));


// --- runner -------------------------------------------------------------

let el = null;              // mounted elements
let state = null;           // { keypoints, meta, personId, samples, scale, results }
let smoothingMs = 0;        // time smoothing already applied to the track
let diagState = {};         // per-diagnostic render state: { canvas, ctx, stats, notes, geom, hover }

function personIds(kpByFrame) {
  const counts = new Map();
  for (const frame of Object.values(kpByFrame)) {
    for (const id of Object.keys(frame)) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || (+a[0]) - (+b[0]));
}

// Scores every diagnostic against one person's track. Pure function of its
// arguments — no DOM, no module state — so it is both what run() below calls
// and the headless entry point Diagnostics.computeResults() exposes for
// testing against a cached track.json (see tests/diagnostics.test.js) without
// mounting the canvas/toggle UI. Diagnostics are independent: one erroring
// (no clean phase found) does not stop the others from being computed.
function computeResults(keypoints, meta, personId) {
  const samples = buildTrack(keypoints, meta, personId);
  const results = {};

  if (samples.length < FILL_WIN) {
    const err = { error: `Person ${personId} was detected in only ${samples.length} sampled frame(s).` };
    for (const d of DIAGNOSTICS) results[d.id] = err;
    return { samples, scale: null, axis: null, results };
  }
  preparePoints(samples);
  const scale = torsoScale(samples);
  if (!scale) {
    const err = { error: 'No frame had a confident hip and shoulder on the same side, so there is no body scale to work from.' };
    for (const d of DIAGNOSTICS) results[d.id] = err;
    return { samples, scale: null, axis: null, results };
  }
  // One axis for the whole clip, computed here rather than inside any one
  // diagnostic: two diagnostics disagreeing about which way is up would be the
  // same class of bug as two of them re-deriving the bar/knee crossing.
  //
  // It is read at the setup frame, so the lift start has to be found before any
  // diagnostic runs. That trigger needs an axis of its own for the bar/knee
  // crossing, and the image axis stands in for it here — safe, because the
  // crossing frame moves by at most a frame or two under any roll the axis will
  // accept, and the setup frame it leads to is a still one either way.
  const anchor = firstPullWindow(samples, scale, IMAGE_AXIS);
  const axis = bodyAxis(samples, scale, anchor.startIdx, anchor.startIdx >= 0 && !anchor.clamped);

  for (const d of DIAGNOSTICS) {
    const phase = d.phase(samples, scale, axis);
    if (phase.error) { results[d.id] = { error: phase.error }; continue; }
    const m = d.measure(samples, phase, axis);
    if (m.error) { results[d.id] = { error: m.error }; continue; }
    results[d.id] = {
      phase,
      series: m.series,
      summary: m.summary,
      verdict: d.verdict(m.summary),
      notes: (phase.notes || []).concat(m.notes || []),
    };
  }
  return { samples, scale, axis, results };
}

function run() {
  if (!state || !state.keypoints || !state.meta || !state.personId) return;
  const out = computeResults(state.keypoints, state.meta, state.personId);
  state.samples = out.samples;
  state.scale = out.scale;
  state.axis = out.axis;
  state.results = out.results;
}


// --- continuous-time lookup ---------------------------------------------

// The video overlay hands this file a TIME, not a frame index. What it draws
// sits directly on top of app.py's wireframe, which is interpolated between
// processed frames, so marks placed at the nearest sampled frame would visibly
// trail it — the trunk segments would sit off the trunk for most of each
// frame's time on screen. A measurement drawn somewhere the joint isn't is
// worse than either layer stepping alone, so both move on the same clock.
//
// The interpolator is app.py's own (el.cubic), passed in rather than
// reimplemented so the two can't drift apart, and el.smoothMotion() is the same
// tickbox the mesh obeys. Linear if this is ever mounted without them.
function mixAt(v0, v1, v2, v3, t0, t1, t2, t3, u) {
  return el.cubic ? el.cubic(v0, v1, v2, v3, t0, t1, t2, t3, u) : v1 + (v2 - v1) * u;
}

function slotAtTime(samples, t) {
  let lo = 0, hi = samples.length - 1;   // last sample at or before t
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// The prepared points at an arbitrary time. A keypoint missing on either side
// of the gap is NOT blended — the nearer sample's value stands until halfway,
// exactly as the mesh does it — so an interpolated mark is never built out of a
// detection that isn't there.
function pointsAtTime(t) {
  const samples = state.samples;
  if (!samples || !samples.length || !samples[0].p) return null;
  const k = slotAtTime(samples, t);
  const a = samples[k], b = samples[k + 1];
  if (!b || !(el.smoothMotion && el.smoothMotion())) return a.p;
  const span = b.t - a.t;
  const u = span > 1e-9 ? Math.min(Math.max((t - a.t) / span, 0), 1) : 0;
  const prev = samples[k - 1], next = samples[k + 2];
  const t0 = prev ? prev.t : 0, t3 = next ? next.t : 0;
  const out = {};
  for (const i of USED) {
    const qa = a.p[i], qb = b.p[i];
    if (!qa || !qb) { out[i] = u < 0.5 ? qa : qb; continue; }
    const q0 = prev && prev.p[i], q3 = next && next.p[i];
    out[i] = {
      x: mixAt(q0 && q0.x, qa.x, qb.x, q3 && q3.x, t0, a.t, b.t, t3, u),
      y: mixAt(q0 && q0.y, qa.y, qb.y, q3 && q3.y, t0, a.t, b.t, t3, u),
      // a filled point on either side taints everything between them
      interp: qa.interp || qb.interp,
    };
  }
  return out;
}


// --- rendering ----------------------------------------------------------

const PAD = { l: 48, r: 18, t: 24, b: 30 };

function tDomain() {
  const meta = state.meta, samples = state.samples;
  const last = samples && samples.length ? samples[samples.length - 1].t : 0;
  const byCount = (meta.frame_count && meta.fps) ? meta.frame_count / meta.fps : 0;
  return Math.max(last, byCount, 0.001);
}

// `time` is where to put the playhead, in seconds; the video's own currentTime
// when the caller doesn't say (hover redraws, a fresh track).
function drawChart(d, ds, time) {
  const cv = ds.canvas, ctx = ds.ctx;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ds.geom = null;
  const res = state && state.results ? state.results[d.id] : null;
  if (!res) return;
  if (res.error) {
    ctx.fillStyle = C.muted;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    wrapText(ctx, res.error, cv.width / 2, cv.height / 2 - 6, cv.width - 60, 17);
    return;
  }

  const w = cv.width, h = cv.height;
  const gw = w - PAD.l - PAD.r, gh = h - PAD.t - PAD.b;
  const tMax = tDomain();

  // y domain: at least a 10-unit window (so a flat trace isn't magnified into
  // apparent wobble), and wide enough to include the reference line.
  let vMin = Infinity, vMax = -Infinity;
  for (const s of res.series) { vMin = Math.min(vMin, s.lo); vMax = Math.max(vMax, s.hi); }
  const ref = d.referenceLine ? d.referenceLine(res.summary) : null;
  if (ref) { vMin = Math.min(vMin, ref.value); vMax = Math.max(vMax, ref.value); }
  const span = Math.max(vMax - vMin, 10);
  const mid = (vMin + vMax) / 2;
  vMin = mid - span / 2 - span * 0.08;
  vMax = mid + span / 2 + span * 0.08;

  const X = t => PAD.l + (t / tMax) * gw;
  const Y = v => PAD.t + (1 - (v - vMin) / (vMax - vMin)) * gh;
  ds.geom = { X, Y, tMax, vMin, vMax, gw, gh };

  // One colour for the whole diagnostic, from the lift's total drift — the same
  // hue the overlay draws on the frame, so the plot and the video can't disagree
  // about how the lift scored.
  const col = alpha => scoreColor(d.score(res.summary), alpha);

  // active phase: shaded, and delimited by a hairline at each edge. Purple —
  // the boundary is not a verdict, and the ramp's own colours are spoken for.
  const t0 = res.series[0].t, t1 = res.series[res.series.length - 1].t;
  ctx.fillStyle = phaseColor(0.10);
  ctx.fillRect(X(t0), PAD.t, Math.max(1, X(t1) - X(t0)), gh);
  ctx.save();
  ctx.strokeStyle = phaseColor(0.75); ctx.lineWidth = 1;
  for (const t of [t0, t1]) {
    const x = Math.round(X(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + gh); ctx.stroke();
  }
  ctx.restore();

  ctx.font = '10px system-ui, sans-serif';
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  ctx.fillStyle = C.muted; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = vMin + (i / 4) * (vMax - vMin), y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(w - PAD.r, y); ctx.stroke();
    ctx.fillText(fmt(v, 0) + d.unit, PAD.l - 6, y + 3);
  }
  ctx.strokeStyle = C.axis;
  ctx.beginPath(); ctx.moveTo(PAD.l, PAD.t); ctx.lineTo(PAD.l, PAD.t + gh); ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = C.muted;
  ctx.fillText('0s', PAD.l, h - 8);
  ctx.fillText(fmt(tMax) + 's', w - PAD.r, h - 8);
  ctx.fillStyle = phaseColor(1);
  ctx.fillText(d.phaseLabel || d.title, (X(t0) + X(t1)) / 2, PAD.t - 9);

  // uncertainty band: the left-side and right-side estimates. Same colour as the
  // trace at low alpha — it is not a second series.
  ctx.fillStyle = col(0.22);
  ctx.beginPath();
  res.series.forEach((s, i) => { const x = X(s.t), y = Y(s.hi); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  for (let i = res.series.length - 1; i >= 0; i--) ctx.lineTo(X(res.series[i].t), Y(res.series[i].lo));
  ctx.closePath(); ctx.fill();

  // reference line, direct-labeled — the phase mean (diagnostic 1) or a fixed
  // anatomical target (diagnostic 2); each diagnostic decides which is
  // meaningful for its own cue.
  if (ref) {
    const ry = Y(ref.value);
    ctx.save();
    ctx.strokeStyle = C.ink2; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(X(t0), ry); ctx.lineTo(X(t1), ry); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = C.ink2; ctx.textAlign = 'left';
    ctx.fillText(ref.label, Math.min(X(t1) + 4, w - PAD.r - 70), ry - 4);
  }

  ctx.strokeStyle = col(1); ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  res.series.forEach((s, i) => { const x = X(s.t), y = Y(s.value); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();

  for (const s of [res.series[0], res.series[res.series.length - 1]]) {
    ctx.fillStyle = col(1);
    ctx.beginPath(); ctx.arc(X(s.t), Y(s.value), 4, 0, 2 * Math.PI); ctx.fill();
  }

  const v = el.video();
  const at = (typeof time === 'number' && isFinite(time)) ? time
           : (v && isFinite(v.currentTime) ? v.currentTime : null);
  if (at != null) {
    const x = X(Math.min(at, tMax));
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + gh); ctx.stroke();
    ctx.restore();
  }

  if (ds.hover != null) drawTooltip(ctx, res, w, h, ds, d);
}

function drawTooltip(ctx, res, w, h, ds, d) {
  const s = res.series[ds.hover];
  if (!s) return;
  const x = ds.geom.X(s.t), y = ds.geom.Y(s.value);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + ds.geom.gh); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = scoreColor(d.score(res.summary));
  ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = C.surface; ctx.lineWidth = 2; ctx.stroke();

  const lines = [
    fmt(s.t, 2) + 's · frame ' + s.frame,
    fmt(s.value) + d.unit,
    s.spread == null ? 'single estimate' : 'L/R differ ' + fmt(s.spread) + d.unit,
  ];
  ctx.font = '11px system-ui, sans-serif';
  const bw = Math.max.apply(null, lines.map(l => ctx.measureText(l).width)) + 16;
  const bh = lines.length * 14 + 10;
  const bx = Math.min(Math.max(x + 10, PAD.l), w - PAD.r - bw);
  const by = Math.min(Math.max(y - bh - 10, PAD.t), h - PAD.b - bh);
  ctx.fillStyle = 'rgba(13,13,13,0.94)';
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.fill(); ctx.stroke();
  ctx.textAlign = 'left';
  lines.forEach((l, i) => {
    ctx.fillStyle = i === 0 ? C.muted : C.ink;
    ctx.fillText(l, bx + 8, by + 17 + i * 14);
  });
}

function wrapText(ctx, text, cx, cy, maxW, lh) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const trial = line ? line + ' ' + word : word;
    if (ctx.measureText(trial).width > maxW && line) { lines.push(line); line = word; }
    else line = trial;
  }
  if (line) lines.push(line);
  const top = cy - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, cx, top + i * lh));
}

// status is either a verdict key (good/warning/critical) or a colour straight
// off the ramp — both come from the same three anchors, so a tile never
// introduces a hue the plot and the overlay don't already use.
function tile(label, value, sub, status) {
  const color = status ? (C[status] || status) : C.ink;
  return '<div class="diag-tile">' +
    '<div class="diag-tile-label">' + label + '</div>' +
    '<div class="diag-tile-value" style="color:' + color + '">' + value + '</div>' +
    '<div class="diag-tile-sub">' + (sub || '') + '</div></div>';
}

function drawPanels(d, ds, ctxExtra) {
  const res = state && state.results ? state.results[d.id] : null;
  if (!res) { ds.stats.innerHTML = ''; ds.notes.innerHTML = ''; return; }
  if (res.error) {
    ds.stats.innerHTML = '';
    ds.notes.innerHTML = '<p class="diag-note"><strong>Not scored.</strong> ' + res.error + '</p>';
    return;
  }
  ds.stats.innerHTML = d.tiles(res.summary, res.verdict).map(t => tile(t.label, t.value, t.sub, t.status)).join('');
  const items = d.transparencyLines(res, state.samples, ctxExtra);
  ds.notes.innerHTML = '<p class="diag-cue">' + d.cue + '</p><ul class="diag-notes">' +
    items.map(i => '<li>' + i + '</li>').join('') + '</ul>';
}

function redrawAll() {
  const ctxExtra = { smoothingMs, scale: state && state.scale, axis: state && state.axis };
  for (const d of DIAGNOSTICS) {
    const ds = diagState[d.id];
    if (!ds) continue;
    drawChart(d, ds);
    drawPanels(d, ds, ctxExtra);
  }
}


// --- public API ---------------------------------------------------------

// One tickbox per diagnostic. Built from DIAGNOSTICS rather than from the
// current track, so the list is stable across uploads and a diagnostic that
// couldn't be scored on this clip still shows why in the panel below.
function buildToggles() {
  if (!el.toggles) return;
  el.toggles.innerHTML = '';
  for (const d of DIAGNOSTICS) {
    const label = document.createElement('label');
    label.className = 'diag-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = enabled.has(d.id);
    box.addEventListener('change', () => {
      if (box.checked) enabled.add(d.id); else enabled.delete(d.id);
      if (el.redraw) el.redraw();   // the video overlay is owned by app.py
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode(' ' + d.title));
    el.toggles.appendChild(label);
  }
}

function nearestSample(ds, res, clientX) {
  if (!ds.geom || !res || res.error) return null;
  const rect = ds.canvas.getBoundingClientRect();
  const x = (clientX - rect.left) * (ds.canvas.width / rect.width);
  let best = null, bestD = Infinity;
  res.series.forEach((s, i) => {
    const d = Math.abs(ds.geom.X(s.t) - x);
    if (d < bestD) { bestD = d; best = i; }
  });
  return bestD <= 24 ? best : null;
}

// One section per diagnostic — its own tiles, canvas and notes — built into
// el.sections. A diagnostic's tickbox (buildToggles, above) only ever gates
// its video overlay; its section here is always present.
function buildSections() {
  if (!el.sections) return;
  el.sections.innerHTML = '';
  diagState = {};
  for (const d of DIAGNOSTICS) {
    const block = document.createElement('div');
    block.className = 'diag-block';

    const h = document.createElement('h4');
    h.className = 'diag-block-title';
    h.textContent = d.title;

    const stats = document.createElement('div');
    stats.className = 'diag-tiles';

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'diag-canvas-wrap';
    const canvas = document.createElement('canvas');
    canvas.width = 620; canvas.height = 240;
    canvas.className = 'diag-canvas';
    canvasWrap.appendChild(canvas);

    const notes = document.createElement('div');

    block.appendChild(h);
    block.appendChild(stats);
    block.appendChild(canvasWrap);
    block.appendChild(notes);
    el.sections.appendChild(block);

    const ds = { canvas, ctx: canvas.getContext('2d'), stats, notes, geom: null, hover: null };
    diagState[d.id] = ds;

    canvas.addEventListener('mousemove', e => {
      const res = state && state.results ? state.results[d.id] : null;
      const hIdx = nearestSample(ds, res, e.clientX);
      if (hIdx !== ds.hover) { ds.hover = hIdx; drawChart(d, ds); }
    });
    canvas.addEventListener('mouseleave', () => { if (ds.hover != null) { ds.hover = null; drawChart(d, ds); } });
    // click-to-seek, same contract as the keypoint plot: any point on the curve
    // goes back to the frame that produced it
    canvas.addEventListener('click', e => {
      if (!ds.geom) return;
      const v = el.video();
      if (!v) return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (canvas.width / rect.width);
      const ratio = Math.max(0, Math.min(1, (x - PAD.l) / ds.geom.gw));
      v.currentTime = ratio * ds.geom.tMax;
    });
  }
}

const Diagnostics = {
  // Headless entry point: scores every diagnostic against one person's track
  // with no DOM involved, for tests running against a cached track.json (see
  // tests/diagnostics.test.js). Returns { samples, scale, axis, results } —
  // the same shape run() stashes onto the (DOM-mounted) module state, minus
  // the DOM. Not used by the app itself; mount()/setTrack() below are.
  computeResults(keypoints, meta, personId) {
    return computeResults(keypoints, meta, personId);
  },

  mount(opts) {
    el = opts;
    buildToggles();
    buildSections();
    el.select.addEventListener('change', () => {
      state.personId = el.select.value;
      run();
      redrawAll();
    });
  },

  // opts.smoothingMs — the Gaussian σ the caller already applied to these
  // trajectories, reported in the notes below. Scoring depends on it, so it
  // belongs with the other things the lifter needs in order to distrust the
  // number.
  setTrack(keypoints, meta, opts) {
    smoothingMs = (opts && opts.smoothingMs) || 0;
    for (const d of DIAGNOSTICS) {
      const ds = diagState[d.id];
      if (ds) { ds.hover = null; ds.geom = null; }
    }
    if (!keypoints || !meta) {
      state = null;
      el.wrap.style.display = 'none';
      for (const d of DIAGNOSTICS) {
        const ds = diagState[d.id];
        if (!ds) continue;
        ds.ctx.clearRect(0, 0, ds.canvas.width, ds.canvas.height);
        ds.stats.innerHTML = ''; ds.notes.innerHTML = '';
      }
      return;
    }
    // The same track re-arrives whenever the frontend's time smoothing changes,
    // so hold onto the chosen lifter: re-picking them on every drag of that
    // slider would make it unusable on a clip with more than one person in it.
    const prev = state && state.personId;
    const ids = personIds(keypoints);
    el.select.innerHTML = '';
    for (const [id, n] of ids) {
      const o = document.createElement('option');
      o.value = id; o.textContent = 'person ' + id + ' (' + n + ' frames)';
      el.select.appendChild(o);
    }
    el.wrap.style.display = 'block';   // not '' — the stylesheet's own rule
                                       // hides #diagWrap until there's a track
    const keep = ids.some(([id]) => id === prev) ? prev : (ids.length ? ids[0][0] : null);
    if (keep != null) el.select.value = keep;
    state = { keypoints, meta, personId: keep };
    if (!state.personId) {
      state.results = {};
      const err = { error: 'No person was detected in any sampled frame.' };
      for (const d of DIAGNOSTICS) state.results[d.id] = err;
    } else {
      run();
    }
    redrawAll();
  },

  draw(time) {
    for (const d of DIAGNOSTICS) {
      const ds = diagState[d.id];
      if (ds) drawChart(d, ds, time);
    }
  },

  // Called from the video overlay loop with the playhead time, in seconds.
  // Every enabled diagnostic whose phase covers that instant draws; their phase
  // labels stack rather than overwrite so more than one can be visible at once.
  overlay(ctx, time) {
    if (!state || !state.results || !state.samples) return;
    const v = el.video();
    const t = (typeof time === 'number' && isFinite(time)) ? time
            : (v && isFinite(v.currentTime) ? v.currentTime : null);
    if (t == null) return;
    // Interpolated once and shared: every diagnostic drawing this instant is
    // drawing the same body, so they cannot disagree about where it is.
    const p = pointsAtTime(t);
    if (!p) return;
    const samples = state.samples;
    const size = ctx.canvas.height || 720;
    let shown = 0;
    for (const d of DIAGNOSTICS) {
      if (!enabled.has(d.id)) continue;
      const res = state.results[d.id];
      if (!res || res.error) continue;
      const ph = res.phase;
      // The phase is bounded by the times its triggers fired, so the marks come
      // up at the instant the pull starts rather than at the next processed
      // frame. On a coarse frame stride that boundary used to be a tenth of a
      // second out, which is enough to see against the video.
      const t0 = samples[ph.startIdx].t, t1 = samples[ph.endIdx].t;
      if (t < t0 || t > t1) continue;
      const steps = ph.endIdx - ph.startIdx;
      const view = {
        t, p,
        axis: state.axis || IMAGE_AXIS,          // the clip's one bar direction
        dt: steps > 0 ? (t1 - t0) / steps : 0,   // mean processed-frame spacing
        at: u => (u < t0 || u > t1) ? null : pointsAtTime(u),
      };
      d.overlay(ctx, view, ph, res, size);
      ctx.fillStyle = phaseColor(1);
      ctx.font = Math.max(12, size / 38) + 'px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(d.phaseLabel || d.title, 8, Math.max(16, size / 30) + shown * (size / 26));
      shown++;
    }
  },
};

window.Diagnostics = Diagnostics;
})();
