'use strict';
// The screens v1 doesn't draw (package d23): the errors (a video that can't be read, no person found,
// the engine failing, storage full), the first run, and a snatch result. Each error is raised by the
// module that raises it in the app (s9's frame source, s12's queue and job, c8's store) and is turned
// into its screen's words by app/src/ui/problem-model.mjs; nothing here types an error's text except
// to compare it with the module's own. Expected words: docs/ui-design.md ("Open questions"), the
// engine's own words from diagnostics.js (loaded by tests/loadDiagnostics.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createFakeWebCodecs } = require('./fake-webcodecs');
const { createFakeStorage } = require('./fake-opfs.js');
const { loadDiagnostics } = require('../loadDiagnostics');
const { loadManifests, trackPathFor } = require('../fixtures');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const load = rel => import(pathToFileURL(path.join(APP, rel)).href);
const Diagnostics = loadDiagnostics();
const CLIPS = path.join(__dirname, 'clips');
const clip = name => new Blob([fs.readFileSync(path.join(CLIPS, name))], { type: 'video/mp4' });

// ---- a minimal queue over fakes (as analysis.test.js has, trimmed to what these cases need) ----

const standing = () => {
  const pts = Array.from({ length: 17 }, () => [100, 100, 0.9]);
  pts[0] = [150, 220, 0.9]; pts[5] = [250, 215, 0.95]; pts[6] = [250, 225, 0.95];
  pts[11] = [400, 155, 0.95]; pts[12] = [400, 165, 0.95];
  return pts;
};
function fakeSource() {
  const times = Array.from({ length: 60 }, (_, i) => i / 30);
  const src = {
    info: { duration: 2, fps: 30, width: 640, height: 480, rotation: 0, codec: 'avc1.64001f' },
    frameTimes: Object.freeze(times),
    async frameAt() { throw new Error('unused'); },
    async *frames(t0, t1) {
      for (let i = 0; i < times.length; i++) {
        if (times[i] < t0 - 1e-6 || times[i] > t1 + 1e-6) continue;
        yield { index: i, timestamp: times[i] * 1e6, duration: 1e6 / 30, displayWidth: 640, displayHeight: 480, close() {} };
      }
    },
    async thumbnails() { return []; },
    async stepper() { throw new Error('unused'); },
    close() {},
  };
  return src;
}
const engineOf = ({ keypoints = standing, fail = null } = {}) => ({
  info: { model: 'movenet-thunder', backend: 'webgl', runtime: 'tfjs 4.22.0' },
  n: 0,
  async estimate(frame) {
    this.n++;
    if (fail && fail(this.n)) throw new Error('worker: WebGL context lost');
    return { keypoints: keypoints(), ms: 10 };
  },
  async reset() {},
  close() {},
});
const timers = { setInterval: () => 1, clearInterval: () => {} };

async function setup({ engine, storage = createFakeStorage(), keepVideo } = {}) {
  const { createStore } = await load('src/store/index.mjs');
  const { createQueue } = await load('src/analysis/index.mjs');
  const store = createStore({ storage: storage.storage, now: () => new Date('2026-11-02T09:00:00.000Z'), appVersion: '0.1.0' });
  const queue = createQueue({
    store, createEngine: async () => engine || engineOf(), openFrameSource: async () => fakeSource(), Diagnostics,
    now: () => 0, timers, keepVideo,
  });
  return { store, queue, storage };
}
const lifted = (store, lift = 'lateral-raise') =>
  store.saveLift({ lift, video: new Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'video/mp4' }), range: { t0: 0.5, t1: 1.2 } });

async function failedJob(opts, lift) {
  const { store, queue } = await setup(opts);
  const job = await queue.enqueue(await lifted(store, lift));
  await queue.idle();
  const end = queue.jobs().find(j => j.id === job.id);
  assert.equal(end.state, 'failed', 'the job failed');
  return end;
}

// ---- the errors ----

test('a file the frame source cannot read is a screen: what happened, what to do, in the source\'s own words, with a way back', async () => {
  const { openFrameSource, MediaError } = await load('src/media/frame-source.mjs');
  const { problemOf } = await load('src/ui/problem-model.mjs');
  const error = await openFrameSource(new Blob([Buffer.from('<html>not a video</html>')]), { webcodecs: createFakeWebCodecs() }).catch(e => e);
  assert.ok(error instanceof MediaError && error.code === 'unreadable');
  const p = problemOf(error);
  assert.equal(p.kind, 'unreadable');
  assert.equal(p.title, "This video can't be read");
  assert.equal(p.engine, error.message, 'the frame source\'s words, unchanged');
  assert.match(p.what, /\S/);
  assert.match(p.can, /another video/i);
  assert.deepEqual(p.actions, { retry: false, another: true });
});

test('HEVC where the decoder lacks it: the screen names the codec the frame source named', async () => {
  const { openFrameSource } = await load('src/media/frame-source.mjs');
  const { problemOf } = await load('src/ui/problem-model.mjs');
  const fake = createFakeWebCodecs({ supported: config => !/^hev1|^hvc1/.test(config.codec) });
  const error = await openFrameSource(clip('testsrc2-hevc-30fps.mp4'), { webcodecs: fake, stallMs: 400 }).catch(e => e);
  assert.equal(error.code, 'unsupported-codec');
  const p = problemOf(error);
  assert.equal(p.kind, 'unsupported-codec');
  assert.equal(p.engine, error.message);
  assert.ok(error.codec && p.engine.includes(error.codec), 'the codec is named');
  assert.equal(p.actions.another, true);
});

test('no person in the marked part: the job fails in the engine\'s own words and Q1 shows "No person found" without a retry', async () => {
  const { problemOf } = await load('src/ui/problem-model.mjs');
  const { analysingView } = await load('src/ui/analysing-model.mjs');
  const job = await failedJob({ engine: engineOf({ keypoints: () => null }) });
  const p = problemOf(job.error);
  assert.equal(p.kind, 'no-person');
  assert.equal(p.title, 'No person found');
  // diagnostics.js's reason for a track nobody is in
  const D = loadDiagnostics();
  D.setPage('lateral-raise');
  const reason = D.computeResults({}, { frame_times_ms: [], frame_indices: [], tracks: { kept: '0' } }, '0').results['lateral-raise-top-height'].error;
  assert.ok(reason, 'the engine has words for it');
  assert.ok(p.engine.includes(reason.replace(/Person \S+ /, '').slice(0, 20)) || /detected in only 0 sampled/.test(p.engine), p.engine);
  assert.deepEqual(p.actions, { retry: false, another: true });
  const lift = (await (await setup()).store.listLifts())[0];
  const view = analysingView([job], { liftId: job.liftId, lift: lift || null });
  assert.equal(view.kind, 'failed');
  assert.equal(view.problem.kind, 'no-person');
  assert.equal(view.actions.retry, false, 'the same video would find the same nobody');
  assert.equal(view.reason, job.error, 'the job\'s words stay');
});

test('a person in only some frames is not a failure: the cues say what they could score', async () => {
  const { store, queue } = await setup({ engine: engineOf({ keypoints: (() => { let n = 0; return () => (++n % 2 ? standing() : null); })() }) });
  const job = await queue.enqueue(await lifted(store));
  await queue.idle();
  assert.equal(queue.jobs().find(j => j.id === job.id).state, 'done');
});

test('the engine failing: the job fails in the worker\'s words, and the screen offers another try', async () => {
  const { problemOf } = await load('src/ui/problem-model.mjs');
  const job = await failedJob({ engine: engineOf({ fail: n => n >= 2 }) });
  const p = problemOf(job.error);
  assert.equal(p.kind, 'engine-failed');
  assert.equal(p.title, 'The pose engine stopped');
  assert.ok(p.engine.includes('worker: WebGL context lost'), p.engine);
  assert.deepEqual(p.actions, { retry: true, another: false });
});

test('a hung engine (the watchdog) is the same screen', async () => {
  const { StallError } = await load('src/analysis/queue.mjs');
  const { problemOf } = await load('src/ui/problem-model.mjs');
  const e = new StallError('The analysis stopped responding: no progress for 30 s with the app open.');
  for (const input of [e, e.message]) {
    const p = problemOf(input);
    assert.equal(p.kind, 'engine-failed');
    assert.equal(p.engine, e.message);
  }
});

test('storage full: the store\'s error, at Analyse and in the job, is one screen with a retry', async () => {
  const { problemOf } = await load('src/ui/problem-model.mjs');
  const { keepVideo } = await load('src/media/cut.mjs');
  const { analyse } = await load('src/ui/mark-model.mjs');
  // at Analyse (c8's saveLift): the cut does not fit
  const full = createFakeStorage({ quota: 1 });
  const { store, queue } = await setup({ storage: full, keepVideo });
  const error = await queue.analyse('lateral-raise', clip('testsrc2-h264-30fps.mp4'), { t0: 0, t1: 0.5 }).catch(e => e);
  assert.equal(error.code, 'storage-full', `${error.name}: ${error.message}`);
  const p = problemOf(error);
  assert.equal(p.kind, 'storage-full');
  assert.equal(p.title, 'Storage is full');
  assert.equal(p.engine, error.message);
  assert.deepEqual(p.actions, { retry: true, another: false });
  // M's Analyse hands the same screen on
  const flow = { go() { throw new Error('must not leave M'); } };
  const out = await analyse({ flow, queue, lift: 'lateral-raise', file: clip('testsrc2-h264-30fps.mp4'), marks: { start: 0, end: 10, error: null }, frameTimes: Array.from({ length: 30 }, (_, i) => i / 30) });
  assert.equal(out.ok, false);
  assert.equal(out.problem.kind, 'storage-full');
  assert.equal(out.error, error.message);
  void store;
  // in the job (updateLift): the job's error is the store's message, and it is the same screen
  const ok = createFakeStorage();
  const s2 = await setup({ storage: ok });
  const lift = await lifted(s2.store);
  ok.setQuota(1);
  const job = await s2.queue.enqueue(lift);
  await s2.queue.idle();
  const end = s2.queue.jobs().find(j => j.id === job.id);
  assert.equal(end.state, 'failed');
  assert.equal(problemOf(end.error).kind, 'storage-full');
});

test('any other failure is shown in its own words with a retry, never as another kind', async () => {
  const { problemOf } = await load('src/ui/problem-model.mjs');
  const p = problemOf('The video file ends before the end of the range.');
  assert.equal(p.kind, 'failed');
  assert.equal(p.engine, 'The video file ends before the end of the range.');
  assert.deepEqual(p.actions, { retry: true, another: false });
  assert.equal(problemOf(new Error('boom')).engine, 'boom');
  assert.equal(problemOf(undefined).kind, 'failed');
});

test('every problem says what happened and what the user can do, and has a way back', async () => {
  const { problemOf, PROBLEM_KINDS } = await load('src/ui/problem-model.mjs');
  const samples = {
    unreadable: Object.assign(new Error('x'), { name: 'MediaError', code: 'unreadable' }),
    'unsupported-codec': Object.assign(new Error('x'), { name: 'MediaError', code: 'unsupported-codec', codec: 'hvc1' }),
    'no-webcodecs': Object.assign(new Error('x'), { name: 'MediaError', code: 'no-webcodecs' }),
    'engine-failed': 'The pose engine failed: x',
    'no-person': 'No person was found in the marked part of the video. x',
    'storage-full': Object.assign(new Error('x'), { name: 'StoreError', code: 'storage-full' }),
    failed: 'x',
  };
  assert.deepEqual(Object.keys(samples).sort(), [...PROBLEM_KINDS].sort());
  for (const [kind, input] of Object.entries(samples)) {
    const p = problemOf(input);
    assert.equal(p.kind, kind);
    for (const k of ['title', 'what', 'can']) assert.match(p[k], /\S/, `${kind}.${k}`);
    assert.equal(typeof p.actions.retry, 'boolean');
    assert.equal(typeof p.actions.another, 'boolean');
  }
});

// ---- the first run ----

test('the first run shows once: the intro starts the app until it is dismissed, and the choice is kept', async () => {
  const { startState, finishWelcome, WELCOME } = await load('src/ui/welcome-model.mjs');
  const { createStore } = await load('src/store/index.mjs');
  const fake = createFakeStorage();
  const mk = () => createStore({ storage: fake.storage, now: () => new Date('2026-11-02T09:00:00.000Z'), appVersion: '0.1.0' });
  assert.equal(await startState(mk()), 'welcome');
  const gone = [];
  const flow = { go: (to, p) => gone.push([to, p]) };
  await finishWelcome(mk(), flow, 'import');
  assert.deepEqual(gone, [['import', undefined]]);
  assert.equal(await startState(mk()), 'home', 'after a restart it does not show again');
  assert.equal(await startState({ getSettings: async () => { throw new Error('no store'); } }), 'home', 'never blocks the app');
  // what it says: what the app does, that everything stays on the phone, and a way to import
  assert.match(WELCOME.title, /\S/);
  assert.ok(WELCOME.points.some(t => /stays on this phone/i.test(t)));
  assert.equal(WELCOME.importLabel, 'Import a video');
});

test('the intro goes on even when the choice cannot be saved', async () => {
  const { finishWelcome } = await load('src/ui/welcome-model.mjs');
  const gone = [];
  await finishWelcome({ saveSettings: async () => { throw new Error('storage full'); } }, { go: to => gone.push(to) }, 'home');
  assert.deepEqual(gone, ['home']);
});

test('the intro is one more state of the flow, entered at the start and left to home or import', async () => {
  const { createFlow, TRANSITIONS, SCREEN_OF } = await load('src/flow/flow.mjs');
  assert.equal(SCREEN_OF.welcome, 'Welcome');
  const flow = createFlow('welcome');
  assert.equal(flow.can('import'), true);
  assert.equal(flow.can('home'), true);
  assert.equal(flow.can('settings'), false);
  assert.ok(Object.values(TRANSITIONS).every(to => !to.includes('welcome')), 'no screen leads back to it');
  assert.ok(fs.existsSync(path.join(APP, 'src', 'ui', 'screens', 'Welcome.mjs')));
});

// ---- a snatch result ----

const manifest = loadManifests();
const SNATCH = 'global/snatch/Session14_01_0h18m07s_made';

test('a snatch result: A1\'s cards are the snatch\'s cues from a committed track, and the header says "provisional"', async () => {
  const { scoreLift } = await load('src/scoring/score.mjs');
  const { cardsOf, provisionalNote, summaryOf } = await load('src/ui/result-model.mjs');
  const { headerOf } = await load('src/ui/player-model.mjs');
  const track = JSON.parse(fs.readFileSync(trackPathFor(SNATCH), 'utf8'));
  assert.equal(manifest[SNATCH].diagnostics, 'snatch');
  const { view } = scoreLift(track, 'snatch', { Diagnostics, sigmaMs: 0 });
  const cards = cardsOf(view, id => Diagnostics.zones(id), id => Diagnostics.rule(id));
  assert.deepEqual(cards.map(c => c.id), Diagnostics.describe('snatch').map(d => d.id));
  assert.ok(cards.length >= 2 && cards.every(c => c.title && c.word && c.cue));
  assert.ok(summaryOf(view).length > 0);
  assert.match(provisionalNote(view), /provisional/);
  const lift = { lift: 'snatch', created: new Date(2026, 10, 2, 9, 0).toISOString(), range: { t0: 0, t1: 3 } };
  const head = headerOf(lift, new Date(2026, 10, 2, 12, 0));
  assert.equal(head.title, 'Snatch');
  assert.equal(head.provisional, true);
  assert.equal(headerOf({ ...lift, lift: 'lateral-raise' }, new Date(2026, 10, 2, 12, 0)).provisional, false);
});

// ---- the look ----

test('the new screens take every colour from tokens.css', () => {
  const hex = /#[0-9a-fA-F]{3,8}\b/;
  const files = [];
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) (f.isDirectory() ? walk : p => files.push(p))(path.join(d, f.name)); };
  walk(path.join(APP, 'src', 'ui'));
  for (const f of files) if (/\.(mjs|css)$/.test(f)) assert.ok(!hex.test(fs.readFileSync(f, 'utf8')), `${path.relative(ROOT, f)} has a literal colour`);
});

// ---- fix round 1 ----

test('no WebCodecs: the screen says only what the app knows and M offers only the way back', async () => {
  const { problemOf, waysOn } = await load('src/ui/problem-model.mjs');
  const p = problemOf(Object.assign(new Error('x'), { name: 'MediaError', code: 'no-webcodecs' }));
  assert.equal(p.kind, 'no-webcodecs');
  assert.equal(p.actions.another, false);
  assert.doesNotMatch(`${p.title} ${p.what} ${p.can}`, /Chrome|Brave|Android app/i, 'no advice the app cannot back up');
  assert.deepEqual(waysOn(p, false), ['home'], 'opening the video: only Back to home');
  assert.deepEqual(waysOn(problemOf(Object.assign(new Error('x'), { code: 'unreadable' })), false), ['another', 'home']);
  assert.deepEqual(waysOn(problemOf(Object.assign(new Error('x'), { code: 'storage-full' })), true), ['retry', 'marks', 'home']);
  const m = fs.readFileSync(path.join(APP, 'src/ui/screens/M.mjs'), 'utf8');
  assert.match(m, /ways\.includes\('another'\)/, 'M gates "Pick another video" on the problem');
  assert.doesNotMatch(m, /!atAnalyse \|\|/);
});

test('a frame-source error during the job is the unreadable-video screen, with no retry', async () => {
  const { MediaError } = await load('src/media/frame-source.mjs');
  const { problemOf } = await load('src/ui/problem-model.mjs');
  const { analysingView } = await load('src/ui/analysing-model.mjs');
  const { createStore } = await load('src/store/index.mjs');
  const { createQueue } = await load('src/analysis/index.mjs');
  const storage = createFakeStorage();
  const store = createStore({ storage: storage.storage, now: () => new Date('2026-11-02T09:00:00.000Z'), appVersion: '0.1.0' });
  const source = fakeSource();
  source.frames = async function* () { throw new MediaError('decode-failed', 'The decoder reported an error (bad NAL)'); };
  const queue = createQueue({ store, createEngine: async () => engineOf(), openFrameSource: async () => source, Diagnostics, now: () => 0, timers });
  const job = await queue.enqueue(await lifted(store));
  await queue.idle();
  const end = queue.jobs().find(j => j.id === job.id);
  assert.equal(end.state, 'failed');
  const p = problemOf(end.error);
  assert.equal(p.kind, 'unreadable');
  assert.equal(p.actions.retry, false);
  assert.equal(p.engine, 'The decoder reported an error (bad NAL)', "the frame source's words, unchanged");
  const view = analysingView([end], { liftId: end.liftId, lift: null });
  assert.equal(view.problem.kind, 'unreadable');
  assert.equal(view.actions.retry, false);
});

test('a job error from the frame source keeps its code: a codec or a missing decoder is its own screen', async () => {
  const { MediaError } = await load('src/media/frame-source.mjs');
  const { mediaFailure } = await load('src/analysis/messages.mjs');
  const { problemOf } = await load('src/ui/problem-model.mjs');
  assert.equal(problemOf(mediaFailure(new MediaError('unsupported-codec', 'hvc1 is not supported', { codec: 'hvc1' }))).kind, 'unsupported-codec');
  assert.equal(problemOf(mediaFailure(new MediaError('no-webcodecs', 'no decoder'))).kind, 'no-webcodecs');
});
