// SPDX-License-Identifier: AGPL-3.0-or-later
// R3's logic (package d29, milestone B; D2: the replay is the last 20 s): what the replay screen shows and
// does, as a plain module with no Preact and no DOM, so Node runs it as written (tests/app/replay.test.js).
// screens/R3.mjs draws what `view()` gives and forwards the player's changes and the bar's drag.
//
//   const replay = createReplay({ session, flow, replayS });   // replayS: the settings' replay length
//   await replay.load();                // the session's snapshot(replayS): phase 'ready', or 'problem'
//   replay.attach(player, range);       // createPlayer's player; plays from the start at once
//   replay.report(playerState);         // the player's onChange
//   replay.tick(dtS);                   // the countdown, every ~100 ms while R3 is up
//   replay.keep();                      // → M, { file, lift, from: 'live' }
//   replay.back(); replay.close();      // → R2; both close the player and drop the snapshot
//
// The recording never stops: nothing here calls the capture except `snapshot()`.
import { problemOf } from './problem-model.mjs';
import { HALF_SPEED, speedLabel } from './player-model.mjs';

/** Seconds on "Not this one: back to live in 0:25" (the mockup's, provisional: nordmu has not settled it). */
export const COUNTDOWN_S = 25;

/** Seconds → "m:ss", the seconds floored (a position of 7.9 s is 0:07). */
export const clockMS = s => {
  const n = Math.max(0, Math.floor(Number.isFinite(s) ? s : 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};

/** "12 s ago": the snapshot's end minus the playhead, rounded; never negative. */
export const agoText = (duration, position) => `${Math.max(0, Math.round(duration - position))} s ago`;

/** The speed ½× switches to: 1× ↔ ½×. */
export const replaySpeed = v => (v === 1 ? HALF_SPEED : 1);

/** The file's name: replay-hh-mm-ss.mp4, from the local time. */
export function replayFileName(d = new Date()) {
  const two = n => String(n).padStart(2, '0');
  return `replay-${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}.mp4`;
}

const NOTHING = 'The recording holds no video yet. Go back to live and try again in a moment.';

/**
 * @param {Object} o
 * @param {{capture: {snapshot: (seconds: number) => Promise<{blob: Blob, duration: number, start: number}|null>}|null, lift: string|null}} o.session
 * @param {{go: Function}} o.flow
 * @param {number} o.replayS the settings' replay length
 * @param {number} [o.countdownS]
 * @param {() => Date} [o.now] the clock the file's name is read from
 */
export function createReplay({ session, flow, replayS, countdownS = COUNTDOWN_S, now = () => new Date() }) {
  let phase = 'loading';       // loading | ready | problem | closed
  let problem = null;
  let snapshot = null;
  let player = null;
  let range = null;            // the snapshot's own timeline: { t0, t1 }
  let t = 0;                   // the playhead, seconds in that timeline
  let playing = false;
  let dragging = false;
  let resume = false;          // the drag began while playing
  let speed = 1;
  let left = countdownS;
  const listeners = new Set();
  const emit = () => { for (const fn of [...listeners]) fn(); };

  const duration = () => (snapshot ? snapshot.duration : replayS);
  const position = () => Math.max(0, Math.min(duration(), range ? t - range.t0 : 0));

  function close() {
    if (phase === 'closed') return;
    phase = 'closed';
    snapshot = null;
    const p = player;
    player = null;
    if (p) p.close();
    emit();
  }

  const api = {
    /** The snapshot's Blob while R3 holds it, else null. */
    get snapshot() { return snapshot ? snapshot.blob : null; },

    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },

    /** What R3 draws. */
    view() {
      const total = Math.min(replayS, Math.max(1, Math.round(duration())));
      return {
        phase, problem,
        ago: agoText(duration(), position()),
        position: clockMS(position()),
        total: clockMS(snapshot ? total : replayS),
        totalS: snapshot ? total : replayS,
        positionS: Math.round(position()),
        fraction: duration() > 0 ? Math.min(1, position() / duration()) : 0,
        playing, speed, speedLabel: speedLabel(speed),
        countdown: clockMS(Math.ceil(left)),
        left,
        dragging,
      };
    },

    /** The session's snapshot of the last `replayS` seconds. Never throws: a failure is the 'problem' phase. */
    async load() {
      const capture = session && session.capture;
      try {
        if (!capture) throw new Error('The camera is not recording.');
        const snap = await capture.snapshot(replayS);
        if (phase === 'closed') return;
        if (!snap || !snap.blob) throw new Error(NOTHING);
        snapshot = snap;
        phase = 'ready';
      } catch (e) {
        if (phase === 'closed') return;
        problem = problemOf(e);
        phase = 'problem';
      }
      emit();
    },

    /** The player on the snapshot (createPlayer's): it plays from its start at once. @param {{t0: number, t1: number}} r the snapshot's frame range */
    attach(p, r) {
      if (phase !== 'ready') { p.close(); return; }
      player = p;
      range = r;
      t = r.t0;
      left = countdownS;
      Promise.resolve(p.play()).catch(() => { /* the player reports a refused play through its own onError */ });
      emit();
    },

    /** The player's state, from its onChange. */
    report(ps) {
      if (phase === 'closed') return;
      t = ps.t;
      playing = !!ps.playing;
      emit();
    },

    togglePlay() { return player ? player.toggle() : Promise.resolve(); },

    toggleSpeed() {
      speed = replaySpeed(speed);
      if (player) player.setSpeed(speed);
      emit();
    },

    /** A drag on the bar: the pointer goes down at `at`, moves, comes up. A drag that interrupted playing lets it go on. */
    scrubStart(at) {
      if (!player) return;
      dragging = true;
      resume = playing;
      player.seek(at);
      emit();
    },
    scrubMove(at) { if (player && dragging) player.seek(at); },
    scrubEnd() {
      if (!dragging) return;
      dragging = false;
      if (resume && player) Promise.resolve(player.play()).catch(() => {});
      resume = false;
      emit();
    },

    /** The countdown: `dtS` seconds passed. It runs only while the replay plays and no drag holds it; at zero, back to live. */
    tick(dtS) {
      if (phase !== 'ready' || !playing || dragging) return;
      left = Math.max(0, left - dtS);
      if (left <= 0) { api.back(); return; }
      emit();
    },

    /** "Keep and mark the lift": M with the snapshot as a File and the session's lift. */
    keep() {
      if (phase !== 'ready' || !snapshot) return;
      const file = new File([snapshot.blob], replayFileName(now()), { type: 'video/mp4' });
      const lift = session.lift;
      close();
      flow.go('mark', { file, lift, from: 'live' });
    },

    /** "Not this one", the countdown's end, and the problem panel's way back. */
    back() {
      if (phase === 'closed') return;
      close();
      flow.go('live');
    },

    /** R3 is leaving by another way: the player closes, the snapshot goes. */
    close,
  };
  return api;
}
