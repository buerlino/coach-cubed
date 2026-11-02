'use strict';
// Q1's logic as plain functions (app/src/ui/analysing-model.mjs, package d15):
// the view state from the queue's jobs. No Preact, no DOM; the screen draws it.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP = path.resolve(__dirname, '..', '..', 'app');
const load = (...p) => import(pathToFileURL(path.join(APP, 'src', ...p)).href);
const model = () => load('ui', 'analysing-model.mjs');

const stored = (id, lift, created, range = { t0: 0.4, t1: 13.4 }) => ({
  id, created, lift, video: `lifts/${id}/cut.mp4`, range,
  track: null, result: null, appVersion: '0.1.0', engine: null,
});
// Local time, so the clock the meta line shows doesn't depend on the machine's zone.
const CREATED = new Date(2026, 10, 1, 14, 32, 5).toISOString();
const LR = stored('20261101-143205-lr', 'lateral-raise', CREATED);
const SN = stored('20261101-144105-sn', 'snatch', new Date(2026, 10, 1, 14, 41, 5).toISOString(), { t0: 0.5, t1: 3.9 });
const job = (l, state, extra = {}) => ({
  id: `job-${l.id}`, liftId: l.id, lift: l.lift, source: l.video, range: { ...l.range },
  state, progress: null, error: null, ...extra,
});
const progress = (stage, done, total, etaS = null) => ({ stage, done, total, etaS });
const RATE = { msPerFrame: 96.7, fps: 30, sPerS: 2.9 };

test('the stage and its share: pose is frames over frames inside the mockup\'s 10-95 % band', async () => {
  const { analysingView } = await model();
  const v = analysingView([job(LR, 'pose', { progress: progress('pose', 195, 390, 20) })], { liftId: LR.id, lift: LR });
  assert.equal(v.kind, 'running');
  assert.equal(v.heading, 'Analysing');
  assert.equal(v.percent, 52);   // 10 + 85 * 0.5, floored
  assert.equal(v.pctLabel, '52%');
  assert.deepEqual(v.stages.map(s => [s.label, s.status]), [['Read the video', 'done'], ['Find the pose', 'now'], ['Score the cues', 'todo']]);
  assert.equal(v.stages[1].detail, 'frame 195 of 390');
  assert.equal(v.stages[0].detail, '');
  assert.equal(v.stages[2].detail, '');
});

test('reading is the first 10 %, scoring the last 5 %, and a running job is never 100 %', async () => {
  const { analysingView } = await model();
  const at = (state, p) => analysingView([job(LR, state, { progress: p })], { liftId: LR.id });
  assert.equal(at('reading', progress('reading', 0, 1)).percent, 0);
  assert.equal(at('reading', progress('reading', 1, 1)).percent, 10);
  assert.equal(at('pose', progress('pose', 0, 390)).percent, 10);
  assert.equal(at('pose', progress('pose', 390, 390)).percent, 95);
  const s = at('scoring', progress('scoring', 0, 1));
  assert.equal(s.percent, 95);
  assert.deepEqual(s.stages.map(g => g.status), ['done', 'done', 'now']);
  assert.equal(at('scoring', progress('scoring', 1, 1)).percent, 99);
});

test('the time left as the mockup rounds it: about N s, rounded up; minutes from two', async () => {
  const { analysingView } = await model();
  const left = eta => analysingView([job(LR, 'pose', { progress: progress('pose', 10, 390, eta) })], { liftId: LR.id }).left;
  assert.equal(left(37.2), 'about 38 s left');
  assert.equal(left(9), 'about 9 s left');
  assert.equal(left(0.2), 'about 1 s left');
  assert.equal(left(0), 'about 1 s left');
  assert.equal(left(119), 'about 119 s left');
  assert.equal(left(150), 'about 3 min left');
});

test('etaS null is never a made-up time: the view says it is measuring', async () => {
  const { analysingView } = await model();
  const v = analysingView([job(LR, 'pose', { progress: progress('pose', 10, 390, null) })], { liftId: LR.id });
  assert.equal(v.left, 'measuring the speed');
  assert.ok(!/\d/.test(v.left));
  assert.equal(v.eta, null);
});

test('the lift card: its name, when it was kept, the marked length and the frames once known', async () => {
  const { analysingView } = await model();
  const v = analysingView([job(LR, 'pose', { progress: progress('pose', 1, 390) })], { liftId: LR.id, lift: LR });
  assert.equal(v.lift.title, 'Lateral raise');
  assert.equal(v.lift.lift, 'lateral-raise');
  assert.equal(v.lift.meta, 'Kept 14:32 · 13.0 s marked · 390 frames');
  const early = analysingView([job(LR, 'reading', { progress: progress('reading', 0, 1) })], { liftId: LR.id, lift: LR });
  assert.equal(early.lift.meta, 'Kept 14:32 · 13.0 s marked');
  const noRecord = analysingView([job(LR, 'reading', { progress: progress('reading', 0, 1) })], { liftId: LR.id });
  assert.equal(noRecord.lift.meta, '13.0 s marked');
});

test('the other lifts in the queue: the next one with its length and time at the measured rate', async () => {
  const { analysingView } = await model();
  const jobs = [job(LR, 'pose', { progress: progress('pose', 1, 390, 30) }), job(SN, 'queued')];
  const v = analysingView(jobs, { liftId: LR.id, rate: RATE });
  assert.equal(v.queue.label, 'Next in the queue');
  assert.equal(v.queue.items.length, 1);
  assert.equal(v.queue.items[0].text, 'Snatch · 3.4 s · about 10 s');
  assert.equal(v.queue.more, 0);
});

test('the queue shows no time for a lift before a rate is measured', async () => {
  const { analysingView } = await model();
  const jobs = [job(LR, 'pose', { progress: progress('pose', 1, 390, null) }), job(SN, 'queued')];
  const v = analysingView(jobs, { liftId: LR.id, rate: null });
  assert.equal(v.queue.items[0].text, 'Snatch · 3.4 s');
});

test('more than one other lift: the first shown, the rest counted; ended jobs are not in the queue', async () => {
  const { analysingView } = await model();
  const A = stored('20261101-150000-lr', 'lateral-raise', CREATED, { t0: 0, t1: 2 });
  const B = stored('20261101-150100-lr', 'lateral-raise', CREATED, { t0: 0, t1: 2 });
  const done = stored('20261101-130000-lr', 'lateral-raise', CREATED);
  const jobs = [job(done, 'done'), job(LR, 'reading', { progress: progress('reading', 0, 1) }), job(SN, 'queued'), job(A, 'queued'), job(B, 'failed', { error: 'x' })];
  const v = analysingView(jobs, { liftId: LR.id, rate: RATE });
  assert.equal(v.queue.items.length, 2);
  assert.equal(v.queue.more, 1);
  assert.deepEqual(v.queue.items.map(i => i.liftId), [SN.id, A.id]);
});

test('nothing else in the queue: no queue block', async () => {
  const { analysingView } = await model();
  assert.equal(analysingView([job(LR, 'reading', { progress: progress('reading', 0, 1) })], { liftId: LR.id }).queue, null);
});

test('a queued job waits: its place in the queue, nothing to measure, cancel offered', async () => {
  const { analysingView } = await model();
  const jobs = [job(LR, 'pose', { progress: progress('pose', 5, 390, 30) }), job(SN, 'queued')];
  const v = analysingView(jobs, { liftId: SN.id, lift: SN, rate: RATE });
  assert.equal(v.kind, 'waiting');
  assert.equal(v.percent, 0);
  assert.equal(v.left, 'waiting');
  assert.deepEqual(v.stages.map(s => s.status), ['todo', 'todo', 'todo']);
  assert.equal(v.queue.label, 'Ahead in the queue');
  assert.equal(v.queue.items[0].liftId, LR.id);
  assert.equal(v.actions.cancel, true);
  assert.equal(v.actions.retry, false);
});

test('a failed job: its reason in the engine\'s words, retry instead of cancel, the stages it reached', async () => {
  const { analysingView } = await model();
  const j = job(LR, 'failed', { progress: progress('pose', 120, 390), error: 'No person found in the video' });
  const v = analysingView([j], { liftId: LR.id, lift: LR });
  assert.equal(v.kind, 'failed');
  assert.equal(v.heading, "Couldn't analyse");
  assert.equal(v.reason, 'No person found in the video');
  assert.equal(v.actions.cancel, false);
  assert.equal(v.actions.retry, true);
  assert.equal(v.actions.open, null);
  assert.deepEqual(v.stages.map(s => s.status), ['done', 'todo', 'todo']);
  assert.equal(v.left, '');
});

test('a cancelled job: stopped, retry offered, no reason', async () => {
  const { analysingView } = await model();
  const v = analysingView([job(LR, 'cancelled', { progress: progress('pose', 120, 390) })], { liftId: LR.id });
  assert.equal(v.kind, 'cancelled');
  assert.equal(v.heading, 'Stopped');
  assert.equal(v.reason, null);
  assert.equal(v.actions.retry, true);
  assert.equal(v.actions.cancel, false);
});

test('a paused job: the app was in the background, so nothing is claimed about the time left', async () => {
  const { analysingView } = await model();
  const jobs = [job(LR, 'pose', { progress: progress('pose', 120, 390, 22) })];
  const v = analysingView(jobs, { liftId: LR.id, visible: false });
  assert.equal(v.kind, 'paused');
  assert.equal(v.heading, 'Analysing');
  assert.equal(v.percent, 36);
  assert.equal(v.left, 'paused');
  assert.equal(v.actions.cancel, true);
  assert.equal(analysingView(jobs, { liftId: LR.id, visible: true }).kind, 'running');
  // a job that is only waiting is waiting, hidden or not
  assert.equal(analysingView([job(LR, 'queued')], { liftId: LR.id, visible: false }).kind, 'waiting');
});

test('done leads to the result: Ready, 100 %, every stage ticked, the step to A1 with the lift\'s id', async () => {
  const { analysingView } = await model();
  const v = analysingView([job(LR, 'done', { progress: progress('scoring', 1, 1) })], { liftId: LR.id });
  assert.equal(v.kind, 'done');
  assert.equal(v.heading, 'Ready');
  assert.equal(v.percent, 100);
  assert.equal(v.left, 'done');
  assert.deepEqual(v.stages.map(s => s.status), ['done', 'done', 'done']);
  assert.deepEqual(v.actions.open, { to: 'result', params: { liftId: LR.id } });
  assert.equal(v.actions.cancel, false);
});

test('a lift already analysed whose job the queue no longer holds is done too', async () => {
  const { analysingView } = await model();
  const analysed = { ...LR, track: `lifts/${LR.id}/track.json`, result: `lifts/${LR.id}/result.json`, engine: { model: 'm', backend: 'webgl', runtime: 'r' } };
  const v = analysingView([], { liftId: LR.id, lift: analysed });
  assert.equal(v.kind, 'done');
  assert.deepEqual(v.actions.open, { to: 'result', params: { liftId: LR.id } });
});

test('a stored lift with no job and no result is stopped and can be queued again', async () => {
  const { analysingView } = await model();
  const v = analysingView([], { liftId: LR.id, lift: LR });
  assert.equal(v.kind, 'cancelled');
  assert.equal(v.actions.retry, true);
  assert.equal(v.jobId, null);
});

test('no lift named: the running job is shown, else the first waiting, else nothing', async () => {
  const { analysingView } = await model();
  const run = job(LR, 'pose', { progress: progress('pose', 1, 390) });
  assert.equal(analysingView([job(SN, 'queued'), run], {}).liftId, LR.id);
  assert.equal(analysingView([job(SN, 'queued')], {}).liftId, SN.id);
  const idle = analysingView([job(SN, 'done')], {});
  assert.equal(idle.kind, 'idle');
  assert.equal(idle.actions.cancel, false);
  assert.equal(analysingView([], {}).kind, 'idle');
});

test('the view does not change the jobs it is given', async () => {
  const { analysingView } = await model();
  const jobs = [job(LR, 'pose', { progress: progress('pose', 1, 390, 5) }), job(SN, 'queued')];
  const before = JSON.stringify(jobs);
  analysingView(jobs, { liftId: LR.id, lift: LR, rate: RATE });
  assert.equal(JSON.stringify(jobs), before);
});

// ---- leaving Q1 and coming back ----
function fakeQueue(jobs = []) {
  const listeners = new Set();
  let current = jobs;
  let kept = null;
  return {
    set(next) { current = next; for (const fn of [...listeners]) fn(current.map(j => ({ ...j }))); },
    setRate(r) { kept = r; },
    subscribe(fn) { listeners.add(fn); fn(current.map(j => ({ ...j }))); return () => listeners.delete(fn); },
    load: async () => current.map(j => ({ ...j })),
    rate: () => kept,
    listeners,
  };
}

test('leaving Q1 and coming back rebuilds the view from the queue, live', async () => {
  const { analysingView, followAnalysis } = await model();
  const q = fakeQueue([job(LR, 'pose', { progress: progress('pose', 100, 390, 30) })]);
  const first = [];
  const off = followAnalysis(q, s => first.push(analysingView(s.jobs, { liftId: LR.id, lift: LR, rate: s.rate })));
  await new Promise(r => setImmediate(r));
  assert.equal(first.at(-1).percent, 31);
  off();
  assert.equal(q.listeners.size, 0, 'leaving Q1 unsubscribes');

  // the job goes on while the user is on H
  q.set([job(LR, 'pose', { progress: progress('pose', 300, 390, 8) })]);
  q.setRate(RATE);

  const second = [];
  const back = followAnalysis(q, s => second.push(analysingView(s.jobs, { liftId: LR.id, lift: LR, rate: s.rate })));
  await new Promise(r => setImmediate(r));
  assert.equal(second.at(-1).percent, 75, 'rebuilt from the queue as it is now');
  assert.equal(second.at(-1).left, 'about 8 s left');
  assert.equal(first.at(-1).percent, 31, 'the first follow saw nothing after it left');

  // and live: the next change reaches the new view, the end included
  q.set([job(LR, 'done', { progress: progress('scoring', 1, 1) })]);
  assert.equal(second.at(-1).kind, 'done');
  assert.equal(second.at(-1).actions.open.to, 'result');
  back();
  assert.equal(q.listeners.size, 0);
});

test('a follow waits for the queue to load before it says anything', async () => {
  const { followAnalysis } = await model();
  const q = fakeQueue([job(LR, 'queued')]);
  let release;
  q.load = () => new Promise(res => { release = () => res([job(LR, 'queued')]); });
  q.subscribe = fn => { fn([]); return () => {}; };   // the queue's first call, before it has read its file
  const seen = [];
  followAnalysis(q, s => seen.push(s.jobs.length));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(seen, [], 'an empty list before load() is not the queue');
  release();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(seen, [1]);
});
