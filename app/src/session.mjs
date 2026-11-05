// SPDX-License-Identifier: AGPL-3.0-or-later
// The gym session (package d28, milestone B): the app's one session, made once in main.mjs like the queue and
// the store, so it outlives the screens. R1 opens the camera for the preview and starts the session; R2 and H
// read it; End session stops and closes the capture. A plain module: no DOM and no camera of its own, the
// capture (media/capture.mjs, c27) is made by `makeCapture` from the settings. Nothing opens at boot: the capture
// is made, and the camera asked for, when R1 first asks (no permission prompt before the user wants one).
//
//   const session = createSession({ makeCapture: settings => createCapture(settings) });
//   await session.open(settings);          // R1: the capture, the camera for the preview; never throws (the capture says why)
//   await session.start(lift, { replayMode });   // R1's Start: the capture records; the lift, the start time and the live state are kept
//   session.active; session.lift; session.startedAt; session.liveState; session.elapsedS();
//   await session.end();                   // End session, or R1's back: stop, close, forget
import { isLift } from './contracts/lifts.mjs';
import { liveStateOf } from './flow/flow.mjs';
import { CaptureError } from './media/capture-error.mjs';

/**
 * @typedef {Object} SessionState
 * @property {boolean} active a session runs (R2)
 * @property {string|null} lift its lift
 * @property {number|null} startedAt when it started, in ms on `now`'s clock
 */

/**
 * d66: the gym session is behind a preview switch, off in 0.1.0. `enabled` is its live value (read at once, so H's top
 * never changes after it draws): off, `open()` makes no capture and asks for no camera, and `start()` throws. main.mjs
 * makes the app's session off and sets it from the settings before the first draw; without the option it is on.
 * @param {{makeCapture: (settings: object) => ReturnType<typeof import('./media/capture.mjs').createCapture>, now?: () => number, enabled?: boolean}} options
 */
export function createSession({ makeCapture, now = () => Date.now(), enabled: enabledAtStart = true }) {
  let enabled = enabledAtStart === true;
  let capture = null, settings = null, active = false, lift = null, startedAt = null, liveState = null;
  const listeners = new Set();
  const state = () => ({ active, lift, startedAt });
  const emit = () => { for (const fn of [...listeners]) fn(state()); };

  return {
    /** The capture while the camera is open (R1's preview, R2's recording), else null. */
    get capture() { return capture; },
    /** The settings the capture was made from (the buffer and the camera that run), else null. */
    get settings() { return settings; },
    get active() { return active; },
    /** d66: the gym session's preview switch; off in 0.1.0. */
    get enabled() { return enabled; },
    /** d66: turns the switch on or off. A running session is not touched: it can still be reached and ended. */
    setEnabled(on) {
      if (typeof on !== 'boolean') throw new TypeError('setEnabled takes true or false.');
      enabled = on;
    },
    get lift() { return lift; },
    get startedAt() { return startedAt; },
    /**
     * The running session's screen state, by the replay mode it started with (d29b): `live` (R2, the replay) or
     * `delayed` (R3b, the delayed view); null when none runs. Every way back to the session goes here.
     */
    get liveState() { return liveState; },

    /** Seconds on the capture's clock since Start (R2's and H's clock); 0 when nothing runs. */
    elapsedS() { return active && capture ? capture.status.sinceS : 0; },

    subscribe(fn) {
      listeners.add(fn);
      fn(state());
      return () => listeners.delete(fn);
    },

    /**
     * R1: the capture for these settings and its camera. The same capture while it is open; after a failure it
     * opens afresh ("Try again"). The capture's errors are not thrown: its status says them.
     * d66: with the switch off nothing is made and no camera is asked for: null.
     */
    async open(next) {
      if (!enabled && !capture) return null;
      if (!capture) { capture = makeCapture(next); settings = next; }
      const mine = capture;
      try { await mine.open(); } catch { /* mine.status.error says why */ }
      if (capture !== mine) mine.close();   // R1 was left while the camera was opening: let it go
      return mine;
    },

    /**
     * R1's Start: records, and keeps the lift, the start time and the live state.
     * @param {string} chosen a lift of the registry
     * @param {{replayMode?: 'replay'|'delayed'}} [mode] R1's replay mode at Start: it fixes the session's live state
     * The session runs only when its capture records (c61): a capture closed meanwhile (R1's back, End session) or one
     * that holds no ring is a CaptureError `stopped`, and nothing runs.
     * @throws {Error} a session runs already, no camera is open, or the lift is not the registry's; the
     *   capture's own error when it can't record (no encoder, `stopped`: the camera lost or closed during Start)
     */
    async start(chosen, { replayMode = 'replay' } = {}) {
      if (active) throw new Error('A session is already running.');
      if (!capture) throw new Error(enabled ? 'The camera is not open: open() first.' : 'The gym session is off (d66): its preview switch is in the settings.');
      if (!isLift(chosen)) throw new Error(`Not a lift of the registry: ${chosen}`);
      const mine = capture;
      await mine.start();
      // recording, or recording a moment ago and holding its ring (the camera lost while the wake lock was asked):
      // R2's "Camera stopped" and Try again carry on from there
      const s = mine.status;
      if (capture !== mine || !(s.state === 'recording' || s.ringHeld === true)) {
        throw new CaptureError('stopped', 'The camera stopped or was closed before recording started.');
      }
      active = true; lift = chosen; startedAt = now(); liveState = liveStateOf(replayMode);
      emit();
    },

    /** End session, or R1's back: the capture stops and its camera closes; nothing is kept. */
    async end() {
      const cap = capture;
      capture = null; settings = null;
      const was = active;
      active = false; lift = null; startedAt = null; liveState = null;
      if (cap) {
        try { if (was) await cap.stop(); } finally { cap.close(); }
      }
      if (was) emit();
    },
  };
}
