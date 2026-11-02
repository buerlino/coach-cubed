// A2's texts and numbers as plain functions (package d18): what the cue's view (contract 4) and
// diagnostics.js's headless API say about one cue, laid out for the screen. No Preact, no DOM, so Node
// runs them as written (tests/app/cue-detail.test.js). Every word and number comes from the view or
// from s4's and s39's API (`tiles`, `zones`, `scoringLines`); the screen's own words are its headings.
// `computed` is scoreLift()'s: computeResults() on the stored track with the view's own smoothing.
import { lookOf, shortTitle } from './result-model.mjs';
import { ruleSentence } from './rule-model.mjs';

export { ruleSentence };

// A tile's `status` as diagnostics.js gives it: a verdict level, or (the snatch's drift) a CSS colour the
// engine computed. Only a level has a place in the app's look; a colour string is not drawn.
const TILE_CLASS = Object.freeze({ good: 'good', warning: 'watch', critical: 'work-on' });
export const tileClass = status => (typeof status === 'string' && Object.prototype.hasOwnProperty.call(TILE_CLASS, status) ? TILE_CLASS[status] : null);

/** The label of the chip over the frame, and the time it shows counted from the marked range's start (A1's clock). */
export const WORST_LABEL = 'Worst moment';

/**
 * Everything A2 shows for one cue.
 * @param {Object} o
 * @param {Object} o.Diagnostics diagnostics.js's object
 * @param {import('../contracts/cue-view.mjs').ResultView} o.view
 * @param {Object} o.computed scoreLift()'s computeResults() output
 * @param {string} o.cueId
 * @param {{t0: number, t1: number}} o.range the marked range
 */
export function detailOf({ Diagnostics, view, computed, cueId, range }) {
  const cue = view.cues.find(c => c.id === cueId);
  if (!cue) throw new Error(`detail-model: the result has no cue ${JSON.stringify(cueId)}`);
  const look = lookOf(cue.status);
  const scored = cue.reason === null;
  const zones = scored ? Diagnostics.zones(cue.id) : null;
  const lines = scored ? Diagnostics.scoringLines(cue.id, computed, { smoothingMs: view.smoothing.sigmaMs }) : [];
  return {
    id: cue.id,
    title: shortTitle(cue.title),
    fullTitle: cue.title,
    status: cue.status,
    cls: look.cls,
    word: look.word,
    icon: look.icon,
    scored,
    reason: cue.reason,
    verdict: cue.verdict,
    cue: cue.cue,
    unit: cue.unit,
    phaseLabel: cue.phaseLabel,
    provisional: cue.provisional,
    notes: [...cue.notes],
    tiles: cue.tiles.map(t => ({ label: t.label, value: t.value, sub: t.sub ?? null, cls: tileClass(t.status) })),
    zones,
    rule: ruleSentence(cue.unit, zones),
    lines,
    worst: cue.worst,
    origin: range.t0,
    moment: cue.worst ? { label: WORST_LABEL, time: (cue.worst.t - range.t0).toFixed(2) } : null,
    plot: cue,
  };
}

/**
 * S1's "How the cues are scored": per cue of the lift, its words, its rule from zones() and, for a stored
 * lift, the scoring lines of that lift's own result (a cue it couldn't score has none). With no stored lift
 * (`view` null) only the lift's cues and their rules, which need no result.
 * @param {Object} o
 * @param {Object} o.Diagnostics
 * @param {'lateral-raise'|'snatch'} o.lift
 * @param {import('../contracts/cue-view.mjs').ResultView|null} o.view
 * @param {Object|null} o.computed
 */
export function scoringText({ Diagnostics, lift, view, computed }) {
  const measured = !!(view && computed);
  const cues = Diagnostics.describe(lift).map(d => {
    const cv = measured ? view.cues.find(c => c.id === d.id) : null;
    const lines = cv && cv.reason === null ? Diagnostics.scoringLines(d.id, computed, { smoothingMs: view.smoothing.sigmaMs }) : [];
    return {
      id: d.id,
      title: shortTitle(d.title),
      fullTitle: d.title,
      cue: d.cue,
      provisional: d.provisional,
      rule: ruleSentence(d.unit, Diagnostics.zones(d.id)),
      lines,
    };
  });
  return { lift, measured, cues };
}
