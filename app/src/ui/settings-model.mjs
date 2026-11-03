// S1's logic as plain functions (package d24): what the settings screen shows
// from the settings record, the lifts and the store's storage figures, the
// values it offers, and the delete-all step. No Preact, no DOM, so Node runs it
// as written (tests/app/settings.test.js); screens/S1.mjs draws what these give.
import { RANGES } from '../store/settings.mjs';
import { liftChoices } from './home-model.mjs';

/**
 * The settings S1 still shows disabled (d28 enabled the rest, which R1 and R2 use, and d29b the delay, which R3b
 * uses): the quality is information, its one value (1080p · 30 fps).
 */
export const NOT_YET = Object.freeze(['quality']);

export const MODES = Object.freeze([
  Object.freeze({ id: 'replay', label: 'Replay button' }),
  Object.freeze({ id: 'delayed', label: 'Delayed view' }),
]);

/** The lengths S1 offers, each inside c8's provisional ranges (RANGES); the stored value is always offered too. */
const OFFERED = { replayS: [10, 15, 20, 30, 45, 60], delayS: [5, 10, 15, 20], bufferS: [30, 60, 120, 180, 300] };
const CAMERAS = [{ value: 'back', label: 'Back' }, { value: 'front', label: 'Front' }];
const QUALITIES = ['1080p30'];

/** @param {number} n seconds */
export const seconds = n => `${n} s`;

/** '1080p30' is '1080p · 30 fps'; anything else is shown as stored. */
export function qualityLabel(q) {
  const m = /^(\d+p)(\d+)$/.exec(q);
  return m ? `${m[1]} · ${m[2]} fps` : q;
}

/** @param {number} n bytes → '412 MB' (powers of 1000, as the phone's own settings show them) */
export function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 'unknown';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let u = 0;
  let v = n;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  const text = u === 0 || v >= 100 ? Math.round(v) : (Math.round(v * 10) / 10);
  return `${text} ${units[u]}`;
}

export const liftsText = n => `${n} ${n === 1 ? 'lift' : 'lifts'}`;

/** The values a numeric field offers: the list, cut to its range, and the current one if it is not in the list. */
export function lengthOptions(field, current) {
  const { min, max } = RANGES[field];
  const values = new Set(OFFERED[field].filter(v => v >= min && v <= max));
  if (Number.isInteger(current) && current >= min && current <= max) values.add(current);
  return [...values].sort((a, b) => a - b).map(v => ({ value: v, label: seconds(v) }));
}

const row = (field, label, value, options, disabled) => ({ field, label, value, options, disabled });

/**
 * The recording settings: the mode switch, then the rows the mode shows. Each row says which
 * field it sets, the values it offers and whether it is disabled (NOT_YET).
 * @param {import('../store/settings.mjs').Settings} s
 */
export function recordingView(s) {
  const off = f => NOT_YET.includes(f);
  const rows = [
    s.replayMode === 'delayed'
      ? row('delayS', 'Delay', s.delayS, lengthOptions('delayS', s.delayS), off('delayS'))
      : row('replayS', 'Replay length', s.replayS, lengthOptions('replayS', s.replayS), off('replayS')),
    row('bufferS', 'Keep in memory', s.bufferS, lengthOptions('bufferS', s.bufferS).map(o => ({ ...o, label: `last ${o.label}` })), off('bufferS')),
    row('camera', 'Camera', s.camera, CAMERAS, off('camera')),
    row('quality', 'Quality', s.quality, [...new Set([s.quality, ...QUALITIES])].map(q => ({ value: q, label: qualityLabel(q) })), off('quality')),
    row('defaultLift', 'Default lift', s.defaultLift, liftChoices().map(c => ({ value: c.id, label: c.label })), off('defaultLift')),
  ];
  return {
    modes: MODES.map(m => ({ ...m, on: s.replayMode === m.id })),
    modesDisabled: off('replayMode'),
    rows: rows.map(r => ({ ...r, shown: (r.options.find(o => o.value === r.value) || { label: String(r.value) }).label })),
    note: 'Up to 30 fps; less in dim light.',
  };
}

/**
 * Storage as information: what the lifts hold, what the app uses, the room left and whether the
 * system promised to keep the files. A figure that is not known says so. Nothing here is an error,
 * least of all `persisted: false`, which is what the APK's WebView answers (c20).
 * @param {{count: number|null, liftsBytes: number|null, info: {usage: number|null, quota: number|null, free: number|null, persisted: boolean}|null}} s
 */
export function storageView({ count, liftsBytes, info }) {
  const known = count !== null && liftsBytes !== null;
  const persisted = info ? info.persisted : null;
  return {
    lifts: known ? `${liftsText(count)} · ${formatBytes(liftsBytes)}` : 'Not available yet',
    used: info && info.usage !== null ? formatBytes(info.usage) : 'unknown',
    free: info && info.free !== null ? formatBytes(info.free) : 'unknown',
    persisted: persisted === null ? 'unknown' : persisted ? 'Yes' : 'No',
    persistedNote: persisted === false
      ? 'If the phone runs very low on space, the system may remove them.'
      : null,
    canDelete: known && count > 0,
    count: count ?? 0,
  };
}

/** Reads what storageView needs; a part that fails is null, never thrown (S1 still draws). */
export async function loadStorage(store) {
  const attempt = async fn => { try { return await fn(); } catch { return null; } };
  const [lifts, liftsBytes, info] = await Promise.all([
    attempt(() => store.listLifts()),
    attempt(() => store.liftsBytes()),
    attempt(() => store.storageInfo()),
  ]);
  return { count: lifts ? lifts.length : null, liftsBytes, info };
}

const BUSY = ['queued', 'reading', 'pose', 'scoring'];

/** A lift being waited on or analysed must not be deleted under the queue. */
export const queueBusy = jobs => jobs.some(j => BUSY.includes(j.state));

/**
 * Deletes every lift, one at a time; stops at the first failure.
 * @returns {Promise<number>} how many were deleted
 */
export async function deleteAllLifts(store) {
  let n = 0;
  for (const l of await store.listLifts()) { await store.deleteLift(l.id); n++; }
  return n;
}

/** The privacy text. nordmu approved it on 2026-11-02, once it is true: the APK has no Android backup (c43). */
export const PRIVACY = Object.freeze({
  lead: 'Nothing leaves this phone.',
  body: "The app keeps your analysed lifts (each lift's cut video, its pose track and its results) and these settings in its own private storage on this phone, and nowhere else. It sends nothing: no account, no analytics, no uploads, and it works in airplane mode.",
});
