// The rule sentence of a cue, built from diagnostics.js's headless API: with rule(id) (s45) the unit's noun, the
// watch band and, for A2 and S1b, the API's own sentence on what the verdict reads, before it; without it the
// shorter sentence from zones(id) (s39), "Good from +5%, work on below −5%". The bands are the API's, the same
// source as A2's plot, so A1's open card, A2 and S1's text cannot disagree about a threshold. The words of the
// unit's noun and of that sentence are never typed here. Plain functions, no DOM.

const MINUS = '−';

/** A number as the cards write it: no trailing zeros ("15", "1.5"), the unit after it ('x' is "×"). */
function amount(v, unit, sign) {
  const body = String(+Math.abs(v).toFixed(2));
  const lead = !sign ? '' : v < 0 ? MINUS : '+';
  return `${lead}${body}${unit === 'x' ? '×' : unit}`;
}

/** A rule(id) answer the sentence can use: its noun and its bands; anything else is no answer. */
const usable = rule => !!(rule && typeof rule.noun === 'string' && rule.noun && Array.isArray(rule.bands) && rule.bands.length);

/**
 * The sentence for a cue's bands, or null when there is nothing to say (no bands; no good band).
 *  - a good band with both ends mirrored about zero (the top height) reads "within N";
 *  - one with a lower end only "from N", an upper end only "up to N";
 *  - with rule(id), the good band's first number carries the unit's noun ("from +5% of …") and the watch band
 *    follows: "between A and B", A the edge it shares with the good band; "between A and B" unsigned for a pair
 *    mirrored about zero;
 *  - the work-on bands follow: "beyond N" for mirrored ones, "below N" and "beyond N" otherwise.
 * A scale with negative edges is signed (the elbow lead's), and its numbers keep their signs. Without rule(id)'s
 * answer (null, or an API without it) the bands are zones(id)'s, with no noun and no watch band: the shorter
 * sentence, and nothing for a cue whose zones are null.
 * @param {string} unit the cue's unit ('%', '°', 'x')
 * @param {Array<{status: string, from: number|null, to: number|null}>|null} zones diagnostics.js's zones(id)
 * @param {{noun: string, basis: string, bands: Array}|null} [rule] diagnostics.js's rule(id)
 * @returns {string|null}
 */
export function ruleSentence(unit, zones, rule = null) {
  const full = usable(rule);
  const bands = full ? rule.bands : zones;
  if (!Array.isArray(bands) || !bands.length) return null;
  const good = bands.find(z => z.status === 'good');
  if (!good) return null;
  const signed = bands.some(z => [z.from, z.to].some(e => typeof e === 'number' && e < 0));
  const n = (v, sign = signed) => amount(v, unit, sign);
  // the good band's first number, with the noun after it when the API gives one
  const first = (v, sign = signed) => (full ? `${amount(v, '', sign)}${rule.noun}` : n(v, sign));

  let goodText;
  if (good.from === null && good.to !== null) goodText = `up to ${first(good.to)}`;
  else if (good.from !== null && good.to === null) goodText = `from ${first(good.from)}`;
  else if (good.from !== null && good.to !== null) goodText = good.from === -good.to ? `within ${first(good.to, false)}` : `from ${first(good.from)} to ${n(good.to)}`;
  else return null;

  const watchText = full ? watchOf(bands, good, n) : null;

  const work = bands.filter(z => z.status === 'work on');
  const lower = work.find(z => z.from === null && z.to !== null);
  const upper = work.find(z => z.to === null && z.from !== null);
  let workText = null;
  if (lower && upper) workText = lower.to === -upper.from ? `beyond ${n(upper.from, false)}` : `below ${n(lower.to)} or beyond ${n(upper.from)}`;
  else if (lower) workText = `below ${n(lower.to)}`;
  else if (upper) workText = `beyond ${n(upper.from)}`;

  return `Good ${goodText}${watchText ? `, watch ${watchText}` : ''}${workText ? `, work on ${workText}` : ''}`;
}

// The watch bands' text: one band between its two edges, the one it shares with the good band first; a pair
// mirrored about zero once, unsigned; an open-ended one "below" or "beyond" its edge.
function watchOf(bands, good, n) {
  const watch = bands.filter(z => z.status === 'watch');
  if (!watch.length) return null;
  const [a, b] = watch;
  if (watch.length === 2 && a.from !== null && a.to !== null && b.from !== null && b.to !== null && a.from === -b.to && a.to === -b.from) {
    return `between ${n(b.from, false)} and ${n(b.to, false)}`;
  }
  return watch.map(z => {
    if (z.from === null) return `below ${n(z.to)}`;
    if (z.to === null) return `beyond ${n(z.from)}`;
    return z.to === good.from ? `between ${n(z.to)} and ${n(z.from)}` : `between ${n(z.from)} and ${n(z.to)}`;
  }).join(' or ');
}

/**
 * A2's and S1b's paragraph: rule(id)'s own sentence on what the verdict reads, then the bands' sentence, closed
 * with a full stop; the shorter sentence alone, or null, without rule(id).
 * @param {string} unit
 * @param {Array|null} zones diagnostics.js's zones(id)
 * @param {{noun: string, basis: string, bands: Array}|null} [rule] diagnostics.js's rule(id)
 * @returns {string|null}
 */
export function ruleParagraph(unit, zones, rule = null) {
  const sentence = ruleSentence(unit, zones, rule);
  if (!usable(rule) || typeof rule.basis !== 'string' || !rule.basis) return sentence;
  return sentence ? `${rule.basis} ${sentence}.` : rule.basis;
}

/** rule(id) from diagnostics.js's object, or null for an API without it (before s45). */
export const ruleOf = (Diagnostics, id) => (Diagnostics && typeof Diagnostics.rule === 'function' ? Diagnostics.rule(id) : null);

/** The line on A1's open card: the rule, then "Provisional" while the thresholds are; null when neither. */
export function ruleLine(rule, provisional) {
  const parts = [rule, provisional ? 'Provisional' : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
