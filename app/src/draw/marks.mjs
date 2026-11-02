// The timeline's marks, from the view: where the lift was found (the old page's
// lift markers, liftMarkHtml in INDEX_HTML, whose placement src/track/lift-window.mjs's
// liftMarks already pins) and where a cue went wrong (a cue's worst moment).
// A window with t1 null (s35) marks its start only; no window marks none. Times
// are the track's (the cut's timeline); the bar shows the marked range, so they are
// shifted to its start. Fractions of the bar, 0–1, clamped. Plain module, no DOM.
import { liftMarks } from '../track/lift-window.mjs';

/**
 * @param {import('../contracts/cue-view.mjs').ResultView} view
 * @param {{t0: number, t1: number}} range the marked range, the bar's extent
 * @returns {{lift: {span: [number, number]|null, marks: number[]}|null,
 *   moments: Array<{cue: string, fraction: number, status: string}>}}
 */
export function timelineMarks(view, range) {
  const duration = range.t1 - range.t0;
  const w = view.liftWindow;
  const shift = t => (t == null ? null : t - range.t0);
  const lift = w ? liftMarks({ t0: shift(w.t0), t1: shift(w.t1) }, duration) : null;
  const r = t => Math.max(0, Math.min(1, (t - range.t0) / duration));
  const moments = duration > 0
    ? view.cues.filter(c => c.worst && (c.status === 'watch' || c.status === 'work on'))
      .map(c => ({ cue: c.id, fraction: r(c.worst.t), status: c.status }))
    : [];
  return { lift, moments };
}
