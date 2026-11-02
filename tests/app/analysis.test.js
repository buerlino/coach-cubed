'use strict';
// The analysis job and its queue (package s12, app/src/analysis/): a stored
// cut read back, every frame of the marked range through the pose engine, the
// track in the fixture format, the scoring adapter, the track and the result
// saved through the store; one job at a time, in order, with progress by stage,
// the time left, cancel, and a job cut off (the app closed, the WebView frozen)
// restarted or resumed, never left hanging.
//
// What is real here: the store (c8) over the in-memory OPFS fake, the contracts,
// the scoring adapter (s11) with diagnostics.js, and in the Analyse test s32's
// keepVideo on s9's committed clip. What is fake: the frame source (Node has no
// WebCodecs), the pose engine (no worker, no TF.js) and the clock and timers.
//
// Where the expected values come from:
//  - the frames in a range, from the fake source's own frame times (worked out
//    here, not by the job);
//  - the time left, from the per-frame times the fake engine is told to take,
//    with the median written out below;
//  - the first-run estimate, ui-design.md ("What the mockups add"): about 2.9 s
//    of processing per second of 30 fps video, MoveNet Thunder, WebGL, Brave on
//    the Fairphone;
//  - the result of a committed fixture track, from scoreLift() on that track
//    alone (tests/fixtures/global/, the adapter's own test pins it to the goldens).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createFakeStorage } = require('./fake-opfs.js');
const { loadDiagnostics } = require('../loadDiagnostics');
const { trackPathFor } = require('../fixtures');

const APP = path.join(__dirname, '..', '..', 'app');
const load = rel => import(pathToFileURL(path.join(APP, rel)).href);
const CLIP = path.join(__dirname, 'clips', 'testsrc2-h264-30fps.mp4');
const Diagnostics = loadDiagnostics();
const ENGINE_INFO = { model: 'movenet-thunder', backend: 'webgl', runtime: 'tfjs 4.22.0', initMs: 1 };
const NOW = () => new Date('2026-11-02T09:00:00.000Z');

// ---- fakes ----

// A standing person, in the frame's pixels: a made-up shape, as scoring.test.js has.
function standing() {
  const pts = Array.from({ length: 17 }, () => [100, 100, 0.9]);
  pts[0] = [150, 220, 0.9]; pts[5] = [250, 215, 0.95]; pts[6] = [250, 225, 0.95];
  pts[11] = [400, 155, 0.95]; pts[12] = [400, 165, 0.95];
  return pts;
}

// A frame source over no video: frames shaped like VideoFrames at the given times
// (seconds), each knowing its index for the fake engine; frames(t0, t1) gives the
// ones starting in [t0, t1], as contract 5 says.
function fakeSource({ fps = 30, width = 640, height = 480, frameTimes }) {
  const times = frameTimes || Array.from({ length: 60 }, (_, i) => i / fps);
  const made = [];
  const frame = i => {
    const f = { index: i, timestamp: times[i] * 1e6, duration: 1e6 / fps, displayWidth: width, displayHeight: height, closed: false,
      close() { f.closed = true; } };
    made.push(f);
    return f;
  };
  const src = {
    info: { duration: times[times.length - 1] + 1 / fps, fps, width, height, rotation: 0, codec: 'avc1.64001f' },
    frameTimes: Object.freeze(times.slice()),
    made, closed: false,
    async frameAt(t) { return frame(Math.max(0, times.findLastIndex(x => x <= t))); },
    async *frames(t0, t1) {
      for (let i = 0; i < times.length; i++) if (times[i] >= t0 - 1e-6 && times[i] <= t1 + 1e-6) yield frame(i);
    },
    async thumbnails() { return []; },
    close() { src.closed = true; },
  };
  return src;
}
const inRange = (times, { t0, t1 }) => times.filter(t => t >= t0 - 1e-6 && t <= t1 + 1e-6).length;

// The pose engine's interface (s10's PoseEngine): estimate takes the frame and closes it.
function fakeEngine({ clock, ms = () => 100, keypoints = () => standing(), hold = null, fail = null } = {}) {
  const e = {
    info: { ...ENGINE_INFO }, frames: [], resets: 0, closed: false,
    async estimate(frame, tMs) {
      if (e.closed) throw new Error('pose engine closed');
      e.frames.push({ index: frame.index, tMs });
      frame.close();
      const n = e.frames.length;
      if (hold) await hold(n, frame);
      if (fail && fail(n)) throw new Error('worker: WebGL context lost');
      if (clock) clock.t += ms(n);
      return { keypoints: keypoints(frame, n), ms: ms(n) };
    },
    async reset() { if (e.closed) throw new Error('pose engine closed'); e.resets++; },
    close() { e.closed = true; },
  };
  return e;
}

// Timers the test drives: tick(n) runs every interval n times.
function fakeTimers() {
  const fns = new Map();
  let next = 1;
  return {
    setInterval(fn) { fns.set(next, fn); return next++; },
    clearInterval(id) { fns.delete(id); },
    tick(n = 1) { for (let k = 0; k < n; k++) for (const fn of [...fns.values()]) fn(); },
    get active() { return fns.size; },
  };
}

const settle = () => new Promise(r => setImmediate(r));
async function until(cond, what) {
  for (let k = 0; k < 500; k++) { if (cond()) return; await settle(); }
  throw new Error(`timed out waiting for ${what}`);
}

async function setup({ storage, engines, sources, ...opts } = {}) {
  const { createStore } = await load('src/store/index.mjs');
  const { createQueue } = await load('src/analysis/index.mjs');
  const fake = storage || createFakeStorage();
  const store = createStore({ storage: fake.storage, now: NOW, appVersion: '0.1.0' });
  const clock = { t: 0, now() { return clock.t; } };
  const timers = fakeTimers();
  const made = [];
  const opened = [];
  const createEngine = async () => {
    const e = engines ? engines(made.length, clock) : fakeEngine({ clock });
    made.push(e);
    return e;
  };
  const openFrameSource = async blob => {
    const src = sources ? sources(blob, opened.length) : fakeSource({});
    opened.push({ blob, src });
    return src;
  };
  const queue = createQueue({
    store, createEngine, openFrameSource, Diagnostics, now: clock.now, timers, stallMs: 30000, tickMs: 1000, ...opts,
  });
  return { fake, store, queue, clock, timers, made, opened };
}

async function storeLift(store, { lift = 'lateral-raise', range = { t0: 0.5, t1: 1.2 }, bytes = [1, 2, 3, 4] } = {}) {
  return store.saveLift({ lift, video: new Blob([Uint8Array.from(bytes)], { type: 'video/mp4' }), range });
}

// Every snapshot a subscriber gets, per job id.
function record(queue) {
  const seen = new Map();
  const all = [];
  queue.subscribe(jobs => {
    all.push(jobs);
    for (const j of jobs) {
      if (!seen.has(j.id)) seen.set(j.id, []);
      seen.get(j.id).push(j);
    }
  });
  return { seen, all, states: id => (seen.get(id) || []).map(j => j.state).filter((s, i, a) => i === 0 || s !== a[i - 1]) };
}

// ---- the job's way through the queue ----

test('jobs go queued, reading, pose, scoring, done, one at a time, in order, and pass contract 2 throughout', async () => {
  const { validateAnalysisJob } = await load('src/contracts/analysis-job.mjs');
  const { store, queue, made } = await setup();
  const a = await storeLift(store, { range: { t0: 0.5, t1: 1.0 } });
  const b = await storeLift(store, { lift: 'snatch', range: { t0: 0.2, t1: 0.6 } });
  const rec = record(queue);
  const ja = await queue.enqueue(a);
  const jb = await queue.enqueue(b);
  assert.equal(ja.state, 'queued');
  assert.equal(ja.source, a.video);
  assert.deepEqual(ja.range, a.range);
  await queue.idle();

  assert.deepEqual(rec.states(ja.id), ['queued', 'reading', 'pose', 'scoring', 'done']);
  assert.deepEqual(rec.states(jb.id), ['queued', 'reading', 'pose', 'scoring', 'done']);
  // one at a time: while a runs, b waits queued; b starts after a is done
  for (const jobs of rec.all) {
    const running = jobs.filter(j => ['reading', 'pose', 'scoring'].includes(j.state));
    assert.ok(running.length <= 1, 'one job runs at a time');
    const sa = jobs.find(j => j.id === ja.id), sb = jobs.find(j => j.id === jb.id);
    if (sb && sb.state !== 'queued') assert.equal(sa.state, 'done', 'b starts after a');
  }
  // one engine for the queue, a's frames before b's
  assert.equal(made.length, 1);
  const lifts = { [ja.id]: a, [jb.id]: b };
  for (const [id, snaps] of rec.seen) for (const j of snaps) assert.deepEqual(validateAnalysisJob(j, { lift: lifts[id] }), [], `${id} ${j.state}`);
});

test('progress per stage: reading, then every frame of the range posed, then scoring', async () => {
  const { store, queue } = await setup();
  const lift = await storeLift(store, { range: { t0: 0.5, t1: 1.0 } });
  const rec = record(queue);
  const job = await queue.enqueue(lift);
  await queue.idle();
  const total = inRange(Array.from({ length: 60 }, (_, i) => i / 30), lift.range);
  const snaps = rec.seen.get(job.id).filter(j => j.progress);
  const by = stage => snaps.filter(j => j.state === stage).map(j => [j.progress.done, j.progress.total]);
  assert.deepEqual(by('reading').at(-1), [1, 1]);
  assert.deepEqual(by('reading')[0], [0, 1]);
  const pose = by('pose');
  assert.deepEqual(pose[0], [0, total]);
  assert.deepEqual(pose.map(p => p[0]), Array.from({ length: total + 1 }, (_, i) => i), 'done counts every posed frame');
  assert.ok(pose.every(p => p[1] === total));
  assert.deepEqual(by('scoring'), [[0, 1], [1, 1]]);
  const done = rec.seen.get(job.id).at(-1);
  assert.equal(done.state, 'done');
  assert.deepEqual([done.progress.stage, done.progress.done, done.progress.total], ['scoring', 1, 1]);
});

test('the time left comes from the running median of the measured ms per frame', async () => {
  // per frame: 100, 400, 100, 300, 100, 100, … ms (the clock moves while the engine works)
  const costs = [100, 400, 100, 300];
  const ms = n => costs[n - 1] ?? 100;
  const { store, queue } = await setup({ engines: (k, clock) => fakeEngine({ clock, ms }) });
  const lift = await storeLift(store, { range: { t0: 0, t1: 0.5 } });
  const rec = record(queue);
  const job = await queue.enqueue(lift);
  await queue.idle();
  const pose = rec.seen.get(job.id).filter(j => j.state === 'pose');
  const total = pose[0].progress.total;
  assert.equal(total, 16);
  assert.equal(pose[0].progress.etaS, null, 'no measurement yet on a first run');
  // medians of the first n frames: 100; 250; 100; 200; 100; then 100
  const medians = [100, 250, 100, 200, 100];
  for (const j of pose.slice(1)) {
    const n = j.progress.done;
    const med = medians[n - 1] ?? 100;
    assert.ok(Math.abs(j.progress.etaS - med * (total - n) / 1000) < 1e-9, `after ${n} frames`);
  }
});

test('cancel stops between frames, resets the engine, and leaves the lift unanalysed', async () => {
  let queue;
  let cancelled;
  const { store, queue: q, made, opened } = await setup({
    engines: (k, clock) => fakeEngine({ clock, hold: async n => { if (n === 3) cancelled = queue.cancel(job.id); } }),
  });
  queue = q;
  const lift = await storeLift(store, { range: { t0: 0, t1: 1 } });
  const job = await queue.enqueue(lift);
  await queue.idle();
  await cancelled;
  const e = made[0];
  assert.equal(e.frames.length, 3, 'the frame in flight finishes, no next frame is sent');
  assert.equal(e.resets, 1, 'the engine is reset after a cancel');
  const end = queue.jobs().find(j => j.id === job.id);
  assert.equal(end.state, 'cancelled');
  assert.equal(end.error, null);
  assert.ok(opened[0].src.closed, 'the source is closed');
  assert.ok(opened[0].src.made.every(f => f.closed), 'no frame is left open');
  assert.equal((await store.getLift(lift.id)).track, null);
  assert.equal((await store.readQueue()).jobs.find(j => j.id === job.id).state, 'cancelled');
});

test('a queued job is cancelled before it runs; cancel of an ended job changes nothing', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { store, queue, made } = await setup({ engines: (k, clock) => fakeEngine({ clock, hold: () => gate }) });
  const a = await storeLift(store);
  const b = await storeLift(store);
  const ja = await queue.enqueue(a);
  const jb = await queue.enqueue(b);
  await until(() => made[0] && made[0].frames.length === 1, 'a in pose');
  await queue.cancel(jb.id);
  assert.equal(queue.jobs().find(j => j.id === jb.id).state, 'cancelled');
  assert.equal(queue.jobs().find(j => j.id === jb.id).progress, null);
  release();
  await queue.idle();
  assert.equal(queue.jobs().find(j => j.id === ja.id).state, 'done');
  assert.ok(made[0].frames.every(f => f.index !== undefined));
  assert.equal(await queue.cancel(ja.id), false);
  assert.equal(queue.jobs().find(j => j.id === ja.id).state, 'done');
});

test('a failed job says why, and the queue goes on with the next', async () => {
  let calls = 0;
  const { store, queue } = await setup({
    sources: () => {
      if (calls++ === 0) { const e = new Error("This video's format (hvc1) can't be decoded on this device."); e.code = 'unsupported-codec'; throw e; }
      return fakeSource({});
    },
  });
  const a = await storeLift(store);
  const b = await storeLift(store);
  const ja = await queue.enqueue(a);
  const jb = await queue.enqueue(b);
  await queue.idle();
  const fa = queue.jobs().find(j => j.id === ja.id);
  assert.equal(fa.state, 'failed');
  assert.equal(fa.error, "This video's format (hvc1) can't be decoded on this device.");
  assert.equal(queue.jobs().find(j => j.id === jb.id).state, 'done');
  // the failure is kept: a queue read back after a restart still says why
  const saved = await store.readQueue();
  assert.equal(saved.jobs.find(j => j.id === ja.id).error, fa.error);
});

test('an engine that fails is replaced once; failing again fails the job in its words', async () => {
  const { store, queue, made } = await setup({ engines: (k, clock) => fakeEngine({ clock, fail: n => n === 2 }) });
  const lift = await storeLift(store);
  const job = await queue.enqueue(lift);
  await queue.idle();
  assert.equal(made.length, 2);
  assert.ok(made[0].closed);
  const end = queue.jobs().find(j => j.id === job.id);
  assert.equal(end.state, 'failed');
  assert.equal(end.error, 'worker: WebGL context lost');
});

test('the track and the result are saved through the store, the track in the fixture format', async () => {
  const { validateTrack, APP_PERSON_ID } = await load('src/contracts/track.mjs');
  const { validateResultView } = await load('src/contracts/cue-view.mjs');
  const { scoreLift } = await load('src/scoring/score.mjs');
  const { validateStoredLift } = await load('src/contracts/stored-lift.mjs');
  const times = Array.from({ length: 40 }, (_, i) => 0.0331 * i);   // not a round rate: the times are the authority
  const nobody = new Set([4, 7]);   // frames in the range where the model found nobody
  const { store, queue } = await setup({
    sources: () => fakeSource({ fps: 30.2, width: 360, height: 640, frameTimes: times }),
    engines: (k, clock) => fakeEngine({ clock, keypoints: f => (nobody.has(f.index) ? null : standing()) }),
  });
  const lift = await storeLift(store, { range: { t0: 0.1, t1: 0.9 } });
  await queue.enqueue(lift);
  await queue.idle();
  const stored = await store.getLift(lift.id);
  assert.deepEqual(validateStoredLift(stored), []);
  assert.deepEqual(stored.engine, { model: ENGINE_INFO.model, backend: ENGINE_INFO.backend, runtime: ENGINE_INFO.runtime });
  const track = await store.readTrack(lift.id);
  assert.deepEqual(validateTrack(track), []);
  const want = times.map((t, i) => [t, i]).filter(([t]) => t >= 0.1 - 1e-6 && t <= 0.9 + 1e-6);
  assert.deepEqual(track.meta.frame_indices, want.map(([, i]) => i), 'indices are frames of the cut');
  assert.deepEqual(track.meta.frame_times_ms, want.map(([t]) => t * 1e6 / 1000));
  assert.equal(track.meta.frame_count, 40);
  assert.equal(track.meta.fps, 30.2);
  assert.deepEqual([track.meta.width, track.meta.height], [360, 640]);
  assert.equal(track.meta.tracks.kept, APP_PERSON_ID);
  assert.equal(track.meta.tracks.kept_frames, want.filter(([, i]) => !nobody.has(i)).length);
  assert.deepEqual(track.keypoints['7'], {});
  assert.equal(track.keypoints['3'], undefined, 'a frame before the range is not posed');
  const result = await store.readResult(lift.id);
  assert.deepEqual(validateResultView(result), []);
  assert.deepEqual(result, JSON.parse(JSON.stringify(scoreLift(track, 'lateral-raise', { Diagnostics }).view)));
});

// ---- cut off, and back ----

test('the app closed mid-job: the job restarts when the app is back, its source found in the store', async () => {
  const fake = createFakeStorage();
  const first = await setup({ storage: fake, engines: (k, clock) => fakeEngine({ clock, hold: n => (n === 4 ? new Promise(() => {}) : null) }) });
  const lift = await storeLift(first.store, { range: { t0: 0.2, t1: 0.8 }, bytes: [9, 8, 7, 6, 5] });
  const job = await first.queue.enqueue(lift);
  await until(() => first.made[0] && first.made[0].frames.length === 4, 'the first app in pose');
  const saved = await first.store.readQueue();
  assert.equal(saved.jobs.find(j => j.id === job.id).state, 'pose', 'the queue is kept as the job runs');
  // the app is gone (nothing closes it); a new one opens the same storage
  const second = await setup({ storage: fake });
  const back = await second.queue.load();
  assert.equal(back.find(j => j.id === job.id).state, 'queued', 'a job cut off is queued again');
  await second.queue.idle();
  const end = second.queue.jobs().find(j => j.id === job.id);
  assert.equal(end.state, 'done');
  assert.deepEqual([...new Uint8Array(await second.opened[0].blob.arrayBuffer())], [9, 8, 7, 6, 5], 'the source is the stored cut');
  assert.ok((await second.store.getLift(lift.id)).track);
  assert.equal((await second.store.readQueue()).jobs.some(j => j.id === job.id), false, 'a done job leaves the kept queue');
});

test('the WebView frozen: hidden time is no stall, and the job resumes where it was', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { store, queue, made, timers } = await setup({ engines: (k, clock) => fakeEngine({ clock, hold: n => (n === 2 ? gate : null) }) });
  const lift = await storeLift(store);
  const job = await queue.enqueue(lift);
  await until(() => made[0] && made[0].frames.length === 2, 'frame 2 in flight');
  queue.setVisible(false);
  timers.tick(1000);                 // far past the stall time, all of it hidden
  await settle();
  queue.setVisible(true);
  timers.tick(29);                   // back, but less than 30 s without progress
  release();
  await queue.idle();
  assert.equal(made.length, 1, 'the engine was kept');
  assert.equal(queue.jobs().find(j => j.id === job.id).state, 'done');
});

test('a hang while visible: the engine is replaced and the job restarts; a second hang fails it', async () => {
  // first the first engine hangs on its 3rd frame; then every 3rd frame sent hangs, whichever engine
  let phase = 1, calls = 0;
  const never = () => new Promise(() => {});
  const { store, queue, made, timers } = await setup({
    engines: (k, clock) => fakeEngine({ clock, hold: n => {
      if (phase === 1) return k === 0 && n === 3 ? never() : null;
      return ++calls % 3 === 0 ? never() : null;
    } }),
  });
  const lift = await storeLift(store);
  const rec = record(queue);
  const job = await queue.enqueue(lift);
  await until(() => made[0] && made[0].frames.length === 3, 'the first hang');
  timers.tick(29);
  await settle();
  assert.equal(made.length, 1, 'not yet: 29 s');
  timers.tick(1);
  await queue.idle();
  assert.equal(made.length, 2);
  assert.ok(made[0].closed, 'the hung engine is closed');
  assert.equal(queue.jobs().find(j => j.id === job.id).state, 'done');
  assert.deepEqual(rec.states(job.id), ['queued', 'reading', 'pose', 'reading', 'pose', 'scoring', 'done'], 'restarted from the start');

  phase = 2;
  const other = await storeLift(store);
  const j2 = await queue.enqueue(other);
  await until(() => calls === 3, 'the second job hangs');
  assert.equal(made[1].resets, 1, 'the kept engine was reset for the new clip');
  timers.tick(30);
  await until(() => calls === 6, 'and hangs again on a new engine');
  assert.equal(made.length, 3);
  timers.tick(30);
  await queue.idle();
  const end = queue.jobs().find(j => j.id === j2.id);
  assert.equal(end.state, 'failed');
  assert.match(end.error, /stopped responding/);
  assert.ok(made[2].closed);
  assert.equal(timers.active, 0, 'no watchdog left running');
});

// ---- the cost while marking ----

test('the estimate before Analyse: 2.9 s per second of 30 fps video on a first run, then the measured rate', async () => {
  const { estimateCost, DEFAULT_RATE } = await load('src/analysis/index.mjs');
  // ui-design.md, "What the mockups add": about 2.9 s per second of 30 fps video on the Fairphone
  assert.equal(DEFAULT_RATE.sPerS, 2.9);
  assert.equal(DEFAULT_RATE.fps, 30);
  const fake = createFakeStorage();
  const { store, queue } = await setup({ storage: fake, engines: (k, clock) => fakeEngine({ clock, ms: () => 50 }) });
  const first = await queue.estimate(10);
  assert.ok(Math.abs(first.seconds - 29) < 1e-9);
  assert.equal(first.measured, false);
  assert.match(first.basis, /Fairphone/);
  assert.ok(Math.abs((await queue.estimate(10, { fps: 60 })).seconds - 58) < 1e-9, 'twice the frames, twice the time');
  assert.deepEqual(estimateCost(10, null), first);

  const lift = await storeLift(store, { range: { t0: 0, t1: 1 } });
  await queue.enqueue(lift);
  await queue.idle();
  const after = await queue.estimate(10);
  // 50 ms a frame at the source's 30 fps: 1.5 s per second of video
  assert.equal(after.measured, true);
  assert.ok(Math.abs(after.perSecond - 1.5) < 1e-9);
  assert.ok(Math.abs(after.seconds - 15) < 1e-9);
  // kept across a restart
  const again = await setup({ storage: fake });
  await again.queue.load();
  const kept = await again.queue.estimate(10);
  assert.equal(kept.measured, true);
  assert.ok(Math.abs(kept.seconds - 15) < 1e-9);
  // and the time left of a new job starts from it, before its first frame
  const rec = record(again.queue);
  const j = await again.queue.enqueue(await storeLift(again.store, { range: { t0: 0, t1: 1 } }));
  await again.queue.idle();
  const firstPose = rec.seen.get(j.id).find(s => s.state === 'pose');
  assert.ok(Math.abs(firstPose.progress.etaS - 0.05 * firstPose.progress.total) < 1e-9);
});

// ---- Analyse: the cut first ----

test('at Analyse the cut is stored before the job starts, and the job reads the stored cut in its timeline', async () => {
  const { keepVideo, cutVideo } = await load('src/media/cut.mjs');
  const file = new Blob([fs.readFileSync(CLIP)], { type: 'video/mp4' });
  const log = [];
  const fake = createFakeStorage();
  const { createStore } = await load('src/store/index.mjs');
  const real = createStore({ storage: fake.storage, now: NOW, appVersion: '0.1.0' });
  const store = { ...real, saveLift: async x => { const r = await real.saveLift(x); log.push('saved'); return r; } };
  const { createQueue } = await load('src/analysis/index.mjs');
  const opened = [];
  const queue = createQueue({
    store, keepVideo, Diagnostics, timers: fakeTimers(), now: () => 0,
    createEngine: async () => { log.push('engine'); return fakeEngine({}); },
    openFrameSource: async blob => { log.push('opened'); opened.push(blob); return fakeSource({}); },
  });
  queue.subscribe(jobs => { for (const j of jobs) if (log.at(-1) !== j.state) log.push(j.state); });
  const job = await queue.analyse('lateral-raise', file, { t0: 1.2, t1: 2.0 });
  await queue.idle();
  assert.equal(log[0], 'saved', 'the cut is stored first');
  assert.ok(log.indexOf('queued') > 0 && log.indexOf('opened') > log.indexOf('queued'));
  const cut = await cutVideo(file, { t0: 1.2, t1: 2.0 });
  const lift = await real.getLift(job.liftId);
  assert.equal(job.source, lift.video);
  assert.deepEqual(job.range, cut.range, 'the range is in the cut\'s timeline');
  assert.deepEqual(lift.range, cut.range);
  assert.notEqual(opened[0], file, 'never the picked file');
  const stored = await real.readVideo(job.liftId);
  assert.deepEqual(Buffer.from(await opened[0].arrayBuffer()), Buffer.from(await stored.arrayBuffer()));
  assert.deepEqual(Buffer.from(await opened[0].arrayBuffer()), Buffer.from(await cut.blob.arrayBuffer()));
});

test('a cut that cannot be stored starts no job, and the store\'s error comes through', async () => {
  const { keepVideo } = await load('src/media/cut.mjs');
  const file = new Blob([fs.readFileSync(CLIP)], { type: 'video/mp4' });
  const { store, queue } = await setup({ storage: createFakeStorage({ quota: 1000 }), keepVideo });
  await assert.rejects(() => queue.analyse('snatch', file, { t0: 0, t1: 2.9 }), { code: 'storage-full' });
  assert.deepEqual(queue.jobs(), []);
  assert.deepEqual(await store.listLifts(), []);
});

// ---- the kept queue ----

test('the store keeps the queue: valid jobs only, written whole', async () => {
  const { createJob } = await load('src/contracts/analysis-job.mjs');
  const { store, fake } = await setup();
  assert.deepEqual(await store.readQueue(), { jobs: [], rate: null });
  const lift = await storeLift(store);
  const job = createJob('job-' + lift.id, lift);
  await store.saveQueue({ jobs: [job], rate: { msPerFrame: 90, fps: 30, sPerS: 2.7 } });
  assert.deepEqual(await store.readQueue(), { jobs: [job], rate: { msPerFrame: 90, fps: 30, sPerS: 2.7 } });
  await assert.rejects(() => store.saveQueue({ jobs: [{ ...job, source: new Blob([]) }], rate: null }), { code: 'invalid' });
  assert.ok(fake.ops.some(o => /queue\.json/.test(JSON.stringify(o))));
});

// ---- the engine's place taken by a committed track ----

for (const slug of ['global/example/lateral-raise-cable-1', 'global/snatch/Session14_01_0h18m07s_made']) {
  test(`${slug}: its track fed in place of the engine gives the adapter's result`, async () => {
    const { scoreLift } = await load('src/scoring/score.mjs');
    const fixture = JSON.parse(fs.readFileSync(trackPathFor(slug), 'utf8'));
    const { meta } = fixture;
    const lift = slug.includes('snatch') ? 'snatch' : 'lateral-raise';
    const times = meta.frame_times_ms.map(ms => ms / 1000);
    const { store, queue } = await setup({
      sources: () => {
        const src = fakeSource({ fps: meta.fps, width: meta.width, height: meta.height, frameTimes: times });
        // the decoder's timestamps are the track's times
        const frames = src.frames;
        src.frames = async function* (t0, t1) { for await (const f of frames(t0, t1)) { f.timestamp = meta.frame_times_ms[f.index] * 1000; yield f; } };
        return src;
      },
      engines: (k, clock) => fakeEngine({ clock, keypoints: f => (fixture.keypoints[String(f.index)] || {})[meta.tracks.kept] || null }),
    });
    const stored = await storeLift(store, { lift, range: { t0: 0, t1: times.at(-1) } });
    await queue.enqueue(stored);
    await queue.idle();
    const track = await store.readTrack(stored.id);
    assert.equal(track.meta.frames_processed, meta.frames_processed);
    const alone = scoreLift(fixture, lift, { Diagnostics }).view;
    assert.deepEqual(await store.readResult(stored.id), JSON.parse(JSON.stringify(alone)));
  });
}
