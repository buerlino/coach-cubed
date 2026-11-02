// The rule sentence of a cue ("Good from +5%, work on below −5%"), built from diagnostics.js's zones(id) (s39),
// the bands of the verdict in the cue's unit: the same source as A2's plot and "How it's scored", so
// A1's open card, A2 and S1's text cannot disagree about a threshold. Plain functions, no DOM.

const MINUS = '−';

/** A number as the cards write it: no trailing zeros ("15", "1.5"), the unit after it ('x' is "×"). */
function amount(v, unit, sign) {
  const body = String(+Math.abs(v).toFixed(2));
  const lead = !sign ? '' : v < 0 ? MINUS : '+';
  return `${lead}${body}${unit === 'x' ? '×' : unit}`;
}

/**
 * The sentence for a cue's zones, or null when there is nothing to say (no zones: the cue is scored on
 * something its plot doesn't show; no good band).
 *  - a good band with both ends mirrored about zero (the top height) reads "within N";
 *  - one with a lower end only "from N", an upper end only "up to N";
 *  - the work-on bands follow: "beyond N" for mirrored ones, "below N" and "beyond N" otherwise.
 * A scale with negative edges is signed (the elbow lead's), and its numbers keep their signs.
 * @param {string} unit the cue's unit ('%', '°', 'x')
 * @param {Array<{status: string, from: number|null, to: number|null}>|null} zones diagnostics.js's zones(id)
 * @returns {string|null}
 */
export function ruleSentence(unit, zones) {
  if (!Array.isArray(zones) || !zones.length) return null;
  const good = zones.find(z => z.status === 'good');
  if (!good) return null;
  const signed = zones.some(z => [z.from, z.to].some(e => typeof e === 'number' && e < 0));
  const n = (v, sign = signed) => amount(v, unit, sign);

  let goodText;
  if (good.from === null && good.to !== null) goodText = `up to ${n(good.to)}`;
  else if (good.from !== null && good.to === null) goodText = `from ${n(good.from)}`;
  else if (good.from !== null && good.to !== null) goodText = good.from === -good.to ? `within ${n(good.to, false)}` : `from ${n(good.from)} to ${n(good.to)}`;
  else return null;

  const work = zones.filter(z => z.status === 'work on');
  const lower = work.find(z => z.from === null && z.to !== null);
  const upper = work.find(z => z.to === null && z.from !== null);
  let workText = null;
  if (lower && upper) workText = lower.to === -upper.from ? `beyond ${n(upper.from, false)}` : `below ${n(lower.to)} or beyond ${n(upper.from)}`;
  else if (lower) workText = `below ${n(lower.to)}`;
  else if (upper) workText = `beyond ${n(upper.from)}`;

  return `Good ${goodText}${workText ? `, work on ${workText}` : ''}`;
}

/** The line on A1's open card: the rule, then "Provisional" while the thresholds are; null when neither. */
export function ruleLine(rule, provisional) {
  const parts = [rule, provisional ? 'Provisional' : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
