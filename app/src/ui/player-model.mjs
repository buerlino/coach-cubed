// SPDX-License-Identifier: AGPL-3.0-or-later
// A1's player as plain functions (package d16): the labels, the speeds, which frames are
// the marked range's, where a drag on the timeline points. No Preact, no DOM, so Node runs
// them as written (tests/app/player.test.js); screens/A1.mjs draws what they give and
// player.mjs plays. Times are seconds in the cut's timeline, as the track's are; the clock
// and the bar show the marked range, so they count from its start.
import { liftLabel, isProvisional, clock, dayKey, dayName } from './home-model.mjs';

/** The playback speeds in the order the button cycles them (settings.view.speed's values). */
export const SPEEDS = Object.freeze([1, 0.5, 0.25]);

/** ½×, the speed "Play the rep at ½×" (A2) asks for: the second of SPEEDS. */
export const HALF_SPEED = SPEEDS[1];

/** The speed button's label: 1×, ½×, ¼×. */
export const speedLabel = v => (v === 1 ? '1×' : v === 0.5 ? '½×' : v === 0.25 ? '¼×' : `${v}×`);

/** The next speed in the cycle; a value outside it starts again at 1×. */
export const nextSpeed = v => { const i = SPEEDS.indexOf(v); return SPEEDS[(i + 1) % SPEEDS.length]; };

/**
 * The header: the lift's name and "Today 14:27 · 3.0 s" (an earlier day by its name).
 * @param {import('../contracts/stored-lift.mjs').StoredLift} lift
 * @param {Date} [now]
 */
export function headerOf(lift, now = new Date()) {
  const created = new Date(lift.created);
  const day = dayKey(created) === dayKey(now) ? 'Today' : dayName(created);
  return { title: liftLabel(lift.lift), provisional: isProvisional(lift.lift), meta: `${day} ${clock(created)} · ${(lift.range.t1 - lift.range.t0).toFixed(1)} s` };
}

/** The clock: seconds into the marked range with two decimals, and the range's length. */
export const clockOf = (t, range) => ({
  now: Math.max(0, Math.min(range.t1 - range.t0, t - range.t0)).toFixed(2),
  total: (range.t1 - range.t0).toFixed(2),
});

/**
 * The lift window's label under the bar, in the range's seconds. A start with no end
 * says so; no window says nothing (the lift's reason belongs to the cards).
 * @param {import('../contracts/cue-view.mjs').ResultView} view
 */
export function windowLabel(view, range) {
  const w = view.liftWindow;
  if (!w) return null;
  const s = t => (t - range.t0).toFixed(2);
  return w.t1 === null || w.t1 === undefined ? `lift starts ${s(w.t0)} s, no end found` : `lift ${s(w.t0)}–${s(w.t1)} s`;
}

/** A worst-moment mark's tooltip: the cue's name (its title before the dash) and what it marks. */
export const momentTitle = cue => `${cue.title.split(' — ')[0]}: worst moment`;

const EPS = 1e-3;   // a time read back from a video is rounded; far under a frame

/**
 * Which frames of the source belong to the marked range: the first index at or after its
 * start to the last at or before its end (the frames the job posed).
 * @param {readonly number[]} frameTimes
 * @param {{t0: number, t1: number}} range
 * @returns {{first: number, last: number}}
 */
export function framesOfRange(frameTimes, range) {
  let first = frameTimes.findIndex(t => t >= range.t0 - EPS);
  if (first < 0) first = frameTimes.length - 1;
  let last = first;
  for (let i = first; i < frameTimes.length && frameTimes[i] <= range.t1 + EPS; i++) last = i;
  return { first, last };
}

/** Where a one-frame step from `index` lands: held at the range's first and last frame. */
export const stepTarget = (index, delta, { first, last }) => Math.max(first, Math.min(last, index + delta));

/**
 * The time a pointer on the timeline points at, clamped to the range.
 * @param {number} x the pointer's clientX
 * @param {{left: number, width: number}} rect the timeline's box
 */
export function timeAtPointer(x, rect, range) {
  if (!(rect.width > 0)) return range.t0;
  const f = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  return range.t0 + f * (range.t1 - range.t0);
}

/** The playhead's place on the bar, a fraction 0–1. */
export const fractionAt = (t, range) => (range.t1 > range.t0 ? Math.max(0, Math.min(1, (t - range.t0) / (range.t1 - range.t0))) : 0);

/**
 * What A2's "Play the rep at ½×" asks A1 for, read from the flow's params when A1 opens: the cue whose card
 * opens, the time to start from (held inside the marked range) and the speed to play at. Null for params
 * without a request (A1 opens as it always does): no cue of this result, no start time, a speed the speed
 * button doesn't have.
 * @param {{cue?: string, from?: number, speed?: number}} params
 * @param {import('../contracts/cue-view.mjs').ResultView} view
 * @param {{t0: number, t1: number}} range
 * @returns {{cue: string, t: number, speed: number}|null}
 */
export function playRequest(params, view, range) {
  if (!params || typeof params.from !== 'number' || !Number.isFinite(params.from) || !SPEEDS.includes(params.speed)) return null;
  if (typeof params.cue !== 'string' || !view.cues.some(c => c.id === params.cue)) return null;
  return { cue: params.cue, t: Math.max(range.t0, Math.min(range.t1, params.from)), speed: params.speed };
}
