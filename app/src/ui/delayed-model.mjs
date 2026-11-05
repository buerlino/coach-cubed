// SPDX-License-Identifier: AGPL-3.0-or-later
// R3b's logic (package d29b, milestone B; D2: the delayed view as a setting beside the replay): what the delayed view
// shows and does, as plain functions with no Preact and no DOM, so Node runs them as written (tests/app/delayed.test.js).
// screens/R3b.mjs draws what `delayedView()` gives; the frames themselves are media/delayed.mjs's.
//
//   delayedView({ status, delayS });                  // the clock, '10 s behind', the delays with the chosen one pressed
//   await saveDelay(store, 15);                       // a delay choice: the settings' delayS
//   loadedDelay(picked, settings);                    // the delay once the settings are read: a choice made first stays
//   await keepLift({ session, flow, replayS, delayS }); // → M, { file, lift, from: 'delayed' }
//
// The recording never stops: nothing here calls the capture except `snapshot()`.
import { RANGES } from '../store/settings.mjs';
import { problemOf } from './problem-model.mjs';
import { canRetryCapture, clockText, holdsVideo } from './record-model.mjs';
import { seconds } from './settings-model.mjs';

/** The delays R3b offers (the mockup's), each inside RANGES.delayS. */
export const DELAY_CHOICES = Object.freeze([5, 10, 15, 20].filter(v => v >= RANGES.delayS.min && v <= RANGES.delayS.max));

const NOTHING = 'The recording holds no video yet. Try again in a moment.';

/**
 * What R3b draws: REC's clock, the delay ('10 s', '10 s behind'), the delay choices, "Camera stopped", Try again and
 * whether Keep works (c61).
 * @param {{status: {state: string, sinceS: number}, delayS: number}} input
 */
export function delayedView({ status, delayS }) {
  const stopped = status.state === 'interrupted';
  return {
    clock: clockText(status.sinceS),
    delay: seconds(delayS),
    behind: `${seconds(delayS)} behind`,
    delays: DELAY_CHOICES.map(v => ({ value: v, label: seconds(v), pressed: v === delayS })),
    interrupted: stopped ? 'Camera stopped' : null,
    canResume: stopped,
    // c61: a capture failed with the ring held tries again (R2's rule), and Keep works while the ring holds video
    canRetry: canRetryCapture(status),
    canKeep: holdsVideo(status),
  };
}

/**
 * A delay choice: saved as the settings' delayS (the store refuses a value outside RANGES.delayS).
 * @returns {Promise<object>} the settings saved
 */
export async function saveDelay(store, value) {
  const { min, max } = RANGES.delayS;
  if (!(Number.isInteger(value) && value >= min && value <= max)) throw new RangeError(`The delay must be a whole number of seconds from ${min} to ${max}.`);
  return store.saveSettings({ delayS: value });
}

/**
 * The delay R3b shows once its settings are read. A choice the user made before they came in (a tap while the store
 * was still reading) stays: the settings' older delayS must not overwrite it, or the label and the pressed button say
 * one delay while the frames run at the one picked (c26's page test, under load: "10 s behind" with 5 s picked).
 * @param {number|null} picked the delay already chosen on R3b, or null
 * @param {{delayS: number}} settings the settings read
 */
export function loadedDelay(picked, settings) {
  return picked ?? settings.delayS;
}

/** The kept lift's file name: delayed-hh-mm-ss.mp4, from the local time. */
export function delayedFileName(d = new Date()) {
  const two = n => String(n).padStart(2, '0');
  return `delayed-${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}.mp4`;
}

/**
 * "Keep this lift": the session's snapshot of `replayS + delayS` seconds (the replay's length before the frame on
 * screen, and everything since) as a File, then M with it and the session's lift. Never throws: a snapshot that
 * fails or holds nothing stays on R3b with a problem to draw.
 * @param {{session: {capture: object|null, lift: string|null}, flow: {go: Function}, replayS: number, delayS: number, now?: () => Date}} o
 * @returns {Promise<{ok: true}|{ok: false, problem: object}>}
 */
export async function keepLift({ session, flow, replayS, delayS, now = () => new Date() }) {
  try {
    const capture = session && session.capture;
    if (!capture) throw new Error('The camera is not recording.');
    const snap = await capture.snapshot(replayS + delayS);
    if (!snap || !snap.blob) throw new Error(NOTHING);
    const file = new File([snap.blob], delayedFileName(now()), { type: 'video/mp4' });
    flow.go('mark', { file, lift: session.lift, from: 'delayed' });
    return { ok: true };
  } catch (e) {
    return { ok: false, problem: problemOf(e) };
  }
}
