// SPDX-License-Identifier: AGPL-3.0-or-later
// The capture's status for a screen (package d28): R1 and R2 follow the session's capture. The capture appears
// when R1 opens the camera (after the settings load) and changes state at any time, so the screen reads it
// four times a second and redraws only when what it shows has changed. Also puts a MediaStream on a <video>.
import { useEffect, useState } from 'preact/hooks';

const IDLE = Object.freeze({ state: 'closed', fps: null, width: null, height: null, sinceS: 0, heldS: 0, bytes: 0, wakeLock: 'off', error: null, ringHeld: false });

const read = session => {
  const cap = session.capture;
  return cap ? { status: cap.status, stream: cap.stream } : { status: IDLE, stream: null };
};
// what the screens draw: the state, the rate and the clock to the second, the wake lock, the error, the stream, and
// (c61) whether the ring is held and holds video (Try again, Replay, Keep)
const same = (a, b) => a.stream === b.stream && a.status.error === b.status.error && a.status.state === b.status.state
  && a.status.ringHeld === b.status.ringHeld && (a.status.bytes > 0) === (b.status.bytes > 0)
  && a.status.wakeLock === b.status.wakeLock && Math.round(a.status.fps) === Math.round(b.status.fps)
  && Math.floor(a.status.sinceS) === Math.floor(b.status.sinceS);

/** @param {ReturnType<import('../session.mjs').createSession>} session @returns {{status: object, stream: MediaStream|null}} */
export function useCapture(session) {
  const [view, setView] = useState(() => read(session));
  useEffect(() => {
    const update = () => setView(prev => { const next = read(session); return same(prev, next) ? prev : next; });
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [session]);
  return view;
}

/** Shows `stream` on the <video> in `ref` (muted, inline, playing). */
export function useStream(ref, stream) {
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.muted = true;
    video.srcObject = stream || null;
    if (stream && typeof video.play === 'function') Promise.resolve(video.play()).catch(() => { /* autoplay says so */ });
  }, [ref, stream]);
}
