// A3, View options (package d22), as plain functions and one controller (design/mockups/ViewOptions.dc.html):
// the sheet's words and controls, what each option does to the player, the re-score a smoothing change
// makes, re-mark and delete. No Preact and no DOM, so Node runs it as written (tests/app/view-options.test.js);
// components/view-options.mjs draws what this gives, and screens/A1.mjs owns the player.
//
// The choices are the store's settings.view (settings.mjs): skeleton, cues, unsure, loop, speed and
// smoothingSigmaMs. The lifter choice of the old page and of the mockup is not here: MoveNet SinglePose
// tracks one person, so there is nothing to choose (docs/app-plan.md, "The pieces").
import { scoreLift } from '../scoring/score.mjs';
import { trackSamples } from '../draw/index.mjs';
import { SPEEDS, speedLabel } from './player-model.mjs';
import { marksFromRange } from './mark-model.mjs';

export { marksFromRange };

/** The four switches under "On the video", in the mockup's order. `key` is the settings.view field. */
export const SWITCHES = Object.freeze([
  { key: 'skeleton', label: 'Skeleton', sub: null },
  { key: 'cues', label: 'Cue drawings', sub: 'The lines each cue measures' },
  { key: 'unsure', label: 'Unsure joints', sub: 'Under 30 % sure' },
  { key: 'loop', label: 'Loop the lift only', sub: 'Skips walking in and out' },
].map(Object.freeze));

/** The speed buttons, slowest first as the mockup has them (the values are settings.view.speed's). */
export const SPEED_BUTTONS = Object.freeze([...SPEEDS].sort((a, b) => a - b).map(value => Object.freeze({ value, label: speedLabel(value) })));

/** The smoothing slider: ms, the mockup's range and step; `standard` is the default the thresholds assume. */
export const SMOOTHING = Object.freeze({ min: 0, max: 300, step: 5, standard: 50 });

/** The sheet's words. The first nine are the mockup's; the rest are built beyond it (the delete step, the errors). */
export const TEXT = Object.freeze({
  title: 'View options',
  done: 'Done',
  video: 'On the video',
  speed: 'Speed',
  advanced: 'Advanced',
  smoothing: 'Smoothing',
  smoothingNote: 'Changes the scores. Thresholds assume 50 ms.',
  remark: 'Re-mark this lift',
  delete: 'Delete this lift',
  close: 'Close view options',
  deleteAsk: 'Delete this lift and its video? This can’t be undone.',
  deleteYes: 'Delete',
  deleteNo: 'Keep it',
  scoring: 'Scoring again…',
});

export const smoothingLabel = ms => `${ms} ms`;

/** The slider's value: a number rounded to its step and held to its range; the standard for anything else. */
export function sigmaChoice(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return SMOOTHING.standard;
  return Math.max(SMOOTHING.min, Math.min(SMOOTHING.max, Math.round(n / SMOOTHING.step) * SMOOTHING.step));
}

/**
 * Where "Loop the lift only" plays, in the cut's seconds: the lift window the analysis found, held inside
 * the marked range. A window with a start and no end (contract 4, s35) runs from its start to the range's end.
 * No span (null: the whole range) for a lift without a window at all (a lateral raise, s36) and for a lift
 * the analysis found no window in.
 * @param {import('../contracts/cue-view.mjs').ResultView} view
 * @param {{t0: number, t1: number}} range
 * @returns {{t0: number, t1: number}|null}
 */
export function loopSpan(view, range) {
  const w = view && view.hasLiftWindow !== false ? view.liftWindow : null;
  if (!w || !Number.isFinite(w.t0)) return null;
  const t0 = Math.max(range.t0, w.t0);
  const t1 = Math.min(range.t1, Number.isFinite(w.t1) ? w.t1 : range.t1);
  return t1 > t0 ? { t0, t1 } : null;
}

const messageOf = e => (e && e.message ? e.message : 'That didn’t work.');

/**
 * A3's controller. It owns the sheet's state, applies each option to the player and keeps it in the
 * store. The player and the flags object are A1's: the controller changes `flags` in place, which the
 * player reads when it paints and plays.
 * @param {Object} o
 * @param {Object} o.store createStore()'s: saveSettings, updateLift, readVideo, deleteLift
 * @param {import('../contracts/stored-lift.mjs').StoredLift} o.rec the lift
 * @param {Object} o.track the stored raw track (readTrack), re-scored on a smoothing change
 * @param {import('../contracts/cue-view.mjs').ResultView} o.view the stored result
 * @param {Object} o.Diagnostics diagnostics.js's object
 * @param {{skeleton: boolean, cues: boolean, unsure: boolean, loop: boolean}} o.flags
 * @param {Object} o.player createPlayer()'s
 * @param {{go: Function}} o.flow
 * @param {Function} [o.score] the scoring adapter's scoreLift
 * @param {(s: {view: object, computed: object, keypoints: object}) => void} [o.onScored] after a re-score was kept
 * @param {Object} [o.settings] settings.view: where the options start; else `flags` and the player's speed
 * @param {number} [o.speed] the speed to start at, when it is not the stored one (A2's "Play the rep at ½×")
 */
export function createViewOptions(o) {
  const { store, rec, track, Diagnostics, flags, player, flow } = o;
  const score = o.score || scoreLift;
  const onScored = o.onScored || (() => {});
  let view = o.view;
  const listeners = new Set();

  if (o.settings) for (const { key } of SWITCHES) if (typeof o.settings[key] === 'boolean') flags[key] = o.settings[key];
  const state = {
    skeleton: !!flags.skeleton, cues: !!flags.cues, unsure: !!flags.unsure, loop: flags.loop !== false,
    speed: o.speed ?? (o.settings ? o.settings.speed : player.state.speed),
    sigmaMs: view.smoothing.sigmaMs,   // the σ the stored verdicts used, not the setting's: the lift's own
    scoring: false, asking: false, error: null,
  };
  const emit = () => { const s = { ...state }; for (const fn of [...listeners]) fn(s); };
  // The choice is kept in the store's settings. A refusal leaves the option applied and says so.
  const keep = async view_ => {
    try { await store.saveSettings({ view: view_ }); return true; } catch (e) { state.error = `Couldn’t save this: ${messageOf(e)}`; return false; }
  };

  let latest = 0;                    // a newer smoothing change makes an older one that has not begun skip
  let chain = Promise.resolve();     // re-scores run one at a time

  const api = {
    get state() { return { ...state }; },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },

    /** One of the four switches: the player repaints (or loops differently) at once, and the choice is kept. */
    async setSwitch(key, on) {
      if (!SWITCHES.some(s => s.key === key)) throw new Error(`no view option '${key}'`);
      flags[key] = !!on;
      state[key] = !!on;
      state.error = null;
      player.repaint();
      emit();
      if (!(await keep({ [key]: !!on }))) emit();
    },

    /** The speed: one of the three the store has a value for. */
    async setSpeed(v) {
      if (!SPEEDS.includes(v)) throw new Error(`no playback speed ${v}`);
      state.speed = v;
      state.error = null;
      player.setSpeed(v);
      emit();
      if (!(await keep({ speed: v }))) emit();
    },

    /**
     * A smoothing change: the stored raw track is scored again through the adapter with the new σ (and the
     * velocity option the stored verdicts used), the new view is saved with updateLift (its `smoothing` says
     * which σ the verdicts used), the choice goes to the settings for the next analyses, and the player and
     * the cards get the new scene. If the view can't be saved nothing changes and the slider goes back.
     * @returns {Promise<{view: object, computed: object, keypoints: object}|null>} null when it didn't happen
     */
    setSigma(raw) {
      const sigmaMs = sigmaChoice(raw);
      const token = ++latest;
      state.sigmaMs = sigmaMs;
      state.scoring = true;
      state.error = null;
      emit();
      const job = chain.then(async () => {
        if (token !== latest) return null;
        try {
          const scored = score(track, rec.lift, { Diagnostics, sigmaMs, keepVelocity: view.smoothing.keepVelocity });
          await store.updateLift(rec.id, { result: scored.view });
          view = scored.view;
          player.setScene({ track: trackSamples(scored.keypoints, track.meta), meta: track.meta, Diagnostics, view, computed: scored.computed });
          player.setLift(loopSpan(view, rec.range));
          onScored({ view, computed: scored.computed, keypoints: scored.keypoints });
          if (token === latest) await keep({ smoothingSigmaMs: sigmaMs });
          return scored;
        } catch (e) {
          state.sigmaMs = view.smoothing.sigmaMs;
          state.error = `Couldn’t change the smoothing: ${messageOf(e)}`;
          return null;
        } finally {
          if (token === latest) { state.scoring = false; emit(); }
        }
      });
      chain = job.catch(() => {});
      return job;
    },

    /**
     * Re-mark: M1–M3 opens on the stored cut with the lift's old marks (M reads the range from the params),
     * and with this lift's id as `replaces` (s50): M's Analyse hands it to the queue, and the new lift
     * replaces this one once its analysis is done. A failed or cancelled one leaves this lift as it is.
     */
    async remark() {
      try {
        const file = await store.readVideo(rec.id);
        flow.go('mark', { file, lift: rec.lift, range: { ...rec.range }, replaces: rec.id });
      } catch (e) {
        state.error = `Couldn’t open this lift: ${messageOf(e)}`;
        emit();
      }
    },

    /** Delete asks first; only confirmDelete() after it removes the lift. */
    askDelete() { state.asking = true; state.error = null; emit(); },
    cancelDelete() { state.asking = false; emit(); },
    async confirmDelete() {
      if (!state.asking) return;
      state.asking = false;
      try {
        await store.deleteLift(rec.id);
      } catch (e) {
        state.error = `Couldn’t delete this lift: ${messageOf(e)}`;
        emit();
        return;
      }
      flow.go('home');
    },
  };
  return api;
}
