// One analysis job (contract 2), run once: the stored cut read back from the
// store, every frame of the marked range through the pose engine, the track
// in the fixture format (contracts/track.mjs), the scoring adapter (s11), and
// the track, the result and the engine saved on the lift (c8's updateLift).
// The queue (queue.mjs) owns the job's record, the engine and the watchdog; this
// file only walks the stages and says where it is. Plain module, no DOM.
//
// Stages, as Q1 shows them (JOB_STAGES):
//   reading  the cut read from the store and opened: one unit, the file
//   pose     every frame of the range posed: one unit a frame
//   scoring  smoothing and scoring, then the save: one unit
// The time left is the frames still to pose times the median ms a frame has
// taken so far in this job (the wall time per frame: decoding, the transfer and
// the model); before its first frame, the last job's median, if any.
import { validateFrameSource } from '../contracts/frame-source.mjs';
import { appTrackMeta, trackFromFrames } from '../contracts/track.mjs';
import { scoreLift } from '../scoring/score.mjs';

/** The job was cancelled between two frames. */
export class JobCancelled extends Error {
  constructor() { super('cancelled'); this.name = 'JobCancelled'; }
}

/** The pose engine failed (a frame refused, the worker gone): the queue replaces the engine. */
export class EngineError extends Error {
  constructor(cause) {
    super(cause && cause.message ? cause.message : String(cause));
    this.name = 'EngineError';
    this.cause = cause;
  }
}

/** The median of a list of numbers (the mean of the middle two for an even count). */
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Frame times, as the frame source has them, within [t0, t1]: the frames
// frames(t0, t1) gives (1 µs of slack for times in floating point).
const SLACK_S = 1e-6;
export const framesInRange = (times, { t0, t1 }) => times.reduce((n, t) => n + (t >= t0 - SLACK_S && t <= t1 + SLACK_S ? 1 : 0), 0);

// The index in `times` (seconds, increasing) of the frame whose time is nearest `t`.
function nearestIndex(times, t) {
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo > 0 && Math.abs(times[lo - 1] - t) <= Math.abs(times[lo] - t) ? lo - 1 : lo;
}

/**
 * Runs one job through its stages.
 * @param {import('../contracts/analysis-job.mjs').AnalysisJob} job
 * @param {Object} ctx
 * @param {Object} ctx.store createStore()'s: getLift, readVideo, updateLift
 * @param {(blob: Blob) => Promise<Object>} ctx.openFrameSource s9's
 * @param {() => Promise<Object>} ctx.engine the queue's engine, ready for a new clip (reset once per clip)
 * @param {Object} [ctx.Diagnostics] for scoreLift; default window.Diagnostics
 * @param {number} [ctx.sigmaMs] the smoothing's σ
 * @param {() => number} ctx.now ms, for the time per frame
 * @param {{msPerFrame: number, sPerS: number}|null} ctx.rate the last measured rate
 * @param {(state: string, progress: Object) => void} ctx.emit the job's new state and progress
 * @param {() => boolean} ctx.cancelled asked between frames
 * @param {<T>(p: Promise<T>) => Promise<T>} ctx.guard every wait goes through it, so a stall ends it
 * @returns {Promise<{msPerFrame: number|null, fps: number, frames: number}>}
 */
export async function runJob(job, ctx) {
  const { store, guard, emit, now, rate } = ctx;
  const { t0, t1 } = job.range;
  emit('reading', { stage: 'reading', done: 0, total: 1, etaS: rate ? rate.sPerS * (t1 - t0) : null });

  const lift = await guard(store.getLift(job.liftId));
  if (!lift) throw new Error(`The lift ${job.liftId} is no longer stored.`);
  const blob = await guard(store.readVideo(job.liftId));
  const src = await guard(ctx.openFrameSource(blob));
  let it = null;
  try {
    // contract 5: the frames' own times (a variable rate's too), never times made up from the rate
    const broken = validateFrameSource(src);
    if (broken.length) throw new Error(`The frame source breaks contract 5: ${broken.join('; ')}`);
    const times = src.frameTimes;
    const total = framesInRange(times, job.range);
    const etaFrom = (ms, left) => (ms === null ? null : ms * left / 1000);
    const before = rate ? rate.msPerFrame : null;
    emit('reading', { stage: 'reading', done: 1, total: 1, etaS: etaFrom(before, total) });
    if (ctx.cancelled()) throw new JobCancelled();

    let engine;
    try { engine = await guard(ctx.engine()); } catch (e) { throw e && e.name === 'StallError' ? e : new EngineError(e); }
    emit('pose', { stage: 'pose', done: 0, total, etaS: etaFrom(before, total) });

    const frames = [];
    const costs = [];
    let last = now();
    it = src.frames(t0, t1)[Symbol.asyncIterator]();
    for (;;) {
      if (ctx.cancelled()) throw new JobCancelled();
      const step = await guard(it.next());
      if (step.done) break;
      const frame = step.value;
      const tMs = frame.timestamp / 1000;
      const index = nearestIndex(times, frame.timestamp / 1e6);
      let r;
      try { r = await guard(engine.estimate(frame, tMs)); } catch (e) { throw e && e.name === 'StallError' ? e : new EngineError(e); }
      const t = now();
      costs.push(t - last);
      last = t;
      if (!frames.length || index > frames[frames.length - 1].index) frames.push({ index, tMs, keypoints: r.keypoints });
      const done = frames.length;
      const all = Math.max(total, done);
      emit('pose', { stage: 'pose', done, total: all, etaS: etaFrom(median(costs), all - done) });
    }
    it = null;
    if (!frames.length) throw new Error(`No frame of the video lies in the marked range (${t0.toFixed(2)}–${t1.toFixed(2)} s).`);

    const info = src.info;
    const track = trackFromFrames(frames, appTrackMeta({ fps: info.fps, frameCount: times.length, width: info.width, height: info.height }));
    emit('scoring', { stage: 'scoring', done: 0, total: 1, etaS: 0 });
    const opts = { sigmaMs: ctx.sigmaMs };
    if (ctx.Diagnostics) opts.Diagnostics = ctx.Diagnostics;
    const { view } = scoreLift(track, job.lift, opts);
    const { model, backend, runtime } = engine.info || {};
    await guard(store.updateLift(job.liftId, { track, result: view, engine: { model, backend, runtime } }));
    emit('scoring', { stage: 'scoring', done: 1, total: 1, etaS: 0 });
    return { msPerFrame: median(costs), fps: info.fps, frames: frames.length };
  } finally {
    // a stream left early (cancel, a failure) is ended: the decoder stops and closes its frames
    if (it && typeof it.return === 'function') Promise.resolve().then(() => it.return()).catch(() => {});
    try { src.close(); } catch { /* closed */ }
  }
}
