// SPDX-License-Identifier: AGPL-3.0-or-later
// R1's and R2's logic as plain functions (package d28, milestone B): what the camera setup and the recording
// screen show from the settings, the capture's status and the queue's jobs, and H's gym card. No Preact and no
// DOM, so Node runs it as written (tests/app/record.test.js); screens/R1.mjs and screens/R2.mjs draw what these
// give. The lifts, their labels and framing tips are the registry's (contracts/lifts.mjs).
import { liftEntries, liftLabel } from '../contracts/lifts.mjs';
import { SESSION_STATES } from '../flow/flow.mjs';
import { DEFAULT_SETTINGS } from '../store/settings.mjs';
import { liftTiles } from './lift-model.mjs';
import { problemOf } from './problem-model.mjs';
import { MODES, qualityLabel } from './settings-model.mjs';

/** The line on the framing guide; the tip of a lift without a framing sentence of its own. */
export const GUIDE_LINE = 'Whole body inside the frame';

/** @param {number} n seconds → 'm:ss', 'h:mm:ss' from an hour on */
export function clockText(n) {
  const s = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = x => String(x).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

/** The camera's real rate, rounded; '– fps' until the frames give one. @param {number|null} fps */
export const fpsText = fps => (typeof fps === 'number' && Number.isFinite(fps) ? `${Math.round(fps)} fps` : '– fps');

/** The buffer and the quality as the settings have them, the defaults while they load. */
const withDefaults = settings => ({ ...DEFAULT_SETTINGS, ...(settings || {}) });

/**
 * R1: the lifts, the tip of the chosen one, the replay mode (d29b), the line under the preview and whether Start works.
 * @param {{settings: object|null|undefined, status: {state: string}, chosen?: string|null}} input
 *   `chosen` the lift tapped on R1, null until one is: the default
 */
export function setupView({ settings, status, chosen = null }) {
  const s = withDefaults(settings);
  const tiles = liftTiles(settings);
  const def = tiles.find(t => t.isDefault).id;
  const lift = tiles.some(t => t.id === chosen) ? chosen : def;
  const entry = liftEntries().find(e => e.id === lift);
  return {
    lifts: tiles.map(t => ({ ...t, pressed: t.id === lift })),
    lift,
    mode: s.replayMode === 'delayed' ? 'delayed' : 'replay',
    modes: MODES.map(m => ({ id: m.id, label: m.label, pressed: m.id === (s.replayMode === 'delayed' ? 'delayed' : 'replay') })),
    tip: entry && entry.framing ? entry.framing : null,
    guide: GUIDE_LINE,
    line: `${qualityLabel(s.quality)} · last ${s.bufferS} s`,
    canStart: status.state === 'preview',
  };
}

const ANALYSING = ['reading', 'pose', 'scoring'];

/** The queue as one line: '1 analysing · 1 waiting'; null when nothing is in it. @param {Array<{state: string}>} jobs */
export function queueLine(jobs) {
  const analysing = jobs.filter(j => ANALYSING.includes(j.state)).length;
  const waiting = jobs.filter(j => j.state === 'queued').length;
  const parts = [...(analysing ? [`${analysing} analysing`] : []), ...(waiting ? [`${waiting} waiting`] : [])];
  return parts.length ? parts.join(' · ') : null;
}

/** The wake lock's line; '' while it has not been asked. */
export const wakeText = wake => (wake === 'held' ? 'Screen stays on' : wake === 'refused' ? 'Screen may turn off' : '');

/**
 * c61: a capture that failed while the session's ring is held (the camera busy at a resume, the encoder failed) can try
 * again and record on into the same ring: R2's and R3b's Try again.
 */
export const canRetryCapture = status => status.state === 'failed' && status.ringHeld === true;
/** c61: the ring holds video, so a snapshot works (R2's Replay, R3b's Keep), also while the capture is failed. */
export const holdsVideo = status => status.state !== 'failed' || status.bytes > 0;

/**
 * R2: the clock, the real rate, the queue, the lift and the buffer, the wake lock, the interruption, Try again (c61),
 * whether Replay works and the Replay button's length.
 * @param {{status: object, jobs: Array<{state: string}>, lift: string, settings: object|null|undefined}} input
 */
export function liveView({ status, jobs, lift, settings }) {
  const s = withDefaults(settings);
  const stopped = status.state === 'interrupted';
  return {
    clock: clockText(status.sinceS),
    fps: fpsText(status.fps),
    queue: queueLine(jobs),
    liftLine: `${liftLabel(lift)} · last ${s.bufferS} s`,
    wake: wakeText(status.wakeLock),
    interrupted: stopped ? 'Camera stopped' : null,
    canResume: stopped,
    canRetry: canRetryCapture(status),
    canReplay: holdsVideo(status),
    replay: `${s.replayS} s`,
  };
}

/**
 * "Camera stopped" and Try again on R1, R2 and R3b (c61): the capture's resume(), its rejection caught. A resume that
 * fails leaves the capture `failed` with its error, which the screen draws as the problem panel (captureProblem); a
 * tap with no capture (the session ended meanwhile) does nothing. Never throws.
 * @param {{capture: {resume: () => Promise<void>}|null}} session
 */
export async function resumeCapture(session) {
  const cap = session && session.capture;
  if (!cap) return;
  try { await cap.resume(); } catch { /* the capture's status says why: the problem panel */ }
}

/** A failed capture as a problem the screens draw (problem-model.mjs); null while it works. */
export const captureProblem = status => (status.state === 'failed' ? problemOf(status.error) : null);

/**
 * H's gym card: it opens R1; while a session runs it reads "Back to the session" with the clock and goes to the
 * session's live state (`live` or `delayed`, d29b).
 * @param {{active: boolean, elapsedS: number, liveState?: string|null}|null|undefined} session
 */
export function gymCard(session) {
  if (session && session.active) return { title: 'Back to the session', clock: clockText(session.elapsedS), to: SESSION_STATES.includes(session.liveState) ? session.liveState : SESSION_STATES[0] };
  return { title: 'Gym session', clock: null, to: 'setup' };
}

/**
 * R1's replay-mode choice (d29b): saved as the settings' replayMode, which Start reads.
 * @returns {Promise<object>} the settings saved
 */
export async function saveMode(store, mode) {
  if (!MODES.some(m => m.id === mode)) throw new RangeError(`The replay mode must be ${MODES.map(m => `'${m.id}'`).join(' or ')}.`);
  return store.saveSettings({ replayMode: mode });
}

/**
 * R1's Start: the session starts in the mode chosen, and the flow goes to its live state: R2 for the replay, R3b for
 * the delayed view (d29b). The session's refusal is thrown, the flow left alone.
 * @param {{session: {start: Function, liveState: string|null}, flow: {go: Function}, lift: string, mode: 'replay'|'delayed'}} o
 */
export async function startSession({ session, flow, lift, mode }) {
  await session.start(lift, { replayMode: mode });
  flow.go(session.liveState);
}

/**
 * Home after End session (R2) or R1's back. A second tap while the capture is still stopping (or a click that lands after the
 * first one finished) finds the flow at home already, and home does not lead to home: the `illegal transition home -> home`
 * was an uncaught exception in the page. So the flow goes home only when it is not there.
 * @param {{state: string, go: (to: string) => void}} flow
 */
export function goHome(flow) {
  if (flow.state !== 'home') flow.go('home');
}
