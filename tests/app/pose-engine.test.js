'use strict';
// The pose engine (package s10), app/src/pose/: the client that talks to the
// worker (pose-client.mjs) and the worker's message handler (worker-core.mjs),
// both against fakes, since Node has neither Worker, VideoFrame nor TF.js.
// What the messages are: contract 1, app/src/contracts/pose-messages.mjs; every
// message the client sends or the worker handler posts passes its validator.
// The real model in a real page is app/tools/check-pose.mjs (headless Brave,
// software WebGL, needs the gitignored bundle and weights); the phone's numbers
// are c20's and c26's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const POSE = path.join(ROOT, 'app', 'src', 'pose');
const load = (dir, name) => import(pathToFileURL(path.join(dir, name)).href);
const client = () => load(POSE, 'pose-client.mjs');
const core = () => load(POSE, 'worker-core.mjs');
const contract = () => load(path.join(ROOT, 'app', 'src', 'contracts'), 'pose-messages.mjs');

// A stand-in VideoFrame: what contract 1's checkFrame looks at, and a count of
// its close() calls.
function fakeFrame(w = 640, h = 480, timestamp = 0) {
  const f = { displayWidth: w, displayHeight: h, timestamp, closes: 0,
    close() { f.closes++; f.displayWidth = 0; f.displayHeight = 0; } };
  return f;
}

// 17 [y, x, conf] in a w × h frame's pixels
const pose17 = (w = 640, h = 480) => Array.from({ length: 17 }, (_, i) => [h * (0.1 + i * 0.05), w * (0.4 + (i % 3) * 0.1), 0.9]);
const READY = { type: 'ready', info: { model: 'movenet-thunder', backend: 'webgl', runtime: 'tfjs 4.22.0', initMs: 1234 } };

// A fake Worker. `sent` keeps every message the client posted, with its
// transfer list; `onPost(msg, fake)` is the test's script for the replies;
// a transferred frame is detached on the sender's side, the way a real
// transfer does it (the worker side then owns, and closes, it).
class FakeWorker {
  constructor(onPost) { this.onPost = onPost; this.sent = []; this.terminated = false; this.onmessage = null; this.onerror = null; }
  postMessage(msg, transfer = []) {
    if (this.terminated) throw new Error('posted to a terminated worker');
    this.sent.push({ msg, transfer });
    queueMicrotask(() => this.onPost && this.onPost(msg, this));
  }
  reply(data) { this.onmessage({ data }); }
  terminate() { this.terminated = true; }
}

// A worker that is ready at init and answers every estimate in order.
function echoScript({ ready = READY, keypoints = f => pose17(f.displayWidth, f.displayHeight) } = {}) {
  return (msg, w) => {
    if (msg.type === 'init') w.reply(ready);
    else if (msg.type === 'estimate') {
      w.reply({ type: 'result', id: msg.id, keypoints: keypoints(msg.frame), ms: 90 });
      msg.frame.close();
    } else if (msg.type === 'reset') w.reply({ type: 'cleared', id: msg.id });
  };
}

// createWorker for PoseEngine.create: makes FakeWorkers and remembers them.
function factory(script) {
  const made = [];
  const createWorker = () => { const w = new FakeWorker(typeof script === 'function' ? script : script[made.length] || script[script.length - 1]); made.push(w); return w; };
  createWorker.made = made;
  return createWorker;
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('init: the client sends one init for the backend and resolves with the worker\'s ready info', async () => {
  const { PoseEngine } = await client();
  const create = factory(echoScript());
  const engine = await PoseEngine.create({ backend: 'webgl', createWorker: create });
  assert.equal(create.made.length, 1);
  assert.deepEqual(create.made[0].sent.map(s => s.msg), [{ type: 'init', backend: 'webgl' }]);
  assert.deepEqual(engine.info, READY.info);
  engine.close();
});

test('init: the default backend is webgl; an unknown one is refused before any worker starts', async () => {
  const { PoseEngine } = await client();
  const create = factory(echoScript());
  const engine = await PoseEngine.create({ createWorker: create });
  assert.equal(create.made[0].sent[0].msg.backend, 'webgl');
  engine.close();
  const create2 = factory(echoScript());
  await assert.rejects(PoseEngine.create({ backend: 'tpu', createWorker: create2 }), /backend/);
  assert.equal(create2.made.length, 0);
});

test('init: an error message rejects create with the worker\'s words and ends the worker', async () => {
  const { PoseEngine } = await client();
  const create = factory((msg, w) => w.reply({ type: 'error', error: 'TF.js backend webgl unavailable' }));
  await assert.rejects(PoseEngine.create({ createWorker: create }), /TF\.js backend webgl unavailable/);
  assert.equal(create.made[0].terminated, true);
});

test('init: a ready that breaks contract 1 rejects create', async () => {
  const { PoseEngine } = await client();
  const bad = { type: 'ready', info: { model: 'movenet-thunder', backend: 'webgl', runtime: 'tfjs 4.22.0', initMs: -1 } };
  const create = factory(echoScript({ ready: bad }));
  await assert.rejects(PoseEngine.create({ createWorker: create }), /initMs/);
  assert.equal(create.made[0].terminated, true);
});

test('init: the worker dying before ready (script error, a 404 on its module) rejects create', async () => {
  const { PoseEngine } = await client();
  const create = factory((msg, w) => w.onerror({ message: 'Failed to load module script' }));
  await assert.rejects(PoseEngine.create({ createWorker: create }), /Failed to load module script/);
  assert.equal(create.made[0].terminated, true);
});

test('estimate: the message passes contract 1, the frame is transferred, and the result is the keypoints and ms', async () => {
  const { PoseEngine } = await client();
  const { validatePoseMessage } = await contract();
  const echo = echoScript();
  const atPost = [];   // the validator's verdict while the frame is still open
  const create = factory((msg, w) => { atPost.push(validatePoseMessage(msg)); echo(msg, w); });
  const engine = await PoseEngine.create({ createWorker: create });
  const frame = fakeFrame();
  const r = await engine.estimate(frame, 33.3);
  const { msg, transfer } = create.made[0].sent[1];
  assert.deepEqual(atPost, [[], []]);
  assert.equal(msg.type, 'estimate');
  assert.equal(msg.frame, frame);
  assert.equal(msg.tMs, 33.3);
  assert.deepEqual(transfer, [frame]);
  assert.equal(r.keypoints.length, 17);
  assert.equal(r.ms, 90);
  assert.equal(frame.closes, 1, 'closed once, by the worker side');
  engine.close();
});

test('estimate: a result of null (nobody found) is passed on as null', async () => {
  const { PoseEngine } = await client();
  const engine = await PoseEngine.create({ createWorker: factory(echoScript({ keypoints: () => null })) });
  assert.deepEqual(await engine.estimate(fakeFrame(), 0), { keypoints: null, ms: 90 });
  engine.close();
});

test('results are matched to their call by id: ids count up from 0, and calls made together get their own answers', async () => {
  const { PoseEngine } = await client();
  // each answer carries its frame's width in the first point's x, so a mix-up shows
  const create = factory(echoScript({ keypoints: f => pose17().map((p, i) => (i === 0 ? [1, f.displayWidth, 0.5] : p)) }));
  const engine = await PoseEngine.create({ createWorker: create });
  const calls = [100, 200, 300].map((w, i) => engine.estimate(fakeFrame(w, 480, i), i));
  const results = await Promise.all(calls);
  assert.deepEqual(results.map(r => r.keypoints[0][1]), [100, 200, 300]);
  assert.deepEqual(create.made[0].sent.slice(1).map(s => s.msg.id), [0, 1, 2]);
  engine.close();
});

test('one frame at a time (contract 1): the next estimate is sent after the last result, not before', async () => {
  const { PoseEngine } = await client();
  const create = factory((msg, w) => { if (msg.type === 'init') w.reply(READY); });
  const engine = await PoseEngine.create({ createWorker: create });
  const w = create.made[0];
  const a = engine.estimate(fakeFrame(), 0), b = engine.estimate(fakeFrame(), 33);
  await tick();
  assert.deepEqual(w.sent.slice(1).map(s => s.msg.id), [0], 'only the first is out');
  w.reply({ type: 'result', id: 0, keypoints: pose17(), ms: 10 });
  await a; await tick();
  assert.deepEqual(w.sent.slice(1).map(s => s.msg.id), [0, 1], 'the second goes after the first answered');
  w.reply({ type: 'result', id: 1, keypoints: null, ms: 11 });
  assert.equal((await b).ms, 11);
  engine.close();
});

test('replies out of order or from nowhere: only the reply with the pending id counts, strays are ignored', async () => {
  const { PoseEngine } = await client();
  const create = factory((msg, w) => { if (msg.type === 'init') w.reply(READY); });
  const engine = await PoseEngine.create({ createWorker: create });
  const w = create.made[0];
  const a = engine.estimate(fakeFrame(), 0), b = engine.estimate(fakeFrame(), 33);
  await tick();
  w.reply({ type: 'result', id: 1, keypoints: null, ms: 1 });   // b's id, but b isn't sent yet
  w.reply({ type: 'result', id: 7, keypoints: null, ms: 2 });   // nobody's
  w.reply({ type: 'result', id: 0, keypoints: pose17(), ms: 3 });
  assert.equal((await a).ms, 3);
  await tick();
  w.reply({ type: 'result', id: 0, keypoints: null, ms: 4 });   // a second answer to a, already settled
  w.reply({ type: 'result', id: 1, keypoints: null, ms: 5 });
  assert.equal((await b).ms, 5);
  engine.close();
});

test('a worker error on one estimate rejects that call only; the next one runs', async () => {
  const { PoseEngine } = await client();
  const create = factory((msg, w) => {
    if (msg.type === 'init') return w.reply(READY);
    if (msg.id === 1) w.reply({ type: 'result', id: 1, error: 'out of memory' });
    else w.reply({ type: 'result', id: msg.id, keypoints: pose17(), ms: 50 });
    msg.frame.close();
  });
  const engine = await PoseEngine.create({ createWorker: create });
  const calls = [0, 1, 2].map(i => engine.estimate(fakeFrame(), i * 33));
  const settled = await Promise.allSettled(calls);
  assert.deepEqual(settled.map(s => s.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.match(settled[1].reason.message, /out of memory/);
  assert.equal(create.made[0].terminated, false);
  assert.equal((await engine.estimate(fakeFrame(), 99)).ms, 50);
  engine.close();
});

test('keypoints that are not COCO-17 [y, x, conf] are refused: that call rejects, the engine goes on', async () => {
  const { PoseEngine } = await client();
  const shapes = [
    pose17().slice(0, 16),                                  // 16 points
    [...pose17(), [1, 2, 3]],                               // 18 points
    pose17().map(([y, x, c]) => ({ y, x, score: c })),      // pose-detection's objects
    pose17().map(([y, x, c]) => [x, y]),                    // [x, y], no conf
    pose17().map((p, i) => (i === 3 ? [NaN, 5, 0.5] : p)),  // not a number
    pose17().map((p, i) => (i === 3 ? [5, 5, -0.1] : p)),   // negative conf
  ];
  let n = 0;
  const create = factory((msg, w) => {
    if (msg.type === 'init') return w.reply(READY);
    const kp = shapes[n++] || pose17();
    w.reply({ type: 'result', id: msg.id, keypoints: kp, ms: 5 });
    msg.frame.close();
  });
  const engine = await PoseEngine.create({ createWorker: create });
  for (let i = 0; i < shapes.length; i++) {
    await assert.rejects(engine.estimate(fakeFrame(), i), /keypoints/, `shape ${i}`);
  }
  assert.equal((await engine.estimate(fakeFrame(), 50)).keypoints.length, 17);
  engine.close();
});

test('keypoints in the 0..1 range of a frame of hundreds of pixels (normalised, not pixels) are refused', async () => {
  const { PoseEngine } = await client();
  const normalised = Array.from({ length: 17 }, (_, i) => [0.1 + i * 0.05, 0.5, 0.9]);
  let n = 0;
  const create = factory((msg, w) => {
    if (msg.type === 'init') return w.reply(READY);
    w.reply({ type: 'result', id: msg.id, keypoints: n++ === 0 ? normalised : pose17(1080, 1920), ms: 5 });
    msg.frame.close();
  });
  const engine = await PoseEngine.create({ createWorker: create });
  await assert.rejects(engine.estimate(fakeFrame(1080, 1920), 0), /pixels/);
  assert.equal((await engine.estimate(fakeFrame(1080, 1920), 33)).keypoints.length, 17);
  engine.close();
});

test('a result that breaks contract 1 (both keypoints and error, an extra field, a negative ms) rejects that call', async () => {
  const { PoseEngine } = await client();
  const bads = [
    { type: 'result', id: 0, keypoints: null, ms: 1, error: 'x' },
    { type: 'result', id: 0, keypoints: null, ms: 1, box: [0, 0, 1, 1] },
    { type: 'result', id: 0, keypoints: null, ms: -3 },
  ];
  let n = 0;
  const create = factory((msg, w) => {
    if (msg.type === 'init') return w.reply(READY);
    w.reply({ ...(bads[n++] || { type: 'result', keypoints: null, ms: 1 }), id: msg.id });
    msg.frame.close();
  });
  const engine = await PoseEngine.create({ createWorker: create });
  for (let i = 0; i < bads.length; i++) await assert.rejects(engine.estimate(fakeFrame(), i), /result|ms|box|error/, `bad ${i}`);
  engine.close();
});

test('each frame is closed once: by the worker when it was transferred, by the client when it never was', async () => {
  const { PoseEngine } = await client();
  // a bad call (not a frame, a negative time), a call refused by the transfer, and a good one
  const create = factory(echoScript());
  const engine = await PoseEngine.create({ createWorker: create });
  const w = create.made[0];
  const good = fakeFrame();
  await engine.estimate(good, 0);
  assert.equal(good.closes, 1);

  const badTime = fakeFrame();
  await assert.rejects(engine.estimate(badTime, -5), /tMs/);
  assert.equal(badTime.closes, 1, 'refused before sending: closed by the client');
  assert.equal(w.sent.length, 2, 'nothing was sent for it');

  const post = w.postMessage.bind(w);
  w.postMessage = (msg, transfer) => { if (msg.type === 'estimate' && msg.tMs === 777) throw new Error('DataCloneError'); return post(msg, transfer); };
  const refused = fakeFrame();
  await assert.rejects(engine.estimate(refused, 777), /DataCloneError/);
  assert.equal(refused.closes, 1, 'the transfer threw: the frame is still ours, closed by the client');
  const after = fakeFrame();
  await engine.estimate(after, 800);
  assert.equal(after.closes, 1, 'a failed send does not stop the next');
  engine.close();
});

test('close: a call waiting or in flight rejects, its frame is closed, the worker is terminated, and later calls reject', async () => {
  const { PoseEngine } = await client();
  const create = factory((msg, w) => { if (msg.type === 'init') w.reply(READY); });   // never answers an estimate
  const engine = await PoseEngine.create({ createWorker: create });
  const w = create.made[0];
  const f1 = fakeFrame(), f2 = fakeFrame();
  const inFlight = engine.estimate(f1, 0), waiting = engine.estimate(f2, 33);
  await tick();
  engine.close();
  await assert.rejects(inFlight, /closed/);
  await assert.rejects(waiting, /closed/);
  assert.equal(w.terminated, true);
  assert.equal(f2.closes, 1, 'the waiting frame never left: the client closes it');
  const f3 = fakeFrame();
  await assert.rejects(engine.estimate(f3, 66), /closed/);
  assert.equal(f3.closes, 1);
  engine.close();   // twice is fine
});

test('a worker error event after init (the worker crashed) rejects what is pending and every later call, with its words', async () => {
  const { PoseEngine } = await client();
  const create = factory((msg, w) => { if (msg.type === 'init') w.reply(READY); });
  const engine = await PoseEngine.create({ createWorker: create });
  const w = create.made[0];
  const a = engine.estimate(fakeFrame(), 0), f = fakeFrame();
  await tick();
  w.onerror({ message: 'Uncaught RangeError: out of memory' });
  await assert.rejects(a, /out of memory/);
  await assert.rejects(engine.estimate(f, 33), /out of memory/);
  assert.equal(f.closes, 1);
  assert.equal(w.terminated, true);
});

test('reset: the same worker clears its crop and keeps its model: reset {id} is sent, cleared {id} resolves it, no new worker, no init', async () => {
  const { PoseEngine } = await client();
  const { validatePoseMessage } = await contract();
  const create = factory(echoScript());
  const engine = await PoseEngine.create({ backend: 'webgl', createWorker: create });
  await engine.estimate(fakeFrame(), 0);
  await engine.reset();
  assert.equal(create.made.length, 1, 'no new worker');
  const w = create.made[0];
  assert.equal(w.terminated, false);
  assert.deepEqual(w.sent.map(s => s.msg.type), ['init', 'estimate', 'reset']);
  const reset = w.sent[2];
  assert.deepEqual(reset.msg, { type: 'reset', id: 1 }, 'ids count across estimates and resets');
  assert.deepEqual(reset.transfer, []);
  assert.deepEqual(validatePoseMessage(reset.msg), []);
  await engine.estimate(fakeFrame(), 0);
  assert.deepEqual(w.sent.map(s => s.msg.type), ['init', 'estimate', 'reset', 'estimate'], 'calls after it go to the same worker');
  assert.deepEqual(engine.info, READY.info);
  engine.close();
});

test('reset waits for the call in flight; a call made during it is sent after its cleared', async () => {
  const { PoseEngine } = await client();
  const held = [];
  const create = factory((msg, w) => {
    if (msg.type === 'init') return w.reply(READY);
    held.push(msg);
  });
  const engine = await PoseEngine.create({ createWorker: create });
  const w = create.made[0];
  const first = engine.estimate(fakeFrame(), 0);
  const reset = engine.reset();
  const during = engine.estimate(fakeFrame(), 33);
  await tick();
  assert.deepEqual(w.sent.map(s => s.msg.type), ['init', 'estimate'], 'the reset waits for the result');
  w.reply({ type: 'result', id: 0, keypoints: pose17(), ms: 90 });
  await first;
  await tick();
  assert.deepEqual(w.sent.map(s => s.msg.type), ['init', 'estimate', 'reset'], 'the next estimate waits for cleared');
  w.reply({ type: 'cleared', id: 0 });   // a stray id: ignored
  await tick();
  assert.equal(w.sent.length, 3);
  w.reply({ type: 'cleared', id: 1 });
  await reset;
  await tick();
  assert.deepEqual(w.sent.map(s => s.msg.type), ['init', 'estimate', 'reset', 'estimate']);
  w.reply({ type: 'result', id: 2, keypoints: pose17(), ms: 90 });
  assert.equal((await during).keypoints.length, 17);
  engine.close();
});

test('a failed reset rejects that call with the worker\'s words, and the engine goes on, as after a failed estimate', async () => {
  const { PoseEngine } = await client();
  const create = factory((msg, w) => {
    if (msg.type === 'init') return w.reply(READY);
    if (msg.type === 'reset') return w.reply({ type: 'cleared', id: msg.id, error: 'detector.reset failed' });
    w.reply({ type: 'result', id: msg.id, keypoints: pose17(), ms: 50 });
    msg.frame.close();
  });
  const engine = await PoseEngine.create({ createWorker: create });
  await assert.rejects(engine.reset(), /detector\.reset failed/);
  assert.equal(create.made[0].terminated, false);
  assert.equal(create.made.length, 1);
  assert.equal((await engine.estimate(fakeFrame(), 0)).ms, 50);
  engine.close();
});

test('a cleared that breaks contract 1 rejects the reset; the engine goes on', async () => {
  const { PoseEngine } = await client();
  const create = factory((msg, w) => {
    if (msg.type === 'init') return w.reply(READY);
    if (msg.type === 'reset') return w.reply({ type: 'cleared', id: msg.id, ms: 4 });
    w.reply({ type: 'result', id: msg.id, keypoints: pose17(), ms: 50 });
    msg.frame.close();
  });
  const engine = await PoseEngine.create({ createWorker: create });
  await assert.rejects(engine.reset(), /worker: .*ms/);
  assert.equal((await engine.estimate(fakeFrame(), 0)).ms, 50);
  engine.close();
});

test('a reset on a closed engine rejects; a worker that dies during a reset rejects it with its words', async () => {
  const { PoseEngine } = await client();
  const create = factory((msg, w) => { if (msg.type === 'init') w.reply(READY); });
  const engine = await PoseEngine.create({ createWorker: create });
  const reset = engine.reset();
  await tick();
  create.made[0].onerror({ message: 'WebGL context lost' });
  await assert.rejects(reset, /WebGL context lost/);
  await assert.rejects(engine.reset(), /WebGL context lost/);
  const closed = await PoseEngine.create({ createWorker: factory(echoScript()) });
  closed.close();
  await assert.rejects(closed.reset(), /closed/);
});

// --- the worker's side -------------------------------------------------------

// A fake engine behind the handler: what movenet.mjs gives it. Like MoveNet it
// keeps the last pose (its crop follows it); `log` records, in order, each
// estimate with whether it started from a previous pose, and each reset, which
// forgets the pose (detector.reset()) or throws when `resetFails` says so.
function fakeEngine({ keypoints = () => pose17(), delay = () => 0, calls = [], log = [], resetFails = () => null } = {}) {
  let previous = null;
  return {
    info: { model: 'movenet-thunder', backend: 'webgl', runtime: 'tfjs 4.22.0' },
    calls, log,
    async estimate(frame, tMs) {
      calls.push({ w: frame.displayWidth, tMs });
      log.push({ estimate: tMs, fromPose: previous !== null });
      await new Promise(r => setTimeout(r, delay(calls.length - 1)));
      const kp = keypoints(frame, tMs);
      if (kp instanceof Error) throw kp;
      previous = kp;
      return kp;
    },
    async reset() {
      log.push({ reset: true });
      const e = resetFails();
      if (e) throw e;
      previous = null;
    },
  };
}
function handler(over = {}) {
  return core().then(({ createWorkerHandler }) => {
    const posted = [];
    let t = 1000;
    const h = createWorkerHandler({ load: async () => over.engine || fakeEngine(), post: m => posted.push(m), now: () => (t += 10) });
    return { h, posted };
  });
}

test('worker: init loads the engine once and posts ready with info and initMs; both pass contract 1', async () => {
  const { validatePoseMessage } = await contract();
  const loaded = [];
  const { createWorkerHandler } = await core();
  const posted = [];
  let t = 0;
  const h = createWorkerHandler({ load: async backend => { loaded.push(backend); return fakeEngine(); }, post: m => posted.push(m), now: () => (t += 250) });
  await h({ type: 'init', backend: 'webgl' });
  assert.deepEqual(loaded, ['webgl']);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'ready');
  assert.deepEqual(posted[0].info, { model: 'movenet-thunder', backend: 'webgl', runtime: 'tfjs 4.22.0', initMs: 250 });
  assert.deepEqual(validatePoseMessage(posted[0]), []);
});

test('worker: a failing load posts error with the words and nothing else; estimates after it answer with an error', async () => {
  const { validatePoseMessage } = await contract();
  const { createWorkerHandler } = await core();
  const posted = [];
  const h = createWorkerHandler({ load: async () => { throw new Error('TF.js backend webgl unavailable'); }, post: m => posted.push(m), now: () => 0 });
  await h({ type: 'init', backend: 'webgl' });
  assert.equal(posted[0].type, 'error');
  assert.match(posted[0].error, /webgl unavailable/);
  assert.deepEqual(validatePoseMessage(posted[0]), []);
  const f = fakeFrame();
  await h({ type: 'estimate', id: 3, frame: f, tMs: 0 });
  assert.equal(posted[1].id, 3);
  assert.match(posted[1].error, /init/);
  assert.equal(f.closes, 1);
  assert.deepEqual(validatePoseMessage(posted[1]), []);
});

test('worker: estimate posts result {id, keypoints, ms} with ms the whole estimate, and closes the frame once', async () => {
  const { validatePoseMessage } = await contract();
  const { h, posted } = await handler();
  await h({ type: 'init', backend: 'webgl' });
  const f = fakeFrame();
  await h({ type: 'estimate', id: 4, frame: f, tMs: 66 });
  const r = posted[1];
  assert.deepEqual(r, { type: 'result', id: 4, keypoints: pose17(), ms: 10 });
  assert.deepEqual(validatePoseMessage(r), []);
  assert.equal(f.closes, 1);
});

test('worker: the engine is asked for the frame while it is still open, with the frame\'s time', async () => {
  const calls = [];
  const { h } = await handler({ engine: fakeEngine({ calls }) });
  await h({ type: 'init', backend: 'webgl' });
  await h({ type: 'estimate', id: 0, frame: fakeFrame(320, 240), tMs: 12.5 });
  assert.deepEqual(calls, [{ w: 320, tMs: 12.5 }]);
});

test('worker: an engine that throws gives result {id, error} for that call only, and the frame is closed once', async () => {
  const { validatePoseMessage } = await contract();
  let n = 0;
  const { h, posted } = await handler({ engine: fakeEngine({ keypoints: () => (n++ === 0 ? new Error('shader compile failed') : pose17()) }) });
  await h({ type: 'init', backend: 'webgl' });
  const f1 = fakeFrame(), f2 = fakeFrame();
  await h({ type: 'estimate', id: 0, frame: f1, tMs: 0 });
  await h({ type: 'estimate', id: 1, frame: f2, tMs: 33 });
  assert.equal(posted[1].id, 0);
  assert.match(posted[1].error, /shader compile failed/);
  assert.equal('keypoints' in posted[1], false);
  assert.deepEqual(validatePoseMessage(posted[1]), []);
  assert.equal(posted[2].keypoints.length, 17);
  assert.equal(f1.closes + f2.closes, 2);
  assert.equal(f1.closes, 1);
});

test('worker: keypoints that are not COCO-17 [y, x, conf] in pixels never leave it: result {id, error} instead', async () => {
  const bads = [pose17().slice(1), pose17().map(([y, x, c]) => ({ y, x, score: c })), Array.from({ length: 17 }, () => [0.2, 0.3, 0.9])];
  let n = 0;
  const { h, posted } = await handler({ engine: fakeEngine({ keypoints: () => bads[n++] }) });
  await h({ type: 'init', backend: 'webgl' });
  for (let i = 0; i < bads.length; i++) {
    const f = fakeFrame();
    await h({ type: 'estimate', id: i, frame: f, tMs: i });
    assert.equal(posted[i + 1].id, i);
    assert.match(posted[i + 1].error, /keypoints/, `bad ${i}`);
    assert.equal(f.closes, 1);
  }
});

test('worker: null from the engine (nobody found) is posted as keypoints: null', async () => {
  const { validatePoseMessage } = await contract();
  const { h, posted } = await handler({ engine: fakeEngine({ keypoints: () => null }) });
  await h({ type: 'init', backend: 'webgl' });
  await h({ type: 'estimate', id: 0, frame: fakeFrame(), tMs: 0 });
  assert.equal(posted[1].keypoints, null);
  assert.deepEqual(validatePoseMessage(posted[1]), []);
});

test('worker: messages that arrive together are handled one after the other, results in the order of the estimates', async () => {
  const calls = [];
  // the first estimate is the slowest: run together, it would answer last
  const engine = fakeEngine({ calls, delay: i => [30, 1, 1][i] });
  const { h, posted } = await handler({ engine });
  const frames = [fakeFrame(), fakeFrame(), fakeFrame()];
  await Promise.all([
    h({ type: 'init', backend: 'webgl' }),
    ...frames.map((f, i) => h({ type: 'estimate', id: i, frame: f, tMs: i })),
  ]);
  assert.deepEqual(posted.map(m => m.type === 'result' ? m.id : m.type), ['ready', 0, 1, 2]);
  assert.deepEqual(frames.map(f => f.closes), [1, 1, 1]);
});

test('worker: a message that breaks contract 1 (unknown type, null, an estimate with a bad id) posts nothing, never throws, and a frame in it is closed', async () => {
  const { h, posted } = await handler();
  await h({ type: 'init', backend: 'webgl' });
  await h({ type: 'nonsense' });
  await h(null);
  const f = fakeFrame();
  await h({ type: 'estimate', id: -1, frame: f, tMs: 0 });
  assert.equal(f.closes, 1);
  assert.deepEqual(posted.map(m => m.type), ['ready']);
});

// --- the pieces ---------------------------------------------------------------

// pose-detection 2.1.3's MoveNet keypoints: {y, x, score, name}, names from its COCO_KEYPOINTS
// (movenet/constants.ts), x and y already in the image's pixels (movenet/detector.ts scales them).
test('worker: reset clears the crop and keeps the model: cleared {id}, no second load, and the next estimate starts from no previous pose', async () => {
  const { validatePoseMessage } = await contract();
  const { createWorkerHandler } = await core();
  const log = [];
  let loads = 0;
  const posted = [];
  const h = createWorkerHandler({ load: async () => { loads++; return fakeEngine({ log }); }, post: m => posted.push(m), now: () => 0 });
  await h({ type: 'init', backend: 'webgl' });
  await h({ type: 'estimate', id: 0, frame: fakeFrame(), tMs: 0 });
  await h({ type: 'estimate', id: 1, frame: fakeFrame(), tMs: 33 });
  await h({ type: 'reset', id: 2 });
  await h({ type: 'estimate', id: 3, frame: fakeFrame(), tMs: 0 });
  assert.equal(loads, 1, 'the model is kept: no load, no warm-up');
  assert.deepEqual(log, [
    { estimate: 0, fromPose: false }, { estimate: 33, fromPose: true },
    { reset: true },
    { estimate: 0, fromPose: false },
  ]);
  assert.deepEqual(posted.map(m => m.type), ['ready', 'result', 'result', 'cleared', 'result']);
  assert.deepEqual(posted[3], { type: 'cleared', id: 2 });
  for (const m of posted) assert.deepEqual(validatePoseMessage(m), [], m.type);
});

test('worker: a reset that arrives with an estimate in flight is answered after that estimate, never in the middle of it', async () => {
  const log = [];
  const { h, posted } = await handler({ engine: fakeEngine({ log, delay: () => 20 }) });
  await h({ type: 'init', backend: 'webgl' });
  const a = h({ type: 'estimate', id: 0, frame: fakeFrame(), tMs: 0 });
  const b = h({ type: 'reset', id: 1 });
  const c = h({ type: 'estimate', id: 2, frame: fakeFrame(), tMs: 0 });
  await Promise.all([a, b, c]);
  assert.deepEqual(log, [{ estimate: 0, fromPose: false }, { reset: true }, { estimate: 0, fromPose: false }]);
  assert.deepEqual(posted.slice(1).map(m => [m.type, m.id]), [['result', 0], ['cleared', 1], ['result', 2]]);
});

test('worker: a reset that fails answers cleared {id, error} in the engine\'s words, and the engine goes on', async () => {
  const { validatePoseMessage } = await contract();
  const { h, posted } = await handler({ engine: fakeEngine({ resetFails: () => new Error('WebGL context lost') }) });
  await h({ type: 'init', backend: 'webgl' });
  await h({ type: 'reset', id: 0 });
  assert.deepEqual(posted[1], { type: 'cleared', id: 0, error: 'WebGL context lost' });
  assert.deepEqual(validatePoseMessage(posted[1]), []);
  await h({ type: 'estimate', id: 1, frame: fakeFrame(), tMs: 0 });
  assert.equal(posted[2].type, 'result');
  assert.equal(posted[2].keypoints.length, 17);
});

test('worker: a reset before init, or after a failed one, answers cleared {id, error}; a reset that breaks contract 1 posts nothing', async () => {
  const { validatePoseMessage } = await contract();
  const { createWorkerHandler } = await core();
  const posted = [];
  const h = createWorkerHandler({ load: async () => { throw new Error('weights missing'); }, post: m => posted.push(m), now: () => 0 });
  await h({ type: 'reset', id: 0 });
  assert.equal(posted[0].type, 'cleared');
  assert.match(posted[0].error, /init/);
  await h({ type: 'init', backend: 'webgl' });
  await h({ type: 'reset', id: 1 });
  assert.deepEqual(posted.map(m => m.type), ['cleared', 'error', 'cleared']);
  assert.match(posted[2].error, /weights missing/);
  for (const m of posted) assert.deepEqual(validatePoseMessage(m), [], m.type);
  await h({ type: 'reset', id: -1 });
  await h({ type: 'reset', id: 4, backend: 'webgl' });
  assert.equal(posted.length, 3);
});

test('movenet.mjs: the engine\'s reset is pose-detection\'s detector.reset(), and nothing reloads the model', () => {
  const src = fs.readFileSync(path.join(POSE, 'movenet.mjs'), 'utf8');
  const ret = src.slice(src.lastIndexOf('return {'));
  assert.match(ret, /reset[^,}]*detector\.reset\(\)/, 'the returned engine has reset() calling detector.reset()');
  assert.doesNotMatch(ret, /createDetector|import\(/);
});

const PD_NAMES = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'left_shoulder', 'right_shoulder', 'left_elbow',
  'right_elbow', 'left_wrist', 'right_wrist', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'];

test('coco17: pose-detection\'s keypoints become [y, x, conf] in COCO-17 order, and contract 1\'s validator takes them', async () => {
  const { toCoco17, MOVENET_NAMES } = await load(POSE, 'coco17.mjs');
  const { validateKeypoints, COCO17 } = await load(path.join(ROOT, 'app', 'src', 'contracts'), 'keypoints.mjs');
  assert.deepEqual([...MOVENET_NAMES], PD_NAMES);
  assert.deepEqual(MOVENET_NAMES.map(n => n.replace('left_', 'l_').replace('right_', 'r_')), [...COCO17]);
  const pts = PD_NAMES.map((name, i) => ({ y: 10 + i, x: 100 + i, score: 0.5, name }));
  const kp = toCoco17(pts);
  assert.deepEqual(kp[5], [15, 105, 0.5]);
  assert.deepEqual(validateKeypoints(kp), []);
  assert.deepEqual(toCoco17(pts.map(({ name, ...p }) => p)), kp, 'names are checked when there, not required');
});

test('coco17: not 17 points, or a name at the wrong place, throws instead of passing the wrong joint on', async () => {
  const { toCoco17 } = await load(POSE, 'coco17.mjs');
  const pts = PD_NAMES.map((name, i) => ({ y: i, x: i, score: 1, name }));
  assert.throws(() => toCoco17(pts.slice(0, 16)), /16/);
  assert.throws(() => toCoco17(null), /17/);
  const swapped = [...pts]; [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  assert.throws(() => toCoco17(swapped), /left_eye/);
});

test('check: null is fine; 17 points in pixels are fine, also past the frame\'s edge; a missing score or normalised points are not', async () => {
  const { checkResultKeypoints } = await load(POSE, 'check.mjs');
  assert.deepEqual(checkResultKeypoints(null, 640, 480), []);
  assert.deepEqual(checkResultKeypoints(pose17(), 640, 480), []);
  assert.deepEqual(checkResultKeypoints(pose17().map(([y, x, c]) => [y, x + 5000, c]), 640, 480), [], 'a joint cut off by the frame is still a number');
  assert.ok(checkResultKeypoints(pose17().map(([y, x]) => [y / 480, x / 640, 1]), 640, 480).some(e => /normalised/.test(e)));
  assert.ok(checkResultKeypoints(pose17().map(([y, x]) => [y, x]), 640, 480).length > 0);
  assert.deepEqual(checkResultKeypoints(Array.from({ length: 17 }, () => [0, 0, 0]), 640, 480), [], 'an all-zero pose is not a normalised one');
  assert.deepEqual(checkResultKeypoints(Array.from({ length: 17 }, () => [0.5, 0.5, 1]), 4, 4), [], 'a 4 px frame cannot tell');
});

// --- the files ----------------------------------------------------------------

const read = f => fs.readFileSync(path.join(POSE, f), 'utf8');
const POSE_FILES = () => fs.readdirSync(POSE).filter(f => f.endsWith('.mjs'));

test('nothing under app/src/pose/ imports from spike/ or from outside app/ (the engine is copied and trimmed, not linked)', () => {
  assert.ok(POSE_FILES().length >= 4);
  for (const f of POSE_FILES()) {
    const src = read(f);
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|new URL\(\s*)['"`]([^'"`]+)['"`]/g)) {
      assert.ok(!/spike/.test(m[1]), `${f} imports ${m[1]}`);
      const target = path.resolve(POSE, m[1]);
      if (m[1].startsWith('.')) assert.ok(target.startsWith(path.join(ROOT, 'app') + path.sep), `${f}: ${m[1]} leaves app/`);
      assert.ok(!m[1].startsWith('/') && !/^https?:/.test(m[1]), `${f}: ${m[1]} is not relative`);
    }
  }
});

test('the worker loads the bundle and the weights by relative URLs into app/vendor/tfjs/ and app/models/, with no other model and no network', () => {
  const src = POSE_FILES().map(read).join('\n');
  assert.match(src, /\.\.\/\.\.\/vendor\/tfjs\/tfjs-webgl\.mjs/);
  assert.match(src, /\.\.\/\.\.\/models\/movenet-thunder-4\/model\.json/);
  assert.doesNotMatch(src, /https?:\/\//);
  assert.doesNotMatch(src, /tfhub|kaggle|cdn\./i);
  assert.doesNotMatch(src, /posenet|blazepose|lightning/i, 'MoveNet Thunder only');
});

test('the worker module runs only in a worker: importing the client in Node starts nothing', async () => {
  const mod = await client();
  assert.equal(typeof mod.PoseEngine.create, 'function');
});
