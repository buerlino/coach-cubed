// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract 4, the cue view model: what the UI draws for a scored lift (A1's
// cards, A2's detail, the timeline). The scoring adapter (app/src/scoring/,
// s11) makes it from diagnostics.js: computeResults() and s4's headless API
// (describe, tiles, referenceLine, worstMoment). The cue list is data, so a
// new cue in diagnostics.js needs no UI change. A stored lift's result.json
// holds one ResultView. Plain module, no DOM.
//
// The status words are ui-design.md's ("The look"): good, watch, work on,
// can't score, always shown with an icon and the word, never colour alone.
// A cue that can't be scored says why, in the engine's words, and draws
// nothing: no verdict, value, tiles, series, phase or worst moment.
import {
  at, checkFields, checkLift, checkStrings, isNumber, isObject, isString,
} from './common.mjs';

/** The four status words, in ui-design.md's order. */
export const STATUS_WORDS = Object.freeze(['good', 'watch', 'work on', "can't score"]);

/**
 * diagnostics.js's verdict.status to the status word. A result with
 * `error` (computeResults() couldn't score the cue) is "can't score".
 */
export const VERDICT_STATUS = Object.freeze({ good: 'good', warning: 'watch', critical: 'work on' });

/**
 * The number a verdict is scored on, by the cue's rule (worstMoment(id,
 * result).rule, diagnostics.js's WORST_RULES): the summary field its
 * verdict(summary) reads, in the cue's unit. It is the verdict's own number,
 * not the worst moment's sample: a 'farthest-from-mean' cue (the snatch's
 * first-pull back angle, the lateral raise's torso lean) is scored on the SD
 * around the mean, and its worst moment is only the sample farthest from
 * that mean, a raw angle.
 *   'summary-worst'       summary.worst: the worst rep or frame, signed (the
 *                         top height's verdict reads its size, worstAbs)
 *   'summary-last'        summary.decline: the first rep minus the last
 *   'farthest-from-mean'  summary.sd: the spread around summary.mean
 *   'phase-end'           the larger of summary.hipDeficit and
 *                         summary.kneeDeficit (null when the knee isn't seen)
 */
export const VERDICT_VALUE = Object.freeze({
  'summary-worst': 'summary.worst',
  'summary-last': 'summary.decline',
  'farthest-from-mean': 'summary.sd',
  'phase-end': 'max(summary.hipDeficit, summary.kneeDeficit)',
});

/**
 * The value VERDICT_VALUE names, read off a scored result's summary.
 * @param {string} rule the cue's worstRule, as worstMoment(id, result).rule gives it
 * @param {Object} summary computeResults() results[id].summary
 * @returns {number|null} null for a rule it doesn't know or a number that isn't finite
 */
export function verdictValue(rule, summary) {
  if (!isObject(summary)) return null;
  let v = null;
  if (rule === 'summary-worst') v = summary.worst;
  else if (rule === 'summary-last') v = summary.decline;
  else if (rule === 'farthest-from-mean') v = summary.sd;
  else if (rule === 'phase-end') {
    v = summary.hipDeficit;
    if (isNumber(summary.kneeDeficit) && !(summary.kneeDeficit <= v)) v = summary.kneeDeficit;
  }
  return isNumber(v) ? v : null;
}

/**
 * Each field's source. `results[id]` is computeResults().results[id] for
 * the lift's track (keypoints, meta, personId), after setPage(lift); the
 * headless calls are s4's, on the Diagnostics object in src/diagnostics.js.
 */
export const CUE_VIEW_SOURCES = Object.freeze({
  id: 'describe(set): id',
  title: 'describe(set): title',
  cue: 'describe(set): cue',
  unit: 'describe(set): unit',
  phaseLabel: 'describe(set): phaseLabel',
  provisional: 'describe(set): provisional',
  status: "the adapter: VERDICT_STATUS[computeResults() results[id].verdict.status], or \"can't score\" for results[id].error",
  verdict: 'computeResults(): results[id].verdict.label',
  value: 'the adapter: verdictValue(worstMoment(id, result).rule, computeResults() results[id].summary), the summary field VERDICT_VALUE names for the rule, in unit',
  tiles: 'tiles(id, result)',
  referenceLine: 'referenceLine(id, result)',
  series: 'computeResults(): results[id].series, each sample\'s t, value, lo, hi',
  phase: 'the adapter: computeResults() samples[results[id].phase.startIdx].t and samples[…endIdx].t',
  worst: 'worstMoment(id, result)',
  reason: 'computeResults(): results[id].error',
  notes: 'computeResults(): results[id].notes',
});

/**
 * One cue, as A1's card and A2's detail draw it. Each field's source is in
 * CUE_VIEW_SOURCES.
 * @typedef {Object} CueView
 * @property {string} id the cue's id in diagnostics.js
 * @property {string} title its title
 * @property {string} cue what good looks like, in a sentence
 * @property {string} unit the unit of value, series and the reference line ('°', '%', 'x')
 * @property {string|null} phaseLabel the phase it is scored in; null when it spans the set
 * @property {boolean} provisional its thresholds aren't checked on real lifts yet
 * @property {'good'|'watch'|'work on'|"can't score"} status
 * @property {string|null} verdict the verdict in words; null when it can't be scored
 * @property {number|null} value the number the verdict is scored on, in unit (VERDICT_VALUE:
 *   the SD for a cue scored on its spread, not a sample's value); null if the rule is unknown
 * @property {Array<{label: string, value: string, sub?: string, status?: string}>} tiles
 *   the old panel's tiles; status is a verdict status or a CSS colour, as diagnostics.js gives it
 * @property {{value: number, label: string}|null} referenceLine the plot's dashed line
 * @property {Array<{t: number, value: number, lo?: number|null, hi?: number|null}>} series
 *   the cue's measurement over time (t in seconds), lo and hi the two sides' band
 * @property {{t0: number, t1: number}|null} phase where the cue was scored, in seconds
 * @property {{t: number, idx: number, frame: number, value: number, rule: string}|null} worst
 *   the sample the verdict rests on
 * @property {string|null} reason why it can't be scored, in the engine's words; null when scored
 * @property {string[]} notes the engine's notes on this cue (a camera note, a fallback)
 */

/**
 * A scored lift: the cues in diagnostics.js's order, the lift window, the notes,
 * and the smoothing the verdicts were scored with.
 * @typedef {Object} ResultView
 * @property {import('./lifts.mjs').LiftId} lift
 * @property {boolean} hasLiftWindow whether the lift has a lift window at all
 *   (computeResults().lift.hasLiftWindow, the set's in diagnostics.js; s36): the
 *   window is the barbell's (the bar below knee height, then a held lockout), so
 *   a lateral raise has none. false: liftWindow and liftWindowReason are null,
 *   there is nothing to find and nothing went wrong
 * @property {{t0: number, t1: number|null}|null} liftWindow the lift found inside the
 *   marked range, in seconds (computeResults().lift t0, t1); t1 null when
 *   diagnostics.js found the start and no held finish (s35); null when no lift was
 *   found, or the lift has no window
 * @property {string|null} liftWindowReason why there is no window
 *   (computeResults().lift.error), or why it has no end (diagnostics.js's own
 *   note, the last of computeResults().lift.notes, never a new string); null
 *   when both ends were found, or the lift has no window
 * @property {CueView[]} cues
 * @property {string[]} notes the lift window's notes (computeResults().lift.notes,
 *   less the one that is liftWindowReason)
 * @property {{sigmaMs: number, keepVelocity: boolean}} smoothing src/track/'s
 *   smoothing the track went through before computeResults(): σ in ms (0: the
 *   raw track) and the velocity option; a result.json keeps it with its verdicts
 */

const CANT = "can't score";

function checkSeconds(errors, path, v) {
  if (!checkFields(errors, path, v, ['t0', 't1'])) return;
  if (!isNumber(v.t0)) errors.push(`${at(path, 't0')}: must be a finite number (seconds)`);
  if (!isNumber(v.t1)) errors.push(`${at(path, 't1')}: must be a finite number (seconds)`);
  else if (isNumber(v.t0) && v.t1 < v.t0) errors.push(`${at(path, 't1')}: must not be before ${at(path, 't0')}`);
}

function checkTiles(errors, tiles) {
  if (!Array.isArray(tiles)) { errors.push('tiles: must be an array'); return; }
  tiles.forEach((tile, i) => {
    const p = at('tiles', i);
    if (!checkFields(errors, p, tile, ['label', 'value'], ['sub', 'status'])) return;
    if (typeof tile.label !== 'string') errors.push(`${at(p, 'label')}: must be a string`);
    if (typeof tile.value !== 'string') errors.push(`${at(p, 'value')}: must be a string (formatted)`);
    if ('sub' in tile && typeof tile.sub !== 'string') errors.push(`${at(p, 'sub')}: must be a string`);
    if ('status' in tile && tile.status !== undefined && typeof tile.status !== 'string') {
      errors.push(`${at(p, 'status')}: must be a string`);
    }
  });
}

function checkSeries(errors, series) {
  if (!Array.isArray(series)) { errors.push('series: must be an array'); return; }
  series.forEach((s, i) => {
    const p = at('series', i);
    if (!checkFields(errors, p, s, ['t', 'value'], ['lo', 'hi'])) return;
    if (!isNumber(s.t)) errors.push(`${at(p, 't')}: must be a finite number (seconds)`);
    if (!isNumber(s.value)) errors.push(`${at(p, 'value')}: must be a finite number`);
    for (const k of ['lo', 'hi']) {
      if (k in s && s[k] !== null && !isNumber(s[k])) errors.push(`${at(p, k)}: must be a finite number or null`);
    }
  });
}

function checkWorst(errors, w) {
  if (!checkFields(errors, 'worst', w, ['t', 'idx', 'frame', 'value', 'rule'])) return;
  if (!isNumber(w.t)) errors.push('worst.t: must be a finite number (seconds)');
  if ('idx' in w && !Number.isInteger(w.idx)) errors.push('worst.idx: must be an integer');
  if ('frame' in w && !Number.isInteger(w.frame)) errors.push('worst.frame: must be an integer');
  if ('value' in w && !isNumber(w.value)) errors.push('worst.value: must be a finite number');
  if ('rule' in w && !isString(w.rule)) errors.push('worst.rule: must be a non-empty string');
}

/**
 * @param {unknown} cue
 * @param {string} [path] where the cue sits, e.g. 'cues[2]'; prefixes the errors
 * @returns {string[]} the errors, empty when valid
 */
export function validateCueView(cue, path = '') {
  if (!isObject(cue)) return [`${path || 'cue'}: must be an object`];
  const errors = [];
  checkFields(errors, '', cue, Object.keys(CUE_VIEW_SOURCES));
  for (const k of ['id', 'title', 'cue']) if (k in cue && !isString(cue[k])) errors.push(`${k}: must be a non-empty string`);
  if ('unit' in cue && typeof cue.unit !== 'string') errors.push('unit: must be a string');
  if ('phaseLabel' in cue && cue.phaseLabel !== null && !isString(cue.phaseLabel)) errors.push('phaseLabel: must be a string or null');
  if ('provisional' in cue && typeof cue.provisional !== 'boolean') errors.push('provisional: must be true or false');
  if (!STATUS_WORDS.includes(cue.status)) errors.push(`status: must be one of ${STATUS_WORDS.join(', ')}`);
  if ('notes' in cue) checkStrings(errors, 'notes', cue.notes);

  if (cue.status === CANT) {
    if (!isString(cue.reason)) errors.push("reason: a cue that can't be scored says why (a non-empty string)");
    if (cue.verdict !== null) errors.push("verdict: must be null for a cue that can't be scored");
    if (cue.value !== null) errors.push("value: must be null for a cue that can't be scored");
    if (!Array.isArray(cue.tiles) || cue.tiles.length) errors.push("tiles: must be [] for a cue that can't be scored");
    if (cue.referenceLine !== null) errors.push("referenceLine: must be null for a cue that can't be scored");
    if (!Array.isArray(cue.series) || cue.series.length) errors.push("series: must be [] for a cue that can't be scored");
    if (cue.phase !== null) errors.push("phase: must be null for a cue that can't be scored");
    if (cue.worst !== null) errors.push("worst: must be null for a cue that can't be scored");
  } else {
    if (cue.reason !== null) errors.push('reason: must be null for a scored cue');
    if (!isString(cue.verdict)) errors.push('verdict: a scored cue has its verdict (a non-empty string)');
    if (cue.value !== null && !isNumber(cue.value)) errors.push('value: must be a finite number or null');
    checkTiles(errors, cue.tiles);
    if (cue.referenceLine !== null && checkFields(errors, 'referenceLine', cue.referenceLine, ['value', 'label'])) {
      if (!isNumber(cue.referenceLine.value)) errors.push('referenceLine.value: must be a finite number');
      if (typeof cue.referenceLine.label !== 'string') errors.push('referenceLine.label: must be a string');
    }
    checkSeries(errors, cue.series);
    if (Array.isArray(cue.series) && !cue.series.length) errors.push('series: a scored cue has its series');
    if (cue.phase === null) errors.push('phase: a scored cue has its phase');
    else checkSeconds(errors, 'phase', cue.phase);
    if (cue.worst !== null) checkWorst(errors, cue.worst);
  }
  return path ? errors.map(e => `${path}.${e}`) : errors;
}

/**
 * @param {unknown} view
 * @returns {string[]} the errors, empty when valid
 */
export function validateResultView(view) {
  if (!isObject(view)) return ['result: must be an object'];
  const errors = [];
  checkFields(errors, '', view, ['lift', 'hasLiftWindow', 'liftWindow', 'liftWindowReason', 'cues', 'notes', 'smoothing']);
  checkLift(errors, 'lift', view.lift);
  const w = view.liftWindow;
  if ('hasLiftWindow' in view && typeof view.hasLiftWindow !== 'boolean') {
    errors.push('hasLiftWindow: must be true or false');
  } else if (view.hasLiftWindow === false) {
    // a lift without a window (a lateral raise): nothing to find, nothing went wrong
    if (w !== null) errors.push('liftWindow: must be null for a lift without a lift window (hasLiftWindow false)');
    if (view.liftWindowReason !== null) errors.push('liftWindowReason: must be null for a lift without a lift window (hasLiftWindow false)');
  } else if (w === null) {
    if (!isString(view.liftWindowReason)) errors.push('liftWindowReason: says why no lift was found (a non-empty string)');
  } else if (isObject(w) && w.t1 === null) {
    // the start found, no held finish
    if (checkFields(errors, 'liftWindow', w, ['t0'], ['t1']) && !isNumber(w.t0)) {
      errors.push('liftWindow.t0: must be a finite number (seconds)');
    }
    if (!isString(view.liftWindowReason)) errors.push('liftWindowReason: says why the lift has no end (a non-empty string)');
  } else {
    if (w !== undefined) checkSeconds(errors, 'liftWindow', w);
    if (view.liftWindowReason !== null) errors.push('liftWindowReason: must be null when both ends were found');
  }
  if (!Array.isArray(view.cues)) errors.push('cues: must be an array');
  else {
    const seen = new Set();
    view.cues.forEach((c, i) => {
      errors.push(...validateCueView(c, at('cues', i)));
      if (isObject(c) && seen.has(c.id)) errors.push(`${at('cues', i)}.id: ${c.id} is there twice`);
      if (isObject(c)) seen.add(c.id);
    });
  }
  if ('notes' in view) checkStrings(errors, 'notes', view.notes);
  if (view.smoothing !== undefined && checkFields(errors, 'smoothing', view.smoothing, ['sigmaMs', 'keepVelocity'])) {
    const { sigmaMs, keepVelocity } = view.smoothing;
    if (sigmaMs !== undefined && (!isNumber(sigmaMs) || sigmaMs < 0)) errors.push('smoothing.sigmaMs: must be ms (0 or more; 0 is the raw track)');
    if (keepVelocity !== undefined && typeof keepVelocity !== 'boolean') errors.push('smoothing.keepVelocity: must be true or false');
  }
  return errors;
}

/**
 * Two cues of the committed lateral raise (global/example/lateral-raise-cable-1,
 * the clip the mockups show), as the sources above give them: its top
 * height, scored, and its symmetry, which one rep can't score.
 * @type {CueView[]}
 */
export const CUE_VIEW_EXAMPLES = [
  {
    id: 'lateral-raise-top-height',
    title: 'Top of rep — raise to shoulder height',
    cue: 'At the top of each rep the arms lift to about shoulder height — not swung above it, not stopped short.',
    unit: '%',
    phaseLabel: null,
    provisional: true,
    status: 'good',
    verdict: 'right at shoulder height',
    value: 10.827463059067192,
    tiles: [
      { label: 'Worst rep', value: '+10.8%', sub: 'right at shoulder height', status: 'good' },
      { label: 'Mean top height', value: '+10.8%', sub: 'vs shoulder, all reps' },
      { label: 'Reps scored', value: '1', sub: 'top positions found' },
      { label: 'L/R disagreement', value: '±9.9%', sub: 'at the top' },
    ],
    referenceLine: { value: 0, label: 'shoulder height' },
    series: [{ t: 2.24, value: 10.827463059067192, lo: 5.877136366985983, hi: 15.777789751148399 }],
    phase: { t0: 1.16, t1: 2.96 },
    worst: { t: 2.24, idx: 56, frame: 56, value: 10.827463059067192, rule: 'summary-worst' },
    reason: null,
    notes: [],
  },
  {
    id: 'lateral-raise-symmetry',
    title: 'Rep-to-rep symmetry — consistent height across the set',
    cue: 'Every rep in the set reaches about the same height as the first — height dropping as the set goes on is fatigue, not a one-off.',
    unit: '%',
    phaseLabel: null,
    provisional: true,
    status: "can't score",
    verdict: null,
    value: null,
    tiles: [],
    referenceLine: null,
    series: [],
    phase: null,
    worst: null,
    reason: "Only one rep was found in this clip — there's nothing to compare rep-to-rep.",
    notes: [],
  },
];

/**
 * The same lift as a ResultView, with the two example cues only. A lateral
 * raise has no lift window (diagnostics.js's LIFT_WINDOW_SETS, s36): no window,
 * no reason. The cues are computeResults() on the committed track as it is, so
 * its smoothing is none: σ 0 (keepVelocity is then moot; true is the app's default).
 * @type {ResultView}
 */
export const RESULT_VIEW_EXAMPLE = {
  lift: 'lateral-raise',
  hasLiftWindow: false,
  liftWindow: null,
  liftWindowReason: null,
  cues: CUE_VIEW_EXAMPLES,
  notes: [],
  smoothing: { sigmaMs: 0, keepVelocity: true },
};
