// M1–M3's logic as plain functions (package d14; d54, checkpoint A round 1): the
// playhead from the drag, the steps as buttons (1 Start and 2 End set or move a mark,
// ↶ undoes the last one), the one-frame steps, the length and its cost, and
// Analyse. No Preact and no DOM, so Node runs it as written
// (tests/app/mark.test.js); the screen (screens/M.mjs) draws what these give.
//
// The marks are frame indexes into the source's `frameTimes` (contract 5), never
// times made up from the frame rate: a variable-rate video has its own spacing.
import { problemOf } from './problem-model.mjs';

/** The filmstrip's scale: pixels to a second (the mockup's), one thumbnail a second. */
export const PX_PER_SECOND = 48;
/** A thumbnail's box in pixels (the mockup's: 47 of the second's 48 px, 64 high). */
export const THUMB = Object.freeze({ width: 47, height: 64 });
/** The end has to be this many frames after the start at least ("a few frames apart"). */
export const MIN_MARK_FRAMES = 3;
/** The pixel ratio the stepper's budget is sized for (contract 5: 128 MiB, 744 × 1320 frames). */
export const MAX_PIXEL_RATIO = 3;

// ---- time and the strip ----

/**
 * The frame shown at `t`: the last one starting at or before it (a microsecond
 * of slack for a time that fell a hair short), held to the first and last frame.
 * @param {readonly number[]} frameTimes
 * @param {number} t seconds
 */
export function frameIndexAt(frameTimes, t) {
  const n = frameTimes.length;
  if (!(t > frameTimes[0])) return 0;
  let lo = 0, hi = n - 1;
  const at = t + 1e-6;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frameTimes[mid] <= at) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * The playhead after a drag of the filmstrip: the strip follows the finger, so
 * dragging left (dx < 0) moves the playhead later, by dx / PX_PER_SECOND seconds.
 * @param {readonly number[]} frameTimes
 * @param {{time: number, dx: number}} drag the playhead's time at pointer-down, and the pixels moved since
 * @returns {{index: number, time: number}} the frame it lands on
 */
export function dragTarget(frameTimes, { time, dx }) {
  const index = frameIndexAt(frameTimes, time - dx / PX_PER_SECOND);
  return { index, time: frameTimes[index] };
}

/** The strip's left edge in px: the playhead sits at the middle of `width`, and time `t` under it. */
export const stripLeft = (t, width) => width / 2 - t * PX_PER_SECOND;

/** "0:07.2": minutes, seconds and tenths, rounded as a whole so it never reads "0:60.0". */
export function formatClock(t) {
  const tenths = Math.max(0, Math.round(t * 10));
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// ---- the filmstrip's thumbnails ----

/**
 * The seconds whose thumbnails are wanted: those the strip shows around the
 * playhead (it is `width` px wide, the playhead at its middle) and `margin`
 * seconds each way, within the video. A thumbnail covers [i, i + 1).
 * @param {{time: number, width: number, duration: number, margin?: number}} view
 * @returns {number[]}
 */
export function thumbSeconds({ time, width, duration, margin = 0 }) {
  const half = width / 2 / PX_PER_SECOND;
  const last = Math.max(0, Math.ceil(duration) - 1);
  const from = Math.max(0, Math.floor(time - half) - margin);
  const to = Math.min(last, Math.floor(time + half) + margin);
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/** The time of the second's thumbnail: its middle, held to the last frame. */
export const thumbTime = (second, frameTimes) => Math.min(second + 0.5, frameTimes[frameTimes.length - 1]);

/** Closes and forgets the held thumbnails (a Map of second → ImageBitmap) that are not in `keep`. */
export function dropFarThumbs(held, keep) {
  const wanted = new Set(keep);
  for (const [second, bitmap] of [...held]) {
    if (wanted.has(second)) continue;
    try { bitmap.close(); } catch { /* already closed */ }
    held.delete(second);
  }
}

/**
 * The size of the stepper's frames: the video fitted into the stage at the
 * device's pixel ratio (3 at most: the stepper's budget is sized for it), its
 * aspect kept, never bigger than the video itself.
 * @param {{width: number, height: number}} info the video's upright size
 * @param {{width: number, height: number}} box the stage in CSS pixels
 * @param {number} ratio devicePixelRatio
 * @returns {{width: number, height: number}}
 */
export function fitSize(info, box, ratio) {
  const r = Math.min(MAX_PIXEL_RATIO, ratio > 0 ? ratio : 1);
  const bw = Math.max(1, Math.round(box.width * r)), bh = Math.max(1, Math.round(box.height * r));
  const heightLimited = bh * info.width <= bw * info.height;
  let width = heightLimited ? Math.round(bh * info.width / info.height) : bw;
  let height = heightLimited ? bh : Math.round(bw * info.height / info.width);
  if (width > info.width || height > info.height) { width = info.width; height = info.height; }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

// ---- the marks ----

/**
 * @typedef {Object} Marks
 * @property {number|null} start frame index of the start (step 1)
 * @property {number|null} end frame index of the end (step 2)
 * @property {'end-before-start'|'start-too-late'|null} error what the last press was refused for
 * @property {ReadonlyArray<Readonly<{start: number|null, end: number|null}>>} history the marks before each press
 *   that changed one, the latest last: what ↶ brings back
 */

const NO_HISTORY = Object.freeze([]);
const marksOf = (start, end, error, history) => Object.freeze({ start, end, error, history });

/** @returns {Readonly<Marks>} no marks set, nothing to undo */
export const newMarks = () => marksOf(null, null, null, NO_HISTORY);

/** @param {Marks} marks @returns {'start'|'end'|'ready'} the step M is in: M1, M2 or M3 */
export const stepOf = marks => (marks.start === null ? 'start' : marks.end === null ? 'end' : 'ready');

// a change of a mark: the marks before it are kept for ↶
const changed = (marks, start, end) => marksOf(start, end, null,
  Object.freeze([...marks.history, Object.freeze({ start: marks.start, end: marks.end })]));
const refused = (marks, error) => marksOf(marks.start, marks.end, error, marks.history);

/**
 * A press on step 1 (`'start'`) or 2 (`'end'`) with the playhead on frame `index`: it sets that mark there, or
 * moves it there once it is set (round 1: a green step pressed again moves its mark). Step 2 does nothing until
 * the start is set. Refused, with no mark changed and nothing kept for ↶: an end fewer than MIN_MARK_FRAMES after
 * the start, a start moved to later than the end minus MIN_MARK_FRAMES (both `end-before-start`), and a start with
 * fewer than MIN_MARK_FRAMES frames after it in the video (`start-too-late`: no end could follow). A press on the
 * frame the mark is already on changes nothing either.
 * @param {Marks} marks
 * @param {'start'|'end'} which the step pressed
 * @param {number} index the playhead's frame
 * @param {readonly number[]} frameTimes
 * @returns {Readonly<Marks>}
 */
export function pressStep(marks, which, index, frameTimes) {
  if (!Number.isInteger(index) || index < 0 || index >= frameTimes.length) return marks;
  if (which === 'start') {
    if (marks.end !== null && index > marks.end - MIN_MARK_FRAMES) return refused(marks, 'end-before-start');
    // no room left for an end MIN_MARK_FRAMES later: every end would be refused
    if (index > frameTimes.length - 1 - MIN_MARK_FRAMES) return refused(marks, 'start-too-late');
    if (index === marks.start) return marks.error ? refused(marks, null) : marks;
    return changed(marks, index, marks.end);
  }
  if (which === 'end') {
    if (marks.start === null) return marks;
    if (index < marks.start + MIN_MARK_FRAMES) return refused(marks, 'end-before-start');
    if (index === marks.end) return marks.error ? refused(marks, null) : marks;
    return changed(marks, marks.start, index);
  }
  return marks;
}

/** ↶: the marks before the last press that changed one, with the history before it; no marks to undo: the same. */
export function undo(marks) {
  const n = marks.history.length;
  if (!n) return marks;
  const last = marks.history[n - 1];
  return marksOf(last.start, last.end, null, Object.freeze(marks.history.slice(0, n - 1)));
}

/** The marks without the last refusal's error (the playhead moved on): the same marks when there is none. */
export const clearError = marks => (marks.error ? refused(marks, null) : marks);

/**
 * The marks of a range already marked (A3's re-mark opens M with the lift's old ones): the frames at the
 * range's two times, an end past the last frame held to it, and nothing to undo. No marks (M1) for a range
 * that is missing or shorter than MIN_MARK_FRAMES frames: M would refuse such an end.
 * @param {{t0: number, t1: number}|null|undefined} range in the video's own timeline
 * @param {readonly number[]} frameTimes
 * @returns {Readonly<Marks>}
 */
export function marksFromRange(range, frameTimes) {
  if (!range || !Number.isFinite(range.t0) || !Number.isFinite(range.t1) || !frameTimes.length) return newMarks();
  const start = frameIndexAt(frameTimes, range.t0), end = frameIndexAt(frameTimes, range.t1);
  if (end < start + MIN_MARK_FRAMES) return newMarks();
  return marksOf(start, end, null, NO_HISTORY);
}

/**
 * The marked range: the times of the start and end frames, the length between
 * them, and the frames the job poses (every frame starting in [t0, t1]).
 * @returns {{t0: number, t1: number, length: number, frames: number}|null} null until both marks are set
 */
export function markedRange(marks, frameTimes) {
  if (stepOf(marks) !== 'ready') return null;
  const t0 = frameTimes[marks.start], t1 = frameTimes[marks.end];
  return { t0, t1, length: t1 - t0, frames: marks.end - marks.start + 1 };
}

// ---- the cost ----

/**
 * The queue's estimate for the marked range: estimate(t1 - t0, {fps}), the
 * last measured rate or the first-run default.
 * @param {{estimate: Function}} queue
 * @param {Marks} marks
 * @param {readonly number[]} frameTimes
 * @param {number} fps the video's frame rate
 * @returns {Promise<{seconds: number, perSecond: number, measured: boolean, basis: string}|null>} null until both marks are set
 */
export async function analyseCost(queue, marks, frameTimes, fps) {
  const range = markedRange(marks, frameTimes);
  if (!range) return null;
  return queue.estimate(range.t1 - range.t0, { fps });
}

const wholeSeconds = s => {
  const n = Math.max(1, Math.round(s));   // never "0 s"
  return n < 60 ? `${n} s` : `${Math.floor(n / 60)} min${n % 60 ? ` ${n % 60} s` : ''}`;
};

// ---- the view ----

/** M's own words (round 1's wording table, approved 2026-11-02) that are not the text line's. */
export const MARK_TEXT = Object.freeze({
  opening: 'Opening…',             // over the video while it opens
  noVideo: 'No video to mark.',    // M without a file
  bothFirst: 'Set 1 and 2 first',  // Analyse without both marks
});

const REFUSALS = {
  'end-before-start': 'The end has to come after the start',
  'start-too-late': 'No room for an end after this',
};

/**
 * What M draws, from the marks and the playhead: the clock, the strip's marks, the one text line (`text`, its
 * `textTone`: 'error' in the work-on colour, 'ready' in the text colour, else null) and the steps row.
 * Each step has its `state`: 'next' (white, the one to press now), 'wait' (not yet: disabled), 'done' (green, ✓
 * and the mark's clock as its label) or 'go' (step 3 once both marks are set); `pressable`; and `name`, its
 * accessible name, which says what a press does. ↶ is `canUndo`.
 * @param {Marks} marks
 * @param {{index: number, frameTimes: readonly number[]|null, cost?: {seconds: number, measured: boolean}|null,
 *   busy?: boolean, refused?: string|null}} at the playhead's frame, the source's frame times (null while the
 *   video opens), the queue's estimate once there is one, whether Analyse is storing the cut, and what Analyse
 *   said when it could not go on
 */
export function markView(marks, { index, frameTimes, cost = null, busy = false, refused: said = null }) {
  if (!frameTimes) {
    const wait = (key, num, label, name) => ({ key, state: 'wait', pressable: false, num, label, name });
    return {
      step: 'loading', time: 0, clock: null, startAt: null, endAt: null, region: null, lengthLabel: '',
      text: '', textTone: null, canUndo: false, canAnalyse: false,
      steps: [wait('start', '1', 'Start', 'Set the start at the playhead'), wait('end', '2', 'End', 'Set the end at the playhead'),
        wait('analyse', '3', 'Analyse', 'Analyse, once 1 and 2 are set')],
    };
  }
  const step = stepOf(marks);
  const time = frameTimes[index];
  const startAt = marks.start === null ? null : frameTimes[marks.start];
  const endAt = marks.end === null ? null : frameTimes[marks.end];
  const to = endAt ?? time;
  const length = startAt === null ? 0 : to - startAt;
  const lengthLabel = `${Math.max(0, length).toFixed(1)} s`;

  let text, textTone = null;
  if (busy) text = 'Saving the clip…';
  else if (said) { text = said; textTone = 'error'; }
  else if (marks.error) { text = REFUSALS[marks.error]; textTone = 'error'; }
  else if (step === 'start') text = 'Drag to just before the lift';
  else if (step === 'end') text = `Drag to just after it · ${lengthLabel}`;
  else {
    textTone = 'ready';
    // the estimate is a first guess until this phone has measured its own rate (ui-design.md)
    text = !cost ? lengthLabel
      : cost.measured ? `${lengthLabel} · analysed in about ${wholeSeconds(cost.seconds)}`
        : `${lengthLabel} · about ${wholeSeconds(cost.seconds)}, a first guess`;
  }

  const set = (key, at, word) => (at === null
    ? { key, num: key === 'start' ? '1' : '2', label: word, name: `Set the ${key} at the playhead` }
    : { key, num: '✓', label: formatClock(at), name: `${word} at ${formatClock(at)}. Press to move it to the playhead.` });
  const ready = step === 'ready';
  const steps = [
    { ...set('start', startAt, 'Start'), state: startAt !== null ? 'done' : 'next', pressable: !busy },
    { ...set('end', endAt, 'End'), state: endAt !== null ? 'done' : startAt !== null ? 'next' : 'wait', pressable: !busy && startAt !== null },
    { key: 'analyse', num: '3', label: busy ? 'Saving…' : 'Analyse', state: ready ? 'go' : 'wait', pressable: !busy && ready,
      name: busy ? 'Saving the clip' : ready ? `Analyse the ${lengthLabel} marked` : 'Analyse, once 1 and 2 are set' },
  ];

  return {
    step,
    time,
    clock: formatClock(time),
    startAt,
    endAt,
    region: startAt !== null && length > 0 ? { from: startAt, to } : null,
    lengthLabel,
    text,
    textTone,
    steps,
    canUndo: !busy && marks.history.length > 0,
    canAnalyse: ready,
  };
}

// ---- the playhead: frames off the input path ----

/**
 * The note over the stage for the playhead's last event: a frame that failed to
 * decode says why, and any frame that is drawn afterwards clears it (a drag seek
 * that succeeds shows a frame, so an old error must not stay over it).
 * @param {{error?: unknown}} event `{error}` for a failure, `{}` for a drawn frame
 * @returns {string|null}
 */
export function playheadNote({ error } = {}) {
  if (error === undefined) return null;
  return error && error.message ? error.message : 'The video could not be decoded.';
}

/**
 * The playhead's frames, decoded off the input path. A drag only says where it
 * is (`request`): the stepper's seek runs one at a time, and the times that pile
 * up while it decodes become one, to the latest, so the strip follows the finger
 * and the frame catches up. A one-frame step (`step`) is the stepper's, relative
 * to the frame shown: it waits behind a seek in flight and lands on the
 * neighbouring entry of frameTimes. `draw(result)` gets each landing (the
 * stepper's `{index, time, frame}`), `fail(error)` each failure; after one, the
 * next request goes on.
 * @param {{stepper: {seek: Function, step: Function}, draw: Function, fail: Function}} deps
 */
export function createPlayhead({ stepper, draw, fail }) {
  let closed = false;
  let running = false;
  const pending = [];       // ops not started: {kind: 'seek', t, waiters} | {kind: 'step', delta, waiters}
  let idleWaiters = [];

  const settle = (op, r, e) => { for (const w of op.waiters) (e ? w.reject(e) : w.resolve(r)); };

  async function pump() {
    running = true;
    while (pending.length && !closed) {
      const op = pending.shift();
      try {
        const r = op.kind === 'seek' ? await stepper.seek(op.t) : await stepper.step(op.delta);
        if (!closed) draw(r);
        settle(op, r, null);
      } catch (e) {
        if (!closed) fail(e);
        settle(op, null, e);
      }
    }
    for (const op of pending.splice(0)) settle(op, null, null);
    running = false;
    const w = idleWaiters;
    idleWaiters = [];
    for (const f of w) f();
  }

  function push(op) {
    if (closed) return Promise.resolve(null);
    const promise = new Promise((resolve, reject) => { op.waiters.push({ resolve, reject }); });
    pending.push(op);
    if (!running) pump();
    return promise;
  }

  // the latest seek not yet started takes the place of the one before it, when nothing came between
  function seek(t) {
    const last = pending[pending.length - 1];
    if (last && last.kind === 'seek') {
      last.t = t;
      return new Promise((resolve, reject) => { last.waiters.push({ resolve, reject }); });
    }
    return push({ kind: 'seek', t, waiters: [] });
  }

  return {
    /** Where a drag is now (seconds): fire and forget. */
    request(t) { seek(t).catch(() => {}); },
    /** Seek to `t` and wait for the frame; the promise rejects with the stepper's error (`fail` hears it too). */
    seekTo: seek,
    /** One frame on (+1) or back (−1) through the stepper. */
    step(delta) { return push({ kind: 'step', delta, waiters: [] }); },
    /** Resolves when nothing is running or waiting. */
    idle() { return running ? new Promise(r => idleWaiters.push(r)) : Promise.resolve(); },
    /** Drops what waits and draws nothing more. */
    close() { closed = true; },
  };
}

// ---- the thumbnails' retries, and which answer may move the playhead ----

/**
 * Which thumbnails to ask for next, and what a failed batch does. A batch that
 * fails is asked again second by second, and a second that fails alone is given up
 * for good (until `reset`), so a frame the decoder can't make never makes the
 * screen loop over decodes that compete with the stepper for the decoder.
 * @param {{batch?: number}} [opts] seconds per request
 */
export function createThumbPlanner({ batch = 6 } = {}) {
  const failed = new Set();
  let size = batch;
  return {
    /** The seconds to ask for now: those wanted and neither held nor given up on, nearest to `time` first. */
    next(seconds, held, time) {
      return seconds.filter(s => !held.has(s) && !failed.has(s))
        .sort((a, b) => Math.abs(a + 0.5 - time) - Math.abs(b + 0.5 - time)).slice(0, size);
    },
    /** A request for `asked` failed: the next ones are single seconds, and a single second that fails is given up. Each failure narrows what is left to ask, so the retries end. */
    failure(asked) {
      if (asked.length > 1) size = 1;
      else for (const s of asked) failed.add(s);
    },
    given: () => [...failed],
    reset() { failed.clear(); size = batch; },
  };
}

/**
 * Orders the answers that may move the playhead's index: an answer to a step is
 * applied only if nothing newer (another step, a drag) was asked since.
 */
export function createLatest() {
  let n = 0;
  return {
    /** A newer request starts: a token for its answer. */
    issue: () => ++n,
    /** True while no newer request has started since `token`. */
    fresh: token => token === n,
  };
}

// ---- Analyse ----

const analysing = new WeakSet();   // the flows with an Analyse under way: a second tap does nothing

/**
 * Analyse: the marked range of the file cut and queued as a new lift, then the
 * flow goes to Q1 with that lift's id (Q1 shows the lift when two are queued).
 * Nothing is queued without both marks and a file; a cut that can't be stored
 * (the store's or the cutter's error) stays on M with the error's words. A re-mark
 * (A3) passes `replaces`, the old lift's id: the queue deletes that lift once the new
 * one's analysis is done (s50).
 * @param {{flow: {go: Function}, queue: {analyse: Function}, lift: string, file: Blob|null,
 *   marks: Marks, frameTimes: readonly number[], replaces?: string|null}} args
 * @returns {Promise<{ok: true}|{ok: false, error: string|null, problem?: Object}>} error null for a tap that did nothing;
 *   `problem` (problem-model.mjs's, d23) for an error the store or the cutter raised: M draws it as a screen
 */
export async function analyse({ flow, queue, lift, file, marks, frameTimes, replaces = null }) {
  const range = markedRange(marks, frameTimes);
  if (!range) return { ok: false, error: MARK_TEXT.bothFirst };
  if (!file) return { ok: false, error: 'There is no video to analyse.' };
  if (analysing.has(flow)) return { ok: false, error: null };
  analysing.add(flow);
  try {
    const marked = { t0: range.t0, t1: range.t1 };
    const job = await (replaces ? queue.analyse(lift, file, marked, { replaces }) : queue.analyse(lift, file, marked));
    flow.go('queued', { liftId: job.liftId });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'That did not work.', problem: problemOf(e) };
  } finally {
    analysing.delete(flow);
  }
}
