// Time smoothing of a pose track, ported from the old page (smoothKeypoints
// and its helpers in src/app.py's INDEX_HTML, frozen). tests/track.test.js
// pins this file to the old code: same input, bit-identical output.
//
// A pose model sees each frame on its own, so a joint held still wanders a few
// px per frame. Each keypoint's trajectory gets a Gaussian-weighted mean over
// its neighbouring frames before anything draws or measures it. The window is
// in time, not samples, so a variable frame rate or a frame_stride > 1 gets the
// same smoothing per second of video.
//
// Two rules keep the mean honest:
//   - neighbours below the confidence gate are skipped and the rest weighted by
//     their confidence, so a guessed, occluded wrist doesn't drag its frames;
//   - a smoothed point keeps its own frame's confidence, so smoothing never
//     brings back a joint the gate was hiding.

export const CONF_THRESHOLD = 0.3;      // the old page's gate, as diagnostics.js's
export const DEFAULT_SIGMA_MS = 50;     // the old page's slider default
export const DEFAULT_KEEP_VELOCITY = true;   // its "preserve velocity" default

const SIGMA_CUTOFF = 3;   // truncate the kernel at 3σ (weights < 1.2% of the centre)
const E_FINE = 0.5, E_COARSE = 4;   // the band-pass on the retiming error, in σ

// The sampled frames in order, and the video time (seconds) of each. Decoder
// timestamps win when present; index / fps is wrong under a stride.
export function sampleTimes(meta, kp) {
  const frames = (meta.frame_indices && meta.frame_indices.length)
    ? meta.frame_indices
    : Object.keys(kp).map(Number).sort((a, b) => a - b);
  const times = frames.map((f, slot) =>
    (meta.frame_times_ms && meta.frame_times_ms[slot] != null)
      ? meta.frame_times_ms[slot] / 1000
      : f / (meta.fps || 30));
  return { frames, times };
}

// raw: the track's keypoints ({frame: {person: 17 × [y, x, conf]}}).
// sigma in seconds; 0 (or less) returns `raw` itself, untouched.
//
// The first pass is the Gaussian mean of each position. Averaging positions
// also averages velocity, so fast phases (the second pull, the turnover) come
// out slower than the raw track had them. With keepVelocity, a second pass
// keeps the smoothed path and re-times the points along it so the speed
// follows the raw track again (retimeAlongPath).
export function smoothKeypoints(raw, meta, sigma, keepVelocity) {
  if (!raw || !meta || !(sigma > 0)) return raw;

  const { frames, times } = sampleTimes(meta, raw);
  const cutoff = SIGMA_CUTOFF * sigma, denom = 2 * sigma * sigma;
  const out = {};

  for (let k = 0; k < frames.length; k++) {
    const src = raw[String(frames[k])];
    if (!src) continue;
    const dst = out[String(frames[k])] = {};
    for (const [id, points] of Object.entries(src)) {
      dst[id] = points.map((pt, i) => {
        if (!pt || pt[2] < CONF_THRESHOLD) return pt;
        let sy = 0, sx = 0, w = 0;
        // outwards from the centre both ways, until the kernel passes the cutoff
        for (const dir of [1, -1]) {
          for (let j = k; j >= 0 && j < frames.length; j += dir) {
            if (dir === -1 && j === k) continue;   // the centre counts once
            const dt = Math.abs(times[j] - times[k]);
            if (dt > cutoff) break;
            const q = raw[String(frames[j])]?.[id]?.[i];
            if (!q || q[2] < CONF_THRESHOLD) continue;
            const g = Math.exp(-(dt * dt) / denom) * q[2];
            sy += g * q[0]; sx += g * q[1]; w += g;
          }
        }
        return w > 0 ? [sy / w, sx / w, pt[2]] : pt;
      });
    }
  }
  if (!keepVelocity) return out;

  // One trajectory at a time: every (person, keypoint) confident in at least
  // three sampled frames.
  const ids = new Set();
  for (const f of frames) { const fr = out[String(f)]; if (fr) for (const id of Object.keys(fr)) ids.add(id); }
  for (const id of ids) {
    let nKp = 0;
    for (const f of frames) { const p = out[String(f)]?.[id]; if (p) { nKp = p.length; break; } }
    for (let i = 0; i < nKp; i++) {
      const ks = [];
      for (let k = 0; k < frames.length; k++) {
        const q = raw[String(frames[k])]?.[id]?.[i];
        if (q && q[2] >= CONF_THRESHOLD) ks.push(k);
      }
      if (ks.length < 3) continue;
      const R = ks.map(k => raw[String(frames[k])][id][i]);
      const P = ks.map(k => out[String(frames[k])][id][i]);
      const T = ks.map(k => times[k]);
      const Q = retimeAlongPath(R, P, T, sigma);
      ks.forEach((k, m) => { out[String(frames[k])][id][i] = Q[m]; });
    }
  }
  return out;
}

// Slides the smoothed points P along their own polyline so the speed along it
// follows the raw track R (both [y, x, conf] at sample times T).
//
// Progress is arc length. A(k) is the smoothed path's; R(k) is the raw track's
// frame-to-frame displacement projected onto the smoothed path's direction and
// summed (perpendicular jitter drops out, jitter along the path telescopes).
// e(k) = R(k) − A(k) is how far ahead the raw track is, and the corrected point
// sits at arc length A(k) + e(k).
//
// e is band-passed first:
//   - wobble at σ/2 and below is the raw jitter's along-path part; handing it
//     back would undo the smoothing along one axis, so it goes;
//   - drift at E_COARSE·σ and above goes too: at a sharp reversal the smoothed
//     path cuts the corner and e grows by that shortfall for good, which would
//     shove every later point forward. Speed at the apex of a cut corner can't
//     be restored on a curve that no longer reaches it.
function retimeAlongPath(R, P, T, sigma) {
  const n = P.length;
  const A = new Float64Array(n), ty = new Float64Array(n), tx = new Float64Array(n);
  for (let m = 1; m < n; m++) {
    const dy = P[m][0] - P[m - 1][0], dx = P[m][1] - P[m - 1][1];
    const len = Math.hypot(dy, dx);
    A[m] = A[m - 1] + len;
    if (len > 1e-9) { ty[m] = dy / len; tx[m] = dx / len; }   // unit tangent of segment m-1 → m
  }
  const e = new Float64Array(n);
  let prog = 0;
  for (let m = 1; m < n; m++) {
    prog += (R[m][0] - R[m - 1][0]) * ty[m] + (R[m][1] - R[m - 1][1]) * tx[m];
    e[m] = prog - A[m];
  }
  const fine = gauss1d(e, T, sigma * E_FINE), coarse = gauss1d(e, T, sigma * E_COARSE);

  const total = A[n - 1];
  const Q = new Array(n);
  for (let m = 0; m < n; m++) {
    const target = Math.max(0, Math.min(total, A[m] + (fine[m] - coarse[m])));
    // the segment holding that arc length: the last s with A[s] <= target
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (A[mid] <= target) lo = mid; else hi = mid - 1; }
    const s = Math.min(lo, n - 2), seg = A[s + 1] - A[s];
    const u = seg > 1e-9 ? (target - A[s]) / seg : 0;
    Q[m] = [P[s][0] + u * (P[s + 1][0] - P[s][0]),
            P[s][1] + u * (P[s + 1][1] - P[s][1]),
            P[m][2]];
  }
  return Q;
}

// Gaussian smoothing of a scalar series over its (possibly uneven) sample times.
function gauss1d(v, T, s) {
  const n = v.length, out = new Float64Array(n);
  if (!(s > 0)) { out.set(v); return out; }
  const cutoff = SIGMA_CUTOFF * s, denom = 2 * s * s;
  for (let k = 0; k < n; k++) {
    let acc = 0, w = 0;
    for (let j = k; j < n; j++) {
      const dt = T[j] - T[k]; if (dt > cutoff) break;
      const g = Math.exp(-(dt * dt) / denom); acc += g * v[j]; w += g;
    }
    for (let j = k - 1; j >= 0; j--) {
      const dt = T[k] - T[j]; if (dt > cutoff) break;
      const g = Math.exp(-(dt * dt) / denom); acc += g * v[j]; w += g;
    }
    out[k] = w > 0 ? acc / w : v[k];
  }
  return out;
}
