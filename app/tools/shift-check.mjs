// M's shift check (package d54; nordmu at checkpoint A, point 9: "the button for analysis moves down a bit so the
// placement is now off"): the boxes of M's controls, read in the page after each press of the walk, must stay where
// they were in M1 before any mark, to half a pixel. page-test.mjs runs it on every walk; layout-check.mjs uses the
// same controls for M's no-scroll check. `readBoxes` is stringified into the page, so it is a plain function.

/** M's controls: [name, selector]. Every one of them has a fixed place: only the video's stage takes what is left. */
export const MARK_CONTROLS = Object.freeze([
  ['the header', '[data-screen="M"] .mark-header'],
  ['the strip', '[data-screen="M"] .strip'],
  ['‹', '[data-screen="M"] button[aria-label="One frame back"]'],
  ['the text line', '[data-screen="M"] .mark-text'],
  ['›', '[data-screen="M"] button[aria-label="One frame forward"]'],
  ['↶', '[data-screen="M"] button[data-mark="undo"]'],
  ['1 Start', '[data-screen="M"] button[data-mark="start"]'],
  ['2 End', '[data-screen="M"] button[data-mark="end"]'],
  ['3 Analyse', '[data-screen="M"] button[data-mark="analyse"]'],
]);

/** The walk's states, in order: the first is the reference the others are compared with. */
export const SHIFT_STEPS = Object.freeze(['M1 before any mark', 'after 1', 'after a refused 2', 'after 2', 'after ↶', 'after 2 again']);

export const SHIFT_TOLERANCE_PX = 0.5;

/** --break shift: the text row grows once the start is set (M2), as `.mark-hints` grew in M3 before d54. */
export const SHIFT_BREAK = `[data-screen="M"][data-step="end"] .mark-read { height: 96px; }`;

/**
 * Page side: each control's box in CSS pixels, or null when it is not on the screen.
 * @param {ReadonlyArray<readonly [string, string]>} controls
 * @returns {Record<string, {x: number, y: number, w: number, h: number}|null>}
 */
export function readBoxes(controls) {
  const out = {};
  for (const [name, selector] of controls) {
    const el = document.querySelector(selector);
    if (!el) { out[name] = null; continue; }
    const r = el.getBoundingClientRect();
    out[name] = { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  return out;
}

const round = v => Math.round(v * 10) / 10;

/**
 * The controls whose box differs from the reference by more than `tolerance` px, one line each, naming the control
 * and the step: "M moved after 2: 3 Analyse (y 460 → 466)".
 * @param {Record<string, {x: number, y: number, w: number, h: number}|null>} base the boxes in M1 before any mark
 * @param {Record<string, {x: number, y: number, w: number, h: number}|null>} now
 * @param {string} step one of SHIFT_STEPS
 * @returns {string[]}
 */
export function compareBoxes(base, now, step, tolerance = SHIFT_TOLERANCE_PX) {
  const problems = [];
  for (const [name] of MARK_CONTROLS) {
    const a = base[name], b = now[name];
    if (!a) { problems.push(`M moved ${step}: ${name} was not on the screen in M1`); continue; }
    if (!b) { problems.push(`M moved ${step}: ${name} is not on the screen`); continue; }
    const diffs = ['x', 'y', 'w', 'h'].filter(k => Math.abs(a[k] - b[k]) > tolerance).map(k => `${k} ${round(a[k])} → ${round(b[k])}`);
    if (diffs.length) problems.push(`M moved ${step}: ${name} (${diffs.join(', ')})`);
  }
  return problems;
}
