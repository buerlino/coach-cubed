// The settings record: S1's defaults and A3's view options, one small JSON
// file in the store (settings.json). Plain module, no DOM, no storage: the
// store reads and writes it. Defaults are v1's (docs/decisions.md, D2): a
// 20 s replay, a 60 s buffer, an analysed lift keeps its video.
import { LIFTS, checkFields, isNumber, isObject } from '../contracts/common.mjs';
import { isLift } from '../contracts/lifts.mjs';

/**
 * @typedef {Object} ViewOptions A3's choices.
 * @property {boolean} skeleton draw the skeleton over the video
 * @property {boolean} cues draw the cue overlays
 * @property {boolean} unsure draw the joints the model is unsure of
 * @property {boolean} loop loop the lift's window
 * @property {number} speed playback speed: 0.25, 0.5 or 1
 * @property {number} smoothingSigmaMs the time smoothing's sigma in ms (0: none)
 *
 * @typedef {Object} Settings S1's choices, with the view options.
 * @property {'replay'|'delayed'} replayMode R3 (a replay on demand) or R3b (the delayed view)
 * @property {number} replayS the replay's length in seconds
 * @property {number} delayS the delayed view's delay in seconds (5 to 20)
 * @property {number} bufferS how much of the camera is kept in memory, in seconds
 * @property {'back'|'front'} camera
 * @property {string} quality the capture quality, e.g. '1080p30'
 * @property {import('../contracts/lifts.mjs').LiftId} defaultLift
 * @property {boolean} keepVideos an analysed lift keeps its cut video
 * @property {boolean} introSeen the first-run screen has been shown and left (d23); it shows once
 * @property {ViewOptions} view
 */

/** @type {Readonly<Settings>} */
export const DEFAULT_SETTINGS = Object.freeze({
  replayMode: 'replay',
  replayS: 20,
  delayS: 10,
  bufferS: 60,
  camera: 'back',
  quality: '1080p30',
  defaultLift: 'lateral-raise',
  keepVideos: true,
  introSeen: false,
  view: Object.freeze({ skeleton: true, cues: true, unsure: false, loop: true, speed: 1, smoothingSigmaMs: 50 }),
});

/** The largest smoothing σ in ms: A3's slider ends here, and a stored value above it reads as this (d51). */
export const SMOOTHING_MAX_MS = 300;

const bool = v => typeof v === 'boolean';
const intIn = (lo, hi) => v => Number.isInteger(v) && v >= lo && v <= hi;
const oneOf = list => v => list.includes(v);

/**
 * The whole-second ranges of the replay's length, the delayed view's delay and
 * the buffer. PROVISIONAL (nordmu, 2026-11-02): c30 measures the buffer's memory
 * on the phone, and the replay's and the buffer's limits may move with it. S1
 * offers values only inside these (app/src/ui/settings-model.mjs).
 */
export const RANGES = Object.freeze({
  replayS: Object.freeze({ min: 5, max: 60 }),
  delayS: Object.freeze({ min: 5, max: 20 }),
  bufferS: Object.freeze({ min: 10, max: 300 }),
});
const rangeCheck = ([k, unit]) => [intIn(RANGES[k].min, RANGES[k].max), `must be a whole number of ${unit} from ${RANGES[k].min} to ${RANGES[k].max}`];

// PROVISIONAL ranges, replayS 5-60 s, bufferS 10-300 s, delayS 5-20 s (RANGES above), and
// smoothingSigmaMs 0-300 ms (SMOOTHING_MAX_MS, A3's slider; nordmu capped it at 300 on 2026-11-02): they stay until c30 measures the buffer's memory on
// the phone (nordmu, 2026-11-02). Do not read them as settled limits.
/** Per field: the check, and what it says when it fails. */
const FIELDS = {
  replayMode: [oneOf(['replay', 'delayed']), "must be 'replay' or 'delayed'"],
  replayS: rangeCheck(['replayS', 'seconds']),
  delayS: rangeCheck(['delayS', 'seconds']),
  bufferS: rangeCheck(['bufferS', 'seconds']),
  camera: [oneOf(['back', 'front']), "must be 'back' or 'front'"],
  quality: [v => typeof v === 'string' && v.length > 0, 'must be a non-empty string'],
  // read at each check, not once: LIFTS is the registry's live list (lifts.mjs)
  defaultLift: [isLift, () => `must be one of ${LIFTS.join(', ')}`],
  keepVideos: [bool, 'must be true or false'],
  introSeen: [bool, 'must be true or false'],
};
const VIEW_FIELDS = {
  skeleton: [bool, 'must be true or false'],
  cues: [bool, 'must be true or false'],
  unsure: [bool, 'must be true or false'],
  loop: [bool, 'must be true or false'],
  speed: [oneOf([0.25, 0.5, 1]), 'must be 0.25, 0.5 or 1'],
  smoothingSigmaMs: [v => isNumber(v) && v >= 0 && v <= SMOOTHING_MAX_MS, `must be a number from 0 to ${SMOOTHING_MAX_MS}`],
};

/** A copy of the defaults: callers may change it. */
export const defaultSettings = () => ({ ...DEFAULT_SETTINGS, view: { ...DEFAULT_SETTINGS.view } });

function checkTable(errors, base, obj, table, { partial }) {
  for (const [k, v] of Object.entries(obj)) {
    const path = base ? `${base}.${k}` : k;
    if (k === 'view' && !base) continue;
    if (!(k in table)) errors.push(`${path}: unknown field`);
    else if (!table[k][0](v)) errors.push(`${path}: ${typeof table[k][1] === 'function' ? table[k][1]() : table[k][1]}`);
  }
  if (!partial) for (const k of Object.keys(table)) if (!(k in obj)) errors.push(`${base ? `${base}.` : ''}${k}: missing`);
}

/**
 * Checks a full settings record.
 * @param {unknown} s
 * @returns {string[]} the errors, empty when valid
 */
export function validateSettings(s) {
  const errors = [];
  if (!checkFields(errors, '', s, [...Object.keys(FIELDS), 'view'])) return errors;
  checkTable(errors, '', s, FIELDS, { partial: true });
  if (checkFields(errors, 'view', s.view, Object.keys(VIEW_FIELDS))) checkTable(errors, 'view', s.view, VIEW_FIELDS, { partial: true });
  return errors;
}

/**
 * Checks a patch: any of the fields, `view` any of its own.
 * @param {unknown} patch
 * @returns {string[]}
 */
export function validateSettingsPatch(patch) {
  const errors = [];
  if (!isObject(patch)) return ['settings: must be an object'];
  checkTable(errors, '', patch, FIELDS, { partial: true });
  if ('view' in patch) {
    if (!isObject(patch.view)) errors.push('view: must be an object');
    else checkTable(errors, 'view', patch.view, VIEW_FIELDS, { partial: true });
  }
  return errors;
}

/** The defaults with `patch` laid over them (a deep copy; `patch` is not checked). */
export function applySettings(base, patch) {
  const out = { ...base, ...patch, view: { ...base.view, ...(isObject(patch.view) ? patch.view : {}) } };
  return out;
}

/**
 * What a stored record means: every field that passes its check, the default
 * for every other, so a damaged or older record still reads.
 * @param {unknown} stored
 * @returns {Settings}
 */
export function readSettings(stored) {
  const out = defaultSettings();
  if (!isObject(stored)) return out;
  for (const [k, [ok]] of Object.entries(FIELDS)) if (k in stored && ok(stored[k])) out[k] = stored[k];
  if (isObject(stored.view)) {
    for (const [k, [ok]] of Object.entries(VIEW_FIELDS)) if (k in stored.view && ok(stored.view[k])) out.view[k] = stored.view[k];
    // a record kept under the old, higher cap: the value reads as the cap, not as damage (d51)
    const sigma = stored.view.smoothingSigmaMs;
    if (isNumber(sigma) && sigma > SMOOTHING_MAX_MS) out.view.smoothingSigmaMs = SMOOTHING_MAX_MS;
  }
  return out;
}
