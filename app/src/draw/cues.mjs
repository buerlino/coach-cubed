// Each cue's drawing over the skeleton: s4's drawCue(ctx, id, t, computed, opts) from
// diagnostics.js's headless API, with `smooth: true` and the ported interpolator
// (interpolate.mjs's cubicAt), so the marks move on the clock the skeleton moves on
// and sit on the joints they measure (s4's report, item 3). `computed` is
// scoreLift()'s, computeResults()'s output for the stored track with the view's own
// smoothing: result.json holds the view, not the samples drawCue needs. Plain module, no DOM.
import { cubicAt } from './interpolate.mjs';

/**
 * Draws the cues that are in their phase at time t, in the view's order; the phase
 * labels of cues drawn at one instant stack, one row each, instead of overwriting.
 * @param {CanvasRenderingContext2D} ctx in the frame's pixels
 * @param {Object} Diagnostics diagnostics.js's object (window.Diagnostics)
 * @param {import('../contracts/cue-view.mjs').ResultView} view
 * @param {Object} computed scoreLift()'s `computed`
 * @param {number} t seconds in the track's timeline
 * @param {{ids?: string[], smooth?: boolean, cubic?: Function}} [opts] ids: draw only
 *   these cues (default all); smooth and cubic are drawCue's (here true and cubicAt)
 * @returns {string[]} the ids that drew something
 */
export function drawCues(ctx, Diagnostics, view, computed, t, { ids = null, smooth = true, cubic = cubicAt } = {}) {
  const drawn = [];
  let row = 0;
  for (const cue of view.cues) {
    if (cue.status === "can't score") continue;
    if (ids && !ids.includes(cue.id)) continue;
    if (Diagnostics.drawCue(ctx, cue.id, t, computed, { smooth, cubic, labelRow: row })) {
      drawn.push(cue.id);
      if (cue.phaseLabel) row++;
    }
  }
  return drawn;
}
