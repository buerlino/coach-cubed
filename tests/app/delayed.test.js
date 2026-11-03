'use strict';
// R3b, the delayed view, as a setting (package d29b, milestone B; D2): the delayed frames
// (app/src/media/delayed.mjs) on the capture's real ring, fake-webcodecs.js's decoder and a fake clock; R3b's logic
// (app/src/ui/delayed-model.mjs) on a stand-in session; R1's replay mode, S1's delay row, the ways back to a running
// session (M, Q1, H) and what the screens' and the tools' sources must hold. No DOM, no camera: the page test and the
// layout check walk R3b in a real browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createFakeWebCodecs, createFakeCapture } = require('./fake-webcodecs');

const APP = path.resolve(__dirname, '..', '..', 'app');
const load = (...p) => import(pathToFileURL(path.join(APP, 'src', ...p)).href);
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8');
const tick = () => new Promise(r => setImmediate(r));
const settle = async (n = 40) => { for (let i = 0; i < n; i++) await tick(); };

const FPS = 30;
const FRAME_US = Math.round(1e6 / FPS);   // 33333 µs
const KEY_EVERY = FPS;                    // a keyframe a second, as the capture asks
const CONFIG = Object.freeze({ codec: 'avc1.42002A', codedWidth: 96, codedHeight: 54, description: new Uint8Array([1, 66, 0, 42]) });

/**
 * The capture as R3b sees it: the real ring (media/ring.mjs) filled with synthetic chunks at 30 fps, a keyframe a
 * second, and a clock the test moves. `liveUs` is the newest frame's time on the recording's clock, as the capture's.
 */
async function recording({ seconds = 20, seg = { decoderConfig: CONFIG, rotation: 0, key: 'a' } } = {}) {
  const { createRing } = await load('media', 'ring.mjs');
  const ring = createRing({ bufferS: 60 });
  let n = 0, live = null, segment = seg;
  const push = count => {
    for (let i = 0; i < count; i++, n++) {
      const ts = n * FRAME_US;
      ring.push({ type: n % KEY_EVERY === 0 ? 'key' : 'delta', ts, dur: FRAME_US, data: new Uint8Array([n & 255]), seg: segment });
      live = ts;
    }
  };
  push(Math.round(seconds * FPS));
  return {
    ring,
    source: { follow: t => ring.follow(t), liveUs: () => live },
    get live() { return live; },
    /** `count` more frames, the clock with them */
    push,
    /** the clock moves on, no new frame (between two camera frames) */
    wait(us) { live += us; },
    newSegment(s) { segment = s; n = Math.ceil(n / KEY_EVERY) * KEY_EVERY; },
  };
}

async function delayed(rec, opts = {}) {
  const { createDelayedFrames } = await load('media', 'delayed.mjs');
  const wc = createFakeWebCodecs({ reorder: 0 });
  const d = createDelayedFrames({ source: rec.source, webcodecs: wc, delayS: 10, ...opts });
  await settle();
  return { d, wc };
}

/** The screen's loop: take what is due, close it as a drawn frame is closed. */
function takeAndClose(d) {
  const e = d.take();
  if (e) e.frame.close();
  return e;
}

// ---- the delayed frames ----

test('it follows the capture from the newest frame\'s time minus the delay: the first chunk is the keyframe at or before it', async () => {
  const rec = await recording({ seconds: 20 });
  const { d, wc } = await delayed(rec);
  const target = rec.live - 10e6;
  const dec = wc.log.decoders[0];
  assert.ok(dec, 'a decoder');
  assert.equal(dec.config.codedWidth, 96, 'configured with the ring\'s decoder config');
  assert.equal(dec.fed[0].type, 'key');
  assert.ok(dec.fed[0].timestamp <= target && target - dec.fed[0].timestamp < 1e6, `the keyframe at or before ${target}: ${dec.fed[0].timestamp}`);
  const e = d.take();
  assert.ok(e, 'a frame is due at once');
  assert.ok(e.timestamp >= target - FRAME_US && e.timestamp <= target, `the frame ${e.timestamp} for ${target}`);
  assert.ok(Math.abs(e.behindS - 10) <= FRAME_US / 1e6 + 1e-9, `behind ${e.behindS} s`);
  e.frame.close();
  assert.equal(d.delayS, 10);
  d.close();
});

test('each frame is handed out once its capture time plus the delay has come: the delay on screen stays within a frame interval', async () => {
  const rec = await recording({ seconds: 15 });
  const { d } = await delayed(rec);
  const shown = [];
  // three seconds of screen refreshes at about 60 Hz, the camera's frames coming at 30 fps
  for (let ms = 0; ms < 3000; ms += 16) {
    if (ms % 33 < 16) rec.push(1); else rec.wait(16000);
    await settle(6);
    const e = takeAndClose(d);
    if (e) {
      const behind = (rec.live - e.timestamp) / 1e6;
      assert.ok(behind >= 10 - 1e-9, `a frame handed out before its time: ${behind} s behind`);
      assert.ok(behind <= 10 + FRAME_US / 1e6 + 0.016 + 1e-9, `a frame handed out late: ${behind} s behind`);
      shown.push(e.timestamp);
    }
  }
  assert.ok(shown.length >= 80, `about 90 frames shown in 3 s at 30 fps: ${shown.length}`);
  for (let i = 1; i < shown.length; i++) assert.ok(shown[i] > shown[i - 1], 'in order, each once');
  assert.equal(d.stats.skips, 0, 'a decoder that keeps up never skips');
  d.close();
});

test('nothing is handed out before its time: a session younger than the delay waits, then shows its first frame', async () => {
  const rec = await recording({ seconds: 2 });
  const { d } = await delayed(rec);
  assert.equal(d.take(), null, 'two seconds recorded, ten behind: nothing yet');
  for (let i = 0; i < 8 * FPS; i++) { rec.push(1); await settle(4); assert.equal(takeAndClose(d), null, `at ${rec.live / 1e6} s`); }
  let first = null;
  for (let i = 0; i < FPS && !first; i++) { rec.push(1); await settle(4); first = takeAndClose(d); }
  assert.ok(first, 'the first frame once ten seconds are recorded');
  assert.equal(first.timestamp, 0, 'the recording\'s first frame');
  assert.ok(first.behindS >= 10 && first.behindS <= 10 + FRAME_US / 1e6 + 1e-9);
  d.close();
});

test('a decoder that falls behind skips to the next keyframe instead of drifting', async () => {
  const rec = await recording({ seconds: 15 });
  const { d, wc } = await delayed(rec);
  for (let i = 0; i < 10; i++) { rec.push(1); await settle(6); takeAndClose(d); }
  const dec = wc.log.decoders[0];
  const fedBefore = dec.fed.length;
  // the screen was away for 2.5 s (a hidden page; a decoder too slow for the frames): the newest decoded frame is far behind
  rec.push(Math.round(2.5 * FPS));
  const target = rec.live - 10e6;
  assert.equal(d.take(), null, 'nothing that late is handed out');
  assert.equal(d.stats.skips, 1);
  await settle();
  const fed = dec.fed.slice(fedBefore);
  assert.ok(fed.length > 0, 'decoding went on');
  assert.equal(fed[0].type, 'key', 'the next chunk decoded is a keyframe');
  assert.ok(fed[0].timestamp >= target, `at or after where the view should be (${target}): ${fed[0].timestamp}`);
  assert.ok(fed[0].timestamp - target < 1e6, 'the next one, not a later one');
  assert.ok(!fed.some(c => c.timestamp < target), 'no chunk from the gap was decoded');
  let e = null;
  for (let i = 0; i < FPS + 2 && !e; i++) { rec.push(1); await settle(6); e = takeAndClose(d); }
  assert.ok(e, 'frames again after the keyframe');
  assert.equal(e.timestamp, fed[0].timestamp, 'the keyframe is the first frame shown');
  assert.ok(e.behindS >= 10 - 1e-9 && e.behindS <= 10 + FRAME_US / 1e6 + 1e-9, `back at the delay: ${e.behindS} s`);
  d.close();
});

test('a change of delay restarts it at the new delay; the old decoder and its frames are closed', async () => {
  const rec = await recording({ seconds: 20 });
  const { d, wc } = await delayed(rec);
  for (let i = 0; i < 5; i++) { rec.push(1); await settle(6); takeAndClose(d); }
  d.setDelay(5);
  assert.equal(d.delayS, 5);
  await settle();
  assert.equal(wc.log.decoders.length, 2, 'a new decoder');
  assert.equal(wc.log.decoders[0].state, 'closed', 'the old one closed');
  const target = rec.live - 5e6;
  const first = wc.log.decoders[1].fed[0];
  assert.equal(first.type, 'key');
  assert.ok(first.timestamp <= target && target - first.timestamp < 1e6, 'from the keyframe at or before the newest frame minus 5 s');
  const e = d.take();
  assert.ok(e && Math.abs(e.behindS - 5) <= FRAME_US / 1e6 + 1e-9, `5 s behind: ${e && e.behindS}`);
  e.frame.close();
  d.setDelay(5);
  await settle();
  assert.equal(wc.log.decoders.length, 2, 'the same delay again changes nothing');
  d.close();
});

test('every frame the screen doesn\'t take is closed, as is every frame held at close(), and the decoder with them', async () => {
  const rec = await recording({ seconds: 15 });
  const { d, wc } = await delayed(rec);
  const handed = [];
  // a slow screen: one take every 100 ms, so three frames of four are never taken
  for (let i = 0; i < 30; i++) {
    rec.push(3);
    await settle(8);
    const e = d.take();
    if (e) handed.push(e.frame);
  }
  assert.ok(handed.length >= 20, `frames handed out: ${handed.length}`);
  const others = wc.log.frames.filter(f => !handed.includes(f));
  assert.ok(others.length > 40, 'the frames in between were decoded');
  for (const f of handed) f.close();   // the screen closes what it draws
  d.close();
  await settle();
  assert.deepEqual(wc.log.frames.filter(f => !f.closed).map(f => f.timestamp), [], 'no frame left open');
  for (const dec of wc.log.decoders) assert.equal(dec.state, 'closed', 'the decoder closed');
  assert.equal(d.take(), null, 'closed: nothing more');
  rec.push(30);
  await settle();
  assert.deepEqual(wc.log.frames.filter(f => !f.closed).map(f => f.timestamp), [], 'nothing decoded after close');
});

test('frames decoded while a close() is under way are closed too', async () => {
  const rec = await recording({ seconds: 15 });
  const { d, wc } = await delayed(rec);
  rec.push(1);
  d.close();   // the pump and the decoder are mid-flight
  await settle();
  assert.deepEqual(wc.log.frames.filter(f => !f.closed).map(f => f.timestamp), []);
  for (const dec of wc.log.decoders) assert.equal(dec.state, 'closed');
});

test('a new decoder config in the ring (the camera came back at another size) configures a new decoder', async () => {
  const rec = await recording({ seconds: 12 });
  const { d, wc } = await delayed(rec);
  rec.newSegment({ decoderConfig: { ...CONFIG, codedWidth: 108, codedHeight: 192 }, rotation: 90, key: 'b' });
  let turned = null;
  for (let i = 0; i < 12 * FPS && !turned; i++) {
    rec.push(1);
    await settle(4);
    const e = d.take();
    if (e) { if (e.frame.displayWidth === 108) turned = e; e.frame.close(); }
  }
  assert.ok(turned, 'the new size reaches the screen');
  assert.equal(turned.rotation, 90, 'with its segment\'s rotation, for the screen to turn it');
  assert.equal(wc.log.decoders.length, 2);
  assert.equal(wc.log.decoders[0].state, 'closed');
  d.close();
});

test('on the real capture and its fake camera: the capture\'s newest frame time, and frames about the delay behind it', async () => {
  const { createCapture } = await load('media', 'capture.mjs');
  const { createDelayedFrames } = await load('media', 'delayed.mjs');
  const fake = await createFakeCapture({ fps: 30 });
  const cap = createCapture({ camera: 'back', quality: '1080p30', bufferS: 30 }, { api: fake.api, now: fake.now });
  assert.equal(cap.liveUs(), null, 'nothing recorded');
  await cap.open();
  await cap.start();
  await fake.deliver(45);
  const last = fake.log.frames.at(-1);
  assert.equal(cap.liveUs(), last.timestamp, 'the newest frame\'s time on the recording\'s clock');
  const wc = createFakeWebCodecs({ reorder: 0 });
  const d = createDelayedFrames({ source: cap, webcodecs: wc, delayS: 1 });
  let e = null;
  for (let i = 0; i < 40 && !e; i++) { await fake.deliver(1); e = d.take(); }
  assert.ok(e, 'a frame within a second of frames');
  assert.ok(e.behindS >= 1 - 1e-9 && e.behindS <= 1 + 1 / 30 + 1e-6, `about 1 s behind: ${e.behindS}`);
  e.frame.close();
  d.close();
  await cap.stop();
  cap.close();
  await settle();
  assert.deepEqual(wc.log.frames.filter(f => !f.closed).map(f => f.timestamp), []);
});

// ---- R3b's logic ----

/** A session whose capture hands out a snapshot and records every call made to it. */
function fakeSession({ lift = 'snatch', empty = false } = {}) {
  const log = [];
  const blob = new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: 'video/mp4' });
  const capture = {
    status: { state: 'recording', sinceS: 252.4 },
    async snapshot(seconds) { log.push(['snapshot', seconds]); return empty ? null : { blob, duration: seconds, start: 4 }; },
    async stop() { log.push(['stop']); },
    close() { log.push(['close']); },
  };
  return { session: { capture, lift, active: true, liveState: 'delayed' }, log, blob };
}

test('R3b\'s view: the clock, "10 s behind", the delays 5, 10, 15 and 20 s inside RANGES.delayS, the chosen one pressed', async () => {
  const { delayedView, DELAY_CHOICES } = await load('ui', 'delayed-model.mjs');
  const { RANGES } = await load('store', 'settings.mjs');
  assert.deepEqual([...DELAY_CHOICES], [5, 10, 15, 20]);
  for (const v of DELAY_CHOICES) assert.ok(v >= RANGES.delayS.min && v <= RANGES.delayS.max, `${v} inside RANGES.delayS`);
  const v = delayedView({ status: { state: 'recording', sinceS: 252.4 }, delayS: 10 });
  assert.equal(v.clock, '4:12');
  assert.equal(v.behind, '10 s behind');
  assert.equal(v.delay, '10 s');
  assert.deepEqual(v.delays.map(c => [c.value, c.label, c.pressed]), [[5, '5 s', false], [10, '10 s', true], [15, '15 s', false], [20, '20 s', false]]);
  assert.equal(delayedView({ status: { state: 'recording', sinceS: 0 }, delayS: 15 }).behind, '15 s behind');
  const stopped = delayedView({ status: { state: 'interrupted', sinceS: 3 }, delayS: 5 });
  assert.equal(stopped.canResume, true);
  assert.equal(delayedView({ status: { state: 'recording', sinceS: 3 }, delayS: 5 }).canResume, false);
});

test('R3b: a delay choice saves delayS; one outside RANGES.delayS is refused', async () => {
  const { saveDelay } = await load('ui', 'delayed-model.mjs');
  const { createStore } = await load('store', 'index.mjs');
  const { createFakeStorage } = require('./fake-opfs');
  const store = createStore({ storage: createFakeStorage().storage, now: () => new Date('2026-11-03T09:00:00.000Z'), appVersion: '0.1.0' });
  const s = await saveDelay(store, 15);
  assert.equal(s.delayS, 15);
  assert.equal((await store.getSettings()).delayS, 15);
  await assert.rejects(() => saveDelay(store, 25));
  await assert.rejects(() => saveDelay(store, 3));
  assert.equal((await store.getSettings()).delayS, 15);
});

test('R3b: "Keep this lift" goes to mark with { file, lift, from: delayed }: the snapshot of the replay\'s length before the frame on screen, and everything since', async () => {
  const { keepLift } = await load('ui', 'delayed-model.mjs');
  const { createFlow } = await load('flow', 'flow.mjs');
  const flow = createFlow('setup');
  flow.go('delayed');
  const { session, log, blob } = fakeSession();
  const out = await keepLift({ session, flow, replayS: 20, delayS: 10, now: () => new Date(2026, 10, 3, 9, 5, 7) });
  assert.deepEqual(out, { ok: true });
  assert.deepEqual(log, [['snapshot', 30]], 'replayS + delayS, and nothing else asked of the capture');
  assert.equal(flow.state, 'mark');
  assert.equal(flow.params.from, 'delayed');
  assert.equal(flow.params.lift, 'snatch');
  assert.ok(flow.params.file instanceof File);
  assert.equal(flow.params.file.type, 'video/mp4');
  assert.equal(flow.params.file.name, 'delayed-09-05-07.mp4');
  assert.equal(flow.params.file.size, blob.size);
  assert.deepEqual(Object.keys(flow.params).sort(), ['file', 'from', 'lift']);
});

test('R3b: a snapshot that fails or holds nothing stays on R3b with a problem, never a throw', async () => {
  const { keepLift } = await load('ui', 'delayed-model.mjs');
  const { createFlow } = await load('flow', 'flow.mjs');
  const flow = createFlow('setup');
  flow.go('delayed');
  const empty = await keepLift({ session: fakeSession({ empty: true }).session, flow, replayS: 20, delayS: 5 });
  assert.equal(empty.ok, false);
  assert.ok(empty.problem && empty.problem.title, 'a problem to draw');
  const none = await keepLift({ session: { capture: null, lift: 'snatch' }, flow, replayS: 20, delayS: 5 });
  assert.equal(none.ok, false);
  assert.equal(flow.state, 'delayed');
});

// ---- R1, S1 ----

test('R1: the replay mode is Replay button or Delayed view, from the settings, the chosen one pressed', async () => {
  const { setupView } = await load('ui', 'record-model.mjs');
  const { DEFAULT_SETTINGS } = await load('store', 'settings.mjs');
  const preview = { state: 'preview' };
  const v = setupView({ settings: { ...DEFAULT_SETTINGS }, status: preview });
  assert.deepEqual(v.modes.map(m => [m.id, m.label, m.pressed]), [['replay', 'Replay button', true], ['delayed', 'Delayed view', false]]);
  assert.equal(v.mode, 'replay');
  const d = setupView({ settings: { ...DEFAULT_SETTINGS, replayMode: 'delayed' }, status: preview });
  assert.equal(d.mode, 'delayed');
  assert.deepEqual(d.modes.map(m => m.pressed), [false, true]);
  assert.equal(setupView({ settings: null, status: preview }).mode, 'replay', 'the default while the settings load');
});

test('R1: Start starts the session in the mode chosen and goes to live or delayed by it', async () => {
  const { startSession } = await load('ui', 'record-model.mjs');
  const { createFlow } = await load('flow', 'flow.mjs');
  const { createSession } = await load('session.mjs');
  for (const [mode, state] of [['replay', 'live'], ['delayed', 'delayed']]) {
    const cap = { status: { state: 'preview', sinceS: 0 }, subscribe: fn => { fn(cap.status); return () => {}; }, async open() {}, async start() { cap.status = { state: 'recording', sinceS: 0 }; }, async stop() {}, close() {} };
    const session = createSession({ makeCapture: () => cap });
    await session.open({});
    const flow = createFlow('setup');
    await startSession({ session, flow, lift: 'snatch', mode });
    assert.equal(flow.state, state, mode);
    assert.equal(session.liveState, state);
  }
});

test('R1: a mode choice saves replayMode; R1 draws the choice in the place d28 left free', async () => {
  const { createStore } = await load('store', 'index.mjs');
  const { createFakeStorage } = require('./fake-opfs');
  const store = createStore({ storage: createFakeStorage().storage, now: () => new Date('2026-11-03T09:00:00.000Z'), appVersion: '0.1.0' });
  const { saveMode } = await load('ui', 'record-model.mjs');
  assert.equal((await saveMode(store, 'delayed')).replayMode, 'delayed');
  assert.equal((await store.getSettings()).replayMode, 'delayed');
  await assert.rejects(() => saveMode(store, 'sideways'));
  const r1 = read('src', 'ui', 'screens', 'R1.mjs');
  assert.match(r1, /class="setup-mode"[^>]*role="group"|role="group"[^>]*class="setup-mode"/s, 'the choice is the kept place itself');
  assert.match(r1, /data-mode=/);
  assert.match(r1, /saveMode\(/);
  assert.match(r1, /startSession\(/);
  assert.doesNotMatch(r1, /flow\.go\('live'\)/, 'Start goes by the mode, not to live by name');
});

test('S1: the delay row is enabled, with no "comes later" note', async () => {
  const { recordingView, NOT_YET } = await load('ui', 'settings-model.mjs');
  const { DEFAULT_SETTINGS } = await load('store', 'settings.mjs');
  assert.ok(!NOT_YET.includes('delayS'));
  const d = recordingView({ ...DEFAULT_SETTINGS, replayMode: 'delayed' });
  assert.deepEqual(d.rows.map(r => [r.field, r.disabled]).slice(0, 1), [['delayS', false]]);
  assert.equal(d.laterNote, null);
  assert.deepEqual(d.rows[0].options.map(o => o.value), [5, 10, 15, 20]);
});

// ---- the ways back to a running session ----

test('M after Analyse and M\'s close go back to the session\'s state: delayed for a lift kept on R3b', async () => {
  const m = await load('ui', 'mark-model.mjs');
  const { createFlow } = await load('flow', 'flow.mjs');
  const session = { active: true, liveState: 'delayed' };
  const flow = createFlow('setup');
  flow.go('delayed');
  flow.go('mark', { file: new File([new Uint8Array(4)], 'delayed-09-05-07.mp4', { type: 'video/mp4' }), lift: 'snatch', from: 'delayed' });
  assert.equal(m.closeTarget('delayed', session), 'delayed');
  assert.equal(m.closeTarget('delayed'), 'delayed');
  assert.equal(m.closeTarget(null, session), 'home', 'not opened from a session');
  const queue = { analyse: async () => ({ id: 'job', liftId: 'L1' }) };
  const T = Array.from({ length: 90 }, (_, i) => i / 30);
  let marks = m.pressStep(m.newMarks(), 'start', 15, T);
  marks = m.pressStep(marks, 'end', 75, T);
  const out = await m.analyse({ flow, queue, lift: 'snatch', file: flow.params.file, marks, frameTimes: T, from: 'delayed', session });
  assert.deepEqual(out, { ok: true });
  assert.equal(flow.state, 'delayed');
  const { problemOf, waysOn } = await load('ui', 'problem-model.mjs');
  assert.deepEqual(waysOn(problemOf(Object.assign(new Error('x'), { code: 'unreadable' })), false, 'delayed'), ['session', 'home']);
});

test('H\'s and Q1\'s "Back to the session" go to the session\'s state', async () => {
  const { gymCard } = await load('ui', 'record-model.mjs');
  assert.equal(gymCard({ active: true, elapsedS: 12, liveState: 'delayed' }).to, 'delayed');
  assert.equal(gymCard({ active: true, elapsedS: 12, liveState: 'live' }).to, 'live');
  const q1 = read('src', 'ui', 'screens', 'Q1.mjs');
  assert.match(q1, /sessionReturn\(/);
  const h = read('src', 'ui', 'screens', 'H.mjs');
  assert.match(h, /liveState/);
  const mScreen = read('src', 'ui', 'screens', 'M.mjs');
  assert.doesNotMatch(mScreen, /go\('live'/, 'M names no way to live');
  assert.doesNotMatch(q1, /to: 'live'/, 'Q1 names no way to live');
});

test('no way back to a running session names live: go(\'live\' only where a replay session starts or R3 goes back to R2', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const hits = [];
  for (const f of walk(path.join(APP, 'src', 'ui'))) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (/go\('live'/.test(line)) hits.push(`${path.relative(APP, f)}:${i + 1}`); });
  }
  for (const h of hits) assert.ok(/^src\/ui\/(lookback-model\.mjs|screens\/R3\.mjs):/.test(h), `go('live' at ${h}`);
});

// ---- the screen and the tools ----

test('R3b: the delayed frames on a canvas, the live view in a <video>, the controls the walks look for; it closes the frames and keeps to the tokens', () => {
  const src = read('src', 'ui', 'screens', 'R3b.mjs');
  assert.match(src, /createDelayedFrames/);
  assert.match(src, /<canvas/);
  assert.match(src, /<video[^>]*muted[^>]*playsinline[^>]*autoplay/s);
  assert.match(src, /button[^>]*data-delayed="keep"|data-delayed="keep"/);
  assert.match(src, /data-delayed="end"/);
  assert.match(src, /data-delay=/);
  assert.match(src, /\.close\(\)/, 'leaving closes the delayed frames');
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b/, 'no colour literal');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /capture\.(stop|close)\(/, 'the recording goes on');
  assert.match(src, /goHome\(flow\)/, 'End session');
  assert.match(read('src', 'ui', 'app.mjs'), /R3b/);
  const tokens = read('src', 'styles', 'tokens.css'), base = read('src', 'styles', 'base.css');
  for (const t of ['--delayed-inset-w', '--delayed-inset-h', '--delayed-keep-h', '--size-delay']) assert.match(tokens, new RegExp(`${t}:`), t);
  assert.ok(base.indexOf('R3b, Delayed view') > 0, 'base.css has R3b\'s section');
});

test('the layout check walks R3b at every size, with the no-scroll rule at the four portrait sizes; the page test walks a delayed session', async () => {
  const { DELAYED_CONTROLS } = await load('..', 'tools', 'layout-check.mjs');
  assert.ok(DELAYED_CONTROLS.some(([, s]) => s.includes('data-delayed="keep"')));
  assert.ok(DELAYED_CONTROLS.some(([, s]) => s.includes('data-delayed="end"')));
  const layout = read('tools', 'layout-check.mjs');
  assert.match(layout, /check\('R3b', fitsWindow, null, M_SIZES, DELAYED_CONTROLS, 'R3b'\)/);
  const page = read('tools', 'page-test.mjs');
  for (const s of ['[data-mode="delayed"]', '[data-delay="5"]', '[data-screen="R3b"]', '[data-delayed="keep"]', 'page-test: delayed walk']) assert.ok(page.includes(s), s);
});
