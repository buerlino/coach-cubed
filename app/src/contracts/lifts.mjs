// SPDX-License-Identifier: AGPL-3.0-or-later
// The lifts the app offers (s49): one entry per lift, the one place in app/ a
// lift is written out. Everything that names a lift reads it from here: the
// contracts' checks (common.mjs's LIFTS and checkLift), the import step's
// choices and the labels (ui/home-model.mjs), the settings' default lift, the
// store's id suffix, H's and Q1's figure (ui/components/icons.mjs). How to add
// a lift or a cue: docs/lifts.md.
//
// Each id is a key of DIAGNOSTIC_SETS in src/diagnostics.js, with its entry in
// LIFT_WINDOW_SETS there. This module doesn't import diagnostics.js (it stays a
// plain module with no dependencies and no DOM, so the pose worker loads it):
// tests/app/lifts.test.js holds the two files together.
//
// The shipped list is SHIPPED_LIFTS. registerLift() adds an entry at run time
// and returns its undo: the tests register a third, test-only lift with it; no
// lift is registered in the shipped app. LIFTS is a live binding, so a module
// that imports it sees a registered lift too, as long as it reads LIFTS when it
// checks a lift, not once when it loads.

/**
 * A lift's id: an entry's `id` below, and its set's key in src/diagnostics.js's
 * DIAGNOSTIC_SETS. The shipped ones: 'lateral-raise', 'snatch'.
 * @typedef {string} LiftId
 */

/**
 * A lift's figure, a stick figure in a 48 × 48 box drawn in lines, as
 * icons.mjs draws the mockup's row thumbnails (design/mockups/Main.dc.html).
 * @typedef {Object} LiftFigure
 * @property {{cx: number, cy: number}} head the head's centre: a circle of radius 4
 * @property {string} path the body, the limbs and the bar: an SVG path's `d`, commands and numbers only
 */

/**
 * One lift.
 * @typedef {Object} LiftEntry
 * @property {LiftId} id its set's key in diagnostics.js's DIAGNOSTIC_SETS
 * @property {string} label its name as the app shows it ("Lateral raise")
 * @property {string} abbr the store's suffix for its lifts' ids (20261101-174205-lr): 2 to 4 letters, one per lift
 * @property {boolean} provisional its thresholds as a whole aren't checked on real lifts yet (the
 *   snatch, while step 3.6 is open): the import step and A1 say so
 * @property {LiftFigure} [icon] its figure on H's rows and Q1; none: the lateral raise's
 * @property {string} [framing] one sentence on how to film it, which milestone B's R1 shows (d28);
 *   nothing in the app reads it yet
 */

/** The fields of an entry: these, and no others. */
export const LIFT_FIELDS = Object.freeze({ required: ['id', 'label', 'abbr', 'provisional'], optional: ['icon', 'framing'] });

const LIFT_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ABBR_RE = /^[a-z]{2,4}$/;
const PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string' && v.trim().length > 0;
const inBox = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 48;

/**
 * The errors of one entry, each starting with its field; empty when valid.
 * @param {unknown} e
 * @returns {string[]}
 */
export function validateLiftEntry(e) {
  if (!isObj(e)) return ['lift: must be an object'];
  const errors = [];
  for (const k of LIFT_FIELDS.required) if (!(k in e) || e[k] === undefined) errors.push(`${k}: missing`);
  for (const k of Object.keys(e)) {
    if (!LIFT_FIELDS.required.includes(k) && !LIFT_FIELDS.optional.includes(k)) errors.push(`${k}: unknown field`);
  }
  if ('id' in e && (typeof e.id !== 'string' || !LIFT_ID_RE.test(e.id))) errors.push(`id: must be a set's key, lower case words joined by '-' (${LIFT_ID_RE.source})`);
  if ('label' in e && !isText(e.label)) errors.push('label: must be a non-empty string');
  if ('abbr' in e && (typeof e.abbr !== 'string' || !ABBR_RE.test(e.abbr))) errors.push(`abbr: must be 2 to 4 lower case letters (${ABBR_RE.source})`);
  if ('provisional' in e && typeof e.provisional !== 'boolean') errors.push('provisional: must be true or false');
  if (e.icon !== undefined) {
    const i = e.icon;
    if (!isObj(i) || Object.keys(i).some(k => k !== 'head' && k !== 'path')) errors.push('icon: must be { head: { cx, cy }, path }');
    else {
      if (!isObj(i.head) || Object.keys(i.head).length !== 2 || !inBox(i.head.cx) || !inBox(i.head.cy)) errors.push('icon.head: must be { cx, cy }, each from 0 to 48');
      if (typeof i.path !== 'string' || !PATH_RE.test(i.path)) errors.push("icon.path: must be an SVG path's d, commands and numbers only");
    }
  }
  if (e.framing !== undefined && !isText(e.framing)) errors.push('framing: must be a sentence (a non-empty string)');
  return errors;
}

const frozen = e => Object.freeze({
  ...e,
  ...(e.icon ? { icon: Object.freeze({ head: Object.freeze({ ...e.icon.head }), path: e.icon.path }) } : {}),
});

function checked(list) {
  const errors = [];
  const ids = new Set();
  const abbrs = new Set();
  list.forEach((e, i) => {
    errors.push(...validateLiftEntry(e).map(m => `lifts[${i}].${m}`));
    if (!isObj(e)) return;
    if (ids.has(e.id)) errors.push(`lifts[${i}].id: ${e.id} is there twice`);
    if (abbrs.has(e.abbr)) errors.push(`lifts[${i}].abbr: ${e.abbr} is another lift's`);
    ids.add(e.id);
    abbrs.add(e.abbr);
  });
  if (errors.length) throw new TypeError(`the lift registry: ${errors.join('; ')}`);
  return Object.freeze(list.map(e => (Object.isFrozen(e) ? e : frozen(e))));
}

/**
 * The lifts the app ships, in the import step's order. The snatch is provisional
 * while step 3.6 is open; the framing tips are v1's.
 * @type {ReadonlyArray<LiftEntry>}
 */
export const SHIPPED_LIFTS = checked([
  {
    id: 'lateral-raise',
    label: 'Lateral raise',
    abbr: 'lr',
    provisional: false,
    framing: 'Face the camera from 3–4 m, phone at hip height, arms fully in frame.',
  },
  {
    id: 'snatch',
    label: 'Snatch',
    abbr: 'sn',
    provisional: true,
    icon: {
      head: { cx: 24, cy: 17 },
      path: 'M5 7h38M8 3v8M40 3v8M24 23l-8-16M24 23l8-16M24 21v13M24 34l-8 4 2 6M24 34l8 4-2 6',
    },
    framing: 'Film from the side, phone at hip height, bar and both feet in frame for the whole pull.',
  },
]);

let entries = SHIPPED_LIFTS;

/** The lifts' ids, in order (DIAGNOSTIC_SETS keys): a live binding, frozen. @type {ReadonlyArray<LiftId>} */
export let LIFTS = Object.freeze(entries.map(e => e.id));

/** Every lift the app offers now, in order: the shipped ones, then any registered. */
export const liftEntries = () => entries;

/** @param {unknown} id @returns {LiftEntry|null} */
export const liftOf = id => entries.find(e => e.id === id) ?? null;

/** @param {unknown} id */
export const isLift = id => liftOf(id) !== null;

/** A lift's label; an id the registry doesn't have is shown as it is. @param {LiftId} id */
export const liftLabel = id => liftOf(id)?.label ?? id;

/** A lift's store abbreviation, or null for an id the registry doesn't have. @param {LiftId} id */
export const liftAbbr = id => liftOf(id)?.abbr ?? null;

/** Whether a lift's thresholds as a whole are still provisional. @param {LiftId} id */
export const isProvisionalLift = id => liftOf(id)?.provisional === true;

function use(list) {
  entries = list;
  LIFTS = Object.freeze(list.map(e => e.id));
}

/**
 * Adds a lift after the others. No lift is registered in the shipped app: a
 * lift that ships is an entry in SHIPPED_LIFTS (docs/lifts.md). The tests use
 * this for a third, test-only lift.
 * @param {LiftEntry} entry its id a DIAGNOSTIC_SETS key, its abbr nobody else's
 * @returns {() => void} removes it again
 * @throws {TypeError} for an invalid entry, or an id or abbr already taken
 */
export function registerLift(entry) {
  const next = checked([...entries, entry]);
  const { id } = next[next.length - 1];
  use(next);
  return () => use(Object.freeze(entries.filter(e => e.id !== id)));
}
