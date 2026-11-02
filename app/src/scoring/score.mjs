// The scoring adapter (package s11): a track in, contract 4's ResultView out
// (contracts/cue-view.mjs). The job's scoring stage calls scoreLift(); the
// screens only ever see the view.
//
// What happens, in order:
//   1. src/track/'s smoothing, first (the old page's, pinned to it by
//      tests/track.test.js): the tracks the pose engine makes are raw, and
//      diagnostics.js was written for smoothed ones (its comments say so).
//      σ and the velocity option are the caller's, defaulting to the app's
//      (50 ms, velocity kept: the old page's, and S1's smoothingSigmaMs).
//      They are on the view as `smoothing` (contract 4, s35), so a stored
//      result.json says what its verdicts were scored with.
//   2. Diagnostics.setPage(lift), then Diagnostics.computeResults(). Its lift says whether the
//      lift has a lift window at all (hasLiftWindow, the set's; s36): a lateral raise has none,
//      and the view carries the flag with no window and no reason.
//   3. The view, through s4's headless API: describe() for each cue's words
//      and provisional flag, tiles(), referenceLine() and worstMoment() for
//      the rest. CUE_VIEW_SOURCES in the contract names every field's source.
//
// Every string on the view comes from diagnostics.js; the adapter writes none
// (the status words are the contract's, STATUS_WORDS). A cue that can't be
// scored carries computeResults()'s own error as its reason and nothing else.
//
// diagnostics.js is a classic script that sets window.Diagnostics: in the app
// index.html loads it before the module, in Node tests/loadDiagnostics.js
// does. So it is on the page's main thread only (a worker has no window); the
// adapter takes it from `opts.Diagnostics` or from window.Diagnostics. A plain
// module: no DOM, no Preact.
import { smoothKeypoints, DEFAULT_SIGMA_MS, DEFAULT_KEEP_VELOCITY } from '../track/smoothing.mjs';
import { pickPerson } from '../track/lift-window.mjs';
import { VERDICT_STATUS, verdictValue } from '../contracts/cue-view.mjs';
import { APP_PERSON_ID } from '../contracts/track.mjs';

export { DEFAULT_SIGMA_MS, DEFAULT_KEEP_VELOCITY };

const CANT = "can't score";

/**
 * The page's Diagnostics object (src/diagnostics.js, a classic script).
 * @returns {Object} window.Diagnostics
 * @throws {Error} when the script isn't loaded
 */
export function getDiagnostics() {
  const D = globalThis.window?.Diagnostics;
  if (!D) throw new Error('diagnostics.js is not loaded: index.html loads it as a classic script, which sets window.Diagnostics');
  return D;
}

/**
 * A cue's status word, from its computeResults() entry.
 * @param {Object} result results[id]: { error } or { verdict: { status, label }, … }
 * @returns {'good'|'watch'|'work on'|"can't score"}
 * @throws {Error} for a verdict level the contract has no word for, so a
 *   level added to diagnostics.js is never shown as another word
 */
export function cueStatus(result) {
  if (!result || typeof result !== 'object') throw new Error('cueStatus: no result');
  if (result.error) return CANT;
  const level = result.verdict && result.verdict.status;
  if (typeof level !== 'string' || !Object.prototype.hasOwnProperty.call(VERDICT_STATUS, level)) {
    throw new Error(`cueStatus: no status word for the verdict level ${JSON.stringify(level)}`);
  }
  return VERDICT_STATUS[level];
}

const finiteOrNull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function scoredCue(D, desc, res, samples) {
  const id = desc.id;
  const worst = D.worstMoment(id, res);
  const ref = D.referenceLine(id, res);
  return {
    ...head(desc),
    status: cueStatus(res),
    verdict: res.verdict.label,
    value: worst ? verdictValue(worst.rule, res.summary) : null,
    tiles: D.tiles(id, res).map(t => {
      const tile = { label: t.label, value: t.value };
      if (t.sub !== undefined) tile.sub = t.sub;
      if (t.status !== undefined) tile.status = t.status;
      return tile;
    }),
    referenceLine: ref ? { value: ref.value, label: ref.label } : null,
    series: res.series.map(s => {
      const point = { t: s.t, value: s.value };
      if (s.lo !== undefined) point.lo = finiteOrNull(s.lo);
      if (s.hi !== undefined) point.hi = finiteOrNull(s.hi);
      return point;
    }),
    phase: { t0: samples[res.phase.startIdx].t, t1: samples[res.phase.endIdx].t },
    worst: worst ? { t: worst.t, idx: worst.idx, frame: worst.frame, value: worst.value, rule: worst.rule } : null,
    reason: null,
    notes: [...(res.notes || [])],
  };
}

function unscoredCue(desc, res) {
  return {
    ...head(desc),
    status: cueStatus(res),
    verdict: null,
    value: null,
    tiles: [],
    referenceLine: null,
    series: [],
    phase: null,
    worst: null,
    reason: res.error,
    notes: [],
  };
}

// describe()'s fields, as the view has them.
function head(d) {
  return { id: d.id, title: d.title, cue: d.cue, unit: d.unit, phaseLabel: d.phaseLabel, provisional: d.provisional };
}

// The lift window, as seconds, or null with diagnostics.js's reason. A start with no end (the engine
// found the pull but no held finish) keeps its start, {t0, t1: null} (contract 4, s35): its reason is the
// engine's last note, which says why the lift has no end marker, and the other notes stay notes. A lift
// whose set has no window (a lateral raise, hasLiftWindow false, s36) has neither window nor reason.
function liftWindowOf(lift) {
  const notes = [...(lift.notes || [])];
  if (lift.hasLiftWindow === false) return { hasLiftWindow: false, liftWindow: null, liftWindowReason: null, notes };
  if (lift.error) return { hasLiftWindow: true, liftWindow: null, liftWindowReason: lift.error, notes };
  if (typeof lift.t0 === 'number' && typeof lift.t1 === 'number') {
    return { hasLiftWindow: true, liftWindow: { t0: lift.t0, t1: lift.t1 }, liftWindowReason: null, notes };
  }
  const reason = notes.pop();
  const liftWindow = typeof lift.t0 === 'number' ? { t0: lift.t0, t1: null } : null;
  return { hasLiftWindow: true, liftWindow, liftWindowReason: reason === undefined ? null : reason, notes };
}

/**
 * Scores a track as one lift.
 * @param {import('../contracts/track.mjs').Track} track raw keypoints, as the job or a fixture has them (left unchanged)
 * @param {'lateral-raise'|'snatch'} lift
 * @param {Object} [opts]
 * @param {Object} [opts.Diagnostics] diagnostics.js's object; default window.Diagnostics
 * @param {number} [opts.sigmaMs] the smoothing's σ in ms; 0 scores the raw track (default DEFAULT_SIGMA_MS)
 * @param {boolean} [opts.keepVelocity] the smoothing's velocity option (default DEFAULT_KEEP_VELOCITY)
 * @param {string} [opts.personId] the lifter; default the track's kept person, else the one with most frames
 * @returns {{view: import('../contracts/cue-view.mjs').ResultView,
 *   computed: Object, personId: string}} the view carries the smoothing it was
 *   scored with (view.smoothing); computed is computeResults()'s output (what drawCue() takes)
 * @throws {Error} for a lift diagnostics.js has no set for
 */
export function scoreLift(track, lift, opts = {}) {
  const D = opts.Diagnostics || getDiagnostics();
  const descriptors = D.describe(lift);   // throws for an unknown lift
  const sigmaMs = opts.sigmaMs ?? DEFAULT_SIGMA_MS;
  const keepVelocity = opts.keepVelocity ?? DEFAULT_KEEP_VELOCITY;

  const keypoints = smoothKeypoints(track.keypoints, track.meta, sigmaMs / 1000, keepVelocity);
  // Nobody in the track: score person 0 anyway, so diagnostics.js says "detected in only 0 sampled frame(s)".
  const personId = opts.personId ?? pickPerson(keypoints, track.meta?.tracks?.kept) ?? APP_PERSON_ID;

  D.setPage(lift);
  const computed = D.computeResults(keypoints, track.meta, personId);

  const cues = descriptors.map(desc => {
    const res = computed.results[desc.id];
    if (!res) throw new Error(`computeResults() has no result for the cue ${desc.id}`);
    return res.error ? unscoredCue(desc, res) : scoredCue(D, desc, res, computed.samples);
  });
  const { hasLiftWindow, liftWindow, liftWindowReason, notes } = liftWindowOf(computed.lift);
  return {
    view: { lift, hasLiftWindow, liftWindow, liftWindowReason, cues, notes, smoothing: { sigmaMs, keepVelocity } },
    computed,
    personId,
  };
}
