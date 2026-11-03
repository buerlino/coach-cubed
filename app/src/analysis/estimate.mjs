// SPDX-License-Identifier: AGPL-3.0-or-later
// What a marked range will cost (M1–M3, "the time to analyse it"), before
// Analyse: seconds of processing per second of video, from the last measured
// rate, or on a first run from the Fairphone's. Plain module, no DOM.

/**
 * The first-run default, docs/ui-design.md ("What the mockups add"): about
 * 2.9 s of processing per second of 30 fps video, MoveNet Thunder on WebGL in
 * Brave on the Fairphone 6. Shown labelled as such until this phone has
 * measured its own.
 */
export const DEFAULT_RATE = Object.freeze({
  sPerS: 2.9,
  fps: 30,
  basis: 'first-run default: 2.9 s per second of 30 fps video, measured on a Fairphone 6 (MoveNet Thunder, WebGL)',
});

/**
 * A rate as the queue keeps it: the median ms per frame of the last job done,
 * at that video's frame rate.
 * @typedef {Object} Rate
 * @property {number} msPerFrame
 * @property {number} fps
 * @property {number} sPerS seconds of processing per second of that video
 */

/** @param {number} msPerFrame @param {number} fps @returns {Rate} */
export const rateOf = (msPerFrame, fps) => ({ msPerFrame, fps, sPerS: msPerFrame * fps / 1000 });

/**
 * The time to analyse `durationS` seconds of video. The cost is per frame, so a
 * frame rate given scales it (60 fps costs twice 30 fps); without one, the
 * rate's own video's rate is assumed.
 * @param {number} durationS the marked length in seconds
 * @param {Rate|null} rate the last measured rate, or null on a first run
 * @param {{fps?: number}} [opts] the marked video's frame rate
 * @returns {{seconds: number, perSecond: number, measured: boolean, basis: string}}
 */
export function estimateCost(durationS, rate, { fps } = {}) {
  const r = rate || DEFAULT_RATE;
  const perSecond = fps > 0 ? r.sPerS / r.fps * fps : r.sPerS;
  return {
    seconds: perSecond * Math.max(0, durationS),
    perSecond,
    measured: !!rate,
    basis: rate ? 'measured on this phone: the last analysis\'s median time per frame' : DEFAULT_RATE.basis,
  };
}
