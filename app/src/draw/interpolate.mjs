// The pose at a playhead time, ported from the old page (INDEX_HTML in src/app.py:
// monoTangent, cubicAt, slotForTime, poseAtTime; tests/app/draw.test.js pins each to
// it). The track has poses only at the processed frames; the overlay is evaluated at
// the playhead's own time and the in-between poses are interpolated, cubic and
// monotone (Fritsch-Carlson), so the curve never leaves the samples it was built
// from: no new peak, no deeper bottom than a frame shows. Plain module, no DOM.
import { CONF_THRESHOLD, sampleTimes } from '../track/smoothing.mjs';

export { CONF_THRESHOLD };

/**
 * A tangent that cannot overshoot: flat at a local extremum, else the 3-point
 * slope for uneven spacing, limited to three times the smaller secant.
 * @param {number} dA slope of the segment before
 * @param {number} hA its width
 * @param {number} dB slope of the segment after
 * @param {number} hB its width
 */
export function monoTangent(dA, hA, dB, hB) {
  if (dA * dB <= 0) return 0;
  const m = (dA * hB + dB * hA) / (hA + hB);
  const lim = 3 * Math.min(Math.abs(dA), Math.abs(dB));
  return Math.sign(m) * Math.min(Math.abs(m), lim);
}

/**
 * One coordinate on the segment v1..v2 at fraction u. v0 and v3 are the outer
 * neighbours (null at the ends of the track or where unsure): that end's tangent
 * is then the segment's own slope. This is the interpolator drawCue() takes as
 * `cubic`, so the cue marks and the skeleton move on one clock.
 */
export function cubicAt(v0, v1, v2, v3, t0, t1, t2, t3, u) {
  const h = t2 - t1;
  if (!(h > 1e-9)) return v1;
  const d = (v2 - v1) / h;
  let m1 = d, m2 = d;
  if (v0 != null && t1 - t0 > 1e-9) m1 = monoTangent((v1 - v0) / (t1 - t0), t1 - t0, d, h);
  if (v3 != null && t3 - t2 > 1e-9) m2 = monoTangent(d, h, (v3 - v2) / (t3 - t2), t3 - t2);
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * v1 + (u3 - 2 * u2 + u) * h * m1
       + (-2 * u3 + 3 * u2) * v2 + (u3 - u2) * h * m2;
}

/** The last sample whose time is at or before t (the first when t is earlier). */
export function slotForTime(times, t) {
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * A track's keypoints with the times of its samples, what every lookup goes through.
 * @param {Object} keypoints the (smoothed) track's keypoints, keyed by frame index
 * @param {Object} meta the track's meta
 * @returns {{keypoints: Object, frames: number[], times: number[]}}
 */
export function trackSamples(keypoints, meta) {
  const { frames, times } = sampleTimes(meta, keypoints);
  return { keypoints, frames, times };
}

/**
 * The pose to draw at time t: { personId: points }, or null for a track with no
 * samples. Interpolated between the two bracketing samples when `smooth`, else
 * the sample at or before t. A joint the confidence gate is unsure of at either
 * end of the gap is not interpolated: it snaps at the halfway point, as does a
 * person present in only one of the two frames. Fading between a detection and a
 * guess would draw a limb sliding through positions the model never proposed.
 * @param {{keypoints: Object, frames: number[], times: number[]}} track trackSamples()
 * @param {number} t seconds
 * @param {{smooth?: boolean}} [opts] smooth defaults to true
 */
export function poseAtTime(track, t, { smooth = true } = {}) {
  const { frames, times, keypoints } = track;
  const n = frames.length;
  if (!n) return null;
  const slot = slotForTime(times, t);
  const at = k => (k >= 0 && k < n) ? keypoints[String(frames[k])] : null;
  const A = at(slot);
  if (!smooth || n < 2 || slot + 1 >= n) return A;

  const span = times[slot + 1] - times[slot];
  const u = span > 1e-9 ? Math.min(Math.max((t - times[slot]) / span, 0), 1) : 0;
  const B = at(slot + 1);
  if (!A || !B) return u < 0.5 ? A : B;

  const P = at(slot - 1), Q = at(slot + 2);
  const t0 = times[slot - 1], t1 = times[slot], t2 = times[slot + 1], t3 = times[slot + 2];
  const out = {};
  for (const id of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const pa = A[id], pb = B[id];
    if (!pa || !pb) { const near = u < 0.5 ? pa : pb; if (near) out[id] = near; continue; }
    const p0 = P && P[id], p3 = Q && Q[id];
    const pts = [];
    for (let k = 0; k < pa.length; k++) {
      const a = pa[k], b = pb[k];
      if (!a || !b || a[2] < CONF_THRESHOLD || b[2] < CONF_THRESHOLD) {
        pts.push(u < 0.5 ? a : b);
        continue;
      }
      // Outer neighbours steer the curve only if they were confident too.
      const q0 = p0 && p0[k], q3 = p3 && p3[k];
      const c0 = (q0 && q0[2] >= CONF_THRESHOLD) ? q0 : null;
      const c3 = (q3 && q3[2] >= CONF_THRESHOLD) ? q3 : null;
      pts.push([
        cubicAt(c0 && c0[0], a[0], b[0], c3 && c3[0], t0, t1, t2, t3, u),
        cubicAt(c0 && c0[1], a[1], b[1], c3 && c3[1], t0, t1, t2, t3, u),
        Math.min(a[2], b[2]),   // an interpolated joint is only as sure as its weaker end
      ]);
    }
    out[id] = pts;
  }
  return out;
}
