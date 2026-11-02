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

// Smoothing for any velocity read off the wrists (see wristRise).
//
// Deliberately measured on an extra-smoothed centroid over a wider baseline
// than one frame: a few px of per-frame pose jitter divided by a 1/30s step
// reads as ~0.5 torso-lengths/s — several times the onset threshold — so a
// one-frame difference finds "motion" in a lifter standing perfectly still.
// Over ±2 samples of a 9-wide mean, that same jitter lands around 0.02–0.04
// torso-lengths/s on the signed vertical component, while an actual pull runs
// ~1–2, which is the margin the trigger needs.
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

// Signed vertical speed of the wrist centroid, in torso-lengths per second,
// positive = rising. "Vertical" is along the bar axis's own up, so a rolled
// camera does not turn a horizontal bar roll-in into a rise. Smoothed over a
// window fixed in time (smoothWindow) and differenced over a baseline of about
// a quarter of that window either side, never frame to frame — see the note on
// SPEED_SMOOTH. Null where the centroid is undefined (both wrists lost for
// longer than the gap fill reaches) or within the baseline of the clip's ends.
function wristRise(samples, scale, ax) {
  const raw = samples.map(s => { const c = wristCentroid(s.p); return c ? elev(c, ax) : null; });
  const win = smoothWindow(samples);
  const sm = smoothSeries(raw, win);
  const half = Math.max(1, (win - 1) >> 2);   // 2 at the 9-sample window it was tuned on
  const out = new Array(samples.length).fill(null);
  for (let i = half; i < samples.length - half; i++) {
    const a = sm[i - half], b = sm[i + half];
    const dt = samples[i + half].t - samples[i - half].t;
    if (a == null || b == null || !(dt > 0)) continue;
    out[i] = -(b - a) / dt / scale;   // elevation grows downward, so rising is negative d(elev)
  }
  return out;
}

const RUN = 3;             // samples a threshold (or its release) must hold for
const RISE_ONSET = 0.1;    // torso-lengths/s of upward wrist speed — provisional

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

// The first pull's window: the bar/knee crossing that ends it, and the first
// frame the wrists start rising before that crossing, which is where the lift
// starts — the bar leaving the floor is the hands going up, and nothing else
// in the setup is.
//
// Anchored on the END trigger, which is a crisp geometric crossing, then
// searched backwards for the start: walk back from the crossing through the
// run of samples where the wrists are rising (wristRise at or above
// RISE_ONSET); the run ends at RUN consecutive samples that are not, and the
// start is the sample after that block. Persistence cuts both ways here — a
// single noisy sample inside the pull does not end the run early, and a single
// noisy sample in the setup does not extend it.
//
// Searching forwards from frame 0 for "the hands start moving" finds the setup
// instead — grip adjustments, the hook re-set, the lifter rocking into
// position all clear a motion threshold before the pull starts. Requiring the
// motion to be UPWARD, rather than any motion, is what makes this hold on a
// lifter who never goes still: rolling the bar into the shins is horizontal,
// a re-set drops the hands before it lifts them, and neither joins the run
// that leads into the crossing.
//
// Shared rather than left inside the first-pull diagnostics, because the bar
// axis is read at the start frame this returns: two versions of "where the lift
// starts" drifting apart would put the axis on a different frame than the
// phase it belongs to, and each would look right on its own. The clean's first
// pull and the snatch's share it because the event is the same — bar off the
// floor to bar past the knee — not because the keypoints happen to be.
function firstPullWindow(samples, scale, ax) {
  const cross = barKneeCrossing(samples, ax);
  if (cross.idx < 0) {
    return { cross, startIdx: -1, endIdx: -1, clamped: false, clampReason: null, onsetRise: null, setupRise: null };
  }
  const endIdx = cross.idx;
  const rise = wristRise(samples, scale, ax);
  const rising = i => rise[i] != null && rise[i] >= RISE_ONSET;

  let startIdx = -1, clampReason = null, still = 0;
  for (let i = endIdx - 1; i >= 0; i--) {
    if (rise[i] == null) {
      // Ran out of measurable wrist speed before the run ended. At the head
      // of the clip that is a clip starting mid-pull; in the middle it is the
      // wrists being lost for longer than the gap fill reaches.
      let head = true;
      for (let j = 0; j < i; j++) if (rise[j] != null) { head = false; break; }
      clampReason = head ? 'head' : 'lost';
      startIdx = head ? 0 : i + 1;
      break;
    }
    if (rising(i)) { still = 0; continue; }
    if (++still === RUN) { startIdx = i + RUN; break; }
  }
  if (startIdx < 0) { clampReason = 'head'; startIdx = 0; }   // rising all the way back to sample 0
  const clamped = clampReason != null;

  // What the trigger saw: the rise speed at the start frame (on a clamped clip,
  // at the first frame that has one), and the fastest the wrists were rising in
  // the still block just before it — the two numbers that put the boundary
  // where it is.
  let onsetRise = null;
  for (let j = startIdx; j <= endIdx; j++) if (rise[j] != null) { onsetRise = rise[j]; break; }
  let setupRise = null;
  if (!clamped) {
    for (let j = startIdx - RUN; j < startIdx; j++) {
      if (rise[j] != null && (setupRise == null || rise[j] > setupRise)) setupRise = rise[j];
    }
  }
  return { cross, startIdx, endIdx, clamped, clampReason, onsetRise, setupRise };
}


// --- the lift window ----------------------------------------------------
//
// Where the LIFT starts and ends, as opposed to where any one cue applies. It
// is not a diagnostic: it scores nothing, has no cue and no plot. It is the
// pair of markers the time sliders carry, so a clip that is mostly walk-up and
// celebration can be scrubbed to the attempt itself.
//
// Start: the start of the first pull — `firstPullWindow`'s own onset, the same
// call the first-pull diagnostics make, with the clip's real bar axis. Shared
// rather than re-derived: the marker on the slider and the shaded phase on the
// first-pull chart have to be the same instant, or one of them is lying.
//
// End: the first frame from which both elbows stay above LOCK_ELBOW, both
// knees above LOCK_KNEE, and the body stays both slower than STILL_SPEED and
// inside STILL_DRIFT of where it started, for LOCK_HOLD_SECONDS — the lifter
// standing locked out and holding it, and going nowhere. The same
// trigger for every barbell lift by request: the snatch finishes overhead and
// the clean & jerk finishes overhead after the jerk, and in both the finish
// position is four extended joints held still. It does NOT describe a lift that
// finishes with the elbows bent (a clean left in the rack position, a curl),
// which is why the tickbox in app.py can turn the markers off per clip. A lift
// with no bar has no window at all: its set says so in LIFT_WINDOW_SETS, and
// computeResults() doesn't run this for it.
//
// Four things this trigger is not:
//
// - Not a threshold on one frame. Full extension is passed THROUGH on the way
//   up — the scoop at the top of the first pull, the triple extension of the
//   second — for a tenth of a second at a time. The half-second hold is what
//   separates those from a finish, and it is stated in seconds and measured
//   against the samples' own timestamps, so it means the same thing at 30fps,
//   at 60fps and at frame stride 3.
// - Not angles alone. The four joints also come open mid-flight, at speed and
//   for longer than a tenth of a second: a lifter rising out of the catch is
//   extending every one of them while the bar is still travelling. Angles that
//   merely pass through the threshold on the way somewhere put the end marker
//   early, so the hold also asks the body to be SLOW — not still. A finish has
//   sway, a step back, and the bar settling overhead in it, and a threshold
//   tight enough to exclude those would find no finish at all.
// - Not one threshold on speed. A recovery can be slower than STILL_SPEED at
//   every instant and still be a recovery, because all of that slow motion
//   goes the SAME WAY: a lifter rising 0.3 torso-lengths per second is under
//   the speed gate and has still travelled a third of a body up the frame by
//   the time the half second is out. So the hold is checked twice over — once
//   instant by instant (STILL_SPEED, which catches the fast), and once end to
//   end (STILL_DRIFT on the NET travel across the whole hold, which catches the
//   steady). Sway and a settling bar go nowhere in net terms and pass both;
//   monotone drift fails the second however gentle it is.
// - Not searched from frame 0. The lifter standing over the bar before they
//   set up is four extended joints held far longer than half a second. The
//   search starts at the bar/knee crossing that ends the first pull, so nothing
//   before the bar is past the knee can end the lift.
// - Not a 3-D joint angle. `jointAngle` is measured in the image plane: a limb
//   pointing at the lens reads straighter than it is. Reported in the notes
//   rather than corrected, since one camera cannot tell the difference.
// The knees are held to a tighter angle than the elbows, because they are the
// joint that lies. An elbow is either locked or it isn't, and the difference is
// tens of degrees. A knee is "soft" for the whole recovery out of a catch — it
// comes open gradually, spends a long time somewhere in the 150s and 160s, and
// only squares up at the very end. 150° on a knee is most of the way through a
// stand-up; 170° is standing.
const LOCK_ELBOW = 150;         // degrees — provisional
const LOCK_KNEE = 170;          // degrees; tighter, see above — provisional
const LOCK_HOLD_SECONDS = 0.5;  // how long all four must hold it before it is a finish
const LOCK_MIN_SAMPLES = 2;     // a hold observed in one sample is not a hold
// A hold that runs off the end of the clip is accepted short (see `truncated`),
// but not arbitrarily short. Both gates below need a span to look at: the net
// travel between two instants a couple of frames apart is mostly the smoothing
// window's own lag, and every clip that happens to end with the lifter upright
// would otherwise collect an end marker from its last three frames.
const LOCK_MIN_SPAN = LOCK_HOLD_SECONDS * 0.4;
const STILL_SPEED = 0.35;       // torso-lengths/s the body may be moving at, instant by instant
const STILL_DRIFT = 0.10;       // torso-lengths/s of NET travel it may make across the hold

// How the body moves: smoothed keypoint paths, a speed per sample, and the net
// travel between any two samples. All three are the MEDIAN over every keypoint
// the track has, never one landmark — at a finish the lifter is standing under
// a settling bar, so the arms are the part still moving, and a mean (or a
// wrist-only reading) lets them veto a body that has plainly stopped. Half the
// skeleton has to be moving before any of these rises.
//
// Measured exactly like wristRise: smoothed over a window fixed in TIME, then
// differenced across a baseline, never frame to frame. Per-frame pose jitter of
// a few pixels over a 1/30s step reads as most of a torso-length per second,
// which would put every sample of the clip above any threshold worth setting.
function median(v) {
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  return v.length % 2 ? v[v.length >> 1] : (v[(v.length >> 1) - 1] + v[v.length >> 1]) / 2;
}

function bodyMotion(samples, scale) {
  const win = smoothWindow(samples);
  const half = Math.max(1, (win - 1) >> 2);
  const sm = {};
  for (const i of USED) {
    sm[i] = {
      x: smoothSeries(samples.map(s => s.p[i] ? s.p[i].x : null), win),
      y: smoothSeries(samples.map(s => s.p[i] ? s.p[i].y : null), win),
    };
  }
  // Median joint travel between two samples, per second of the span. For a body
  // rocking in place this is near zero however fast the rocking is, because the
  // travel is a straight line between the endpoints and not a path length; for
  // a body going somewhere it is the speed of going there.
  const drift = (a, b) => {
    const dt = samples[b].t - samples[a].t;
    if (!(dt > 0)) return null;
    const v = [];
    for (const i of USED) {
      const x0 = sm[i].x[a], x1 = sm[i].x[b], y0 = sm[i].y[a], y1 = sm[i].y[b];
      if (x0 == null || x1 == null || y0 == null || y1 == null) continue;
      v.push(Math.hypot(x1 - x0, y1 - y0) / dt / scale);
    }
    return median(v);
  };

  const speed = new Array(samples.length).fill(null);
  for (let k = half; k < samples.length - half; k++) speed[k] = drift(k - half, k + half);
  return { speed, drift };
}

// The four joint angles the finish is defined by, at one sample. `missing` is
// how many could not be measured at all — a dropped ankle is missing data, not
// a bent knee, so it breaks the hold rather than passing it.
function extensionAt(p) {
  const elbows = [
    jointAngle(p[KP.lElb], p[KP.lSho], p[KP.lWri]),
    jointAngle(p[KP.rElb], p[KP.rSho], p[KP.rWri]),
  ];
  const knees = [
    jointAngle(p[KP.lKnee], p[KP.lHip], p[KP.lAnk]),
    jointAngle(p[KP.rKnee], p[KP.rHip], p[KP.rAnk]),
  ];
  const angles = elbows.concat(knees);
  const have = angles.filter(v => v != null);
  return {
    angles,
    missing: angles.length - have.length,
    minElbow: elbows.every(v => v != null) ? Math.min.apply(null, elbows) : null,
    minKnee: knees.every(v => v != null) ? Math.min.apply(null, knees) : null,
    min: have.length ? Math.min.apply(null, have) : null,
  };
}

function liftWindow(samples, scale, ax) {
  const none = (error, extra) => Object.assign(
    { error, startIdx: -1, endIdx: -1, t0: null, t1: null, notes: [] }, extra || {});

  const w = firstPullWindow(samples, scale, ax);
  if (w.cross.idx < 0) {
    return none(w.cross.reason === 'no-below'
      ? 'The bar never sits below knee height in this clip, so there is no start of the lift to mark.'
      : 'The bar never crosses knee height in this clip, so there is no lift to mark.');
  }

  const ext = samples.map(s => extensionAt(s.p));
  const { speed, drift } = bodyMotion(samples, scale);
  const extended = i =>
    ext[i].missing === 0 && ext[i].minElbow > LOCK_ELBOW && ext[i].minKnee > LOCK_KNEE;
  // Three states, not two. Speed is differenced across a baseline either side
  // of a sample, so the few samples at each end of the clip have none — and a
  // finish that runs off the end of the clip is exactly the case where those
  // samples matter. Unknown neither confirms a hold nor breaks it: a run can't
  // START on one, but it survives them, and a run that reaches the end of the
  // clip on unknowns is reported as an unconfirmed (`truncated`) hold rather
  // than thrown away.
  const held = i => !extended(i) ? 'no'
                  : speed[i] == null ? 'unknown'
                  : speed[i] <= STILL_SPEED ? 'yes' : 'no';
  const locked = i => held(i) === 'yes';

  let endIdx = -1, holdSpan = null, holdSamples = 0, holdDrift = null, truncated = false;
  let driftSeen = false;   // a hold failed on net travel alone, for the notes
  for (let i = w.cross.idx; i < samples.length; i++) {
    if (!locked(i)) continue;
    // Walk forward until the hold is satisfied, broken, or the clip runs out.
    let j = i, broke = false;
    while (samples[j].t - samples[i].t < LOCK_HOLD_SECONDS && j + 1 < samples.length) {
      j++;
      if (held(j) === 'no') { broke = true; break; }
    }
    if (broke) { i = j; continue; }   // no run containing j can hold either
    const span = samples[j].t - samples[i].t;
    const n = j - i + 1;
    if (n < LOCK_MIN_SAMPLES || span < LOCK_MIN_SPAN) continue;
    // End to end: slow at every instant is not the same as staying put.
    const net = drift(i, j);
    if (net != null && net > STILL_DRIFT) { driftSeen = true; continue; }
    endIdx = i; holdSpan = span; holdSamples = n; holdDrift = net;
    truncated = span < LOCK_HOLD_SECONDS;   // the clip ended mid-hold
    break;
  }

  const notes = [];
  if (w.clamped) {
    notes.push(w.clampReason === 'lost'
      ? 'The wrists were lost from the track before the bar reached the knee, so the start marker sits where they reappear — the beginning of the lift may be missing.'
      : 'The wrists were already rising at the first measurable frame, so the clip probably starts mid-pull and the start marker is clamped to the first frame.');
  }
  if (endIdx < 0) {
    // Which of the three it was: the joints never all visible, never all
    // extended at once, extended but never slow, or both but never for long
    // enough. They are the same empty slider, and a different thing to fix.
    let everComplete = false, everExtended = false, everLocked = false;
    for (let i = w.cross.idx; i < samples.length; i++) {
      if (ext[i].missing === 0) everComplete = true;
      if (extended(i)) everExtended = true;
      if (locked(i)) everLocked = true;
    }
    const angles = `both elbows above ${LOCK_ELBOW}° and both knees above ${LOCK_KNEE}°`;
    notes.push(!everComplete
      ? `After the bar passed the knee, no frame had all four joints (both elbows, both knees) above the confidence gate at once, so the finish could not be looked for.`
      : !everExtended
        ? `The clip never has ${angles} at the same time after the bar clears the knee, so the lift has no end marker.`
        : !everLocked
          ? `The clip reaches ${angles} after the bar clears the knee, but never while the body is slower than ${fmt(STILL_SPEED, 2)} torso-lengths/s — the extension is passed through in flight, not held. The lift has no end marker.`
          : driftSeen
            ? `The clip reaches ${angles} slowly enough to look like a finish, but the body keeps travelling the same way throughout — more than ${fmt(STILL_DRIFT, 2)} torso-lengths/s of net movement across the half second. That is a recovery still in progress, not a finish, so the lift has no end marker.`
            : `The clip reaches ${angles} with the body slower than ${fmt(STILL_SPEED, 2)} torso-lengths/s after the bar clears the knee, but never for ${fmt(LOCK_HOLD_SECONDS, 1)}s together, so the lift has no end marker.`);
    return none(null, {
      startIdx: w.startIdx, t0: samples[w.startIdx].t,
      startClamped: w.clamped, clampReason: w.clampReason, notes,
    });
  }
  if (truncated) {
    notes.push(`The clip ends ${fmt(holdSpan, 2)}s into the hold, short of the ${fmt(LOCK_HOLD_SECONDS, 1)}s the trigger asks for. The end marker is where the extension started; whether it was held is unknown.`);
  }
  notes.push(`Joint angles are measured in the image plane, so a limb pointing toward or away from the camera reads straighter than it is. Filmed square to the lifter this is small; filmed down the platform it can turn a soft knee into a locked one.`);

  return {
    error: null,
    startIdx: w.startIdx,
    endIdx,
    t0: samples[w.startIdx].t,
    t1: samples[endIdx].t,
    startClamped: w.clamped,
    clampReason: w.clampReason,
    truncated,
    notes,
    triggers: {
      onsetRise: w.onsetRise,
      setupRise: w.setupRise,
      crossIdx: w.cross.idx,
      crossT: samples[w.cross.idx].t,
      holdSeconds: holdSpan,
      holdSamples,
      minAngle: ext[endIdx].min,
      minElbow: ext[endIdx].minElbow,
      minKnee: ext[endIdx].minKnee,
      angles: ext[endIdx].angles,
      // The fastest the body got anywhere inside the hold — the number the
      // stillness gate was actually decided on, not the one at its first frame.
      peakSpeed: Math.max.apply(null,
        samples.slice(endIdx, endIdx + holdSamples).map((_, k) => speed[endIdx + k] || 0)),
      netDrift: holdDrift,
      lockElbow: LOCK_ELBOW,
      lockKnee: LOCK_KNEE,
      holdRequired: LOCK_HOLD_SECONDS,
      stillSpeed: STILL_SPEED,
      stillDrift: STILL_DRIFT,
    },
  };
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

// One first-pull diagnostic per lift, built from the same measurement. The
// snatch and the clean share the event (bar off the floor to bar past the knee)
// and the cue (the trunk holds its inclination through it), so the phase
// trigger, the scalar and the overlay are the same code; what differs is the
// object each lift's set carries — its own id, title, cue wording and the
// caveat about where its thresholds came from — so a fixture, a label or a
// note can name one lift's cue without implying the other's.
function makeFirstPullBackAngle(spec) {
  return {
    id: spec.id,
    title: spec.title,
    phaseLabel: 'first pull',
    cue: spec.cue,
    unit: '°',
    provisional: true,   // SD_GOOD/SD_WARN
    worstRule: 'farthest-from-mean',   // the verdict is the SD around the pull's mean
    zones: null,   // the verdict reads the SD, which the plot (the angle itself) doesn't show

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
        notes.push(w.clampReason === 'lost'
          ? 'The wrists were lost from the pose track for a stretch before the bar reached the knee, so there is no wrist speed to find the start from. The phase starts where they reappear, so the beginning of the first pull may be missing.'
          : 'The wrists were already rising at the first frame with a measurable speed — the clip probably starts mid-pull. The phase start is clamped to the first frame, so the beginning of the first pull may be missing.');
      }
      if (endIdx - startIdx < RUN) {
        return { error: `The first pull resolved to only ${endIdx - startIdx + 1} sampled frame(s) — too short to score. Try a lower frame stride.` };
      }

      const gapPx = elev(knee[endIdx], ax) - elev(bar[endIdx], ax);
      return {
        startIdx, endIdx, notes,
        triggers: {
          onsetRise: w.onsetRise,
          setupRise: w.setupRise,
          clamped: w.clamped,
          clampReason: w.clampReason,
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
        '<strong>Start trigger</strong> — first frame the wrists rise, walking back from the knee crossing: upward wrist speed of at least ' +
          fmt(RISE_ONSET, 2) + ' torso-lengths/s' +
          (tr.clamped
            ? (tr.clampReason === 'lost'
                ? ', but the wrists dropped out of the track before that — the phase starts where they reappear (' + fmt(tr.onsetRise, 2) + ' at that frame).'
                : ', already met at the first measurable frame (' + fmt(tr.onsetRise, 2) + ') — no start found; clamped to the first frame.')
            : ' (measured ' + fmt(tr.onsetRise, 2) + ' at the start frame; the ' + RUN + ' frames before it peaked at ' +
              fmt(tr.setupRise, 2) + '). Sideways wrist motion does not count, so a bar roll-in or a re-grip before the pull is not the pull.'),
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
          fmt(SD_GOOD, 1) + '° / ' + fmt(SD_WARN, 1) + '° SD) are provisional and not fitted to labelled lifts' + spec.thresholdNote + '. ' +
          'The green-to-red colour is a separate reading — total drift, full red at ' + fmt(DRIFT_RED, 0) +
          '° — so a lift can score red on constancy while the colour stays green, if the angle wandered and came back.',
      ].concat(res.notes.map(n => '<strong>Note</strong> — ' + n));
    },

    // Everything the two triggers and the measurement rest on, drawn on the frame
    // itself while the playhead is inside the phase.
    //
    // `view` is the track at the playhead's actual time (see pointsAt), not a
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
}

const firstPullBackAngle = makeFirstPullBackAngle({
  id: 'first-pull-back-angle',
  title: 'First pull — constant back angle',
  cue: 'Through the first pull the back angle to the floor stays constant: the knees open and the bar rises, but the trunk keeps its inclination.',
  thresholdNote: '',
});

// The clean's first pull: same event, same cue, same measurement — see
// .claude/skills/lifting-diagnostic/diagnostics/08-clean-first-pull-back-angle.md
// for why sharing is mechanically justified here and what still differs (the
// narrower grip sets the trunk up more upright, so the MEAN differs between the
// lifts; the constancy the cue is about does not).
const cleanFirstPullBackAngle = makeFirstPullBackAngle({
  id: 'clean-first-pull-back-angle',
  title: 'Clean first pull — constant back angle',
  cue: 'Through the clean\'s first pull the back angle to the floor stays constant: the knees open and the bar rises, but the trunk keeps its inclination until the bar passes the knee.',
  thresholdNote: ', and were carried over from the snatch rather than set on clean footage',
});


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
  provisional: true,   // EXT_GOOD/EXT_WARN
  worstRule: 'phase-end',   // the deficits are read over the phase's last samples
  zones: null,   // the verdict reads the larger of two deficits averaged over the last samples, not one plotted value

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
  // see diagnostic 1's overlay and pointsAt.
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

// --- diagnostic 3: lateral raise, top-of-rep height -----------------------
//
// Unlike a snatch pull (one clean start->finish), a lateral raise set is
// several reps back to back, so the trigger every lateral-raise diagnostic
// needs first is not "the phase", it's "where is each rep's top" — the
// analogue of barKneeCrossing for this lift. Same rules as every other
// trigger in this file: a smoothed signal, never frame-to-frame; persistence
// before a threshold or extremum counts; a window fixed in TIME so stride
// doesn't move it.
const REP_BOTTOM_FRAC = -0.6;   // torso-lengths; wrist below this counts as "at rest", ending a rep
const REP_MIN_HEIGHT = -0.7;    // torso-lengths below shoulder; low detection floor, not the form target
const REP_RISE_MIN = 0.075;     // torso-lengths risen from the local bottom before a rep is real
const REP_RELEASE_DROP = 0.075; // torso-lengths below that rep's peak before another rep can begin
const REP_BASELINE_SECONDS = 1; // recent valley only; an old low must not suppress later partial reps
const MIN_REP_SECONDS = SMOOTH_SECONDS;   // ~0.3s between threshold-derived boundaries

function lateralRaiseReps(samples, scale, ax) {
  const raw = samples.map(s => {
    const sho = centroid(s.p, [KP.lSho, KP.rSho]);
    const wri = wristCentroid(s.p);
    return (sho && wri) ? (elev(sho, ax) - elev(wri, ax)) / scale : null;
  });
  if (raw.every(v => v == null)) return { list: [], dropped: [], signal: raw, win: null, reason: 'no-signal' };
  const win = smoothWindow(samples);
  const signal = smoothSeries(raw, win);

  const holds = (i, test) => {
    for (let j = i; j < Math.min(i + RUN, signal.length); j++) {
      if (signal[j] == null || !test(signal[j])) return false;
    }
    return true;
  };
  const found = [];
  let state = 'bottom', peakIdx = -1, peakVal = -Infinity;
  let bottomBeforeIdx = null, bottomVal = Infinity, pending = null;
  for (let i = 0; i < signal.length; i++) {
    const v = signal[i];
    if (v == null) continue;
    if (state === 'bottom') {
      if (pending) {
        if (v <= bottomVal) { bottomVal = v; bottomBeforeIdx = i; }
      } else {
        bottomVal = Infinity; bottomBeforeIdx = null;
        for (let j = i; j >= 0 && samples[i].t - samples[j].t <= REP_BASELINE_SECONDS; j--) {
          if (signal[j] != null && signal[j] <= bottomVal) {
            bottomVal = signal[j]; bottomBeforeIdx = j;
          }
        }
      }
          if (bottomBeforeIdx != null && v >= REP_MIN_HEIGHT && v - bottomVal >= REP_RISE_MIN &&
            holds(i, x => x >= REP_MIN_HEIGHT && x - bottomVal >= REP_RISE_MIN)) {
        if (pending) {
          pending.bottomAfterIdx = bottomBeforeIdx;
          found.push(pending);
          pending = null;
        }
        state = 'top'; peakIdx = i; peakVal = v;
      }
    } else {
      if (v > peakVal) { peakIdx = i; peakVal = v; }
      if (peakVal - v >= REP_RELEASE_DROP && holds(i, x => peakVal - x >= REP_RELEASE_DROP)) {
        pending = { peakIdx, bottomBeforeIdx, bottomAfterIdx: null };
        state = 'bottom'; bottomBeforeIdx = i; bottomVal = v;
      }
    }
  }
  if (state === 'top') found.push({ peakIdx, bottomBeforeIdx, bottomAfterIdx: null });
  else if (pending) {
    pending.bottomAfterIdx = bottomBeforeIdx;
    found.push(pending);
  }

  // A "rep" the smoothed signal only holds for a fraction of a second is more
  // likely a jitter blip riding over the top/bottom threshold than a lifter
  // actually completing a rep in that time — drop it, but say so rather than
  // silently shrinking the rep count.
  const list = [], dropped = [];
  for (const rep of found) {
    if (rep.bottomBeforeIdx != null && rep.bottomAfterIdx != null) {
      const duration = samples[rep.bottomAfterIdx].t - samples[rep.bottomBeforeIdx].t;
      if (duration < MIN_REP_SECONDS) { dropped.push(Object.assign({ duration }, rep)); continue; }
    }
    list.push(rep);
  }
  return { list, dropped, signal, win,
    reason: list.length ? null : (found.length ? 'all-too-short' : 'no-reps') };
}

const TOP_GOOD = 15, TOP_WARN = 30, TOP_RED = 45;   // % of torso length off shoulder height — provisional
const topHeightScore = summary => (!summary || summary.worstAbs == null || !isFinite(summary.worstAbs)) ? null
  : Math.max(0, Math.min(1, summary.worstAbs / TOP_RED));

const lateralRaiseTopHeight = {
  id: 'lateral-raise-top-height',
  title: 'Top of rep — raise to shoulder height',
  phaseLabel: null,   // one rep looks like any other on the video — no label needed there
  cue: 'At the top of each rep the arms lift to about shoulder height — not swung above it, not stopped short.',
  unit: '%',
  provisional: true,   // TOP_GOOD/TOP_WARN
  worstRule: 'summary-worst',   // the verdict is the worst rep's height
  // The verdict reads the worst rep's size (worstAbs): too high and too low
  // alike, so the bands are mirrored about shoulder height (0). Lowest first.
  zones: [
    { status: 'critical', from: null, to: -TOP_WARN },
    { status: 'warning', from: -TOP_WARN, to: -TOP_GOOD },
    { status: 'good', from: -TOP_GOOD, to: TOP_GOOD },
    { status: 'warning', from: TOP_GOOD, to: TOP_WARN },
    { status: 'critical', from: TOP_WARN, to: null },
  ],

  // Active phase: every rep this clip contains, start to finish — the union of
  // lateralRaiseReps' rep list rather than one window, since the cue applies
  // once per rep, not once per clip.
  phase(samples, scale, ax) {
    const notes = [];
    const reps = lateralRaiseReps(samples, scale, ax);
    if (!reps.list.length) {
      return { error: reps.reason === 'no-signal'
        ? 'Neither the shoulders nor the wrists stayed above the confidence threshold long enough to find a rep in this clip.'
        : reps.reason === 'all-too-short'
          ? 'Every rep candidate in this clip was shorter than ' + fmt(MIN_REP_SECONDS, 1) + 's, which is more likely pose noise than a real rep.'
          : 'No rep (arm raised toward shoulder height and back down) was found in this clip.' };
    }
    const first = reps.list[0], last = reps.list[reps.list.length - 1];
    const startIdx = first.bottomBeforeIdx != null ? first.bottomBeforeIdx : first.peakIdx;
    const endIdx = last.bottomAfterIdx != null ? last.bottomAfterIdx : last.peakIdx;
    if (reps.dropped.length) {
      notes.push(reps.dropped.length + ' rep candidate(s) shorter than ' + fmt(MIN_REP_SECONDS, 1) + 's were treated as detection noise, not scored.');
    }
    if (first.bottomBeforeIdx == null || last.bottomAfterIdx == null) {
      notes.push('The first and/or last rep\'s resting bottom falls outside this clip, so that rep\'s boundary is clamped to the clip\'s own start or end.');
    }
    return { startIdx, endIdx, notes, reps: reps.list, win: reps.win, scale };
  },

  // Two independent estimates from disjoint keypoints, same contract as the
  // snatch diagnostics: left shoulder->wrist and right shoulder->wrist, read at
  // each rep's own peak rather than at every sampled frame — the cue is about
  // the top of the rep, not the path to it.
  measure(samples, phase, ax) {
    const notes = [];
    const series = [];
    let bothSides = 0, interp = 0;

    for (const rep of phase.reps) {
      const i = rep.peakIdx;
      const p = samples[i].p;
      const devL = (p[KP.lSho] && p[KP.lWri]) ? (elev(p[KP.lSho], ax) - elev(p[KP.lWri], ax)) / phase.scale : null;
      const devR = (p[KP.rSho] && p[KP.rWri]) ? (elev(p[KP.rSho], ax) - elev(p[KP.rWri], ax)) / phase.scale : null;
      const vals = [devL, devR].filter(v => v != null);
      if (!vals.length) continue;
      if (vals.length === 2) bothSides++;
      if ([KP.lSho, KP.rSho, KP.lWri, KP.rWri].some(k => p[k] && p[k].interp)) interp++;
      series.push({
        idx: i, frame: samples[i].frame, t: samples[i].t,
        value: 100 * vals.reduce((a, b) => a + b, 0) / vals.length,
        lo: 100 * Math.min.apply(null, vals),
        hi: 100 * Math.max.apply(null, vals),
        spread: vals.length === 2 ? 100 * Math.abs(devL - devR) : null,
      });
    }
    if (!series.length) {
      return { error: 'Neither shoulder–wrist pair stayed above the confidence threshold at the top of any rep.' };
    }

    const vals = series.map(s => s.value);
    const spreads = series.map(s => s.spread).filter(v => v != null);
    const worst = vals.reduce((a, b) => Math.abs(b) > Math.abs(a) ? b : a, vals[0]);
    const summary = {
      reps: series.length,
      mean: vals.reduce((a, b) => a + b, 0) / vals.length,
      worst,
      worstAbs: Math.abs(worst),
      meanSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null,
      bothSides: bothSides / series.length,
      interpFrac: interp / series.length,
    };
    if (summary.meanSpread != null && summary.meanSpread > 15) {
      notes.push('The two arms disagree by ' + fmt(summary.meanSpread) + '% of torso length at the top, on average — a real side-to-side difference, or the camera is not square to the lifter.');
    }
    return { series, summary, notes };
  },

  score: topHeightScore,

  verdict(summary) {
    if (summary.worstAbs <= TOP_GOOD) return { label: 'right at shoulder height', status: 'good' };
    if (summary.worstAbs <= TOP_WARN) return { label: 'off shoulder height', status: 'warning' };
    return { label: summary.worst > 0 ? 'raised well above shoulder' : 'stopped well short', status: 'critical' };
  },

  // Target is anatomical (shoulder height itself), not the clip's own mean —
  // same reasoning as the second pull's "full extension" reference line.
  referenceLine() {
    return { value: 0, label: 'shoulder height' };
  },

  tiles(summary, verdict) {
    return [
      { label: 'Worst rep', value: (summary.worst >= 0 ? '+' : '') + fmt(summary.worst) + '%',
        sub: verdict.label, status: verdict.status },
      { label: 'Mean top height', value: (summary.mean >= 0 ? '+' : '') + fmt(summary.mean) + '%',
        sub: 'vs shoulder, all reps' },
      { label: 'Reps scored', value: String(summary.reps), sub: 'top positions found' },
      { label: 'L/R disagreement', value: summary.meanSpread == null ? '—' : '±' + fmt(summary.meanSpread) + '%', sub: 'at the top' },
    ];
  },

  transparencyLines(res, samples, ctxExtra) {
    const s = res.summary, ph = res.phase;
    const pct = v => Math.round(v * 100) + '%';
    return [
      '<strong>Reps</strong> — ' + ph.reps.length + ' rep(s) found between frames ' +
        samples[ph.startIdx].frame + '–' + samples[ph.endIdx].frame + '.',
      '<strong>Per rep</strong> — ' + res.series.map((sr, i) =>
        'rep ' + (i + 1) + ': ' + (sr.value >= 0 ? '+' : '') + fmt(sr.value) + '%').join(', ') + '.',
      '<strong>Rep trigger</strong> — wrist elevation relative to the shoulders, smoothed over ' + ph.win +
        ' sampled frames (' + fmt(SMOOTH_SECONDS, 2) + 's, fixed in time so the frame stride does not move it). ' +
        'A rep starts after rising ' + fmt(REP_RISE_MIN, 2) + ' torso-lengths from its local bottom and holding for ' +
        RUN + ' samples; its top is the highest point before descending ' +
        fmt(REP_RELEASE_DROP, 2) + ' torso-lengths from its own peak, then the lowest point before the next ascent becomes the shared rep boundary.',
      '<strong>Measurement</strong> — left and right shoulder→wrist heights scored separately at each rep\'s top; ' +
        pct(s.bothSides) + ' of scored tops had both sides visible, ' + pct(s.interpFrac) +
        ' relied on a detection filled in from neighbouring frames.',
      axisNote(ctxExtra.axis),
      '<strong>Time smoothing</strong> — ' + (ctxExtra.smoothingMs
        ? 'trajectories were smoothed with a Gaussian of σ = ' + ctxExtra.smoothingMs + ' ms before scoring (the slider under the video).'
        : 'off — scored on raw per-frame detections, so pose jitter is counted as height variation.'),
      '<strong>Caveat</strong> — height is a percentage of torso length, not a physical unit (the pose track has no metric scale); positive means above shoulder height, negative below. The good/warning bands (' +
        fmt(TOP_GOOD, 0) + '% / ' + fmt(TOP_WARN, 0) + '%) are provisional and not fitted to labelled reps.',
    ].concat(res.notes.map(n => '<strong>Note</strong> — ' + n));
  },

  // Both shoulder->wrist segments carry the rep's colour, same contract as the
  // snatch diagnostics' measured segments; the shoulder-height rule is the
  // target the top is judged against, drawn purple like every other
  // interpretability mark rather than ramped.
  overlay(ctx, view, phase, res, size) {
    const p = view.p, ax = view.axis;
    const lw = Math.max(2, size / 260);
    const col = alpha => scoreColor(this.score(res.summary), alpha);
    const segs = [[KP.lSho, KP.lWri], [KP.rSho, KP.rWri]]
      .map(([sh, w]) => [p[sh], p[w]]).filter(([a, b]) => a && b);
    for (const [width, style] of [[lw * 3.2, 'rgba(0,0,0,0.55)'], [lw * 1.8, col(1)]]) {
      ctx.strokeStyle = style; ctx.lineWidth = width;
      for (const [a, b] of segs) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
    const shoAvg = centroid(p, [KP.lSho, KP.rSho]);
    if (!shoAvg) return;
    const thin = Math.max(1, lw * 0.6);
    barRule(ctx, shoAvg, ax, [lw, lw * 1.5], 0.85, thin);
    ctx.fillStyle = phaseColor(1);
    ctx.font = Math.max(9, size / 62) + 'px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('shoulder height', 6, shoAvg.y - 4);
  },
};

// --- diagnostic 4: lateral raise, torso lean ------------------------------
//
// Same "constant back angle" idea as the snatch's first-pull diagnostic, but
// scored over the whole set rather than one pull: the trunk should hold its
// inclination while the arms do the work, so swinging the torso to sling the
// weight up shows up as trunk-angle variability across reps, not just within
// one of them.
const LEAN_GOOD = 3, LEAN_WARN = 7, LEAN_RED = 15;   // degrees SD — provisional
const leanScore = summary =>
  (!summary || summary.sd == null || !isFinite(summary.sd)) ? null
    : Math.max(0, Math.min(1, summary.sd / LEAN_RED));

const lateralRaiseTorsoLean = {
  id: 'lateral-raise-torso-lean',
  title: 'Torso lean — stay upright through the set',
  phaseLabel: null,   // spans the whole set — no distinct sub-phase to name on the video
  cue: 'The trunk stays upright throughout the set: the weight is raised by the arms, not by leaning or swinging the torso.',
  unit: '°',
  provisional: true,   // LEAN_GOOD/LEAN_WARN
  worstRule: 'farthest-from-mean',   // the verdict is the SD around the set's mean
  zones: null,   // the verdict reads the SD, which the plot (the angle itself) doesn't show

  // Active phase: the same rep span lateralRaiseTopHeight uses, but measured
  // continuously frame-by-frame rather than only at each rep's peak — a lean
  // introduced mid-rep and corrected before the top would otherwise go unseen.
  phase(samples, scale, ax) {
    const notes = [];
    const reps = lateralRaiseReps(samples, scale, ax);
    if (!reps.list.length) {
      return { error: reps.reason === 'no-signal'
        ? 'Neither the shoulders nor the wrists stayed above the confidence threshold long enough to find a rep in this clip.'
        : reps.reason === 'all-too-short'
          ? 'Every rep candidate in this clip was shorter than ' + fmt(MIN_REP_SECONDS, 1) + 's, which is more likely pose noise than a real rep.'
          : 'No rep (arm raised toward shoulder height and back down) was found in this clip.' };
    }
    const first = reps.list[0], last = reps.list[reps.list.length - 1];
    const startIdx = first.bottomBeforeIdx != null ? first.bottomBeforeIdx : first.peakIdx;
    const endIdx = last.bottomAfterIdx != null ? last.bottomAfterIdx : last.peakIdx;
    if (endIdx - startIdx < RUN) {
      return { error: `The set resolved to only ${endIdx - startIdx + 1} sampled frame(s) — too short to score. Try a lower frame stride.` };
    }
    if (reps.dropped.length) {
      notes.push(reps.dropped.length + ' rep candidate(s) shorter than ' + fmt(MIN_REP_SECONDS, 1) + 's were treated as detection noise, not scored.');
    }
    if (first.bottomBeforeIdx == null || last.bottomAfterIdx == null) {
      notes.push('The first and/or last rep\'s resting bottom falls outside this clip, so the phase is clamped to the clip\'s own start or end.');
    }
    return { startIdx, endIdx, notes, repCount: reps.list.length };
  },

  // Two independent estimates from disjoint keypoints, same contract as the
  // snatch's back-angle diagnostic: left hip->shoulder and right hip->shoulder,
  // scored every sampled frame in the phase rather than once per rep.
  measure(samples, phase, ax) {
    const notes = [];
    const series = [];
    let both = 0, interp = 0;

    for (let i = phase.startIdx; i <= phase.endIdx; i++) {
      const p = samples[i].p;
      const aL = trunkAngle(p[KP.lHip], p[KP.lSho], ax);
      const aR = trunkAngle(p[KP.rHip], p[KP.rSho], ax);
      const vals = [aL, aR].filter(v => v != null);
      if (!vals.length) continue;
      if (vals.length === 2) both++;
      if ([KP.lHip, KP.lSho, KP.rHip, KP.rSho].some(k => p[k] && p[k].interp)) interp++;
      series.push({
        idx: i, frame: samples[i].frame, t: samples[i].t,
        value: vals.reduce((a, b) => a + b, 0) / vals.length,
        lo: Math.min.apply(null, vals),
        hi: Math.max.apply(null, vals),
        spread: vals.length === 2 ? Math.abs(aL - aR) : null,
      });
    }
    if (series.length < RUN) {
      return { error: 'Neither hip–shoulder pair stayed above the confidence threshold for long enough across the set.' };
    }

    const vals = series.map(s => s.value);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) * (v - mean), 0) / vals.length);
    const spreads = series.map(s => s.spread).filter(v => v != null);
    const summary = {
      mean, sd,
      range: Math.max.apply(null, vals) - Math.min.apply(null, vals),
      meanSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null,
      n: series.length,
      repCount: phase.repCount,
      bothSides: both / series.length,
      interpFrac: interp / series.length,
      duration: series[series.length - 1].t - series[0].t,
    };
    if (summary.meanSpread != null && summary.meanSpread > 8) {
      notes.push('The two sides disagree by ' + fmt(summary.meanSpread) + '° on average. A steady offset means the camera is not square to the lifter; a jittery one means the pose track is unreliable — check the band on the plot.');
    }
    return { series, summary, notes };
  },

  score: leanScore,

  verdict(summary) {
    if (summary.sd <= LEAN_GOOD) return { label: 'stays upright', status: 'good' };
    if (summary.sd <= LEAN_WARN) return { label: 'some sway', status: 'warning' };
    return { label: 'noticeable swinging', status: 'critical' };
  },

  // The set's own mean, since the cue is constancy relative to the lifter's own
  // posture, not a fixed external target.
  referenceLine(summary) {
    return { value: summary.mean, label: 'mean ' + fmt(summary.mean) + '°' };
  },

  tiles(summary, verdict) {
    return [
      { label: 'Trunk stability', value: fmt(summary.sd) + '°',
        sub: verdict.label + ' · SD over the set', status: verdict.status },
      { label: 'Peak sway', value: fmt(summary.range) + '°', sub: 'max − min across the set' },
      { label: 'Mean trunk angle', value: fmt(summary.mean) + '°', sub: 'to horizontal · 90° = upright' },
      { label: 'L/R disagreement', value: summary.meanSpread == null ? '—' : '±' + fmt(summary.meanSpread) + '°', sub: 'uncertainty' },
    ];
  },

  transparencyLines(res, samples, ctxExtra) {
    const s = res.summary, ph = res.phase;
    const pct = v => Math.round(v * 100) + '%';
    return [
      '<strong>Phase</strong> — ' + s.repCount + ' rep(s), frames ' + samples[ph.startIdx].frame + '–' +
        samples[ph.endIdx].frame + ', ' + fmt(s.duration, 2) + 's, ' + s.n + ' sampled frames measured.',
      '<strong>Measurement</strong> — left and right hip→shoulder scored separately, every sampled frame in the set; ' +
        pct(s.bothSides) + ' of frames had both sides visible, ' + pct(s.interpFrac) +
        ' relied on a detection filled in from neighbouring frames.',
      axisNote(ctxExtra.axis),
      '<strong>Time smoothing</strong> — ' + (ctxExtra.smoothingMs
        ? 'trajectories were smoothed with a Gaussian of σ = ' + ctxExtra.smoothingMs + ' ms before scoring (the slider under the video).'
        : 'off — scored on raw per-frame detections, so pose jitter is counted as trunk movement and the SD reads high.'),
      '<strong>Caveat</strong> — angles are in the image plane, so this assumes a side-on camera. The good/warning bands (' +
        fmt(LEAN_GOOD, 1) + '° / ' + fmt(LEAN_WARN, 1) + '° SD) are provisional and not fitted to labelled reps.',
    ].concat(res.notes.map(n => '<strong>Note</strong> — ' + n));
  },

  // The hip->shoulder segments carry the ramp, same contract as the snatch's
  // back-angle diagnostic — the mark that is the measurement is also its own
  // readout.
  overlay(ctx, view, phase, res, size) {
    const p = view.p;
    const lw = Math.max(2, size / 260);
    const col = alpha => scoreColor(this.score(res.summary), alpha);
    const segs = [[KP.lHip, KP.lSho], [KP.rHip, KP.rSho]]
      .map(([h, sh]) => [p[h], p[sh]]).filter(([a, b]) => a && b);
    for (const [width, style] of [[lw * 3.2, 'rgba(0,0,0,0.55)'], [lw * 1.8, col(1)]]) {
      ctx.strokeStyle = style; ctx.lineWidth = width;
      for (const [a, b] of segs) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
  },
};

// --- diagnostic 5: lateral raise, elbow lead ------------------------------
//
// Same rep span as the others, but scored only while the arm is actually
// working — not at rest, where the elbow trivially sits above a hanging
// wrist regardless of technique. Reuses REP_BOTTOM_FRAC as the "in the
// working range" gate on the same combined elevation signal the rep trigger
// itself computed, so the two never disagree about where a rep starts.
const ELBOW_GOOD = 5, ELBOW_WARN = -5, ELBOW_RED = -20;   // % of torso length, elbow above (+) / below (-) wrist — provisional
const elbowLeadScore = summary => (!summary || summary.worst == null || !isFinite(summary.worst)) ? null
  : Math.max(0, Math.min(1, (ELBOW_GOOD - summary.worst) / (ELBOW_GOOD - ELBOW_RED)));

const lateralRaiseElbowLead = {
  id: 'lateral-raise-elbow-lead',
  title: 'Elbow lead — elbow tracks at or above the wrist',
  phaseLabel: null,   // spans the whole set — no distinct sub-phase to name on the video
  cue: 'Through the raise the elbow stays at or slightly above the wrist — the wrist shouldn\'t flick up and lead the lift.',
  unit: '%',
  provisional: true,   // ELBOW_GOOD/ELBOW_WARN
  worstRule: 'summary-worst',   // the verdict is the lowest elbow lead
  zones: [   // lowest first, as verdict() reads summary.worst
    { status: 'critical', from: null, to: ELBOW_WARN },
    { status: 'warning', from: ELBOW_WARN, to: ELBOW_GOOD },
    { status: 'good', from: ELBOW_GOOD, to: null },
  ],

  phase(samples, scale, ax) {
    const notes = [];
    const reps = lateralRaiseReps(samples, scale, ax);
    if (!reps.list.length) {
      return { error: reps.reason === 'no-signal'
        ? 'Neither the shoulders nor the wrists stayed above the confidence threshold long enough to find a rep in this clip.'
        : reps.reason === 'all-too-short'
          ? 'Every rep candidate in this clip was shorter than ' + fmt(MIN_REP_SECONDS, 1) + 's, which is more likely pose noise than a real rep.'
          : 'No rep (arm raised toward shoulder height and back down) was found in this clip.' };
    }
    const first = reps.list[0], last = reps.list[reps.list.length - 1];
    const startIdx = first.bottomBeforeIdx != null ? first.bottomBeforeIdx : first.peakIdx;
    const endIdx = last.bottomAfterIdx != null ? last.bottomAfterIdx : last.peakIdx;
    if (endIdx - startIdx < RUN) {
      return { error: `The set resolved to only ${endIdx - startIdx + 1} sampled frame(s) — too short to score. Try a lower frame stride.` };
    }
    if (reps.dropped.length) {
      notes.push(reps.dropped.length + ' rep candidate(s) shorter than ' + fmt(MIN_REP_SECONDS, 1) + 's were treated as detection noise, not scored.');
    }
    if (first.bottomBeforeIdx == null || last.bottomAfterIdx == null) {
      notes.push('The first and/or last rep\'s resting bottom falls outside this clip, so the phase is clamped to the clip\'s own start or end.');
    }
    return { startIdx, endIdx, notes, repCount: reps.list.length, signal: reps.signal, scale };
  },

  measure(samples, phase, ax) {
    const notes = [];
    const series = [];
    let both = 0, interp = 0, atRest = 0;

    for (let i = phase.startIdx; i <= phase.endIdx; i++) {
      const sig = phase.signal[i];
      if (sig == null || sig <= REP_BOTTOM_FRAC) { atRest++; continue; }   // resting between reps — not what the cue is about
      const p = samples[i].p;
      const dL = (p[KP.lElb] && p[KP.lWri]) ? (elev(p[KP.lWri], ax) - elev(p[KP.lElb], ax)) / phase.scale : null;
      const dR = (p[KP.rElb] && p[KP.rWri]) ? (elev(p[KP.rWri], ax) - elev(p[KP.rElb], ax)) / phase.scale : null;
      const vals = [dL, dR].filter(v => v != null);
      if (!vals.length) continue;
      if (vals.length === 2) both++;
      if ([KP.lElb, KP.rElb, KP.lWri, KP.rWri].some(k => p[k] && p[k].interp)) interp++;
      series.push({
        idx: i, frame: samples[i].frame, t: samples[i].t,
        value: 100 * vals.reduce((a, b) => a + b, 0) / vals.length,
        lo: 100 * Math.min.apply(null, vals),
        hi: 100 * Math.max.apply(null, vals),
        spread: vals.length === 2 ? 100 * Math.abs(dL - dR) : null,
      });
    }
    if (series.length < RUN) {
      return { error: 'Neither elbow–wrist pair stayed above the confidence threshold for long enough while the arm was raised.' };
    }

    const vals = series.map(s => s.value);
    const spreads = series.map(s => s.spread).filter(v => v != null);
    const summary = {
      mean: vals.reduce((a, b) => a + b, 0) / vals.length,
      worst: Math.min.apply(null, vals),   // most negative = wrist furthest above elbow
      meanSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null,
      n: series.length,
      atRestFrac: atRest / (phase.endIdx - phase.startIdx + 1),
    };
    if (summary.meanSpread != null && summary.meanSpread > 10) {
      notes.push('The two arms disagree by ' + fmt(summary.meanSpread) + '% of torso length, on average — a real side-to-side difference, or the camera is not square to the lifter.');
    }
    return { series, summary, notes };
  },

  score: elbowLeadScore,

  verdict(summary) {
    if (summary.worst >= ELBOW_GOOD) return { label: 'elbow leads clearly', status: 'good' };
    if (summary.worst >= ELBOW_WARN) return { label: 'elbow and wrist near level', status: 'warning' };
    return { label: 'wrist rises above elbow', status: 'critical' };
  },

  referenceLine() {
    return { value: 0, label: 'elbow = wrist height' };
  },

  tiles(summary, verdict) {
    return [
      { label: 'Elbow lead margin', value: (summary.worst >= 0 ? '+' : '') + fmt(summary.worst) + '%',
        sub: verdict.label, status: verdict.status },
      { label: 'Mean margin', value: (summary.mean >= 0 ? '+' : '') + fmt(summary.mean) + '%', sub: 'across the working range' },
      { label: 'Frames scored', value: String(summary.n), sub: 'while the arm was raised' },
      { label: 'L/R disagreement', value: summary.meanSpread == null ? '—' : '±' + fmt(summary.meanSpread) + '%', sub: 'uncertainty' },
    ];
  },

  transparencyLines(res, samples, ctxExtra) {
    const s = res.summary, ph = res.phase;
    const pct = v => Math.round(v * 100) + '%';
    return [
      '<strong>Phase</strong> — ' + ph.repCount + ' rep(s), frames ' + samples[ph.startIdx].frame + '–' +
        samples[ph.endIdx].frame + ', ' + s.n + ' frames scored while the arm was raised (' +
        pct(s.atRestFrac) + ' of the span was resting between reps and excluded).',
      '<strong>Measurement</strong> — elbow minus wrist elevation, per side, only while the combined shoulder–wrist signal is above ' +
        fmt(REP_BOTTOM_FRAC, 2) + ' torso-lengths (the same "at rest" gate the rep trigger uses).',
      axisNote(ctxExtra.axis),
      '<strong>Time smoothing</strong> — ' + (ctxExtra.smoothingMs
        ? 'trajectories were smoothed with a Gaussian of σ = ' + ctxExtra.smoothingMs + ' ms before scoring (the slider under the video).'
        : 'off — scored on raw per-frame detections, so pose jitter is counted as elbow/wrist movement.'),
      '<strong>Caveat</strong> — height is a percentage of torso length, not a physical unit (the pose track has no metric scale); positive means the elbow sits above the wrist. The good/warning bands (' +
        fmt(ELBOW_GOOD, 0) + '% / ' + fmt(ELBOW_WARN, 0) + '%) are provisional and not fitted to labelled reps.',
    ].concat(res.notes.map(n => '<strong>Note</strong> — ' + n));
  },

  overlay(ctx, view, phase, res, size) {
    const p = view.p;
    const lw = Math.max(2, size / 260);
    const col = alpha => scoreColor(this.score(res.summary), alpha);
    const segs = [[KP.lElb, KP.lWri], [KP.rElb, KP.rWri]]
      .map(([e, w]) => [p[e], p[w]]).filter(([a, b]) => a && b);
    for (const [width, style] of [[lw * 3.2, 'rgba(0,0,0,0.55)'], [lw * 1.8, col(1)]]) {
      ctx.strokeStyle = style; ctx.lineWidth = width;
      for (const [a, b] of segs) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
  },
};

// --- diagnostic 6: lateral raise, tempo -----------------------------------
//
// Ascent and descent speed, compared per rep rather than per frame — the cue
// is about a whole rep's shape (up under control, down under control), not an
// instant. Each rep contributes one measurement, same as the top-height
// diagnostic, but built from the wrists' ascent/descent speed rather than the
// peak position alone.
const TEMPO_GOOD = 1.5, TEMPO_WARN = 2.5, TEMPO_RED = 4;   // descent/ascent speed ratio — provisional
const tempoScore = summary => (!summary || summary.worst == null || !isFinite(summary.worst)) ? null
  : Math.max(0, Math.min(1, (summary.worst - 1) / (TEMPO_RED - 1)));

const lateralRaiseTempo = {
  id: 'lateral-raise-tempo',
  title: 'Tempo — controlled lowering, not dropped',
  phaseLabel: null,   // spans the whole set — no distinct sub-phase to name on the video
  cue: 'The weight is lowered under control — the descent isn\'t noticeably faster than the raise.',
  unit: 'x',
  provisional: true,   // TEMPO_GOOD/TEMPO_WARN
  worstRule: 'summary-worst',   // the verdict is the fastest descent
  zones: [   // lowest first, as verdict() reads summary.worst
    { status: 'good', from: null, to: TEMPO_GOOD },
    { status: 'warning', from: TEMPO_GOOD, to: TEMPO_WARN },
    { status: 'critical', from: TEMPO_WARN, to: null },
  ],

  phase(samples, scale, ax) {
    const notes = [];
    const reps = lateralRaiseReps(samples, scale, ax);
    if (!reps.list.length) {
      return { error: reps.reason === 'no-signal'
        ? 'Neither the shoulders nor the wrists stayed above the confidence threshold long enough to find a rep in this clip.'
        : reps.reason === 'all-too-short'
          ? 'Every rep candidate in this clip was shorter than ' + fmt(MIN_REP_SECONDS, 1) + 's, which is more likely pose noise than a real rep.'
          : 'No rep (arm raised toward shoulder height and back down) was found in this clip.' };
    }
    const usable = reps.list.filter(r => r.bottomBeforeIdx != null && r.bottomAfterIdx != null);
    if (!usable.length) {
      return { error: 'No rep in this clip had both a bottom before and after its peak, so ascent and descent speed can\'t be compared.' };
    }
    if (reps.dropped.length) {
      notes.push(reps.dropped.length + ' rep candidate(s) shorter than ' + fmt(MIN_REP_SECONDS, 1) + 's were treated as detection noise, not scored.');
    }
    if (usable.length < reps.list.length) {
      notes.push((reps.list.length - usable.length) + ' rep(s) touched the clip\'s own start or end, so a full ascent and descent couldn\'t be measured for them.');
    }
    const startIdx = usable[0].bottomBeforeIdx, endIdx = usable[usable.length - 1].bottomAfterIdx;
    const repPoints = usable.map(rep => ({
      bottom: centroid(samples[rep.bottomBeforeIdx].p, [KP.lWri, KP.rWri]),
      peak: centroid(samples[rep.peakIdx].p, [KP.lWri, KP.rWri]),
      after: centroid(samples[rep.bottomAfterIdx].p, [KP.lWri, KP.rWri]),
    }));
    return { startIdx, endIdx, notes, reps: usable, repPoints, scale, repCount: reps.list.length };
  },

  // Two independent estimates of the same rep's ratio — left wrist and right
  // wrist scored separately, same contract as every other diagnostic here —
  // rather than one estimate from the wrist centroid.
  measure(samples, phase, ax) {
    const notes = [];
    const series = [];

    const ratioSide = (rep, wristKey) => {
      const b = samples[rep.bottomBeforeIdx].p[wristKey];
      const pk = samples[rep.peakIdx].p[wristKey];
      const a = samples[rep.bottomAfterIdx].p[wristKey];
      const ascentDur = samples[rep.peakIdx].t - samples[rep.bottomBeforeIdx].t;
      const descentDur = samples[rep.bottomAfterIdx].t - samples[rep.peakIdx].t;
      if (!b || !pk || !a || !(ascentDur > 0) || !(descentDur > 0)) return null;
      const ascentSpeed = Math.abs(elev(b, ax) - elev(pk, ax)) / ascentDur / phase.scale;
      const descentSpeed = Math.abs(elev(a, ax) - elev(pk, ax)) / descentDur / phase.scale;
      return ascentSpeed > 0 ? descentSpeed / ascentSpeed : null;
    };

    for (const rep of phase.reps) {
      const rL = ratioSide(rep, KP.lWri), rR = ratioSide(rep, KP.rWri);
      const vals = [rL, rR].filter(v => v != null && isFinite(v));
      if (!vals.length) continue;
      series.push({
        idx: rep.peakIdx, frame: samples[rep.peakIdx].frame, t: samples[rep.peakIdx].t,
        value: vals.reduce((a, b) => a + b, 0) / vals.length,
        lo: Math.min.apply(null, vals), hi: Math.max.apply(null, vals),
        spread: vals.length === 2 ? Math.abs(rL - rR) : null,
      });
    }
    if (!series.length) {
      return { error: 'Wrist speed could not be measured for any rep\'s ascent and descent in this clip.' };
    }

    const vals = series.map(s => s.value);
    const spreads = series.map(s => s.spread).filter(v => v != null);
    const summary = {
      reps: series.length,
      mean: vals.reduce((a, b) => a + b, 0) / vals.length,
      worst: Math.max.apply(null, vals),
      meanSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null,
    };
    if (summary.meanSpread != null && summary.meanSpread > 0.5) {
      notes.push('The two arms\' tempo ratios disagree by ' + fmt(summary.meanSpread, 2) + 'x, on average — one arm may be doing more of the lowering than the other.');
    }
    return { series, summary, notes };
  },

  score: tempoScore,

  verdict(summary) {
    if (summary.worst <= TEMPO_GOOD) return { label: 'controlled descent', status: 'good' };
    if (summary.worst <= TEMPO_WARN) return { label: 'descent a little fast', status: 'warning' };
    return { label: 'weight dropped, not lowered', status: 'critical' };
  },

  referenceLine() {
    return { value: 1, label: '1× (equal tempo)' };
  },

  tiles(summary, verdict) {
    return [
      { label: 'Descent vs ascent', value: fmt(summary.worst, 2) + 'x', sub: verdict.label, status: verdict.status },
      { label: 'Mean ratio', value: fmt(summary.mean, 2) + 'x', sub: 'across all reps' },
      { label: 'Reps scored', value: String(summary.reps), sub: 'with a measured ascent and descent' },
      { label: 'L/R disagreement', value: summary.meanSpread == null ? '—' : '±' + fmt(summary.meanSpread, 2) + 'x', sub: 'uncertainty' },
    ];
  },

  transparencyLines(res, samples, ctxExtra) {
    const s = res.summary, ph = res.phase;
    return [
      '<strong>Phase</strong> — ' + ph.repCount + ' rep(s) found, ' + s.reps + ' scored with a measured ascent and descent, frames ' +
        samples[ph.startIdx].frame + '–' + samples[ph.endIdx].frame + '.',
      '<strong>Measurement</strong> — per rep, per side: wrist vertical speed from bottom to peak (ascent) and peak to bottom (descent), each as torso-lengths/second; the ratio descent÷ascent is the rep\'s value, averaged over the sides that could be measured.',
      axisNote(ctxExtra.axis),
      '<strong>Caveat</strong> — a ratio nowhere near 1 in either direction can also mean a rep\'s ascent or descent was too short to time reliably at this frame stride, not necessarily a real tempo fault. The good/warning bands (' +
        fmt(TEMPO_GOOD, 1) + 'x / ' + fmt(TEMPO_WARN, 1) + 'x) are provisional and not fitted to labelled reps.',
    ].concat(res.notes.map(n => '<strong>Note</strong> — ' + n));
  },

  // Not a pose overlay — a static dashed path per rep (bottom -> peak -> bottom)
  // in the ramp colour, since the measurement is a rep-level ascent/descent
  // shape rather than a per-frame position.
  overlay(ctx, view, phase, res, size) {
    const col = scoreColor(this.score(res.summary), 1);
    const lw = Math.max(1, size / 300);
    ctx.save();
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.setLineDash([lw * 2, lw * 2]);
    for (const rp of phase.repPoints || []) {
      if (rp.bottom && rp.peak) { ctx.beginPath(); ctx.moveTo(rp.bottom.x, rp.bottom.y); ctx.lineTo(rp.peak.x, rp.peak.y); ctx.stroke(); }
      if (rp.peak && rp.after) { ctx.beginPath(); ctx.moveTo(rp.peak.x, rp.peak.y); ctx.lineTo(rp.after.x, rp.after.y); ctx.stroke(); }
    }
    ctx.restore();
  },
};

// --- diagnostic 7: lateral raise, rep-to-rep symmetry ---------------------
//
// Same per-rep top-height reading as lateralRaiseTopHeight, but scored across
// reps rather than against shoulder height — the cue here is consistency with
// the set's own first rep, which is what fatigue actually breaks: a lifter can
// be a little short of shoulder height on every rep and still be scored well
// here, if every rep is equally short.
const SYM_GOOD = 8, SYM_WARN = 18, SYM_RED = 35;   // percentage points of decline, first rep to last — provisional
const symmetryScore = summary => (!summary || summary.decline == null || !isFinite(summary.decline)) ? null
  : Math.max(0, Math.min(1, summary.decline / SYM_RED));

const lateralRaiseSymmetry = {
  id: 'lateral-raise-symmetry',
  title: 'Rep-to-rep symmetry — consistent height across the set',
  phaseLabel: null,   // spans the whole set — no distinct sub-phase to name on the video
  cue: 'Every rep in the set reaches about the same height as the first — height dropping as the set goes on is fatigue, not a one-off.',
  unit: '%',
  provisional: true,   // SYM_GOOD/SYM_WARN
  worstRule: 'summary-last',   // the decline is measured to the last rep
  zones: null,   // the verdict reads the decline, first rep minus last, which the plot (each rep's height) doesn't show

  phase(samples, scale, ax) {
    const notes = [];
    const reps = lateralRaiseReps(samples, scale, ax);
    if (!reps.list.length) {
      return { error: reps.reason === 'no-signal'
        ? 'Neither the shoulders nor the wrists stayed above the confidence threshold long enough to find a rep in this clip.'
        : reps.reason === 'all-too-short'
          ? 'Every rep candidate in this clip was shorter than ' + fmt(MIN_REP_SECONDS, 1) + 's, which is more likely pose noise than a real rep.'
          : 'No rep (arm raised toward shoulder height and back down) was found in this clip.' };
    }
    if (reps.list.length < 2) {
      return { error: 'Only one rep was found in this clip — there\'s nothing to compare rep-to-rep.' };
    }
    const first = reps.list[0], last = reps.list[reps.list.length - 1];
    const startIdx = first.bottomBeforeIdx != null ? first.bottomBeforeIdx : first.peakIdx;
    const endIdx = last.bottomAfterIdx != null ? last.bottomAfterIdx : last.peakIdx;
    if (reps.dropped.length) {
      notes.push(reps.dropped.length + ' rep candidate(s) shorter than ' + fmt(MIN_REP_SECONDS, 1) + 's were treated as detection noise, not scored.');
    }
    return { startIdx, endIdx, notes, reps: reps.list, scale };
  },

  // Same measurement lateralRaiseTopHeight makes at each rep's peak — left and
  // right shoulder->wrist deviation from shoulder height. The formula is
  // written out again here, not shared: change one, change both, or the two
  // diagnostics drift apart on what "this rep's height" means.
  measure(samples, phase, ax) {
    const notes = [];
    const series = [];
    let both = 0, interp = 0;

    for (const rep of phase.reps) {
      const i = rep.peakIdx;
      const p = samples[i].p;
      const devL = (p[KP.lSho] && p[KP.lWri]) ? (elev(p[KP.lSho], ax) - elev(p[KP.lWri], ax)) / phase.scale : null;
      const devR = (p[KP.rSho] && p[KP.rWri]) ? (elev(p[KP.rSho], ax) - elev(p[KP.rWri], ax)) / phase.scale : null;
      const vals = [devL, devR].filter(v => v != null);
      if (!vals.length) continue;
      if (vals.length === 2) both++;
      if ([KP.lSho, KP.rSho, KP.lWri, KP.rWri].some(k => p[k] && p[k].interp)) interp++;
      series.push({
        idx: i, frame: samples[i].frame, t: samples[i].t,
        value: 100 * vals.reduce((a, b) => a + b, 0) / vals.length,
        lo: 100 * Math.min.apply(null, vals),
        hi: 100 * Math.max.apply(null, vals),
        spread: vals.length === 2 ? 100 * Math.abs(devL - devR) : null,
      });
    }
    if (series.length < 2) {
      return { error: 'Neither shoulder–wrist pair stayed above the confidence threshold at the top of enough reps to compare them.' };
    }

    const vals = series.map(s => s.value);
    const spreads = series.map(s => s.spread).filter(v => v != null);
    const summary = {
      reps: series.length,
      first: vals[0],
      last: vals[vals.length - 1],
      decline: vals[0] - vals[vals.length - 1],
      range: Math.max.apply(null, vals) - Math.min.apply(null, vals),
      meanSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null,
    };
    if (summary.decline < 0) {
      notes.push('The last rep reached higher than the first — no decline to report, whatever drove the difference isn\'t fatigue.');
    }
    return { series, summary, notes };
  },

  score: symmetryScore,

  verdict(summary) {
    if (summary.decline <= SYM_GOOD) return { label: 'consistent across the set', status: 'good' };
    if (summary.decline <= SYM_WARN) return { label: 'some fatigue', status: 'warning' };
    return { label: 'notable fatigue', status: 'critical' };
  },

  // The set's own first rep is the target, not an external anatomical value —
  // consistency with where the lifter themselves started.
  referenceLine(summary) {
    return { value: summary.first, label: 'first rep ' + fmt(summary.first) + '%' };
  },

  tiles(summary, verdict) {
    return [
      { label: 'Decline', value: (summary.decline >= 0 ? '−' : '+') + fmt(Math.abs(summary.decline)) + 'pp',
        sub: verdict.label + ' · first rep to last', status: verdict.status },
      { label: 'First rep', value: (summary.first >= 0 ? '+' : '') + fmt(summary.first) + '%', sub: 'vs shoulder height' },
      { label: 'Last rep', value: (summary.last >= 0 ? '+' : '') + fmt(summary.last) + '%', sub: 'vs shoulder height' },
      { label: 'L/R disagreement', value: summary.meanSpread == null ? '—' : '±' + fmt(summary.meanSpread) + '%', sub: 'at the top' },
    ];
  },

  transparencyLines(res, samples, ctxExtra) {
    const s = res.summary, ph = res.phase;
    const pct = v => Math.round(v * 100) + '%';
    return [
      '<strong>Reps</strong> — ' + s.reps + ' rep(s) compared, frames ' + samples[ph.startIdx].frame + '–' +
        samples[ph.endIdx].frame + '.',
      '<strong>Per rep</strong> — ' + res.series.map((sr, i) =>
        'rep ' + (i + 1) + ': ' + (sr.value >= 0 ? '+' : '') + fmt(sr.value) + '%').join(', ') + ' (vs shoulder height, same reading as the top-height diagnostic).',
      '<strong>Measurement</strong> — decline is the first rep\'s value minus the last rep\'s, in percentage points; a negative decline means the last rep was higher, not lower.',
      axisNote(ctxExtra.axis),
      '<strong>Caveat</strong> — with only a few reps in a clip, one noisy rep can dominate the first/last comparison. The good/warning bands (' +
        fmt(SYM_GOOD, 0) + 'pp / ' + fmt(SYM_WARN, 0) + 'pp) are provisional and not fitted to labelled sets.',
    ].concat(res.notes.map(n => '<strong>Note</strong> — ' + n));
  },

  overlay(ctx, view, phase, res, size) {
    const p = view.p;
    const lw = Math.max(2, size / 260);
    const col = alpha => scoreColor(this.score(res.summary), alpha);
    const segs = [[KP.lSho, KP.lWri], [KP.rSho, KP.rWri]]
      .map(([sh, w]) => [p[sh], p[w]]).filter(([a, b]) => a && b);
    for (const [width, style] of [[lw * 3.2, 'rgba(0,0,0,0.55)'], [lw * 1.8, col(1)]]) {
      ctx.strokeStyle = style; ctx.lineWidth = width;
      for (const [a, b] of segs) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
  },
};

// Per-lift diagnostic sets. Each page (see PAGES in app.py) names one of these
// keys, and the app calls Diagnostics.setPage(name) to make it the active set —
// what every function below iterates as DIAGNOSTICS. A set may be empty: a lift
// whose diagnostics haven't been written yet still gets a fully working page
// (upload, pose, plot), just no scored cues. To add a lift's diagnostics, write
// the objects above and list them here under the page's key, and say in
// LIFT_WINDOW_SETS (below) whether the lift has a lift window.
const DIAGNOSTIC_SETS = {
  'snatch': [firstPullBackAngle, secondPullTripleExtension],
  'lateral-raise': [lateralRaiseTopHeight, lateralRaiseTorsoLean, lateralRaiseElbowLead, lateralRaiseTempo, lateralRaiseSymmetry],
  'clean-and-jerk': [cleanFirstPullBackAngle],
};
const DEFAULT_SET = 'snatch';

// Whether each set's lift has a lift window (liftWindow, above): the start of
// the first pull, then a held lockout. That trigger is the barbell's: the bar
// below knee height, then four extended joints held still. A lift with no bar
// has nothing for it to find, so its set says so here rather than getting the
// trigger's "the bar never sits below knee height" as if the lift were missing
// (nordmu, 2026-11-02: a lateral raise has no lift window and no error).
// computeResults() reads it, describe(set) returns it. Every key of
// DIAGNOSTIC_SETS is listed, true or false (checked just below); a page whose
// name has no set (setPage's empty set) keeps the trigger, as before.
const LIFT_WINDOW_SETS = {
  'snatch': true,
  'lateral-raise': false,
  'clean-and-jerk': true,
};
for (const name of Object.keys(DIAGNOSTIC_SETS)) {
  if (typeof LIFT_WINDOW_SETS[name] !== 'boolean') {
    throw new Error('LIFT_WINDOW_SETS: say whether the set ' + name + ' has a lift window (true or false)');
  }
}
const hasLiftWindow = name => LIFT_WINDOW_SETS[name] !== false;

// The active set. `let`, not `const`: setPage() swaps it (and rebuilds the
// panel) when the lift tab changes. Everything downstream reads this one array,
// so nothing else needs to know which lift is selected.
let DIAGNOSTICS = DIAGNOSTIC_SETS[DEFAULT_SET] || [];
let liftWindowOn = hasLiftWindow(DEFAULT_SET);   // the active set's LIFT_WINDOW_SETS entry

// Which diagnostics draw on the video. Only gates the overlay — a diagnostic
// that's switched off is still computed, plotted and scored, since the tickbox
// is about the frame getting crowded, not about what's being measured.
// Default on: a new diagnostic is invisible until you go looking for it
// otherwise. Reset by setPage() so it tracks the active set.
let enabled = new Set(DIAGNOSTICS.map(d => d.id));


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

// The lift when it can't be looked for: a track too short or without a body
// scale (its error), or a set that has no lift window (no error, and it says
// so). The same fields as liftWindow()'s, so every reader finds them.
function liftOrNone(error) {
  if (!liftWindowOn) {
    return { hasLiftWindow: false, error: null, startIdx: -1, endIdx: -1, t0: null, t1: null, notes: [] };
  }
  return { error, startIdx: -1, endIdx: -1, t0: null, t1: null, notes: [], hasLiftWindow: true };
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
    return { samples, scale: null, axis: null, lift: liftOrNone(err.error), results };
  }
  preparePoints(samples);
  const scale = torsoScale(samples);
  if (!scale) {
    const err = { error: 'No frame had a confident hip and shoulder on the same side, so there is no body scale to work from.' };
    for (const d of DIAGNOSTICS) results[d.id] = err;
    return { samples, scale: null, axis: null, lift: liftOrNone(err.error), results };
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

  // The lift's own start/end, independent of which cues this page scores: it is
  // the same window whether the panel is showing two diagnostics or none, so it
  // is computed here rather than inside the loop below. Whether a lift HAS a
  // window is its set's (LIFT_WINDOW_SETS, beside DIAGNOSTIC_SETS): a set
  // without one gets no window and no error, `hasLiftWindow: false`.
  const lift = liftWindowOn
    ? Object.assign(liftWindow(samples, scale, axis), { hasLiftWindow: true })
    : liftOrNone(null);

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
  return { samples, scale, axis, lift, results };
}

function run() {
  if (!state || !state.keypoints || !state.meta || !state.personId) return;
  const out = computeResults(state.keypoints, state.meta, state.personId);
  state.samples = out.samples;
  state.scale = out.scale;
  state.axis = out.axis;
  state.lift = out.lift;
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
//
// `motion` is { smooth, cubic }: whether to interpolate between samples at all,
// and the interpolator (linear without one). The old page builds it from `el`
// (pageMotion); the headless drawCue takes it from its caller.
function mixAt(cubic, v0, v1, v2, v3, t0, t1, t2, t3, u) {
  return cubic ? cubic(v0, v1, v2, v3, t0, t1, t2, t3, u) : v1 + (v2 - v1) * u;
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
function pointsAt(samples, t, motion) {
  if (!samples || !samples.length || !samples[0].p) return null;
  const k = slotAtTime(samples, t);
  const a = samples[k], b = samples[k + 1];
  if (!b || !(motion && motion.smooth)) return a.p;
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
      x: mixAt(motion.cubic, q0 && q0.x, qa.x, qb.x, q3 && q3.x, t0, a.t, b.t, t3, u),
      y: mixAt(motion.cubic, q0 && q0.y, qa.y, qb.y, q3 && q3.y, t0, a.t, b.t, t3, u),
      // a filled point on either side taints everything between them
      interp: qa.interp || qb.interp,
    };
  }
  return out;
}

// The old page's motion: its smooth-motion tickbox and app.py's interpolator.
function pageMotion() {
  return { smooth: !!(el.smoothMotion && el.smoothMotion()), cubic: el.cubic };
}


// --- one cue, from computeResults()'s output ----------------------------
//
// What the old page's panel and overlay do for one cue, as functions of the
// cue and a result passed in: no DOM, no `el`, no `state`. The old page calls
// them on its own state; the Diagnostics object's headless API (describe,
// tiles, referenceLine, worstMoment, drawCue) calls them on whatever
// computeResults() output the new app hands it.

// Every cue of every set, by id. Ids are unique across sets (the clean's first
// pull has its own), so a cue is found without knowing the active page.
const CUE_BY_ID = new Map();
for (const set of Object.values(DIAGNOSTIC_SETS)) for (const d of set) CUE_BY_ID.set(d.id, d);

function cueById(id) {
  const d = CUE_BY_ID.get(id);
  if (!d) throw new Error('Unknown cue id: ' + id);
  return d;
}

// The tiles above a cue's plot; none for a cue that can't be scored.
function cueTiles(d, res) {
  return (!res || res.error) ? [] : d.tiles(res.summary, res.verdict);
}

// The plot's dashed reference line, { value, label }, or null. Some cues draw
// it at a fixed target, some at the set's own mean or first rep, so it needs a
// scored result either way.
function cueReferenceLine(d, res) {
  return (!res || res.error || !d.referenceLine) ? null : d.referenceLine(res.summary);
}

// The worst moment: the one sample of a cue's series its verdict rests on, so
// the new UI can show the frame (A2). Each cue names its rule as `worstRule`:
//   'summary-worst'       the sample whose value the summary names as `worst`
//   'summary-last'        the last sample, which the summary's `last` is
//   'farthest-from-mean'  the sample farthest from the mean the verdict's SD is taken around
//   'phase-end'           the last sample of the phase, where the verdict's value is read
// A cue without a rule, or a result that can't be scored, has none (null).
const WORST_RULES = {
  'summary-worst': res => res.series.find(s => s.value === res.summary.worst),
  'summary-last': res => res.series[res.series.length - 1],
  'farthest-from-mean': res => res.series.reduce((a, s) =>
    Math.abs(s.value - res.summary.mean) > Math.abs(a.value - res.summary.mean) ? s : a),
  'phase-end': res => res.series[res.series.length - 1],
};

function cueWorstMoment(d, res) {
  if (!res || res.error || !res.series || !res.series.length || !WORST_RULES[d.worstRule]) return null;
  const s = WORST_RULES[d.worstRule](res);
  return s ? { t: s.t, idx: s.idx, frame: s.frame, value: s.value, rule: d.worstRule } : null;
}

// A2's "How it's scored" block: the cue's transparency lines, the bullets the
// old panel lists under its plot, as plain text. Every line is
// '<strong>label</strong> — text'; the label is split off and nothing else may
// be markup (a tag or an entity), so a cue can't slip HTML into the app: such
// a line throws, naming the cue. A cue that can't be scored has none ([]).
const LINE_RE = /^<strong>([^<>]+)<\/strong> — ([\s\S]*)$/;
const MARKUP_RE = /[<>]|&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/;

function cueScoringLines(d, out, smoothingMs) {
  const res = out && out.results ? out.results[d.id] : null;
  if (!res || res.error) return [];
  const ctxExtra = { smoothingMs, scale: out.scale, axis: out.axis };
  return d.transparencyLines(res, out.samples, ctxExtra).map(line => {
    const m = LINE_RE.exec(line);
    if (!m || MARKUP_RE.test(m[1]) || MARKUP_RE.test(m[2])) {
      throw new Error('Cue ' + d.id + ': a transparency line must be "<strong>label</strong> — text" ' +
        'with no other markup: ' + JSON.stringify(line));
    }
    return { label: m[1], text: m[2] };
  });
}

// Contract 4's status words (app/src/contracts/cue-view.mjs, VERDICT_STATUS)
// for the verdict levels a cue's zones are declared in.
const ZONE_STATUS = { good: 'good', warning: 'watch', critical: 'work on' };

// The bands A2 draws behind the cue's plot, from the cue's own `zones`: an array
// of { status, from, to } lowest first, in the cue's verdict levels and built
// from its threshold constants, or null where the plot doesn't show the value
// the verdict reads. A cue that declares neither throws, so a new cue can't
// reach the app without saying which.
function cueZones(d) {
  if (d.zones === undefined) {
    throw new Error('Cue ' + d.id + ' declares no zones: an array of bands, or null with the reason');
  }
  if (d.zones === null) return null;
  return d.zones.map(z => {
    if (!Object.prototype.hasOwnProperty.call(ZONE_STATUS, z.status)) {
      throw new Error('Cue ' + d.id + ': no status word for the zone level ' + JSON.stringify(z.status));
    }
    return { status: ZONE_STATUS[z.status], from: z.from, to: z.to };
  });
}

function overlaySize(ctx) {
  return ctx.canvas.height || 720;
}

// Draws one cue on the video at time `t` from `out` ({ samples, axis, results },
// computeResults()'s shape) and says whether it drew: nothing for a cue that
// can't be scored or a time outside its phase. `p`, the points at `t`, is
// passed in by the old page's overlay so every cue drawing one instant draws
// the same body; otherwise it is interpolated here with `motion`.
function drawCueAt(ctx, d, out, t, motion, p) {
  const res = out.results ? out.results[d.id] : null;
  if (!res || res.error) return false;
  const samples = out.samples;
  const ph = res.phase;
  // The phase is bounded by the times its triggers fired, so the marks come
  // up at the instant the pull starts rather than at the next processed
  // frame. On a coarse frame stride that boundary used to be a tenth of a
  // second out, which is enough to see against the video.
  const t0 = samples[ph.startIdx].t, t1 = samples[ph.endIdx].t;
  if (t < t0 || t > t1) return false;
  if (p === undefined) p = pointsAt(samples, t, motion);
  if (!p) return false;
  const steps = ph.endIdx - ph.startIdx;
  const view = {
    t, p,
    axis: out.axis || IMAGE_AXIS,            // the clip's one bar direction
    dt: steps > 0 ? (t1 - t0) / steps : 0,   // mean processed-frame spacing
    at: u => (u < t0 || u > t1) ? null : pointsAt(samples, u, motion),
  };
  d.overlay(ctx, view, ph, res, overlaySize(ctx));
  return true;
}

// A cue's phase label in the frame's top-left corner, `row` lines down, so the
// labels of cues drawn at one instant stack rather than overwrite.
function drawPhaseLabel(ctx, label, row) {
  const size = overlaySize(ctx);
  ctx.fillStyle = phaseColor(1);
  ctx.font = Math.max(12, size / 38) + 'px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(label, 8, Math.max(16, size / 30) + row * (size / 26));
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
  const ref = cueReferenceLine(d, res);
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
  ds.stats.innerHTML = cueTiles(d, res).map(t => tile(t.label, t.value, t.sub, t.status)).join('');
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
  // A lift can have no diagnostics yet (an empty set in DIAGNOSTIC_SETS). The
  // page still works — pose, overlay, plot — so say so rather than leaving a
  // blank panel that reads as broken.
  if (!DIAGNOSTICS.length) {
    const note = document.createElement('p');
    note.className = 'diag-note';
    note.textContent = 'No diagnostics for this lift yet.';
    el.sections.appendChild(note);
    return;
  }
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

// Two ways in. The old page mounts a panel: mount(), setPage(), setTrack(),
// draw(), overlay(ctx, time), liftWindow(). The headless API needs no DOM and
// no mounted panel; it is what the new app (app/) and the tests use:
//
//   computeResults(keypoints, meta, personId)
//       Scores the active set (setPage) against one person's COCO-17 track.
//       Returns { samples, scale, axis, lift, results }; results[id] is
//       { phase, series, summary, verdict, notes } or { error }.
//   describe(set) -> [{ id, title, cue, unit, phaseLabel, provisional }]
//       A set's cues in the panel's order (set: a DIAGNOSTIC_SETS key, e.g.
//       'snatch', 'lateral-raise'); an unknown set throws. phaseLabel is null
//       for a cue spanning the whole set; provisional is true while its
//       thresholds aren't checked on real lifts (all of them today). The
//       array's own `hasLiftWindow` (true or false, LIFT_WINDOW_SETS) says
//       whether the lift has a lift window; it isn't enumerable, so the array
//       is still the plain list of cues to map, compare or JSON.
//   computeResults().lift.hasLiftWindow says the same for the set it scored:
//       false is a lift with no window and no error (t0, t1 null, no notes).
//   tiles(id, result) -> [{ label, value, sub, status }]
//       The tiles the old panel shows above the cue's plot; [] for a result
//       that can't be scored. `result` is computeResults().results[id].
//   referenceLine(id, result) -> { value, label } | null
//       The plot's dashed line. Needs the result: some cues draw it at the
//       set's own mean or first rep. null without a scored result.
//   worstMoment(id, result) -> { t, idx, frame, value, rule } | null
//       The series sample the cue's verdict rests on, by the cue's rule
//       (`worstRule`, see WORST_RULES); null for a result that can't be scored.
//   drawCue(ctx, id, t, computed, opts) -> boolean
//       Draws the cue's overlay at time t (seconds) on any 2D context, from
//       computed = computeResults()'s whole output (it needs the samples), in
//       the frame's pixels; draws nothing and returns false outside the cue's
//       phase or for a cue that can't be scored. opts: smooth (interpolate
//       between samples, default false), cubic (the interpolator, linear
//       without one), label (draw the phase label, default true), labelRow
//       (its line, default 0). It is what overlay() draws for that cue.
//   scoringLines(id, computed, { smoothingMs }) -> [{ label, text }]
//       A2's "How it's scored" block: the cue's transparency lines, the
//       bullets the old panel lists under its plot (the phase, the
//       measurement, the bar axis, the time smoothing, the caveat with the
//       provisional bands, the notes), as plain text: each line's <strong>
//       label split off, so `<strong>label</strong> — text` is the panel's line
//       again. A line with any other markup throws, naming the cue. computed
//       is computeResults()'s whole output (the lines need its samples, scale
//       and axis); smoothingMs is the σ in ms the track was smoothed with
//       before computeResults() (0: the raw track), required, since the "Time
//       smoothing" line says it. [] for a cue that can't be scored.
//   zones(id) -> [{ status, from, to }] | null
//       The verdict's bands on the plot's scale, in the cue's unit, lowest
//       first, from the cue's own threshold constants: status is contract 4's
//       word (good, watch, work on), from and to the band's edges, null where a
//       band is open-ended. An edge value belongs to the band the cue's
//       verdict() puts it in. For a cue whose verdict reads one value of its
//       series (worstRule 'summary-worst'): the elbow lead and the tempo read
//       the worst value as signed; the top height reads its size (worstAbs),
//       so its bands are mirrored about shoulder height. null for a cue scored
//       on something its series doesn't plot (the back angles' and the torso
//       lean's SD, the symmetry's decline, the triple extension's deficits;
//       contract 4's VERDICT_VALUE), where bands on the plot would mislead.
//
// Every id is a cue id from any set (unknown ids throw); none of these read the
// active page or the mounted state.
const Diagnostics = {
  computeResults(keypoints, meta, personId) {
    return computeResults(keypoints, meta, personId);
  },

  describe(set) {
    if (!Object.prototype.hasOwnProperty.call(DIAGNOSTIC_SETS, set)) {
      throw new Error('Unknown diagnostic set: ' + set);
    }
    const cues = DIAGNOSTIC_SETS[set].map(d => ({
      id: d.id, title: d.title, cue: d.cue, unit: d.unit,
      phaseLabel: d.phaseLabel || null,
      provisional: d.provisional === true,
    }));
    return Object.defineProperty(cues, 'hasLiftWindow', { value: hasLiftWindow(set), enumerable: false });
  },

  tiles(id, result) {
    return cueTiles(cueById(id), result);
  },

  referenceLine(id, result) {
    return cueReferenceLine(cueById(id), result);
  },

  worstMoment(id, result) {
    return cueWorstMoment(cueById(id), result);
  },

  scoringLines(id, computed, opts) {
    const d = cueById(id);
    const ms = opts ? opts.smoothingMs : undefined;
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) {
      throw new Error('scoringLines: opts.smoothingMs is the smoothing the track was scored with, in ms (0 for none)');
    }
    return cueScoringLines(d, computed, ms);
  },

  zones(id) {
    return cueZones(cueById(id));
  },

  drawCue(ctx, id, t, computed, opts) {
    const d = cueById(id);
    const o = opts || {};
    if (typeof t !== 'number' || !isFinite(t) || !computed || !computed.samples) return false;
    if (!drawCueAt(ctx, d, computed, t, { smooth: !!o.smooth, cubic: o.cubic })) return false;
    if (d.phaseLabel && o.label !== false) drawPhaseLabel(ctx, d.phaseLabel, o.labelRow || 0);
    return true;
  },

  mount(opts) {
    el = opts;
    buildToggles();
    buildSections();
    el.select.addEventListener('change', () => {
      state.personId = el.select.value;
      run();
      redrawAll();
      // Everything painted ON the video — the marks, and the lift window the
      // sliders carry — belongs to the selected lifter too, and the paint loop
      // isn't running while the video sits paused, which is when you change it.
      if (el.redraw) el.redraw();
    });
  },

  // Switch to a lift's diagnostic set. Called by app.py's setPage() every time
  // a lift tab is selected: the video machine (upload, track, overlay, plot) is
  // shared across lifts, so only the set of cues and the panel below it change.
  // An unknown or absent name resolves to the empty set — a page with no cues.
  //
  // Rebuilds the toggles and sections for the new set, then re-scores whatever
  // clip is already loaded against it (nothing loaded yet is fine — run() is a
  // no-op then) and repaints. Safe to call before mount(): it just updates the
  // module state and mount() will build from it.
  setPage(name) {
    DIAGNOSTICS = DIAGNOSTIC_SETS[name] || [];
    liftWindowOn = hasLiftWindow(name);
    enabled = new Set(DIAGNOSTICS.map(d => d.id));
    if (!el) return;
    buildToggles();
    buildSections();
    if (state && state.keypoints && state.meta && state.personId) run();
    redrawAll();
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
      state.lift = null;
      const err = { error: 'No person was detected in any sampled frame.' };
      for (const d of DIAGNOSTICS) state.results[d.id] = err;
    } else {
      run();
    }
    redrawAll();
  },

  // The current clip's lift window — `{ t0, t1, ... }` in seconds, or null when
  // no track is loaded. Read by app.py to place the start/end markers on the
  // time sliders; it re-reads this after every setTrack/setPage rather than
  // caching, since the window moves with the smoothing slider like everything
  // else derived from the track. `t1` is null when no finish was found — a
  // clip with a start marker and no end one is a normal outcome, explained by
  // `notes`. null too for a set without a lift window (LIFT_WINDOW_SETS): the
  // page then draws no markers and no note, rather than a barbell trigger's
  // reason on a lift that has no bar.
  liftWindow() {
    return (state && state.lift && state.lift.hasLiftWindow !== false) ? state.lift : null;
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
    const motion = pageMotion();
    const p = pointsAt(state.samples, t, motion);
    if (!p) return;
    let shown = 0;
    for (const d of DIAGNOSTICS) {
      if (!enabled.has(d.id)) continue;
      if (!drawCueAt(ctx, d, state, t, motion, p)) continue;
      // Only diagnostics scoped to a distinct sub-phase (first pull, top of
      // rep) earn a label here — one spanning the whole set has nothing to
      // name that the active tab doesn't already say.
      if (d.phaseLabel) drawPhaseLabel(ctx, d.phaseLabel, shown++);
    }
  },
};

window.Diagnostics = Diagnostics;
})();
