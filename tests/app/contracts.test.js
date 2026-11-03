// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// The app's contracts (package s5; docs/app-plan.md, "The contracts"): the
// pose worker's messages, an analysis job, a stored lift, the cue view model,
// a frame source, plus the track file and the keypoints all of them carry.
// Each lives in app/src/contracts/ as a plain module: a JSDoc typedef, a
// validate…(value) that returns a list of errors, each naming its field, and a
// small valid example. For every contract: the example passes, and each
// broken field is named in the errors.
//
// The real data: the committed fixture tracks (tests/fixtures/global/) and
// diagnostics.js's headless API (s4) on them. Where a contract quotes a doc
// (the joint order, the status words), the test reads the doc.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { loadDiagnostics } = require('../loadDiagnostics');
const { loadManifests, trackPathFor } = require('../fixtures');

const ROOT = path.resolve(__dirname, '..', '..');
const CONTRACTS = path.join(ROOT, 'app', 'src', 'contracts');
const load = name => import(pathToFileURL(path.join(CONTRACTS, name)).href);

const LATERAL = 'global/example/lateral-raise-cable-1';
const SNATCH = 'global/snatch/Session14_01_0h18m07s_made';
const manifest = loadManifests();
const GLOBAL_TRACKS = Object.keys(manifest).filter(slug => slug.startsWith('global/'));
const readTrack = slug => JSON.parse(fs.readFileSync(trackPathFor(slug), 'utf8'));
const clone = v => structuredClone(v);

// Breaks one field of a valid value and asserts the errors name it.
function assertNames(validate, value, field, mutate, ...rest) {
  const v = clone(value);
  mutate(v);
  const errors = validate(v, ...rest);
  assert.ok(errors.length > 0, `breaking ${field} gave no error`);
  assert.ok(errors.some(e => e === field || e.startsWith(field + ':') || e.startsWith(field + ' ')),
    `breaking ${field}: no error names it in ${JSON.stringify(errors)}`);
}

const MODULES = ['common.mjs', 'lifts.mjs', 'keypoints.mjs', 'track.mjs', 'pose-messages.mjs', 'analysis-job.mjs',
  'stored-lift.mjs', 'cue-view.mjs', 'frame-source.mjs'];

// --- the folder -------------------------------------------------------------

test('the contracts are plain modules: no import outside app/src/contracts/, no DOM, so a worker can load them', () => {
  const files = fs.readdirSync(CONTRACTS).filter(f => f.endsWith('.mjs')).sort();
  assert.deepEqual(files, [...MODULES].sort());
  for (const f of files) {
    const src = fs.readFileSync(path.join(CONTRACTS, f), 'utf8');
    const specs = [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
    for (const s of specs) assert.match(s, /^\.\/[a-z-]+\.mjs$/, `${f} imports ${s}`);
    assert.doesNotMatch(src, /\b(document|window|localStorage)\.[A-Za-z]/, `${f} touches the DOM`);
  }
});

test('the contracts load inside a worker thread, with nothing but themselves', async () => {
  const { Worker } = require('node:worker_threads');
  const urls = MODULES.map(f => pathToFileURL(path.join(CONTRACTS, f)).href);
  const code = `const { parentPort, workerData } = require('node:worker_threads');
    Promise.all(workerData.map(u => import(u))).then(
      ms => parentPort.postMessage(ms.map(m => Object.keys(m).length)),
      e => parentPort.postMessage(String(e)));`;
  const got = await new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData: urls });
    w.once('message', m => { w.terminate(); resolve(m); });
    w.once('error', reject);
  });
  assert.ok(Array.isArray(got), String(got));
  got.forEach((n, i) => assert.ok(n > 0, MODULES[i]));
});

test('app/README.md has a Contracts section naming every module', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'app', 'README.md'), 'utf8');
  const m = readme.match(/^## Contracts\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  assert.ok(m, 'no "## Contracts" section');
  for (const f of MODULES) assert.ok(m[1].includes(f), `the section doesn't name ${f}`);
  assert.match(m[1], /package of its own/);
});

// --- keypoints --------------------------------------------------------------

test('keypoints: COCO-17 in the joint order docs/fixture-data-contract.md gives', async () => {
  const { COCO17 } = await load('keypoints.mjs');
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'fixture-data-contract.md'), 'utf8');
  const block = doc.match(/Joint order[^\n]*\n\n```\n([\s\S]*?)```/)[1];
  const fromDoc = [...block.matchAll(/(\d+) ([a-z_]+)/g)].map(m => [+m[1], m[2]]);
  assert.equal(fromDoc.length, 17);
  assert.deepEqual(COCO17, fromDoc.map(([, name]) => name));
  fromDoc.forEach(([i], k) => assert.equal(i, k));
});

test('keypoints: 17 points [y, x, conf] in frame pixels, or null', async () => {
  const { validateKeypoints, KEYPOINTS_EXAMPLE } = await load('keypoints.mjs');
  assert.deepEqual(validateKeypoints(null), []);
  assert.deepEqual(validateKeypoints(KEYPOINTS_EXAMPLE), []);
  const kp = KEYPOINTS_EXAMPLE;
  assertNames(validateKeypoints, kp, 'keypoints', v => v.pop());
  assert.ok(validateKeypoints(undefined).some(e => e.startsWith('keypoints')));
  assert.ok(validateKeypoints('none').some(e => e.startsWith('keypoints')));
  assertNames(validateKeypoints, kp, 'keypoints[3]', v => { v[3] = v[3].slice(0, 2); });
  assertNames(validateKeypoints, kp, 'keypoints[0][0]', v => { v[0][0] = NaN; });
  assertNames(validateKeypoints, kp, 'keypoints[16][1]', v => { v[16][1] = '12'; });
  assertNames(validateKeypoints, kp, 'keypoints[5][2]', v => { v[5][2] = -0.1; });
  // pose-detection's own shape, before the conversion to [y, x, conf]:
  const raw = kp.map(([y, x, score]) => ({ y, x, score }));
  assert.ok(validateKeypoints(raw).some(e => e.startsWith('keypoints[0]')));
});

test('keypoints: the example is frame 0 of a committed track, not made up', async () => {
  const { KEYPOINTS_EXAMPLE } = await load('keypoints.mjs');
  const t = readTrack(LATERAL);
  assert.deepEqual(KEYPOINTS_EXAMPLE, t.keypoints['0'][t.meta.tracks.kept]);
});

// --- the track (the fixture format, stored with a lift) ----------------------

test('track: every committed fixture track is valid in the fixture format', async () => {
  const { validateTrack } = await load('track.mjs');
  assert.ok(GLOBAL_TRACKS.length >= 4);
  for (const slug of GLOBAL_TRACKS) assert.deepEqual(validateTrack(readTrack(slug)), [], slug);
});

test('track: a fixture track round-trips through frames and JSON', async () => {
  const { framesFromTrack, trackFromFrames, validateTrack } = await load('track.mjs');
  const { validateKeypoints } = await load('keypoints.mjs');
  for (const slug of GLOBAL_TRACKS) {
    const t = readTrack(slug);
    const frames = framesFromTrack(t);
    assert.equal(frames.length, t.meta.frames_processed, slug);
    frames.forEach((f, i) => {
      assert.equal(f.index, t.meta.frame_indices[i]);
      assert.equal(f.tMs, t.meta.frame_times_ms[i]);
      assert.deepEqual(validateKeypoints(f.keypoints), []);
    });
    const back = trackFromFrames(frames, t.meta);
    assert.deepEqual(validateTrack(back), [], slug);
    assert.deepEqual(back, t, slug);
    assert.deepEqual(JSON.parse(JSON.stringify(back)), t, slug);
  }
  // A frame with no person stays a frame with no person: the snatch has seven.
  const s = readTrack(SNATCH);
  const empty = framesFromTrack(s).filter(f => f.keypoints === null).length;
  assert.equal(empty, Object.values(s.keypoints).filter(fr => !Object.keys(fr).length).length);
  assert.ok(empty > 0);
});

test('track: a rebuilt track scores exactly as the committed one', async () => {
  const { framesFromTrack, trackFromFrames } = await load('track.mjs');
  const D = loadDiagnostics();
  for (const slug of [LATERAL, SNATCH]) {
    const t = readTrack(slug);
    D.setPage(manifest[slug].diagnostics);
    const back = trackFromFrames(framesFromTrack(t), t.meta);
    const a = D.computeResults(t.keypoints, t.meta, t.meta.tracks.kept);
    const b = D.computeResults(back.keypoints, back.meta, back.meta.tracks.kept);
    assert.deepEqual(b.results, a.results, slug);
    assert.deepEqual(b.lift, a.lift, slug);
  }
});

test('track: COCO17_SKELETON is every committed track\'s meta.skeleton', async () => {
  const { COCO17_SKELETON } = await load('track.mjs');
  for (const slug of GLOBAL_TRACKS) assert.deepEqual(COCO17_SKELETON, readTrack(slug).meta.skeleton, slug);
});

test('track: the app\'s own track, one person under its id, in the fixture format', async () => {
  const { trackFromFrames, appTrackMeta, validateTrack, APP_PERSON_ID } = await load('track.mjs');
  const { KEYPOINTS_EXAMPLE } = await load('keypoints.mjs');
  const frames = [
    { index: 0, tMs: 0, keypoints: KEYPOINTS_EXAMPLE },
    { index: 1, tMs: 40, keypoints: null },
    { index: 2, tMs: 80, keypoints: KEYPOINTS_EXAMPLE },
  ];
  const t = trackFromFrames(frames, appTrackMeta({ fps: 25, frameCount: 3, width: 1080, height: 1920 }));
  assert.deepEqual(validateTrack(t), []);
  assert.deepEqual(Object.keys(t.keypoints), ['0', '1', '2']);
  assert.deepEqual(t.keypoints['1'], {});
  assert.deepEqual(t.keypoints['2'][APP_PERSON_ID], KEYPOINTS_EXAMPLE);
  assert.equal(t.meta.tracks.kept, APP_PERSON_ID);
  assert.equal(t.meta.tracks.kept_frames, 2);
  assert.deepEqual(t.meta.frame_indices, [0, 1, 2]);
  assert.deepEqual(t.meta.frame_times_ms, [0, 40, 80]);
  assert.equal(t.meta.frames_processed, 3);
});

test('track: each broken field is named', async () => {
  const { validateTrack } = await load('track.mjs');
  const t = readTrack(LATERAL);
  const kept = t.meta.tracks.kept;
  assertNames(validateTrack, t, 'keypoints', v => { v.keypoints = []; });
  assertNames(validateTrack, t, 'keypoints.x', v => { v.keypoints.x = {}; });
  assertNames(validateTrack, t, 'keypoints.9999', v => { v.keypoints['9999'] = {}; });
  assertNames(validateTrack, t, 'keypoints.3.999', v => { v.keypoints['3']['999'] = v.keypoints['3'][kept]; });
  assertNames(validateTrack, t, `keypoints.4.${kept}`, v => { v.keypoints['4'][kept].pop(); });
  assertNames(validateTrack, t, `keypoints.5.${kept}[2][0]`, v => { v.keypoints['5'][kept][2][0] = null; });
  assertNames(validateTrack, t, 'meta', v => { delete v.meta; });
  assertNames(validateTrack, t, 'meta.width', v => { v.meta.width = 0; });
  assertNames(validateTrack, t, 'meta.height', v => { v.meta.height = 1920.5; });
  assertNames(validateTrack, t, 'meta.fps', v => { v.meta.fps = -1; });
  assertNames(validateTrack, t, 'meta.frame_count', v => { v.meta.frame_count = '75'; });
  assertNames(validateTrack, t, 'meta.frames_processed', v => { v.meta.frames_processed = 74; });
  assertNames(validateTrack, t, 'meta.frame_stride', v => { v.meta.frame_stride = 0; });
  assertNames(validateTrack, t, 'meta.frame_indices', v => { v.meta.frame_indices.pop(); });
  assertNames(validateTrack, t, 'meta.frame_times_ms', v => { v.meta.frame_times_ms.pop(); });
  assertNames(validateTrack, t, 'meta.frame_times_ms[3]', v => { v.meta.frame_times_ms[3] = 'x'; });
  assertNames(validateTrack, t, 'meta.tracks.kept', v => { delete v.meta.tracks.kept; });
  assertNames(validateTrack, t, 'meta.tracks.kept', v => { v.meta.tracks.kept = 12; });
});

// --- 1. the pose worker's messages --------------------------------------------

test('pose messages: one example per message, each valid', async () => {
  const { validatePoseMessage, POSE_MESSAGE_EXAMPLES, TO_WORKER, FROM_WORKER } = await load('pose-messages.mjs');
  assert.deepEqual(TO_WORKER, ['init', 'estimate', 'reset']);
  assert.deepEqual(FROM_WORKER, ['ready', 'error', 'result', 'cleared']);
  const types = POSE_MESSAGE_EXAMPLES.map(m => m.type);
  for (const t of [...TO_WORKER, ...FROM_WORKER]) assert.ok(types.includes(t), `no example of ${t}`);
  for (const m of POSE_MESSAGE_EXAMPLES) assert.deepEqual(validatePoseMessage(m), [], m.type);
  // a result with no person, and a failed estimate
  assert.deepEqual(validatePoseMessage({ type: 'result', id: 3, keypoints: null, ms: 95.5 }), []);
  assert.deepEqual(validatePoseMessage({ type: 'result', id: 3, error: 'out of memory' }), []);
});

test('pose messages: reset {id} clears MoveNet\'s crop in the worker, answered by cleared {id} or cleared {id, error}', async () => {
  const { validatePoseMessage, POSE_MESSAGE_EXAMPLES } = await load('pose-messages.mjs');
  assert.deepEqual(validatePoseMessage({ type: 'reset', id: 7 }), []);
  assert.deepEqual(validatePoseMessage({ type: 'cleared', id: 7 }), []);
  assert.deepEqual(validatePoseMessage({ type: 'cleared', id: 7, error: 'the engine was not initialised: send init first' }), []);
  const ex = type => POSE_MESSAGE_EXAMPLES.find(m => m.type === type);
  const v = validatePoseMessage;
  assertNames(v, ex('reset'), 'id', m => { delete m.id; });
  assertNames(v, ex('reset'), 'id', m => { m.id = -1; });
  assertNames(v, ex('reset'), 'backend', m => { m.backend = 'webgl'; });   // a reset keeps the model: no new backend
  assertNames(v, ex('cleared'), 'id', m => { m.id = 1.5; });
  assertNames(v, ex('cleared'), 'error', m => { m.error = ''; });
  assertNames(v, ex('cleared'), 'ms', m => { m.ms = 3; });
  assertNames(v, ex('cleared'), 'keypoints', m => { m.keypoints = null; });
});

test('pose messages: pose-bench\'s, trimmed to MoveNet: no detector, model or ep options', async () => {
  const { validatePoseMessage } = await load('pose-messages.mjs');
  // What spike/pose-bench/lib/pose-client.mjs sends: init { opts }.
  const bench = { type: 'init', opts: { model: 'movenet-thunder', ep: 'tfjs-webgl', detector: 'yolo', detEvery: 5 } };
  const errs = validatePoseMessage(bench);
  assert.ok(errs.some(e => e.startsWith('opts')), JSON.stringify(errs));
  assert.ok(errs.some(e => e.startsWith('backend')), JSON.stringify(errs));
  for (const extra of ['detector', 'detEvery', 'model', 'ep']) {
    const e = validatePoseMessage({ type: 'init', backend: 'webgl', [extra]: 'x' });
    assert.ok(e.some(s => s.startsWith(extra)), `${extra}: ${JSON.stringify(e)}`);
  }
  // pose-bench's result carried the detector's box and a breakdown of ms.
  const box = validatePoseMessage({ type: 'result', id: 0, keypoints: null, box: [0, 0, 1, 1], ms: 90 });
  assert.ok(box.some(e => e.startsWith('box')));
  const ms = validatePoseMessage({ type: 'result', id: 0, keypoints: null, ms: { pre: 2, pose: 80, total: 90 } });
  assert.ok(ms.some(e => e.startsWith('ms')));
});

test('pose messages: each broken field is named', async () => {
  const { validatePoseMessage, POSE_MESSAGE_EXAMPLES } = await load('pose-messages.mjs');
  const ex = type => POSE_MESSAGE_EXAMPLES.find(m => m.type === type);
  const v = validatePoseMessage;
  assertNames(v, ex('init'), 'type', m => { m.type = 'start'; });
  assert.ok(v(null).some(e => e.startsWith('message')));
  assertNames(v, ex('init'), 'backend', m => { m.backend = 'tfjs-webgl'; });
  assertNames(v, ex('init'), 'backend', m => { delete m.backend; });
  assertNames(v, ex('ready'), 'info', m => { delete m.info; });
  assertNames(v, ex('ready'), 'info.model', m => { m.info.model = ''; });
  assertNames(v, ex('ready'), 'info.backend', m => { m.info.backend = 'gpu'; });
  assertNames(v, ex('ready'), 'info.runtime', m => { delete m.info.runtime; });
  assertNames(v, ex('ready'), 'info.initMs', m => { m.info.initMs = -5; });
  assertNames(v, ex('ready'), 'info.gpu', m => { m.info.gpu = true; });
  assertNames(v, ex('error'), 'error', m => { m.error = ''; });
  const est = POSE_MESSAGE_EXAMPLES.find(m => m.type === 'estimate');
  const brokenEstimate = (field, mutate) => {
    const m = { ...est };
    mutate(m);
    const errs = v(m);
    assert.ok(errs.some(e => e.startsWith(field)), `${field}: ${JSON.stringify(errs)}`);
  };
  brokenEstimate('id', m => { m.id = -1; });
  brokenEstimate('id', m => { m.id = 1.5; });
  brokenEstimate('frame', m => { delete m.frame; });
  brokenEstimate('frame', m => { m.frame = { displayWidth: 0, displayHeight: 0, timestamp: 0, close() {} }; });
  brokenEstimate('frame', m => { m.frame = { displayWidth: 640, displayHeight: 480, timestamp: 0 }; });
  brokenEstimate('tMs', m => { m.tMs = NaN; });
  brokenEstimate('tMs', m => { m.tMs = -1; });
  assertNames(v, ex('result'), 'id', m => { delete m.id; });
  assertNames(v, ex('result'), 'keypoints', m => { m.keypoints.pop(); });
  assertNames(v, ex('result'), 'keypoints[2][1]', m => { m.keypoints[2][1] = Infinity; });
  assertNames(v, ex('result'), 'ms', m => { delete m.ms; });
  assertNames(v, ex('result'), 'error', m => { m.error = 'both'; });
});

// --- 3. a stored lift ---------------------------------------------------------

test('stored lift: the examples are valid, analysed and not yet', async () => {
  const { validateStoredLift, STORED_LIFT_EXAMPLE, liftPaths } = await load('stored-lift.mjs');
  assert.deepEqual(validateStoredLift(STORED_LIFT_EXAMPLE), []);
  const fresh = { ...clone(STORED_LIFT_EXAMPLE), track: null, result: null, engine: null };
  assert.deepEqual(validateStoredLift(fresh), []);
  const p = liftPaths('abc-1');
  assert.deepEqual(p, { folder: 'lifts/abc-1/', video: 'lifts/abc-1/cut.mp4',
    track: 'lifts/abc-1/track.json', result: 'lifts/abc-1/result.json' });
  const canonical = { ...clone(STORED_LIFT_EXAMPLE), id: 'abc-1', video: p.video, track: p.track, result: p.result };
  assert.deepEqual(validateStoredLift(canonical), []);
  assert.deepEqual(JSON.parse(JSON.stringify(STORED_LIFT_EXAMPLE)), STORED_LIFT_EXAMPLE);
});

test('stored lift: its engine is what the pose worker\'s ready message names', async () => {
  const { STORED_LIFT_EXAMPLE } = await load('stored-lift.mjs');
  const { POSE_MESSAGE_EXAMPLES } = await load('pose-messages.mjs');
  const info = POSE_MESSAGE_EXAMPLES.find(m => m.type === 'ready').info;
  for (const k of Object.keys(STORED_LIFT_EXAMPLE.engine)) assert.ok(k in info, k);
});

test('stored lift: each broken field is named', async () => {
  const { validateStoredLift, STORED_LIFT_EXAMPLE: L } = await load('stored-lift.mjs');
  const v = validateStoredLift;
  assert.ok(v(null).some(e => e.startsWith('lift')));
  assertNames(v, L, 'id', l => { l.id = 'Has Spaces'; });
  assertNames(v, L, 'id', l => { l.id = '../up'; });
  assertNames(v, L, 'created', l => { l.created = 'yesterday'; });
  assertNames(v, L, 'created', l => { l.created = 1761955200000; });
  assertNames(v, L, 'lift', l => { l.lift = 'clean-and-jerk'; });
  assertNames(v, L, 'video', l => { l.video = 'lifts/other/cut.mp4'; });
  assertNames(v, L, 'video', l => { l.video = `lifts/${l.id}/cut.mov`; });
  assertNames(v, L, 'video', l => { l.video = `/lifts/${l.id}/cut.mp4`; });
  assertNames(v, L, 'video', l => { l.video = `lifts/${l.id}/../x/cut.mp4`; });
  assertNames(v, L, 'range', l => { delete l.range; });
  assertNames(v, L, 'range.t0', l => { l.range.t0 = -0.5; });
  assertNames(v, L, 'range.t1', l => { l.range.t1 = l.range.t0; });
  assertNames(v, L, 'track', l => { l.track = 'elsewhere/track.json'; });
  assertNames(v, L, 'track', l => { l.track = null; });
  assertNames(v, L, 'result', l => { l.result = `lifts/${l.id}/result.txt`; });
  assertNames(v, L, 'appVersion', l => { l.appVersion = ''; });
  assertNames(v, L, 'engine', l => { l.engine = null; });
  assertNames(v, L, 'engine.model', l => { delete l.engine.model; });
  assertNames(v, L, 'engine.backend', l => { l.engine.backend = 'gpu'; });
  assertNames(v, L, 'engine.runtime', l => { l.engine.runtime = 4; });
  assertNames(v, L, 'notes', l => { l.notes = 'unknown field'; });
});

// --- 2. an analysis job -------------------------------------------------------

test('analysis job: the example is valid and names only stored files', async () => {
  const { validateAnalysisJob, ANALYSIS_JOB_EXAMPLE, JOB_STATES } = await load('analysis-job.mjs');
  const { STORED_LIFT_EXAMPLE } = await load('stored-lift.mjs');
  assert.deepEqual(JOB_STATES, ['queued', 'reading', 'pose', 'scoring', 'done', 'failed', 'cancelled']);
  assert.deepEqual(validateAnalysisJob(ANALYSIS_JOB_EXAMPLE), []);
  assert.deepEqual(validateAnalysisJob(ANALYSIS_JOB_EXAMPLE, { lift: STORED_LIFT_EXAMPLE }), []);
  assert.equal(ANALYSIS_JOB_EXAMPLE.source, STORED_LIFT_EXAMPLE.video);
});

test('analysis job: a queued job survives a restart (JSON in, the same job out)', async () => {
  const { validateAnalysisJob, createJob } = await load('analysis-job.mjs');
  const { STORED_LIFT_EXAMPLE } = await load('stored-lift.mjs');
  const job = createJob('job-1', STORED_LIFT_EXAMPLE);
  assert.equal(job.state, 'queued');
  assert.equal(job.liftId, STORED_LIFT_EXAMPLE.id);
  assert.equal(job.lift, STORED_LIFT_EXAMPLE.lift);
  assert.equal(job.source, STORED_LIFT_EXAMPLE.video);
  assert.deepEqual(job.range, STORED_LIFT_EXAMPLE.range);
  assert.notEqual(job.range, STORED_LIFT_EXAMPLE.range);
  const back = JSON.parse(JSON.stringify(job));
  assert.deepEqual(back, job);
  assert.deepEqual(validateAnalysisJob(back, { lift: STORED_LIFT_EXAMPLE }), []);
});

test('analysis job: the source is the stored cut\'s path, never a File, a Blob or a URL', async () => {
  const { validateAnalysisJob, ANALYSIS_JOB_EXAMPLE: J } = await load('analysis-job.mjs');
  const bad = [
    new File([new Uint8Array(8)], 'lift.mp4', { type: 'video/mp4' }),
    new Blob([new Uint8Array(8)], { type: 'video/mp4' }),
    'blob:http://127.0.0.1:8090/2c4e-…',
    'file:///sdcard/DCIM/lift.mp4',
    'https://example.org/lift.mp4',
    `/lifts/${J.liftId}/cut.mp4`,
    `lifts/${J.liftId}/../other/cut.mp4`,
    'lifts/another-lift/cut.mp4',
    `lifts/${J.liftId}/track.json`,
    { path: J.source },
    '',
  ];
  for (const source of bad) {
    const errs = validateAnalysisJob({ ...J, range: { ...J.range }, progress: J.progress && { ...J.progress }, source });
    assert.ok(errs.some(e => e.startsWith('source')), `${String(source)}: ${JSON.stringify(errs)}`);
  }
});

test('analysis job: each broken field is named', async () => {
  const { validateAnalysisJob, ANALYSIS_JOB_EXAMPLE: J } = await load('analysis-job.mjs');
  const { STORED_LIFT_EXAMPLE } = await load('stored-lift.mjs');
  const v = validateAnalysisJob;
  assert.ok(v(undefined).some(e => e.startsWith('job')));
  assertNames(v, J, 'id', j => { j.id = ''; });
  assertNames(v, J, 'liftId', j => { delete j.liftId; });
  assertNames(v, J, 'lift', j => { j.lift = 'squat'; });
  assertNames(v, J, 'range', j => { j.range = [0, 1]; });
  assertNames(v, J, 'range.t0', j => { j.range.t0 = 'start'; });
  assertNames(v, J, 'range.t1', j => { j.range.t1 = j.range.t0 - 1; });
  assertNames(v, J, 'range.extra', j => { j.range.extra = 1; });
  assertNames(v, J, 'state', j => { j.state = 'running'; });
  assertNames(v, J, 'progress', j => { j.state = 'pose'; j.progress = null; });
  assertNames(v, J, 'progress.stage', j => { j.state = 'pose'; j.progress = { stage: 'reading', done: 0, total: 10, etaS: null }; });
  assertNames(v, J, 'progress.done', j => { j.state = 'pose'; j.progress = { stage: 'pose', done: 11, total: 10, etaS: 3 }; });
  assertNames(v, J, 'progress.total', j => { j.state = 'pose'; j.progress = { stage: 'pose', done: 0, total: -1, etaS: 3 }; });
  assertNames(v, J, 'progress.etaS', j => { j.state = 'pose'; j.progress = { stage: 'pose', done: 1, total: 10, etaS: -2 }; });
  assertNames(v, J, 'error', j => { j.state = 'failed'; j.error = null; });
  assertNames(v, J, 'error', j => { j.error = 'not failed'; });
  assertNames(v, J, 'file', j => { j.file = 'unknown'; });
  // checked against its lift
  const other = { ...clone(STORED_LIFT_EXAMPLE) };
  assertNames(v, J, 'range', j => { j.range = { t0: 0, t1: 9 }; }, { lift: other });
  assertNames(v, J, 'lift', j => { j.lift = j.lift === 'snatch' ? 'lateral-raise' : 'snatch'; }, { lift: other });
  const moved = { ...clone(STORED_LIFT_EXAMPLE), video: `lifts/${STORED_LIFT_EXAMPLE.id}/cut-2.mp4` };
  assertNames(v, J, 'source', () => {}, { lift: moved });
});

test('analysis job: a re-mark names the lift it replaces (s50), null for any other job, and is validated like the rest', async () => {
  const { validateAnalysisJob, createJob, ANALYSIS_JOB_EXAMPLE: J } = await load('analysis-job.mjs');
  const { STORED_LIFT_EXAMPLE } = await load('stored-lift.mjs');
  assert.equal(J.replaces, null, 'a plain Analyse replaces nothing');
  assert.equal(createJob('job-1', STORED_LIFT_EXAMPLE).replaces, null);
  const re = createJob('job-1', STORED_LIFT_EXAMPLE, { replaces: '20261101-170000-lr' });
  assert.equal(re.replaces, '20261101-170000-lr');
  assert.deepEqual(validateAnalysisJob(re, { lift: STORED_LIFT_EXAMPLE }), []);
  assert.deepEqual(JSON.parse(JSON.stringify(re)), re, 'it survives a restart');
  const v = validateAnalysisJob;
  assertNames(v, J, 'replaces', j => { delete j.replaces; });
  assertNames(v, J, 'replaces', j => { j.replaces = ''; });
  assertNames(v, J, 'replaces', j => { j.replaces = 42; });
  assertNames(v, J, 'replaces', j => { j.replaces = '../other'; });
  assertNames(v, J, 'replaces', j => { j.replaces = j.liftId; });   // a lift never replaces itself
});

test('analysis job: a running and a failed job are valid', async () => {
  const { validateAnalysisJob, ANALYSIS_JOB_EXAMPLE: J } = await load('analysis-job.mjs');
  assert.deepEqual(validateAnalysisJob({ ...J, state: 'pose',
    progress: { stage: 'pose', done: 120, total: 300, etaS: null } }), []);
  assert.deepEqual(validateAnalysisJob({ ...J, state: 'failed', progress: null, error: 'The video can\'t be read.' }), []);
  assert.deepEqual(validateAnalysisJob({ ...J, state: 'done',
    progress: { stage: 'scoring', done: 1, total: 1, etaS: 0 } }), []);
});

// --- 4. the cue view model ----------------------------------------------------

test('cue view: the status words are ui-design.md\'s', async () => {
  const { STATUS_WORDS, VERDICT_STATUS } = await load('cue-view.mjs');
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'ui-design.md'), 'utf8');
  const line = doc.match(/Status: ([^.]*)/)[1].replace(/\s+/g, ' ');
  const words = [...line.matchAll(/([a-z' ]+?) `#[0-9A-F]{6}`/g)].map(m => m[1].replace(/^,? */, '').trim());
  assert.deepEqual(STATUS_WORDS, words);
  assert.deepEqual(Object.values(VERDICT_STATUS), STATUS_WORDS.slice(0, 3));
});

test('cue view: every field names its source', async () => {
  const { CUE_VIEW_SOURCES, CUE_VIEW_EXAMPLES } = await load('cue-view.mjs');
  const src = fs.readFileSync(path.join(CONTRACTS, 'cue-view.mjs'), 'utf8');
  const typedef = src.match(/@typedef \{Object\} CueView([\s\S]*?)\*\//)[1];
  // the type may hold braces itself ({{t0: number, t1: number}|null}): up to the line's last '} '
  const props = [...typedef.matchAll(/@property \{.*\} (\w+)/g)].map(m => m[1]);
  for (const ex of CUE_VIEW_EXAMPLES) assert.deepEqual(Object.keys(ex).sort(), Object.keys(CUE_VIEW_SOURCES).sort());
  assert.deepEqual(props.sort(), Object.keys(CUE_VIEW_SOURCES).sort());
  for (const [field, source] of Object.entries(CUE_VIEW_SOURCES)) {
    assert.match(source, /computeResults\(\)|describe\(set\)|tiles\(id, result\)|referenceLine\(id, result\)|worstMoment\(id, result\)|the adapter/, field);
  }
});

test('cue view: the examples are valid, a scored cue and one that can\'t be scored', async () => {
  const { validateCueView, CUE_VIEW_EXAMPLES, validateResultView, RESULT_VIEW_EXAMPLE } = await load('cue-view.mjs');
  assert.deepEqual(CUE_VIEW_EXAMPLES.map(c => c.status).sort(), ["can't score", 'good']);
  for (const c of CUE_VIEW_EXAMPLES) assert.deepEqual(validateCueView(c), [], c.id);
  assert.deepEqual(validateResultView(RESULT_VIEW_EXAMPLE), []);
  assert.deepEqual(JSON.parse(JSON.stringify(RESULT_VIEW_EXAMPLE)), RESULT_VIEW_EXAMPLE);
});

test('cue view: each broken field is named', async () => {
  const { validateCueView, CUE_VIEW_EXAMPLES } = await load('cue-view.mjs');
  const v = validateCueView;
  const good = CUE_VIEW_EXAMPLES.find(c => c.status === 'good');
  const na = CUE_VIEW_EXAMPLES.find(c => c.status === "can't score");
  assert.ok(v(7).some(e => e.startsWith('cue')));
  assertNames(v, good, 'id', c => { c.id = 3; });
  assertNames(v, good, 'title', c => { delete c.title; });
  assertNames(v, good, 'cue', c => { c.cue = null; });
  assertNames(v, good, 'unit', c => { c.unit = undefined; });
  assertNames(v, good, 'phaseLabel', c => { c.phaseLabel = 4; });
  assertNames(v, good, 'provisional', c => { c.provisional = 'yes'; });
  assertNames(v, good, 'status', c => { c.status = 'warning'; });
  assertNames(v, good, 'status', c => { c.status = 'Good'; });
  assertNames(v, good, 'verdict', c => { c.verdict = null; });
  assertNames(v, good, 'value', c => { c.value = '10.8%'; });
  assertNames(v, good, 'tiles', c => { c.tiles = {}; });
  assertNames(v, good, 'tiles[0].label', c => { delete c.tiles[0].label; });
  assertNames(v, good, 'tiles[0].value', c => { c.tiles[0].value = 10.8; });
  assertNames(v, good, 'tiles[1].status', c => { c.tiles[1].status = 1; });
  assertNames(v, good, 'referenceLine.value', c => { c.referenceLine.value = 'zero'; });
  assertNames(v, good, 'series', c => { c.series = []; });
  assertNames(v, good, 'series[0].t', c => { c.series[0].t = NaN; });
  assertNames(v, good, 'series[0].value', c => { c.series[0].value = null; });
  assertNames(v, good, 'series[0].lo', c => { c.series[0].lo = 'x'; });
  assertNames(v, good, 'phase', c => { c.phase = null; });
  assertNames(v, good, 'phase.t1', c => { c.phase.t1 = c.phase.t0 - 1; });
  assertNames(v, good, 'worst.rule', c => { delete c.worst.rule; });
  assertNames(v, good, 'worst.t', c => { c.worst.t = 'late'; });
  assertNames(v, good, 'reason', c => { c.reason = 'scored anyway'; });
  assertNames(v, good, 'notes', c => { c.notes = 'one note'; });
  assertNames(v, good, 'notes[0]', c => { c.notes = [3]; });
  assertNames(v, good, 'extra', c => { c.extra = 1; });
  // can't score: says why, and draws nothing
  assertNames(v, na, 'reason', c => { c.reason = null; });
  assertNames(v, na, 'reason', c => { c.reason = ''; });
  assertNames(v, na, 'verdict', c => { c.verdict = 'good'; });
  assertNames(v, na, 'value', c => { c.value = 1; });
  assertNames(v, na, 'tiles', c => { c.tiles = clone(good.tiles); });
  assertNames(v, na, 'series', c => { c.series = clone(good.series); });
  assertNames(v, na, 'phase', c => { c.phase = { t0: 0, t1: 1 }; });
  assertNames(v, na, 'worst', c => { c.worst = clone(good.worst); });
  assertNames(v, na, 'referenceLine', c => { c.referenceLine = clone(good.referenceLine); });
});

test('result view: each broken field is named', async () => {
  const { validateResultView, RESULT_VIEW_EXAMPLE: R } = await load('cue-view.mjs');
  const v = validateResultView;
  assert.ok(v([]).some(e => e.startsWith('result')));
  assertNames(v, R, 'lift', r => { r.lift = 'deadlift'; });
  assertNames(v, R, 'liftWindow.t1', r => { r.hasLiftWindow = true; r.liftWindow = { t0: 2, t1: 1 }; r.liftWindowReason = null; });
  assertNames(v, R, 'liftWindowReason', r => { r.hasLiftWindow = true; r.liftWindow = null; r.liftWindowReason = null; });
  assertNames(v, R, 'liftWindowReason', r => { r.hasLiftWindow = true; r.liftWindow = { t0: 0, t1: 1 }; r.liftWindowReason = 'both'; });
  assertNames(v, R, 'cues', r => { r.cues = null; });
  assertNames(v, R, 'cues[0].status', r => { r.cues[0].status = 'bad'; });
  assertNames(v, R, 'cues[1].id', r => { r.cues[1].id = r.cues[0].id; });
  assertNames(v, R, 'notes', r => { delete r.notes; });
  assertNames(v, R, 'smoothing', r => { delete r.smoothing; });
  assertNames(v, R, 'smoothing', r => { r.smoothing = 50; });
  assertNames(v, R, 'smoothing.sigmaMs', r => { r.smoothing.sigmaMs = -1; });
  assertNames(v, R, 'smoothing.sigmaMs', r => { r.smoothing.sigmaMs = NaN; });
  assertNames(v, R, 'smoothing.sigmaMs', r => { delete r.smoothing.sigmaMs; });
  assertNames(v, R, 'smoothing.keepVelocity', r => { r.smoothing.keepVelocity = 'yes'; });
  assertNames(v, R, 'smoothing.sigma', r => { r.smoothing.sigma = 0.05; });
});

test('result view: the smoothing its verdicts were scored with is part of it, as numbers', async () => {
  const { validateResultView, RESULT_VIEW_EXAMPLE: R } = await load('cue-view.mjs');
  // the example's cues are computeResults() on the committed raw track: no smoothing
  assert.equal(R.smoothing.sigmaMs, 0);
  assert.equal(typeof R.smoothing.keepVelocity, 'boolean');
  for (const smoothing of [{ sigmaMs: 50, keepVelocity: true }, { sigmaMs: 100, keepVelocity: false }, { sigmaMs: 0, keepVelocity: true }]) {
    assert.deepEqual(validateResultView({ ...clone(R), smoothing }), [], JSON.stringify(smoothing));
  }
});

test('result view: a lift window with a start and no end is {t0, t1: null}, and its reason is required', async () => {
  const { validateResultView, RESULT_VIEW_EXAMPLE: R } = await load('cue-view.mjs');
  const v = validateResultView;
  const noEnd = 'a stand-in for diagnostics.js\'s note on why the lift has no end marker (scoring.test.js checks the real one)';
  // a lift with a window (the example is a lateral raise, which has none: s36)
  const W = { ...clone(R), hasLiftWindow: true };
  assert.deepEqual(v({ ...clone(W), liftWindow: { t0: 1.2, t1: null }, liftWindowReason: noEnd }), []);
  assertNames(v, W, 'liftWindowReason', r => { r.liftWindow = { t0: 1.2, t1: null }; r.liftWindowReason = null; });
  assertNames(v, W, 'liftWindowReason', r => { r.liftWindow = { t0: 1.2, t1: null }; r.liftWindowReason = ''; });
  assertNames(v, W, 'liftWindow.t0', r => { r.liftWindow = { t0: null, t1: 2 }; r.liftWindowReason = noEnd; });
  assertNames(v, W, 'liftWindow.t0', r => { r.liftWindow = { t0: null, t1: null }; r.liftWindowReason = noEnd; });
  assertNames(v, W, 'liftWindow.t1', r => { r.liftWindow = { t0: 1.2 }; r.liftWindowReason = noEnd; });
  assertNames(v, W, 'liftWindow.t1', r => { r.liftWindow = { t0: 1.2, t1: NaN }; r.liftWindowReason = noEnd; });
  // both ends found: no reason
  assert.deepEqual(v({ ...clone(W), liftWindow: { t0: 1.2, t1: 2.4 }, liftWindowReason: null }), []);
  assertNames(v, W, 'liftWindowReason', r => { r.liftWindow = { t0: 1.2, t1: 2.4 }; r.liftWindowReason = noEnd; });
});

test('result view: a lift without a lift window has no window and no reason, and says so (s36)', async () => {
  const { validateResultView, RESULT_VIEW_EXAMPLE: R } = await load('cue-view.mjs');
  const v = validateResultView;
  // the example is a lateral raise: diagnostics.js gives it no window and no error
  assert.equal(R.hasLiftWindow, false);
  assert.equal(R.liftWindow, null);
  assert.equal(R.liftWindowReason, null);
  assert.deepEqual(v(R), []);
  // the flag is required, and a boolean
  assertNames(v, R, 'hasLiftWindow', r => { delete r.hasLiftWindow; });
  assertNames(v, R, 'hasLiftWindow', r => { r.hasLiftWindow = 'no'; });
  assertNames(v, R, 'hasLiftWindow', r => { r.hasLiftWindow = null; });
  // fields that disagree with it are refused: no window, and no reason for one
  assertNames(v, R, 'liftWindow', r => { r.liftWindow = { t0: 1.2, t1: 2.4 }; });
  assertNames(v, R, 'liftWindow', r => { r.liftWindow = { t0: 1.2, t1: null }; });
  assertNames(v, R, 'liftWindowReason', r => { r.liftWindowReason = 'The bar never sits below knee height in this clip, so there is no start of the lift to mark.'; });
  assertNames(v, R, 'liftWindowReason', r => { r.liftWindowReason = ''; });
  // and a lift with a window that has neither window nor reason is refused, as before
  assertNames(v, R, 'liftWindowReason', r => { r.hasLiftWindow = true; });
});

// What the view model takes from diagnostics.js, read off the real API on the
// committed tracks: a sketch of s11's adapter, only to show that each named
// source gives the shape the contract asks for.
function viewFrom(D, set, out) {
  const { VERDICT_STATUS, verdictValue } = this;
  const cues = D.describe(set).map(d => {
    const r = out.results[d.id];
    const base = { id: d.id, title: d.title, cue: d.cue, unit: d.unit, phaseLabel: d.phaseLabel, provisional: d.provisional };
    if (r.error) {
      return { ...base, status: "can't score", verdict: null, value: null, tiles: [], referenceLine: null,
        series: [], phase: null, worst: null, reason: r.error, notes: r.notes || [] };
    }
    const worst = D.worstMoment(d.id, r);
    return { ...base, status: VERDICT_STATUS[r.verdict.status], verdict: r.verdict.label,
      value: worst ? verdictValue(worst.rule, r.summary) : null,
      tiles: D.tiles(d.id, r), referenceLine: D.referenceLine(d.id, r),
      series: r.series.map(s => ({ t: s.t, value: s.value, lo: s.lo, hi: s.hi })),
      phase: { t0: out.samples[r.phase.startIdx].t, t1: out.samples[r.phase.endIdx].t },
      worst, reason: null, notes: r.notes };
  });
  if (out.lift.hasLiftWindow === false) {
    return { lift: set, hasLiftWindow: false, liftWindow: null, liftWindowReason: null, cues,
      notes: out.lift.notes, smoothing: { sigmaMs: 0, keepVelocity: true } };
  }
  const ok = !out.lift.error;
  const end = ok && out.lift.t1 != null;
  return { lift: set, hasLiftWindow: true, liftWindow: ok ? { t0: out.lift.t0, t1: end ? out.lift.t1 : null } : null,
    liftWindowReason: ok ? (end ? null : out.lift.notes.at(-1)) : out.lift.error, cues,
    notes: end || !ok ? out.lift.notes : out.lift.notes.slice(0, -1), smoothing: { sigmaMs: 0, keepVelocity: true } };
}

test('cue view: the sources it names give its shapes, on the committed tracks', async () => {
  const mod = await load('cue-view.mjs');
  const D = loadDiagnostics();
  const seen = new Set();
  for (const slug of [LATERAL, SNATCH]) {
    const set = manifest[slug].diagnostics;
    D.setPage(set);
    const t = readTrack(slug);
    const out = D.computeResults(t.keypoints, t.meta, t.meta.tracks.kept);
    for (const r of Object.values(out.results)) if (r.verdict) seen.add(r.verdict.status);
    const view = viewFrom.call(mod, D, set, out);
    assert.deepEqual(mod.validateResultView(view), [], slug);
    for (const c of view.cues) seen.add(c.status);
  }
  // Every verdict status diagnostics.js gives maps to a word; the two tracks
  // give all three, and "can't score" (lateral raise: one rep, no symmetry).
  assert.deepEqual([...seen].filter(s => !(s in mod.VERDICT_STATUS) && !mod.STATUS_WORDS.includes(s)), []);
  for (const w of ['good', 'watch', 'work on', "can't score"]) assert.ok(seen.has(w), w);
});

// A card's value is the number its verdict is scored on, not the worst
// moment's sample. The snatch's first-pull back angle is a 'farthest-from-mean'
// cue: diagnostics.js scores it on the SD around the pull's mean
// (src/diagnostics.js, the cue's verdict(summary) reads summary.sd), so its
// value is results[id].summary.sd, which on this track differs from the
// sample worstMoment() returns (a raw angle to the floor).
test('cue view: value is the summary field the verdict is scored on (snatch, farthest-from-mean)', async () => {
  const mod = await load('cue-view.mjs');
  const D = loadDiagnostics();
  D.setPage('snatch');
  const t = readTrack(SNATCH);
  const out = D.computeResults(t.keypoints, t.meta, t.meta.tracks.kept);
  const id = 'first-pull-back-angle';
  const r = out.results[id];
  assert.ok(!r.error, r.error);
  const worst = D.worstMoment(id, r);
  assert.equal(worst.rule, 'farthest-from-mean');
  assert.equal(mod.VERDICT_VALUE[worst.rule], 'summary.sd');
  assert.match(mod.CUE_VIEW_SOURCES.value, /VERDICT_VALUE/);
  const card = viewFrom.call(mod, D, 'snatch', out).cues.find(c => c.id === id);
  assert.equal(card.value, r.summary.sd);
  assert.notEqual(card.value, worst.value);
  assert.deepEqual(mod.validateCueView(card), []);
});

// Every rule a cue in diagnostics.js names has its value in VERDICT_VALUE, and
// each scored cue on the committed tracks gets a number from the field named.
test('cue view: every worstRule in diagnostics.js names its value, and each scored cue gets it', async () => {
  const mod = await load('cue-view.mjs');
  const src = fs.readFileSync(path.join(ROOT, 'src', 'diagnostics.js'), 'utf8');
  const rules = new Set([...src.matchAll(/worstRule: '([a-z-]+)'/g)].map(m => m[1]));
  assert.ok(rules.size >= 4);
  assert.deepEqual([...rules].filter(rule => !(rule in mod.VERDICT_VALUE)), []);
  assert.deepEqual(Object.keys(mod.VERDICT_VALUE).filter(rule => !rules.has(rule)), []);
  const D = loadDiagnostics();
  for (const slug of [LATERAL, SNATCH]) {
    const set = manifest[slug].diagnostics;
    D.setPage(set);
    const t = readTrack(slug);
    const out = D.computeResults(t.keypoints, t.meta, t.meta.tracks.kept);
    for (const c of viewFrom.call(mod, D, set, out).cues) {
      if (c.status === "can't score") continue;
      const s = out.results[c.id].summary;
      const expected = {
        'summary-worst': s.worst, 'summary-last': s.decline, 'farthest-from-mean': s.sd,
        'phase-end': Math.max(s.hipDeficit, s.kneeDeficit == null ? -Infinity : s.kneeDeficit),
      }[c.worst.rule];
      assert.equal(c.value, expected, `${slug} ${c.id}`);
    }
  }
  assert.equal(mod.verdictValue('no-such-rule', { worst: 1 }), null);
  assert.equal(mod.verdictValue('phase-end', { hipDeficit: 4, kneeDeficit: null }), 4);
  assert.equal(mod.verdictValue('phase-end', { hipDeficit: 4, kneeDeficit: 9 }), 9);
});

test('cue view: the examples are the lateral raise\'s real output, not made up', async () => {
  const mod = await load('cue-view.mjs');
  const D = loadDiagnostics();
  D.setPage('lateral-raise');
  const t = readTrack(LATERAL);
  const view = viewFrom.call(mod, D, 'lateral-raise', D.computeResults(t.keypoints, t.meta, t.meta.tracks.kept));
  for (const ex of mod.CUE_VIEW_EXAMPLES) {
    const real = view.cues.find(c => c.id === ex.id);
    assert.ok(real, ex.id);
    assert.deepEqual({ ...ex, series: ex.series.length }, { ...real, series: real.series.length }, ex.id);
    assert.deepEqual(ex.series, real.series.slice(0, ex.series.length), ex.id);
  }
});

// --- 5. a frame source ----------------------------------------------------------

test('frame source: the info and the example source are valid', async () => {
  const { validateFrameSourceInfo, validateFrameSource, FRAME_SOURCE_INFO_EXAMPLE, exampleFrameSource } = await load('frame-source.mjs');
  assert.deepEqual(validateFrameSourceInfo(FRAME_SOURCE_INFO_EXAMPLE), []);
  const src = exampleFrameSource();
  assert.deepEqual(validateFrameSource(src), []);
  assert.deepEqual(src.info, FRAME_SOURCE_INFO_EXAMPLE);
  // frameTimes: every frame's start, from the first frame at 0, in presentation order
  const n = Math.round(FRAME_SOURCE_INFO_EXAMPLE.duration * FRAME_SOURCE_INFO_EXAMPLE.fps);
  assert.equal(src.frameTimes.length, n);
  src.frameTimes.forEach((t, i) => assert.ok(Math.abs(t - i / FRAME_SOURCE_INFO_EXAMPLE.fps) < 1e-9, `frame ${i}: ${t}`));
  src.close();
});

test('frame source: frameTimes is part of a source (s9 gives it; M1–M3 step on it): required, an array of finite seconds from 0, in order', async () => {
  const { validateFrameSource, exampleFrameSource } = await load('frame-source.mjs');
  const broken = (mutate, what) => {
    const src = exampleFrameSource();
    mutate(src);
    const errors = validateFrameSource(src);
    assert.ok(errors.some(e => e.startsWith('frameTimes')), `${what}: ${JSON.stringify(errors)}`);
  };
  broken(s => { delete s.frameTimes; }, 'missing');
  broken(s => { s.frameTimes = '0,0.04,0.08'; }, 'not an array');
  broken(s => { s.frameTimes = { 0: 0, 1: 0.04, length: 2 }; }, 'array-like, not an array');
  broken(s => { s.frameTimes = []; }, 'empty: an open video has a first frame');
  broken(s => { s.frameTimes = [0, 0.04, NaN]; }, 'NaN');
  broken(s => { s.frameTimes = [0, 0.04, Infinity]; }, 'Infinity');
  broken(s => { s.frameTimes = [0, '0.04', 0.08]; }, 'a string');
  broken(s => { s.frameTimes = [0, 0.08, 0.04]; }, 'out of order');
  broken(s => { s.frameTimes = [0, 0.04, 0.04]; }, 'two frames at one time');
  broken(s => { s.frameTimes = [0.04, 0.08]; }, 'not from the first frame');
  broken(s => { s.frameTimes = [-0.04, 0, 0.04]; }, 'negative');
  // the error names the frame
  const src = exampleFrameSource();
  src.frameTimes = [0, 0.08, 0.04];
  assert.ok(validateFrameSource(src).some(e => e.startsWith('frameTimes[2]')), JSON.stringify(validateFrameSource(src)));
  // a variable rate's own times are fine
  const vfr = exampleFrameSource();
  vfr.frameTimes = [0, 0.0273, 0.0625, 0.0977];
  assert.deepEqual(validateFrameSource(vfr), []);
});

test('frame source: each broken field is named', async () => {
  const { validateFrameSourceInfo, validateFrameSource, FRAME_SOURCE_INFO_EXAMPLE: I, exampleFrameSource } = await load('frame-source.mjs');
  const v = validateFrameSourceInfo;
  assert.ok(v(null).some(e => e.startsWith('info')));
  assertNames(v, I, 'duration', i => { i.duration = 0; });
  assertNames(v, I, 'fps', i => { i.fps = -30; });
  assertNames(v, I, 'width', i => { i.width = 1080.5; });
  assertNames(v, I, 'height', i => { delete i.height; });
  assertNames(v, I, 'rotation', i => { i.rotation = 45; });
  assertNames(v, I, 'codec', i => { i.codec = 264; });
  assertNames(v, I, 'bitrate', i => { i.bitrate = 1; });
  for (const method of ['frameAt', 'frames', 'thumbnails', 'stepper', 'close']) {
    const src = exampleFrameSource();
    delete src[method];
    assert.ok(validateFrameSource(src).some(e => e.startsWith(method)), method);
  }
  const src = exampleFrameSource();
  src.info = { ...src.info, rotation: 30 };
  assert.ok(validateFrameSource(src).some(e => e.startsWith('info.rotation')));
});

test('frame source: the stepper (s38) is part of a source: opened at a time, it steps by frameTimes, holds a budget, and closes its frames', async () => {
  const { exampleFrameSource, STEPPER_BUDGET } = await load('frame-source.mjs');
  assert.deepEqual(STEPPER_BUDGET, { maxFrames: 90, maxBytes: 128 * 1024 * 1024 });
  assert.ok(Object.isFrozen(STEPPER_BUDGET));
  const src = exampleFrameSource();
  const st = await src.stepper(1.01, { height: 64 });
  assert.equal(st.index, 25, 'the frame shown at 1.01 s at 25 fps');
  assert.equal(st.time, src.frameTimes[25]);
  assert.deepEqual([st.width, st.height, st.frame.width, st.frame.height], [36, 64, 36, 64], '1080 × 1920 scaled to 64 high');
  assert.deepEqual(st.budget, { ...STEPPER_BUDGET, frameBytes: 36 * 64 * 4, frames: 90 });
  const r = await st.step(1);
  assert.deepEqual([r.index, r.time, r.cached], [26, src.frameTimes[26], true]);
  assert.equal(r.frame, st.frame);
  assert.equal((await st.step(-2)).index, 24);
  assert.equal((await st.seek(99)).index, src.frameTimes.length - 1);
  assert.equal((await st.step(1)).index, src.frameTimes.length - 1, 'the last frame stays put');
  await st.settled();
  assert.ok(st.held >= 1 && st.held <= st.budget.frames);
  assert.equal(st.bytes, st.held * st.budget.frameBytes);
  const shown = st.frame;
  st.close();
  assert.equal(shown.width, 0, 'close() closes the frames it held');
  await assert.rejects(st.step(1));
  src.close();
});

test('frame source: a range is a stream of frames in order, each one an estimate message can carry', async () => {
  const { exampleFrameSource } = await load('frame-source.mjs');
  const { validatePoseMessage } = await load('pose-messages.mjs');
  const src = exampleFrameSource();
  const { fps } = src.info;
  const ts = [];
  for await (const frame of src.frames(0.5, 1.0)) {
    const tS = frame.timestamp / 1e6;
    assert.deepEqual(validatePoseMessage({ type: 'estimate', id: ts.length, frame, tMs: tS * 1000 }), []);
    assert.equal(frame.displayWidth, src.info.width);
    assert.equal(frame.displayHeight, src.info.height);
    ts.push(tS);
    frame.close();
    assert.ok(validatePoseMessage({ type: 'estimate', id: 0, frame, tMs: 0 }).some(e => e.startsWith('frame')),
      'a closed frame can\'t be sent');
  }
  assert.ok(ts.length > 0);
  assert.ok(ts[0] >= 0.5 - 1e-9 && ts[ts.length - 1] <= 1.0 + 1e-9);
  for (let i = 1; i < ts.length; i++) assert.ok(Math.abs(ts[i] - ts[i - 1] - 1 / fps) < 1e-6);
  const f = await src.frameAt(0.51);
  assert.ok(f.timestamp / 1e6 <= 0.51 && f.timestamp / 1e6 > 0.51 - 1 / fps);
  f.close();
  const thumbs = await src.thumbnails([0, 1, 2], { height: 64 });
  assert.equal(thumbs.length, 3);
  for (const th of thumbs) { assert.equal(th.height, 64); th.close(); }
  src.close();
});
