// A1's timeline and cards as plain functions (package d17): what the view model (contract 4) says,
// laid out for the screen. No Preact, no DOM, so Node runs them as written (tests/app/result.test.js);
// screens/A1.mjs draws what they give. The cards come from view.cues, in diagnostics.js's order and
// whatever they are called, so a cue added there needs no change here. Times are seconds in the
// cut's timeline, as the view's are; the bar shows the marked range, so the model also gives each
// time counted from its start (`at`, `start`, `end`) and as a share of the bar (`fraction`, `from`, `to`).
import { timelineMarks } from '../draw/marks.mjs';
import { summariseResult } from './home-model.mjs';
import { windowLabel } from './player-model.mjs';
import { ruleLine, ruleSentence } from './rule-model.mjs';

// Per status word of contract 4: the word as tokens.css spells it (--status-*-word; the screen shows
// that word through base.css's `.status`, this one is for the model's callers and the tests), the
// CSS modifier of `.status--…`, and the icon drawn before the word.
const LOOKS = Object.freeze({
  good: { word: 'Good', cls: 'good', icon: 'good' },
  watch: { word: 'Watch', cls: 'watch', icon: 'watch' },
  'work on': { word: 'Work on', cls: 'work-on', icon: 'work' },
  "can't score": { word: "Can't score", cls: 'cant-score', icon: 'cant' },
});

/** A status word's look; throws for a word the contract has none for, so none is shown as another. */
export function lookOf(status) {
  if (!Object.prototype.hasOwnProperty.call(LOOKS, status)) throw new Error(`result-model: no look for the status ${JSON.stringify(status)}`);
  return LOOKS[status];
}

/** A cue's name on its card: its title before the dash ("Top of rep — raise to shoulder height" is "Top of rep"). */
export const shortTitle = title => title.split(' \u2014 ')[0];

const MINUS = '−';
const TIMES = '×';

/**
 * A card's value as the mockup writes it: "+10.8%", "−11.4%", "1.2°", "1.07×"; "—" when there is none.
 * A cue scored on its worst sample (rule 'summary-worst') is signed, as its tile is, unless it is a ratio (the
 * tempo's "1.07×"); the others are sizes.
 * @param {import('../contracts/cue-view.mjs').CueView} cue
 */
export function valueText(cue) {
  if (typeof cue.value !== 'number') return '—';
  const times = cue.unit === 'x';
  const body = Math.abs(cue.value).toFixed(times ? 2 : 1);
  const unit = times ? TIMES : cue.unit;
  const signed = !times && cue.worst && cue.worst.rule === 'summary-worst';
  const sign = !signed ? '' : cue.value < 0 && Number(body) !== 0 ? MINUS : '+';
  return `${sign}${body}${unit}`;
}

/** The note under the counts, while any cue's thresholds are provisional (nothing to say when none are). */
export function provisionalNote(view) {
  return view.cues.some(c => c.provisional) ? 'Thresholds are provisional: not yet checked on real lifts.' : null;
}

/**
 * The cards, one per cue of the view, in its order.
 * @param {import('../contracts/cue-view.mjs').ResultView} view
 * @param {(id: string) => Array|null} [zonesOf] diagnostics.js's zones(id) (s39): the bands the open card's rule
 *   sentence is built from; without it the card's `rule` is "Provisional" alone, as d17 had it
 * @returns {Array<{id: string, title: string, fullTitle: string, status: string, cls: string, word: string, icon: string,
 *   verdict: string|null, line: string|null, value: string, provisional: boolean, rule: string|null, cue: string,
 *   notes: string[], reason: string|null, scored: boolean}>}
 *   `line` is what follows the status word: the verdict, or the engine's reason when it can't score. `rule` is
 *   the open card's line: the sentence from the zones and "Provisional" while the thresholds are.
 */
export function cardsOf(view, zonesOf = null) {
  return view.cues.map(c => {
    const look = lookOf(c.status);
    return {
      id: c.id,
      title: shortTitle(c.title),
      fullTitle: c.title,
      status: c.status,
      cls: look.cls,
      word: look.word,
      icon: look.icon,
      verdict: c.verdict,
      line: c.reason === null ? c.verdict : c.reason,
      value: valueText(c),
      provisional: c.provisional,
      rule: ruleLine(zonesOf ? ruleSentence(c.unit, zonesOf(c.id)) : null, c.provisional),
      cue: c.cue,
      notes: [...c.notes],
      reason: c.reason,
      scored: c.reason === null,
    };
  });
}

/**
 * The card that starts open: the first cue to work on, else the first to watch, else none.
 * @param {ReturnType<typeof cardsOf>} cards
 * @returns {string|null} a cue's id
 */
export function defaultOpen(cards) {
  const first = status => cards.find(c => c.status === status);
  const c = first('work on') || first('watch');
  return c ? c.id : null;
}

/** The counts under the header: [{status, count, text}], the worst first (H's). */
export const summaryOf = view => summariseResult(view);

const clamp01 = x => Math.max(0, Math.min(1, x));

/**
 * The timeline's marks, from the view and the marked range.
 *  - `window`: the lift found, `{t0, t1, start, end, from, to}` (`t1`, `end` and `to` null for a start
 *    with no end; `from` and `to` are shares of the bar); null with no window to show. A lift that has
 *    none at all (`hasLiftWindow` false, the lateral raise) shows nothing and no reason.
 *  - `label`: the line under the bar for it (player-model's `windowLabel`), null without a window.
 *  - `reason`: why there is no window or no end (the view's `liftWindowReason`, the engine's words);
 *    null for a lift without a window and for both ends found.
 *  - `cues`: per cue, its `phase` and `worst` moment where it has them, in the three forms above, and
 *    whether its worst moment is marked on the bar (`marked`: only where a cue went wrong, as draw/'s).
 * @param {import('../contracts/cue-view.mjs').ResultView} view
 * @param {{t0: number, t1: number}} range
 */
export function timelineOf(view, range) {
  const length = range.t1 - range.t0;
  const share = t => (length > 0 ? clamp01((t - range.t0) / length) : 0);
  const marks = timelineMarks(view, range);
  const marked = new Set(marks.moments.map(m => m.cue));
  const w = view.hasLiftWindow === false ? null : view.liftWindow;
  const window = w ? {
    t0: w.t0,
    t1: w.t1 ?? null,
    start: w.t0 - range.t0,
    end: w.t1 == null ? null : w.t1 - range.t0,
    from: share(w.t0),
    to: w.t1 == null ? null : share(w.t1),
  } : null;
  return {
    window,
    label: window ? windowLabel(view, range) : null,
    reason: view.hasLiftWindow === false ? null : view.liftWindowReason,
    lift: marks.lift,
    cues: view.cues.map(c => ({
      id: c.id,
      status: c.status,
      marked: marked.has(c.id),
      phase: c.phase ? { t0: c.phase.t0, t1: c.phase.t1, start: c.phase.t0 - range.t0, end: c.phase.t1 - range.t0, from: share(c.phase.t0), to: share(c.phase.t1) } : null,
      worst: c.worst ? { t: c.worst.t, at: c.worst.t - range.t0, fraction: share(c.worst.t) } : null,
    })),
  };
}

/** How near a pointer must be to a worst-moment mark to land on it exactly, in CSS pixels. */
export const SNAP_PX = 22;

/**
 * Where a tap on the timeline seeks: the pointer's time, or the exact time of a worst moment
 * when the tap is on its mark.
 * @param {number} x the pointer's clientX
 * @param {{left: number, width: number}} rect the timeline's box
 * @param {{t0: number, t1: number}} range
 * @param {Array<{fraction: number, t: number}>} moments the marks' times (timelineOf(...).cues' `worst`)
 * @param {number} [snap] in pixels
 */
export function seekTime(x, rect, range, moments, snap = SNAP_PX) {
  if (!(rect.width > 0)) return range.t0;
  const f = clamp01((x - rect.left) / rect.width);
  let best = null;
  for (const m of moments) {
    const d = Math.abs(m.fraction - f) * rect.width;
    if (d <= snap && (best === null || d < best.d)) best = { d, t: m.t };
  }
  return best ? best.t : range.t0 + f * (range.t1 - range.t0);
}
