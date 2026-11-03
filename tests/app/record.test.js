'use strict';
// R1 and R2, setting up and recording (package d28, milestone B): the screens' logic as plain functions
// (app/src/ui/record-model.mjs), the camera's errors as problems (problem-model.mjs), H's gym card, S1's
// recording rows, and what the screens' sources may and may not do. No Preact, no DOM, no camera: the page
// test and the layout check walk the screens in a real browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP = path.resolve(__dirname, '..', '..', 'app');
const load = (...p) => import(pathToFileURL(path.join(APP, 'src', ...p)).href);
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8');
const model = () => load('ui', 'record-model.mjs');
const status = (o = {}) => ({ state: 'recording', fps: 30, width: 1920, height: 1080, sinceS: 0, heldS: 0, bytes: 0, dropped: 0, wakeLock: 'held', error: null, ...o });

// ---- R1 ----

test('R1: the lifts are the registry\'s, in its order, with their labels and provisional; the default is S1\'s', async () => {
  const { setupView } = await model();
  const { liftEntries } = await load('contracts', 'lifts.mjs');
  const v = setupView({ settings: { defaultLift: 'snatch', bufferS: 60, quality: '1080p30' }, status: status({ state: 'preview' }), chosen: null });
  assert.deepEqual(v.lifts.map(l => l.id), liftEntries().map(e => e.id));
  assert.deepEqual(v.lifts.map(l => l.label), liftEntries().map(e => e.label));
  assert.deepEqual(v.lifts.map(l => l.provisional), liftEntries().map(e => e.provisional));
  assert.deepEqual(v.lifts.map(l => l.isDefault), liftEntries().map(e => e.id === 'snatch'));
  assert.equal(v.lift, 'snatch', 'nothing chosen yet: the default');
  assert.deepEqual(v.lifts.map(l => l.pressed), liftEntries().map(e => e.id === 'snatch'));
});

test('R1: the first lift while the settings load or name a lift the registry lacks (as L1)', async () => {
  const { setupView } = await model();
  const { liftEntries } = await load('contracts', 'lifts.mjs');
  const first = liftEntries()[0].id;
  for (const settings of [null, undefined, { defaultLift: 'curl' }]) {
    const v = setupView({ settings, status: status({ state: 'preview' }), chosen: null });
    assert.equal(v.lift, first);
    assert.equal(v.lifts.filter(l => l.isDefault).length, 1);
    assert.equal(v.lifts[0].isDefault, true);
  }
});

test('R1: a chosen lift is pressed; the default stays ringed', async () => {
  const { setupView } = await model();
  const v = setupView({ settings: { defaultLift: 'lateral-raise' }, status: status({ state: 'preview' }), chosen: 'snatch' });
  assert.equal(v.lift, 'snatch');
  assert.deepEqual(v.lifts.map(l => [l.id, l.pressed, l.isDefault]), [['lateral-raise', false, true], ['snatch', true, false]]);
  const bad = setupView({ settings: { defaultLift: 'lateral-raise' }, status: status({ state: 'preview' }), chosen: 'curl' });
  assert.equal(bad.lift, 'lateral-raise', 'a chosen lift the registry lacks is the default');
});

test('R1: each lift\'s tip is the registry\'s framing; a lift without one has the guide line alone', async () => {
  const { setupView, GUIDE_LINE } = await model();
  const { liftEntries } = await load('contracts', 'lifts.mjs');
  assert.equal(GUIDE_LINE, 'Whole body inside the frame');
  for (const e of liftEntries()) {
    const v = setupView({ settings: null, status: status({ state: 'preview' }), chosen: e.id });
    assert.equal(v.tip, e.framing);
    assert.equal(v.guide, GUIDE_LINE);
  }
});

test('R1: a lift registered without a framing tip shows the guide line alone', async () => {
  const { setupView, GUIDE_LINE } = await model();
  const { registerLift, liftEntries } = await load('contracts', 'lifts.mjs');
  let undo;
  try { undo = registerLift({ id: 'deadlift', label: 'Deadlift', abbr: 'dl', provisional: true }); } catch (e) { assert.fail(e.message); }
  try {
    const v = setupView({ settings: null, status: status({ state: 'preview' }), chosen: 'deadlift' });
    assert.equal(v.lifts.length, liftEntries().length);
    assert.equal(v.tip, null);
    assert.equal(v.guide, GUIDE_LINE);
  } finally { undo(); }
});

test('R1: the line under the preview comes from the settings', async () => {
  const { setupView } = await model();
  assert.equal(setupView({ settings: { quality: '1080p30', bufferS: 60 }, status: status({ state: 'preview' }) }).line, '1080p · 30 fps · last 60 s');
  assert.equal(setupView({ settings: { quality: '1080p30', bufferS: 120 }, status: status({ state: 'preview' }) }).line, '1080p · 30 fps · last 120 s');
  assert.equal(setupView({ settings: null, status: status({ state: 'preview' }) }).line, '1080p · 30 fps · last 60 s', 'the defaults while the settings load');
});

test('R1: Start is enabled only while the capture shows the preview', async () => {
  const { setupView } = await model();
  const can = state => setupView({ settings: null, status: status({ state }) }).canStart;
  assert.equal(can('preview'), true);
  for (const s of ['closed', 'failed', 'interrupted', 'recording']) assert.equal(can(s), false, s);
});

// ---- R2 ----

test('R2: the clock is m:ss, and h:mm:ss from an hour on', async () => {
  const { clockText } = await model();
  assert.equal(clockText(0), '0:00');
  assert.equal(clockText(5.9), '0:05');
  assert.equal(clockText(65), '1:05');
  assert.equal(clockText(252.4), '4:12');
  assert.equal(clockText(3599.9), '59:59');
  assert.equal(clockText(3600), '1:00:00');
  assert.equal(clockText(3725), '1:02:05');
  assert.equal(clockText(-1), '0:00');
  assert.equal(clockText(NaN), '0:00');
});

test('R2: the real rate, rounded, never the asked one; unknown until the frames give it', async () => {
  const { liveView } = await model();
  const v = f => liveView({ status: status({ fps: f }), jobs: [], lift: 'lateral-raise', settings: null }).fps;
  assert.equal(v(29.4), '29 fps');
  assert.equal(v(29.6), '30 fps');
  assert.equal(v(19.98), '20 fps');
  assert.equal(v(null), '– fps');
});

test('R2: the queue line from the jobs; nothing when the queue is empty', async () => {
  const { liveView, queueLine } = await model();
  const j = state => ({ id: state + Math.random(), state });
  assert.equal(queueLine([]), null);
  assert.equal(queueLine([j('done'), j('failed'), j('cancelled')]), null, 'ended jobs are not in the queue');
  assert.equal(queueLine([j('pose'), j('queued')]), '1 analysing · 1 waiting');
  assert.equal(queueLine([j('reading'), j('queued'), j('queued')]), '1 analysing · 2 waiting');
  assert.equal(queueLine([j('scoring')]), '1 analysing');
  assert.equal(queueLine([j('queued')]), '1 waiting');
  assert.equal(liveView({ status: status(), jobs: [j('pose'), j('queued')], lift: 'snatch', settings: null }).queue, '1 analysing · 1 waiting');
  assert.equal(liveView({ status: status(), jobs: [], lift: 'snatch', settings: null }).queue, null);
});

test('R2: the lift and the buffer, from the lift and the buffer that runs', async () => {
  const { liveView } = await model();
  assert.equal(liveView({ status: status(), jobs: [], lift: 'lateral-raise', settings: { bufferS: 60, replayS: 20 } }).liftLine, 'Lateral raise · last 60 s');
  assert.equal(liveView({ status: status(), jobs: [], lift: 'snatch', settings: { bufferS: 120, replayS: 20 } }).liftLine, 'Snatch · last 120 s');
});

test('R2: the wake lock: held and refused each say so, with the same box', async () => {
  const { liveView } = await model();
  const w = wakeLock => liveView({ status: status({ wakeLock }), jobs: [], lift: 'snatch', settings: null }).wake;
  assert.equal(w('held'), 'Screen stays on');
  assert.equal(w('refused'), 'Screen may turn off');
  assert.equal(w('off'), '', 'not asked yet: no claim either way');
});

test('R2: an interrupted camera shows "Camera stopped" and offers to resume; a recording does not', async () => {
  const { liveView } = await model();
  const i = liveView({ status: status({ state: 'interrupted' }), jobs: [], lift: 'snatch', settings: null });
  assert.equal(i.interrupted, 'Camera stopped');
  assert.equal(i.canResume, true);
  const r = liveView({ status: status(), jobs: [], lift: 'snatch', settings: null });
  assert.equal(r.interrupted, null);
  assert.equal(r.canResume, false);
});

test('R2: the Replay button carries the replay\'s length from the settings', async () => {
  const { liveView } = await model();
  assert.equal(liveView({ status: status(), jobs: [], lift: 'snatch', settings: { replayS: 20, bufferS: 60 } }).replay, '20 s');
  assert.equal(liveView({ status: status(), jobs: [], lift: 'snatch', settings: { replayS: 45, bufferS: 60 } }).replay, '45 s');
  assert.equal(liveView({ status: status(), jobs: [], lift: 'snatch', settings: null }).replay, '20 s', 'the default while the settings load');
});

test('R2: the clock reads the capture\'s sinceS', async () => {
  const { liveView } = await model();
  assert.equal(liveView({ status: status({ sinceS: 252.4 }), jobs: [], lift: 'snatch', settings: null }).clock, '4:12');
});

// ---- the errors on R1 and R2 ----

test('the capture\'s errors are problems in d55\'s short style, each with what the user can do', async () => {
  const { problemOf, PROBLEM_KINDS } = await load('ui', 'problem-model.mjs');
  const { CaptureError, CAPTURE_ERROR_CODES } = await load('media', 'capture.mjs');
  const kinds = ['camera-denied', 'no-camera', 'camera-busy', 'no-encoder', 'insecure'];
  for (const k of kinds) {
    assert.ok(PROBLEM_KINDS.includes(k), `${k} is a kind`);
    assert.ok(CAPTURE_ERROR_CODES.includes(k), `${k} is a capture code`);
    const p = problemOf(new CaptureError(k, `The browser says: ${k}.`));
    assert.equal(p.kind, k);
    for (const f of ['title', 'what', 'can']) {
      assert.match(p[f], /\S/, `${k}.${f}`);
      assert.ok(p[f].length <= 90, `${k}.${f} is short (${p[f].length}): ${p[f]}`);
    }
    assert.equal(p.engine, `The browser says: ${k}.`, 'the capture\'s own words');
    assert.equal(p.actions.another, false, 'another video is no way out of a camera problem');
  }
  assert.equal(problemOf(new CaptureError('camera-denied', 'x')).actions.retry, true);
  assert.equal(problemOf(new CaptureError('camera-busy', 'x')).actions.retry, true);
  assert.equal(problemOf(new CaptureError('no-camera', 'x')).actions.retry, true);
  assert.equal(problemOf(new CaptureError('no-encoder', 'x')).actions.retry, false);
  assert.equal(problemOf(new CaptureError('insecure', 'x')).actions.retry, false);
  assert.match(problemOf(new CaptureError('camera-denied', 'x')).can, /allow|permission|settings/i, 'says where the permission is');
});

test('a failed capture is a problem; a working one is none', async () => {
  const { captureProblem } = await model();
  const { CaptureError } = await load('media', 'capture.mjs');
  assert.equal(captureProblem(status({ state: 'preview' })), null);
  assert.equal(captureProblem(status({ state: 'interrupted' })), null);
  const p = captureProblem(status({ state: 'failed', error: new CaptureError('camera-denied', 'No.') }));
  assert.equal(p.kind, 'camera-denied');
  assert.equal(captureProblem(status({ state: 'failed', error: new CaptureError('encoder-failed', 'x') })).kind, 'encoder-failed');
});

// ---- H, S1 ----

test('H: the gym card opens R1; while a session runs it reads "Back to the session" with the clock and goes to live', async () => {
  const { gymCard } = await model();
  assert.deepEqual(gymCard({ active: false, elapsedS: 0 }), { title: 'Gym session', clock: null, to: 'setup' });
  assert.deepEqual(gymCard({ active: true, elapsedS: 252.4 }), { title: 'Back to the session', clock: '4:12', to: 'live' });
  assert.deepEqual(gymCard(null), { title: 'Gym session', clock: null, to: 'setup' });
  const h = read('src/ui/screens/H.mjs');
  assert.doesNotMatch(h, /Coming later/);
  assert.doesNotMatch(h, /card--disabled/);
  assert.match(h, /gymCard\(/);
  assert.match(h, /flow\.go\(card\.to\)/);
});

test('S1: the replay mode, the replay\'s length, the buffer, the camera and (d29b) the delay are enabled; the quality is not', async () => {
  const { recordingView } = await load('ui', 'settings-model.mjs');
  const { DEFAULT_SETTINGS } = await load('store', 'settings.mjs');
  const v = recordingView({ ...DEFAULT_SETTINGS });
  assert.equal(v.modesDisabled, false);
  assert.deepEqual(v.rows.map(r => [r.field, r.disabled]), [['replayS', false], ['bufferS', false], ['camera', false], ['quality', true], ['defaultLift', false]]);
  const d = recordingView({ ...DEFAULT_SETTINGS, replayMode: 'delayed' });
  assert.deepEqual(d.rows.map(r => [r.field, r.disabled]).slice(0, 1), [['delayS', false]], 'the delay, which R3b uses (d29b)');
  assert.equal(v.rows.find(r => r.field === 'quality').options.length, 1, 'the quality is information: its one value');
});

test('S1: a choice in the recording rows is saved within RANGES, and one outside is refused', async () => {
  const { createStore } = await load('store', 'index.mjs');
  const { RANGES } = await load('store', 'settings.mjs');
  const { lengthOptions } = await load('ui', 'settings-model.mjs');
  const { createFakeStorage } = require('./fake-opfs');
  const fake = createFakeStorage();
  const store = createStore({ storage: fake.storage, now: () => new Date('2026-11-03T09:00:00.000Z'), appVersion: '0.1.0' });
  for (const field of ['replayS', 'bufferS']) {
    for (const o of lengthOptions(field, 20)) assert.ok(o.value >= RANGES[field].min && o.value <= RANGES[field].max, `${field} offers ${o.value}`);
  }
  let s = await store.saveSettings({ replayMode: 'delayed', replayS: 30, bufferS: 120, camera: 'front' });
  assert.deepEqual([s.replayMode, s.replayS, s.bufferS, s.camera], ['delayed', 30, 120, 'front']);
  await assert.rejects(() => store.saveSettings({ bufferS: RANGES.bufferS.max + 1 }));
  await assert.rejects(() => store.saveSettings({ replayS: RANGES.replayS.min - 1 }));
  s = await store.getSettings();
  assert.equal(s.bufferS, 120);
  const s1 = read('src/ui/screens/S1.mjs');
  assert.match(s1, /\['defaultLift', 'camera', 'quality', 'replayMode'\]/, 'the text fields are not turned into numbers');
  assert.match(s1, /onClick=\$\{\(\) => pick\('replayMode', m\.id\)\}/, "the mode switch's buttons save the mode");
});

// ---- the screens' sources ----

test('d28: the screens use the capture and nothing else: no camera, encoder, frame reader or wake lock in app/src/ui', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(APP, 'src', 'ui'))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /getUserMedia|VideoEncoder|MediaStreamTrackProcessor|navigator\.wakeLock/, path.relative(APP, f));
  }
});

test('d28: R1\'s lifts come from the registry, and no colour is typed in the UI', () => {
  assert.doesNotMatch(read('src/ui/screens/R1.mjs'), /'(lateral-raise|snatch)'/);
  assert.doesNotMatch(read('src/ui/record-model.mjs'), /'(lateral-raise|snatch)'/);
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(APP, 'src', 'ui'))) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /#[0-9a-fA-F]{3,8}\b/, path.relative(APP, f));
});

test('d28: R1 and R2 have the controls the walks look for, and the screens never import each other', () => {
  const r1 = read('src/ui/screens/R1.mjs'), r2 = read('src/ui/screens/R2.mjs');
  assert.match(r1, /data-lift=/);
  assert.match(r1, /data-record="start"/);
  assert.match(r1, /aria-label="Back"/);
  assert.match(r1, /<video[^>]*muted[^>]*playsinline[^>]*autoplay|<video[^>]*autoplay[^>]*muted[^>]*playsinline|<video[^>]*playsinline[^>]*muted[^>]*autoplay/s);
  assert.match(r2, /data-record="replay"/);
  assert.match(r2, /data-record="end"/);
  assert.match(r2, /from: 'live'/, 'the queue line opens Q1 from the session');
  assert.match(r2, /flow\.go\('replay'\)/);
  for (const s of [r1, r2]) assert.doesNotMatch(s, /from '\.\/[A-Za-z0-9]+\.mjs'/);
  assert.match(r1, /session\.end\(\)/, 'back closes the camera');
  assert.match(r2, /session\.end\(\)/, 'End session ends it');
});

test('d28: new sizes are tokens, and base.css has R1\'s and R2\'s sections', () => {
  const tokens = read('src/styles/tokens.css'), base = read('src/styles/base.css');
  for (const t of ['--replay-h', '--record-disc', '--record-disc-dot', '--setup-mode-h', '--live-chip-h']) assert.match(tokens, new RegExp(`${t}:`), t);
  const at = base.indexOf('R1, Set up the camera');
  assert.ok(at > 0, 'base.css has R1\'s section');
  assert.ok(base.indexOf('R2, Recording') > at, 'and R2\'s');
});

// ---- the tools' walks ----

test('d28 layout-check: R2 at the four portrait sizes has no vertical scroll and every control inside the window', async () => {
  const { M_NO_SCROLL, LIVE_CONTROLS, SETUP_CONTROLS, fitsWindow } = await load('..', 'tools', 'layout-check.mjs');
  const page = (scrollHeight, boxes) => {
    globalThis.document = {
      documentElement: { scrollHeight },
      querySelector: sel => { const b = boxes[sel]; return b ? { getBoundingClientRect: () => b } : null; },
    };
  };
  const inside = controls => Object.fromEntries(controls.map(([, sel], i) => [sel, { left: 12, top: 20 + 50 * i, right: 340, bottom: 60 + 50 * i }]));
  const fits = (controls, name, vw, vh) => fitsWindow(vw, 980, vh, M_NO_SCROLL, controls, name);
  try {
    for (const { width, height } of M_NO_SCROLL) {
      page(height, inside(LIVE_CONTROLS));
      assert.deepEqual(fits(LIVE_CONTROLS, 'R2', width, height), [], `${width}×${height}`);
    }
    page(700, inside(LIVE_CONTROLS));
    assert.deepEqual(fits(LIVE_CONTROLS, 'R2', 360, 640), ['R2 scrolls: the page is 700 px high in a 640 px window']);
    assert.deepEqual(fits(LIVE_CONTROLS, 'R2', 800, 360), [], 'phone landscape may scroll');
    const replay = LIVE_CONTROLS.find(([n]) => n === 'Replay')[1];
    page(640, { ...inside(LIVE_CONTROLS), [replay]: { left: 16, top: 560, right: 344, bottom: 660 } });
    assert.deepEqual(fits(LIVE_CONTROLS, 'R2', 360, 640), ['R2: Replay is not inside the window (16,560 to 344,660 in 360×640)']);
    page(640, { ...inside(LIVE_CONTROLS), [replay]: undefined });
    assert.deepEqual(fits(LIVE_CONTROLS, 'R2', 360, 640), ['R2: Replay is not on the screen']);
    page(640, inside(SETUP_CONTROLS));
    assert.deepEqual(fits(SETUP_CONTROLS, 'R1', 412, 760), []);
  } finally { delete globalThis.document; }
  const src = fs.readFileSync(path.join(APP, 'tools', 'layout-check.mjs'), 'utf8');
  assert.match(src, /check\('R1', fitsWindow, null, M_SIZES, SETUP_CONTROLS, 'R1'\)/);
  assert.match(src, /check\('R2', fitsWindow, null, M_SIZES, LIVE_CONTROLS, 'R2'\)/);
});

test('d28: the page test and the layout check launch their browser on the fake camera, from browser.mjs\'s one list, and the page test walks the session', async () => {
  const { FAKE_CAMERA } = await load('..', 'tools', 'browser.mjs');
  assert.deepEqual([...FAKE_CAMERA], ['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream']);
  for (const f of ['page-test.mjs', 'layout-check.mjs']) {
    const src = fs.readFileSync(path.join(APP, 'tools', f), 'utf8');
    assert.match(src, /\.\.\.FAKE_CAMERA/, f);
    assert.doesNotMatch(src, /use-fake-device-for-media-stream/, `${f} takes the flags from browser.mjs`);
  }
  const page = fs.readFileSync(path.join(APP, 'tools', 'page-test.mjs'), 'utf8');
  for (const s of ['[data-card="session"]', '[data-record="start"]', '[data-record="end"]', 'readyState !== \'ended\'', 'page-test: session walk']) assert.ok(page.includes(s), s);
});

test('d29 fix: End session tapped twice goes home once, without the illegal home -> home; R1 and R2 use it', async () => {
  const { goHome } = await model();
  const { createFlow } = await load('flow', 'flow.mjs');
  const flow = createFlow('setup');
  flow.go('live');
  goHome(flow);
  assert.equal(flow.state, 'home');
  assert.doesNotThrow(() => goHome(flow));   // the second tap's session.end() resolved: still home
  assert.equal(flow.state, 'home');
  for (const f of ['R1', 'R2']) assert.match(read('src/ui/screens/' + f + '.mjs'), /goHome\(flow\)/, f);
});
