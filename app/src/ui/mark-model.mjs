// M1–M3's logic as plain functions (package d14): the playhead from the drag,
// Set start and Set end, the one-frame steps, the length and its cost, and
// Analyse. No Preact and no DOM, so Node runs it as written
// (tests/app/mark.test.js); the screen (screens/M.mjs) draws what these give.
//
// The marks are frame indexes into the source's `frameTimes` (contract 5), never
// times made up from the frame rate: a variable-rate video has its own spacing.
import { LIFTS } from '../contracts/common.mjs';
import { LIFT_CHOICES, liftLabel } from './home-model.mjs';

/** The filmstrip's scale: pixels to a second (the mockup's), one thumbnail a second. */
export const PX_PER_SECOND = 48;
/** A thumbnail's box in pixels (the mockup's: 47 of the second's 48 px, 64 high). */
export const THUMB = Object.freeze({ width: 47, height: 64 });
/** The end has to be this many frames after the start at least ("a few frames apart"). */
export const MIN_MARK_FRAMES = 3;
/** The pixel ratio the stepper's budget is sized for (contract 5: 128 MiB, 744 × 1320 frames). */
export const MAX_PIXEL_RATIO = 3;

export const otherLift = lift => LIFTS.find(l => l !== lift) ?? lift;
export const liftLabelOf = liftLabel;
export { LIFT_CHOICES };

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
 * @property {number|null} start frame index of Set start
 * @property {number|null} end frame index of Set end
 * @property {'end-before-start'|'start-too-late'|null} error what the last Set was refused for
 */

/** @returns {Readonly<Marks>} no marks set */
export const newMarks = () => Object.freeze({ start: null, end: null, error: null });

/** @param {Marks} marks @returns {'start'|'end'|'ready'} the step M is in: M1, M2 or M3 */
export const stepOf = marks => (marks.start === null ? 'start' : marks.end === null ? 'end' : 'ready');

/**
 * Set start or Set end at frame `index`, by the step. An end that doesn't come
 * MIN_MARK_FRAMES after the start is refused (the start stays, `error` says
 * why), and so is a start with fewer than MIN_MARK_FRAMES frames after it; once both are set, Set does nothing (Redo first).
 * @param {Marks} marks
 * @param {number} index the playhead's frame
 * @param {readonly number[]} frameTimes
 * @returns {Readonly<Marks>}
 */
export function setMark(marks, index, frameTimes) {
  if (!Number.isInteger(index) || index < 0 || index >= frameTimes.length) return marks;
  const step = stepOf(marks);
  if (step === 'start') {
    // no room left for an end MIN_MARK_FRAMES later: every Set end would be refused
    if (index > frameTimes.length - 1 - MIN_MARK_FRAMES) return Object.freeze({ start: null, end: null, error: 'start-too-late' });
    return Object.freeze({ start: index, end: null, error: null });
  }
  if (step === 'end') {
    if (index < marks.start + MIN_MARK_FRAMES) return Object.freeze({ ...marks, error: 'end-before-start' });
    return Object.freeze({ start: marks.start, end: index, error: null });
  }
  return marks;
}

/** Redo the marks: both cleared. */
export const redo = () => newMarks();

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

const STEP_LABELS = ['Start', 'End', 'Analyse'];
const STEP_ORDER = ['start', 'end', 'ready'];

/**
 * What M draws, from the marks and the playhead (the mockup's strings).
 * @param {Marks} marks
 * @param {{index: number, frameTimes: readonly number[], cost?: {seconds: number, measured: boolean}|null}} at
 *   the playhead's frame, the source's frame times, and the queue's estimate once there is one
 */
export function markView(marks, { index, frameTimes, cost = null }) {
  const step = stepOf(marks);
  const time = frameTimes[index];
  const at = STEP_ORDER.indexOf(step);
  const startAt = marks.start === null ? null : frameTimes[marks.start];
  const endAt = marks.end === null ? null : frameTimes[marks.end];
  const to = endAt ?? time;
  const length = startAt === null ? 0 : to - startAt;
  const lengthLabel = `${Math.max(0, length).toFixed(1)} s`;
  const tooLate = marks.error === 'start-too-late';
  const error = marks.error === 'end-before-start' || tooLate;

  let hint;
  if (tooLate) hint = 'Too close to the end of the video for an end to follow: drag left, to before the lift starts.';
  else if (error) hint = 'The end has to come after the start: drag right, past the lift.';
  else if (step === 'start') hint = 'Drag the filmstrip until the playhead sits just before the lift starts, then tap Set start.';
  else if (step === 'end') hint = 'Now drag to just after the last rep ends, then tap Set end.';
  else if (cost) hint = `${lengthLabel} marked. About ${wholeSeconds(cost.seconds)} to analyse on this phone; it runs in the background while you train.`;
  else hint = `${lengthLabel} marked. It runs in the background while you train.`;

  return {
    step,
    time,
    clock: formatClock(time),
    steps: STEP_LABELS.map((label, i) => ({
      label, num: i < at ? '✓' : String(i + 1), state: i < at ? 'done' : i === at ? 'now' : 'todo',
    })),
    startAt,
    endAt,
    region: startAt !== null && length > 0 ? { from: startAt, to } : null,
    lengthLabel,
    hint,
    hintIsError: error,
    subHint: step === 'ready'
      ? 'The marks only need to bracket the lift; the analysis finds its exact start and end.'
      : 'Rough is fine: coach finds the exact lift inside your marks. Shorter marks analyse faster.',
    // the estimate is the first-run default until this phone has measured its own (ui-design.md)
    estimateNote: step === 'ready' && cost && !cost.measured
      ? 'Estimated from a first-run default: this phone has not measured its own rate yet.' : null,
    setLabel: step === 'start' ? 'Set start' : 'Set end',
    analyseLabel: `Analyse ${lengthLabel}`,
    canSet: step !== 'ready',
    canAnalyse: step === 'ready',
    canRedo: step === 'ready',
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
 * (the store's or the cutter's error) stays on M with the error's words.
 * @param {{flow: {go: Function}, queue: {analyse: Function}, lift: string, file: Blob|null,
 *   marks: Marks, frameTimes: readonly number[]}} args
 * @returns {Promise<{ok: true}|{ok: false, error: string|null}>} error null for a tap that did nothing
 */
export async function analyse({ flow, queue, lift, file, marks, frameTimes }) {
  const range = markedRange(marks, frameTimes);
  if (!range) return { ok: false, error: 'Set the start and the end first.' };
  if (!file) return { ok: false, error: 'There is no video to analyse.' };
  if (analysing.has(flow)) return { ok: false, error: null };
  analysing.add(flow);
  try {
    const job = await queue.analyse(lift, file, { t0: range.t0, t1: range.t1 });
    flow.go('queued', { liftId: job.liftId });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'That did not work.' };
  } finally {
    analysing.delete(flow);
  }
}
