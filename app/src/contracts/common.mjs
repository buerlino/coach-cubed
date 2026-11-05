// SPDX-License-Identifier: AGPL-3.0-or-later
// What the contracts share: the lifts (lifts.mjs's registry), ids, store paths, time ranges, and the
// small checks every validator is built from. Plain module, no dependencies,
// no DOM: a worker can import it.
//
// Every validator returns a list of errors, empty when the value is valid.
// Each error starts with the path of the field it is about ("range.t1: …",
// "keypoints[3]: …"), so a test, a log line or a developer finds the field.
// Unknown fields are errors too: a contract changes in a package of its own,
// never by a field one side starts sending.

import { LIFTS, isLift } from './lifts.mjs';

/**
 * The lifts the app offers, their ids in order (DIAGNOSTIC_SETS keys in
 * src/diagnostics.js): lifts.mjs's registry, re-exported for the callers that
 * had it here. A live binding: a lift registered there is in it.
 */
export { LIFTS };

/** An id, a lift's or a job's: also a folder name in the store. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The store's folder for lifts: one folder per lift under it. */
export const LIFTS_DIR = 'lifts';

export const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isNumber = v => typeof v === 'number' && Number.isFinite(v);
export const isInteger = v => Number.isInteger(v);
export const isString = v => typeof v === 'string' && v.length > 0;

/** "a.b", "a[3]": the path of a field inside `base`. */
export const at = (base, key) => typeof key === 'number' ? `${base}[${key}]` : (base ? `${base}.${key}` : key);

/**
 * Checks that `value` is an object with the `required` fields and no fields
 * other than those and the `optional` ones. Returns false (after one error
 * naming `path`) when `value` isn't an object at all.
 */
export function checkFields(errors, path, value, required, optional = []) {
  if (!isObject(value)) {
    errors.push(`${path}: must be an object`);
    return false;
  }
  for (const k of required) if (!(k in value) || value[k] === undefined) errors.push(`${at(path, k)}: missing`);
  for (const k of Object.keys(value)) {
    if (!required.includes(k) && !optional.includes(k)) errors.push(`${at(path, k)}: unknown field`);
  }
  return true;
}

export function checkId(errors, path, v) {
  if (typeof v !== 'string' || !ID_RE.test(v)) errors.push(`${path}: must be an id (${ID_RE.source})`);
}

export function checkString(errors, path, v) {
  if (!isString(v)) errors.push(`${path}: must be a non-empty string`);
}

export function checkStringOrNull(errors, path, v) {
  if (v !== null && !isString(v)) errors.push(`${path}: must be a non-empty string or null`);
}

export function checkNumber(errors, path, v, { min = -Infinity, above = false } = {}) {
  if (!isNumber(v)) errors.push(`${path}: must be a finite number`);
  else if (above ? v <= min : v < min) errors.push(`${path}: must be ${above ? 'above' : 'at least'} ${min}`);
}

export function checkInteger(errors, path, v, min = 0) {
  if (!isInteger(v) || v < min) errors.push(`${path}: must be an integer, at least ${min}`);
}

export function checkLift(errors, path, v) {
  if (!isLift(v)) errors.push(`${path}: must be one of ${LIFTS.join(', ')}`);
}

export function checkStrings(errors, path, v) {
  if (!Array.isArray(v)) { errors.push(`${path}: must be an array of strings`); return; }
  v.forEach((s, i) => { if (typeof s !== 'string') errors.push(`${at(path, i)}: must be a string`); });
}

/**
 * A time range in seconds, `{ t0, t1 }`, 0 <= t0 < t1. In a stored lift and a
 * job it is in the cut's own timeline: 0 is the cut's first frame.
 */
export function checkRange(errors, path, v) {
  if (!checkFields(errors, path, v, ['t0', 't1'])) return;
  checkNumber(errors, at(path, 't0'), v.t0, { min: 0 });
  if (!isNumber(v.t1)) errors.push(`${at(path, 't1')}: must be a finite number`);
  else if (isNumber(v.t0) && v.t1 <= v.t0) errors.push(`${at(path, 't1')}: must be greater than ${at(path, 't0')}`);
}

/**
 * A path in the app's store (OPFS): relative, '/'-separated, no empty, '.' or
 * '..' segment, no scheme. Never a File, a Blob or a URL, which don't survive
 * a restart. `folder` (e.g. 'lifts/<id>/') and `suffix` (e.g. '.mp4') narrow it.
 */
export function checkStorePath(errors, path, v, { folder = null, suffix = null } = {}) {
  if (typeof v !== 'string') {
    const what = typeof Blob !== 'undefined' && v instanceof Blob ? (v.constructor && v.constructor.name) || 'Blob' : typeof v;
    errors.push(`${path}: must be a path in the store (a string), not ${v === null ? 'null' : what}`);
    return;
  }
  const segs = v.split('/');
  if (!v || /^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('/') || segs.some(s => !s || s === '.' || s === '..')) {
    errors.push(`${path}: must be a relative path in the store, not ${JSON.stringify(v)}`);
    return;
  }
  if (folder && !v.startsWith(folder)) errors.push(`${path}: must be inside ${folder}`);
  if (suffix && !v.endsWith(suffix)) errors.push(`${path}: must end in ${suffix}`);
}

/**
 * Checks a decoded frame by its shape, as a VideoFrame: displayWidth and
 * displayHeight above 0 (a closed VideoFrame reads 0), a timestamp, close().
 * Duck-typed, so tests and the example frame source pass fakes.
 */
export function checkFrame(errors, path, f) {
  if (!f || typeof f !== 'object') { errors.push(`${path}: must be a VideoFrame`); return; }
  if (typeof f.close !== 'function') errors.push(`${path}: must be a VideoFrame (no close())`);
  if (!(f.displayWidth > 0 && f.displayHeight > 0)) errors.push(`${path}: has no size (closed, or not a VideoFrame)`);
  if (!isNumber(f.timestamp)) errors.push(`${path}: has no timestamp`);
}
