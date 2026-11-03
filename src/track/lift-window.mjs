// SPDX-License-Identifier: AGPL-3.0-or-later
// The lift window and the scores as the old page shows them. The page smooths
// the raw track (applySmoothing in src/app.py's INDEX_HTML), hands it to
// diagnostics.js (setTrack), which picks the lifter and scores the lift's cue
// set; the window it returns goes onto the time bars (renderLiftMarks,
// liftMarkHtml). tests/track.test.js pins each step to the old code.
//
// diagnostics.js computes the window itself (liftWindow there); this file is
// the glue around it, so a new UI and the spike score what the user saw.

import { smoothKeypoints, DEFAULT_SIGMA_MS, DEFAULT_KEEP_VELOCITY } from './smoothing.mjs';

// Person ids by number of frames, most first, ties by numeric id: the order
// diagnostics.js's personIds gives, and so its lifter picker.
export function personIds(keypoints) {
  const counts = new Map();
  for (const frame of Object.values(keypoints)) {
    for (const id of Object.keys(frame)) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || (+a[0]) - (+b[0]));
}

// The lifter the page scores: the one picked before if this track still has
// them (the page keeps the choice across re-smoothing), else the one with the
// most frames; null when nobody was detected.
export function pickPerson(keypoints, previous) {
  const ids = personIds(keypoints);
  if (ids.some(([id]) => id === previous)) return previous;
  return ids.length ? ids[0][0] : null;
}

// What the page does with a raw track: smooth it (σ in ms; the page's defaults
// unless given), pick the lifter (or take opts.personId), and score the lift's
// cue set. Diagnostics is diagnostics.js's object (window.Diagnostics in a
// page, loadDiagnostics() in Node); it's passed in because diagnostics.js is a
// classic script, not a module.
//
// Returns the smoothed keypoints, the lifter, the lift window
// ({ t0, t1, startIdx, endIdx, error?, notes, triggers? }, times in seconds),
// each cue's result and the samples (each with its time `t`) that the
// indices in a result's phase point into, as computeResults returns them.
export function scoreTrack(Diagnostics, track, set, opts = {}) {
  const sigmaMs = opts.sigmaMs ?? DEFAULT_SIGMA_MS;
  const keepVelocity = opts.keepVelocity ?? DEFAULT_KEEP_VELOCITY;
  const keypoints = smoothKeypoints(track.keypoints, track.meta, sigmaMs / 1000, keepVelocity);
  const personId = opts.personId ?? pickPerson(keypoints);
  Diagnostics.setPage(set);
  if (personId == null) {
    // setTrack's own message for a track with nobody in it; it has no window.
    // Scoring an empty track is how to learn the set's cue ids.
    const err = { error: 'No person was detected in any sampled frame.' };
    const ids = Object.keys(Diagnostics.computeResults({}, track.meta, '0').results);
    const results = Object.fromEntries(ids.map(id => [id, err]));
    return { keypoints, personId: null, sigmaMs, keepVelocity, lift: null, results, samples: [] };
  }
  const out = Diagnostics.computeResults(keypoints, track.meta, personId);
  return { keypoints, personId, sigmaMs, keepVelocity, lift: out.lift, results: out.results, samples: out.samples };
}

// Where the window sits on a time bar of `duration` seconds, as fractions of
// the bar (0–1, clamped): `marks` holds one entry per end that was found,
// `span` both ends or null. Null when there's no window or no duration, as
// the page then draws nothing.
export function liftMarks(win, duration) {
  if (!win || !(duration > 0)) return null;
  const r = t => Math.max(0, Math.min(1, t / duration));
  const t0 = win.t0 != null ? win.t0 : null;
  const t1 = win.t1 != null ? win.t1 : null;
  return {
    span: (t0 != null && t1 != null) ? [r(t0), r(t1)] : null,
    marks: [t0, t1].filter(t => t != null).map(r),
  };
}
