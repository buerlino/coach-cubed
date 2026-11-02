// The analysis queue (package s12): Analyse doesn't block. A marked lift's cut
// is stored first (s32's keepVideo), then its job (contract 2) joins the queue
// and the user carries on; the queue runs one job at a time, in order, on one
// pose engine, and outlives screen changes: Q1 and H subscribe to it. A plain
// module, no DOM; everything it touches is injected, so tests run it on fakes.
//
//   const queue = createQueue({ store, createEngine, openFrameSource, keepVideo });
//   await queue.load();                       // the kept queue back after a restart
//   const off = queue.subscribe(jobs => …);   // every change: the jobs, copies
//   const job = await queue.analyse('snatch', file, { t0, t1 });   // the cut kept, then queued
//   await queue.cancel(job.id);               // between frames; the engine is reset
//   await queue.estimate(durationS, { fps }); // M1–M3's cost before Analyse
//
// A job cut off is never left hanging:
//  - the app closed: the queue is kept in the store (queue.json) at every change
//    of state, and a job found running at load() was cut off, so it is queued
//    again and runs from the start (its source is the stored cut, by path);
//  - the WebView frozen in the background: nothing runs, the timers neither, and
//    the job resumes where it was when the app is back. setVisible(false) stops
//    the watchdog counting; setVisible(true) gives it a fresh window;
//  - a hang while visible (a worker or a decoder that never answers): after
//    `stallMs` without progress the engine is closed and replaced and the job
//    restarts; the same again fails the job, saying so. An engine that fails
//    (a refused frame, the worker gone) and a stalled decoder are treated alike.
import { JOB_STAGES, createJob, validateAnalysisJob } from '../contracts/analysis-job.mjs';
import { EngineError, JobCancelled, runJob } from './job.mjs';
import { estimateCost, rateOf } from './estimate.mjs';
import { STALLED, mediaFailure } from './messages.mjs';

/** No progress for the watchdog's time while visible. */
export class StallError extends Error {
  constructor(message) { super(message); this.name = 'StallError'; }
}

const copy = j => ({ ...j, range: { ...j.range }, progress: j.progress && { ...j.progress } });
const ended = s => s === 'done' || s === 'failed' || s === 'cancelled';
const messageOf = e => (e && typeof e.message === 'string' && e.message) || String(e);
// what a failed job keeps: a MediaError (the frame source, d23) with its code, so a screen can tell the video from the engine
const failureOf = e => (e && e.name === 'MediaError' && typeof e.code === 'string' ? mediaFailure(e) : messageOf(e));

/**
 * @param {Object} deps
 * @param {Object} deps.store createStore()'s
 * @param {() => Promise<Object>} deps.createEngine a PoseEngine (s10): estimate, reset, close, info
 * @param {(blob: Blob) => Promise<Object>} deps.openFrameSource s9's
 * @param {Function} [deps.keepVideo] s32's, for analyse()
 * @param {Object} [deps.Diagnostics] for the scoring adapter; default window.Diagnostics
 * @param {() => number} [deps.now] ms, for the time per frame
 * @param {{setInterval: Function, clearInterval: Function}} [deps.timers] the watchdog's
 * @param {number} [deps.stallMs] no progress this long while visible is a hang (30 s)
 * @param {number} [deps.tickMs] the watchdog's period (1 s)
 * @param {number} [deps.maxRestarts] restarts of a job after a hang or an engine failure (1)
 */
export function createQueue({
  store, createEngine, openFrameSource, keepVideo, Diagnostics,
  now = () => globalThis.performance.now(),
  timers = { setInterval: (f, ms) => globalThis.setInterval(f, ms), clearInterval: id => globalThis.clearInterval(id) },
  stallMs = 30000, tickMs = 1000, maxRestarts = 1,
} = {}) {
  let jobs = [];            // the records, in queue order
  let rate = null;          // the last measured rate (estimate.mjs)
  let loading = null, isLoaded = false;
  let running = null;       // { id, cancel, abort, idleTicks, waiters }
  let enginePromise = null, dirty = false;
  let visible = true, timer = null, closed = false;
  const listeners = new Set();
  let idleWaiters = [];

  // ---- state out ----
  const snapshot = () => jobs.map(copy);
  function emit() {
    const s = snapshot();
    for (const fn of [...listeners]) { try { fn(s); } catch { /* a listener's own error */ } }
  }
  function persist() {
    const kept = jobs.filter(j => j.state !== 'done').map(copy);
    // the queue's file is a cache of what runs; a failed write is tried again at the next change
    return Promise.resolve().then(() => store.saveQueue({ jobs: kept, rate })).catch(() => {});
  }

  // ---- load ----
  function load() {
    if (!loading) {
      loading = (async () => {
        const saved = await store.readQueue();
        if (rate === null) rate = saved.rate;
        let changed = false;
        for (const j of saved.jobs) {
          if (jobs.some(r => r.id === j.id)) continue;
          if (!(await store.getLift(j.liftId))) { changed = true; continue; }   // the lift was deleted
          if (JOB_STAGES.includes(j.state)) {   // cut off: the app was closed while it ran
            jobs.push({ ...j, state: 'queued', progress: null, error: null });
            changed = true;
          } else jobs.push(j);
        }
        isLoaded = true;
        if (changed) persist();
      })();
      loading.catch(() => { loading = null; });
    }
    return loading.then(() => {
      const s = snapshot();
      emit();
      pump();
      return s;
    });
  }
  const loaded = () => (isLoaded ? Promise.resolve() : load());

  // ---- the engine: one, created on first use, reset once per clip ----
  function getEngine() {
    if (!enginePromise) {
      const p = Promise.resolve().then(() => createEngine());
      enginePromise = p;
      dirty = false;
      p.catch(() => { if (enginePromise === p) enginePromise = null; });
    }
    return enginePromise;
  }
  async function engineForClip() {
    const e = await getEngine();
    if (dirty) await e.reset();
    dirty = true;
    return e;
  }
  function dropEngine() {
    const p = enginePromise;
    enginePromise = null;
    dirty = false;
    if (p) p.then(e => { try { e.close(); } catch { /* gone */ } }, () => {});
  }

  // ---- the watchdog ----
  function onTick() {
    const run = running;
    if (!run || !visible || !run.abort) return;
    run.idleTicks++;
    if (run.idleTicks * tickMs >= stallMs) {
      const abort = run.abort;
      run.abort = null;
      abort(new StallError(`${STALLED}: no progress for ${Math.round(stallMs / 1000)} s with the app open.`));
    }
  }
  function startWatchdog() { if (timer === null) timer = timers.setInterval(onTick, tickMs); }
  function stopWatchdog() { if (timer !== null) { timers.clearInterval(timer); timer = null; } }

  // ---- running ----
  async function sigma() {
    try { return typeof store.getSettings === 'function' ? (await store.getSettings()).view.smoothingSigmaMs : undefined; } catch { return undefined; }
  }

  function update(job, run, state, progress) {
    // a job cancelled (or ended) keeps its state: a late emit from the run never revives it
    if (running !== run || ended(job.state)) return;
    const moved = job.state !== state;
    job.state = state;
    job.progress = progress;
    job.error = null;
    run.idleTicks = 0;
    if (moved) persist();
    emit();
  }

  async function drive(job, run) {
    const sigmaMs = await sigma();
    // cancelled while the settings were read: nothing has started, so nothing to stop
    if (run.cancel) return { state: 'cancelled' };
    for (let restarts = 0; ; restarts++) {
      const aborted = new Promise((_, reject) => { run.abort = reject; });
      aborted.catch(() => {});
      const guard = p => Promise.race([p, aborted]);
      run.idleTicks = 0;
      try {
        const out = await runJob(job, {
          store, openFrameSource, engine: engineForClip, Diagnostics, sigmaMs, now, rate, guard,
          emit: (state, progress) => update(job, run, state, progress),
          cancelled: () => run.cancel,
        });
        return { state: 'done', out };
      } catch (e) {
        if (e instanceof JobCancelled) {
          // the next clip starts on a fresh crop; a reset that fails leaves no engine
          try { if (enginePromise && dirty) { const eng = await guard(enginePromise); await guard(eng.reset()); dirty = false; } } catch { dropEngine(); }
          return { state: 'cancelled' };
        }
        // a hung or failed engine is replaced; a stalled decoder only needs the run again
        if (e instanceof EngineError || e instanceof StallError) dropEngine();
        const again = e instanceof EngineError || e instanceof StallError || (e && e.code === 'decode-stalled');
        if (again && restarts < maxRestarts && !run.cancel) continue;
        if (run.cancel) return { state: 'cancelled' };
        return { state: 'failed', error: failureOf(e) };
      } finally {
        run.abort = null;
      }
    }
  }

  async function pump() {
    if (running || closed || !isLoaded) return;
    const job = jobs.find(j => j.state === 'queued');
    if (!job) {
      const w = idleWaiters;
      idleWaiters = [];
      for (const res of w) res();
      return;
    }
    const run = { id: job.id, cancel: false, abort: null, idleTicks: 0, waiters: [] };
    running = run;
    startWatchdog();
    let end;
    try { end = await drive(job, run); } catch (e) { end = { state: 'failed', error: failureOf(e) }; }
    // a cancel the run saw ends it cancelled, whatever the run's own end (a failure after it)
    if (run.cancel && end.state !== 'done') end = { state: 'cancelled' };
    job.state = end.state;
    job.error = end.state === 'failed' ? end.error : null;
    if (end.state === 'done' && end.out && end.out.msPerFrame > 0 && end.out.fps > 0) rate = rateOf(end.out.msPerFrame, end.out.fps);
    running = null;
    stopWatchdog();
    persist();
    emit();
    for (const res of run.waiters) res(end.state === 'cancelled');   // a job that finished first wasn't cancelled
    pump();
  }

  // ---- what the UI calls ----
  async function enqueue(lift) {
    await loaded();
    const live = jobs.find(j => j.liftId === lift.id && !ended(j.state));
    if (live) return copy(live);
    const job = createJob(`job-${lift.id}`, lift);
    const errors = validateAnalysisJob(job, { lift });
    if (errors.length) throw new Error(`job: ${errors.join('; ')}`);
    jobs = [...jobs.filter(j => j.liftId !== lift.id), job];   // an ended job of the same lift makes way
    persist();
    emit();
    pump();
    return copy(job);
  }

  function cancelNow(id) {
    const job = jobs.find(j => j.id === id);
    if (!job || ended(job.state)) return Promise.resolve(false);
    // the running job first: pump() has taken it but it may still read "queued" while
    // its run starts (the settings read from OPFS), so its state can't tell
    const run = running;
    if (run && run.id === id) {
      run.cancel = true;
      return new Promise(res => run.waiters.push(res));
    }
    if (job.state === 'queued') {
      job.state = 'cancelled';
      persist();
      emit();
      return Promise.resolve(true);
    }
    return Promise.resolve(false);   // not reached: a job in a running stage is the running one
  }

  return {
    load,
    /**
     * Analyse: the marked range of `file` cut and stored as a new lift (s32's
     * keepVideo), then its job queued. Nothing is queued when the cut can't be
     * stored: keepVideo's error (MediaError, or the store's storage-full) comes through.
     */
    async analyse(lift, file, range) {
      await loaded();
      if (typeof keepVideo !== 'function') throw new Error('analyse: the queue was made without keepVideo');
      const kept = await keepVideo(store, lift, file, range);
      return enqueue(kept.lift);
    },
    /** Queues a stored lift (A3's re-mark, a retry): its cut and its range as stored. */
    enqueue,
    /** Cancels a job: a queued one at once, a running one between frames. Resolves once it has stopped: true if cancelled. */
    cancel(id) { return isLoaded ? cancelNow(id) : loaded().then(() => cancelNow(id)); },
    /** A failed or cancelled job queued again, from the start. */
    async retry(id) {
      await loaded();
      const job = jobs.find(j => j.id === id);
      if (!job || (job.state !== 'failed' && job.state !== 'cancelled')) return false;
      jobs = [...jobs.filter(j => j !== job), Object.assign(job, { state: 'queued', progress: null, error: null })];
      persist(); emit(); pump();
      return true;
    },
    /** An ended job taken off the list. */
    async dismiss(id) {
      await loaded();
      const job = jobs.find(j => j.id === id);
      if (!job || !ended(job.state)) return false;
      jobs = jobs.filter(j => j !== job);
      persist(); emit();
      return true;
    },
    /** The jobs, copies, in queue order. */
    jobs: snapshot,
    /** fn(jobs) now and at every change; returns the unsubscribe. */
    subscribe(fn) {
      listeners.add(fn);
      try { fn(snapshot()); } catch { /* the listener's own error */ }
      return () => listeners.delete(fn);
    },
    /** M1–M3's cost of `durationS` seconds of video (estimate.mjs's estimateCost with the last measured rate). */
    async estimate(durationS, opts) { await loaded(); return estimateCost(durationS, rate, opts); },
    /** The last measured rate, or null before the first job is done. */
    rate: () => (rate ? { ...rate } : null),
    /** The page's visibility (document.visibilityState): hidden time is never a stall. */
    setVisible(v) {
      visible = !!v;
      if (visible && running) running.idleTicks = 0;
    },
    /** The engine created now (its warm-up), so the first job doesn't wait for it. */
    warmUp: () => getEngine().then(() => undefined),
    /** True while a job runs or waits. */
    busy: () => !!running || jobs.some(j => j.state === 'queued'),
    /** Resolves when no job runs or waits (the service worker's update waits for it). */
    async idle() {
      await loaded();
      if (!running && !jobs.some(j => j.state === 'queued')) return;
      await new Promise(res => idleWaiters.push(res));
    },
    /** Stops: no new job starts, the watchdog ends, the engine is closed. */
    close() {
      closed = true;
      stopWatchdog();
      dropEngine();
      listeners.clear();
    },
  };
}
