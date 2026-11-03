// SPDX-License-Identifier: AGPL-3.0-or-later
// A2's texts and numbers as plain functions (package d18): what the cue's view (contract 4) and
// diagnostics.js's headless API say about one cue, laid out for the screen. No Preact, no DOM, so Node
// runs them as written (tests/app/cue-detail.test.js). Every word and number comes from the view or
// from s4's, s39's and s45's API (`tiles`, `zones`, `scoringLines`, `rule`); the screen's own words are its headings.
// `computed` is scoreLift()'s: computeResults() on the stored track with the view's own smoothing.
import { HALF_SPEED } from './player-model.mjs';
import { lookOf, shortTitle } from './result-model.mjs';
import { ruleOf, ruleParagraph, ruleSentence } from './rule-model.mjs';

export { ruleSentence };

// A tile's `status` as diagnostics.js gives it: a verdict level, or (the snatch's drift) a CSS colour the
// engine computed. Only a level has a place in the app's look; a colour string is not drawn.
const TILE_CLASS = Object.freeze({ good: 'good', warning: 'watch', critical: 'work-on' });
export const tileClass = status => (typeof status === 'string' && Object.prototype.hasOwnProperty.call(TILE_CLASS, status) ? TILE_CLASS[status] : null);

/** The label of the chip over the frame, and the time it shows counted from the marked range's start (A1's clock). */
export const WORST_LABEL = 'Worst moment';

/** The button that goes back to A1 and plays the rep slowly (the mockup's string). */
export const PLAY_HALF_LABEL = 'Play the rep at \u00bd\u00d7';

/**
 * What the button hands A1 through the flow's params: the cue, the start of its phase and speed ½×. A cue with
 * no phase (one that can't be scored) has no rep to play: no button. (Where the worst moment is the only time a
 * cue has, a second either side would be the other choice; the phase is what the mockup means by "the rep".)
 * @param {import('../contracts/cue-view.mjs').CueView} cue
 * @returns {{cue: string, from: number, speed: number}|null}
 */
export const playHalfOf = cue => (cue.phase ? { cue: cue.id, from: cue.phase.t0, speed: HALF_SPEED } : null);

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
  const apiRule = scored ? ruleOf(Diagnostics, cue.id) : null;
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
    // "How it's scored": rule(id)'s sentence on what the verdict reads, then the bands with the noun and the
    // watch band; the shorter sentence from the zones without it (s45)
    basis: apiRule ? apiRule.basis : null,
    rule: ruleParagraph(cue.unit, zones, apiRule),
    lines,
    worst: cue.worst,
    playHalf: playHalfOf(cue),
    origin: range.t0,
    moment: cue.worst ? { label: WORST_LABEL, time: (cue.worst.t - range.t0).toFixed(2) } : null,
    plot: cue,
  };
}

/**
 * S1's "How the cues are scored": per cue of the lift, its words, its rule from rule() and zones() and, for a stored
 * lift, the scoring lines of that lift's own result (a cue it couldn't score has none). With no stored lift
 * (`view` null) only the lift's cues and their rules, which need no result.
 * @param {Object} o
 * @param {Object} o.Diagnostics
 * @param {import('../contracts/lifts.mjs').LiftId} o.lift
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
      rule: ruleParagraph(d.unit, Diagnostics.zones(d.id), ruleOf(Diagnostics, d.id)),
      lines,
    };
  });
  return { lift, measured, cues };
}
