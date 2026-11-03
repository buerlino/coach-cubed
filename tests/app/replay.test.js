'use strict';
// R3, the replay, and marking a kept lift (package d29, milestone B): app/src/ui/replay-model.mjs, the plain
// module behind screens/R3.mjs, on fakes (a session whose capture hands out a snapshot, a player that logs
// its calls), and M's `from: 'live'` (mark-model.mjs, problem-model.mjs's waysOn). No DOM, no camera.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP = path.resolve(__dirname, '..', '..', 'app');
const load = (...p) => import(pathToFileURL(path.join(APP, 'src', ...p)).href);

/** A session with a capture that hands out a snapshot and records every call made to it. */
function fakeSession({ duration = 20.4, lift = 'lateral-raise', empty = false, error = null } = {}) {
  const log = [];
  const blob = new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: 'video/mp4' });
  const capture = {
    status: { state: 'recording' },
    async snapshot(seconds) {
      log.push(['snapshot', seconds]);
      if (error) throw error;
      return empty ? null : { blob, duration, start: 31.5 };
    },
    async stop() { log.push(['stop']); },
    close() { log.push(['close']); },
    async resume() { log.push(['resume']); },
  };
  const calls = [];
  const session = { capture, lift, active: true, calls, end: async () => { calls.push('end'); } };
  return { session, log, blob, capture };
}

/** A player that logs, and reports its state like createPlayer's onChange. */
function fakePlayer(onChange = () => {}) {
  const log = [];
  const state = { t: 100, index: 0, playing: false, live: false, speed: 1 };
  const p = {
    log,
    get state() { return { ...state }; },
    async play() { log.push(['play']); state.playing = true; onChange({ ...state }); },
    async pause() { log.push(['pause']); state.playing = false; onChange({ ...state }); },
    toggle() { return state.playing ? p.pause() : p.play(); },
    async seek(t) { log.push(['seek', t]); state.playing = false; state.t = t; onChange({ ...state }); },
    setSpeed(v) { log.push(['speed', v]); state.speed = v; onChange({ ...state }); },
    close() { log.push(['close']); },
    set(patch) { Object.assign(state, patch); onChange({ ...state }); },
  };
  return p;
}

async function opened(opts = {}) {
  const { createReplay } = await load('ui', 'replay-model.mjs');
  const { createFlow } = await load('flow', 'flow.mjs');
  const flow = createFlow('live');
  flow.go('replay');
  const fake = fakeSession(opts);
  const replay = createReplay({ session: fake.session, flow, replayS: 20, ...opts.extra });
  await replay.load();
  let player;
  player = fakePlayer(ps => replay.report({ ...ps }));
  replay.attach(player, { t0: 100, t1: 120.4 });
  return { replay, flow, player, ...fake };
}

test('on entry it takes the session\'s snapshot(replayS), the settings\' length, and plays it from its start at once', async () => {
  const { replay, player, log } = await opened();
  assert.deepEqual(log, [['snapshot', 20]]);
  assert.equal(replay.view().phase, 'ready');
  assert.deepEqual(player.log, [['play']], 'play, nothing before it');
  assert.equal(replay.view().playing, true);
  const { createReplay } = await load('ui', 'replay-model.mjs');
  const { createFlow } = await load('flow', 'flow.mjs');
  const f = createFlow('live'); f.go('replay');
  const other = fakeSession();
  const r = createReplay({ session: other.session, flow: f, replayS: 12 });
  await r.load();
  assert.deepEqual(other.log, [['snapshot', 12]], 'the length is the setting\'s');
});

test('the label is the snapshot\'s end minus the playhead, rounded: "12 s ago"; the position is m:ss / 0:20', async () => {
  const { replay, player } = await opened({ duration: 20.4 });
  assert.equal(replay.view().ago, '20 s ago');
  assert.equal(replay.view().position, '0:00');
  assert.equal(replay.view().total, '0:20');
  player.set({ t: 108 });   // 8 s in; 20.4 - 8 = 12.4
  assert.equal(replay.view().ago, '12 s ago');
  assert.equal(replay.view().position, '0:08');
  player.set({ t: 108.6 });   // 20.4 - 8.6 = 11.8
  assert.equal(replay.view().ago, '12 s ago');
  player.set({ t: 115.2 });   // 5.2 s to go
  assert.equal(replay.view().ago, '5 s ago');
  assert.equal(replay.view().position, '0:15');
  player.set({ t: 99 });
  assert.equal(replay.view().position, '0:00', 'never before the start');
  player.set({ t: 125 });
  assert.equal(replay.view().ago, '0 s ago', 'never after the end');
  const { replay: r2, player: p2 } = await opened({ duration: 20.4 });
  p2.set({ t: 110.2 });
  assert.ok(Math.abs(r2.view().fraction - 10.2 / 20.4) < 1e-9);
});

test('a ring that holds less than the replay says its own length over the bar', async () => {
  const { replay } = await opened({ duration: 8.2 });
  assert.equal(replay.view().total, '0:08');
});

test('½× switches between 1× and ½× (the player\'s speeds); play/pause are the player\'s', async () => {
  const { replay, player } = await opened();
  const { SPEEDS } = await load('ui', 'player-model.mjs');
  assert.equal(replay.view().speedLabel, '1×');
  replay.toggleSpeed();
  assert.equal(replay.view().speedLabel, '½×');
  assert.ok(SPEEDS.includes(0.5));
  replay.toggleSpeed();
  assert.equal(replay.view().speedLabel, '1×');
  assert.deepEqual(player.log.filter(e => e[0] === 'speed'), [['speed', 0.5], ['speed', 1]]);
  replay.togglePlay();
  assert.deepEqual(player.log.at(-1), ['pause']);
  assert.equal(replay.view().playing, false);
  replay.togglePlay();
  assert.deepEqual(player.log.at(-1), ['play']);
});

test('the countdown is 25 s, runs only while the replay plays, and is held by a pause or a drag', async () => {
  const { COUNTDOWN_S } = await load('ui', 'replay-model.mjs');
  assert.equal(COUNTDOWN_S, 25);
  const { replay, player, flow } = await opened();
  assert.equal(replay.view().countdown, '0:25');
  replay.tick(2);
  assert.equal(replay.view().countdown, '0:23');
  await replay.togglePlay();   // pause
  replay.tick(10);
  assert.equal(replay.view().countdown, '0:23', 'a pause holds it');
  await replay.togglePlay();
  replay.tick(1);
  assert.equal(replay.view().countdown, '0:22');
  replay.scrubStart(105);
  replay.tick(10);
  assert.equal(replay.view().countdown, '0:22', 'a drag holds it');
  assert.deepEqual(player.log.filter(e => e[0] === 'seek'), [['seek', 105]]);
  replay.scrubMove(107);
  replay.scrubEnd();
  assert.deepEqual(player.log.filter(e => e[0] === 'seek'), [['seek', 105], ['seek', 107]]);
  assert.deepEqual(player.log.at(-1), ['play'], 'it plays on after a drag it interrupted');
  replay.tick(1);
  assert.equal(replay.view().countdown, '0:21');
  assert.equal(flow.state, 'replay');
});

test('a drag that began on a paused replay leaves it paused', async () => {
  const { replay, player } = await opened();
  await replay.togglePlay();
  const n = player.log.length;
  replay.scrubStart(104); replay.scrubEnd();
  assert.deepEqual(player.log.slice(n), [['seek', 104]]);
});

test('when the countdown ends it goes to live, closes the player and drops the snapshot', async () => {
  const { replay, player, flow } = await opened();
  replay.tick(24.9);
  assert.equal(flow.state, 'replay');
  replay.tick(0.2);
  assert.equal(flow.state, 'live');
  assert.deepEqual(flow.params, {});
  assert.deepEqual(player.log.at(-1), ['close']);
  assert.equal(replay.view().phase, 'closed');
  assert.equal(replay.snapshot, null);
  replay.tick(100);   // nothing more happens
  assert.equal(flow.state, 'live');
});

test('"Not this one" goes to live at once, with the player closed and the snapshot dropped', async () => {
  const { replay, player, flow } = await opened();
  replay.back();
  assert.equal(flow.state, 'live');
  assert.equal(player.log.filter(e => e[0] === 'close').length, 1);
  assert.equal(replay.snapshot, null);
  replay.back(); replay.close();
  assert.equal(player.log.filter(e => e[0] === 'close').length, 1, 'closing twice closes once');
});

test('"Keep and mark" goes to mark with { file, lift, from: live }: the snapshot as a File named replay-hh-mm-ss.mp4', async () => {
  const { replay, player, flow, blob } = await opened({ lift: 'snatch', extra: { now: () => new Date(2026, 10, 3, 9, 5, 7) } });
  replay.keep();
  assert.equal(flow.state, 'mark');
  assert.deepEqual(Object.keys(flow.params).sort(), ['file', 'from', 'lift']);
  assert.equal(flow.params.lift, 'snatch');
  assert.equal(flow.params.from, 'live');
  const f = flow.params.file;
  assert.ok(f instanceof File);
  assert.equal(f.name, 'replay-09-05-07.mp4');
  assert.equal(f.type, 'video/mp4');
  assert.equal(f.size, blob.size);
  assert.deepEqual(player.log.at(-1), ['close']);
  assert.equal(replay.snapshot, null);
});

test('the recording never stops: R3 leaves the session and the capture alone (no stop, no close, no end)', async () => {
  for (const way of ['keep', 'back', 'countdown']) {
    const { replay, log, session } = await opened();
    if (way === 'keep') replay.keep(); else if (way === 'back') replay.back(); else replay.tick(30);
    assert.deepEqual(log.map(e => e[0]), ['snapshot'], way);
    assert.deepEqual(session.calls, [], way);
  }
});

test('a snapshot that fails is d23\'s problem, with the way back to live; the countdown does not run', async () => {
  const { CaptureError } = await load('media', 'capture-error.mjs');
  const { createReplay } = await load('ui', 'replay-model.mjs');
  const { createFlow } = await load('flow', 'flow.mjs');
  for (const options of [{ error: new CaptureError('encoder-failed', 'The encoder failed.') }, { empty: true }]) {
    const flow = createFlow('live'); flow.go('replay');
    const fake = fakeSession(options);
    const replay = createReplay({ session: fake.session, flow, replayS: 20 });
    await replay.load();
    const v = replay.view();
    assert.equal(v.phase, 'problem');
    assert.ok(v.problem.title && v.problem.what && v.problem.can);
    replay.tick(60);
    assert.equal(flow.state, 'replay', 'no countdown on a problem');
    replay.keep();
    assert.equal(flow.state, 'replay', 'nothing to keep');
    replay.back();
    assert.equal(flow.state, 'live');
    assert.ok(!fake.log.some(e => e[0] === 'stop' || e[0] === 'close'));
  }
  // an encoder that failed is the capture's kind
  const flow = createFlow('live'); flow.go('replay');
  const r = createReplay({ session: fakeSession({ error: new CaptureError('encoder-failed', 'x') }).session, flow, replayS: 20 });
  await r.load();
  assert.equal(r.view().problem.kind, 'encoder-failed');
});

test('no capture at all (the session ended) is a problem too, never a throw', async () => {
  const { createReplay } = await load('ui', 'replay-model.mjs');
  const { createFlow } = await load('flow', 'flow.mjs');
  const flow = createFlow('live'); flow.go('replay');
  const replay = createReplay({ session: { capture: null, lift: null }, flow, replayS: 20 });
  await replay.load();
  assert.equal(replay.view().phase, 'problem');
});

test('closing while the snapshot is still being taken drops it', async () => {
  const { createReplay } = await load('ui', 'replay-model.mjs');
  const { createFlow } = await load('flow', 'flow.mjs');
  const flow = createFlow('live'); flow.go('replay');
  const fake = fakeSession();
  const replay = createReplay({ session: fake.session, flow, replayS: 20 });
  const loading = replay.load();
  replay.close();
  await loading;
  assert.equal(replay.snapshot, null);
  assert.equal(replay.view().phase, 'closed');
});

test('listeners hear each change, and an unsubscribed one hears nothing more', async () => {
  const { replay } = await opened();
  let n = 0;
  const off = replay.subscribe(() => { n++; });
  replay.tick(1);
  assert.ok(n >= 1);
  off();
  const before = n;
  replay.tick(1);
  assert.equal(n, before);
});

// ---- M in a session ----

async function markFromLive() {
  const { createFlow } = await load('flow', 'flow.mjs');
  const flow = createFlow('live');
  flow.go('replay');
  flow.go('mark', { file: new File([new Uint8Array(4)], 'replay-09-05-07.mp4', { type: 'video/mp4' }), lift: 'snatch', from: 'live' });
  return flow;
}

test('M in a session (from: live): Analyse queues the lift as it does now, then goes to live, not queued', async () => {
  const m = await load('ui', 'mark-model.mjs');
  const flow = await markFromLive();
  const calls = [];
  const queue = { analyse: async (lift, f, range) => { calls.push([lift, f.name, range]); return { id: 'job', liftId: 'L1' }; } };
  const T = Array.from({ length: 90 }, (_, i) => i / 30);
  let marks = m.pressStep(m.newMarks(), 'start', 15, T);
  marks = m.pressStep(marks, 'end', 75, T);
  const out = await m.analyse({ flow, queue, lift: 'snatch', file: flow.params.file, marks, frameTimes: T, from: flow.params.from });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'snatch');
  assert.equal(flow.state, 'live');
});

test('M outside a session: Analyse still goes to queued with the lift\'s id', async () => {
  const m = await load('ui', 'mark-model.mjs');
  const { createFlow } = await load('flow', 'flow.mjs');
  const flow = createFlow('lift');
  flow.go('mark', { file: new File([new Uint8Array(4)], 'a.mp4'), lift: 'snatch' });
  const queue = { analyse: async () => ({ liftId: 'L9' }) };
  const T = Array.from({ length: 90 }, (_, i) => i / 30);
  let marks = m.pressStep(m.newMarks(), 'start', 15, T);
  marks = m.pressStep(marks, 'end', 75, T);
  await m.analyse({ flow, queue, lift: 'snatch', file: flow.params.file, marks, frameTimes: T, from: flow.params.from });
  assert.equal(flow.state, 'queued');
  assert.deepEqual(flow.params, { liftId: 'L9' });
});

test('M\'s close goes to live in a session and home outside one', async () => {
  const m = await load('ui', 'mark-model.mjs');
  assert.equal(m.closeTarget('live'), 'live');
  assert.equal(m.closeTarget(undefined), 'home');
  assert.equal(m.closeTarget(null), 'home');
  assert.equal(m.closeTarget('anything else'), 'home');
  const flow = await markFromLive();
  assert.ok(flow.can(m.closeTarget(flow.params.from)));
});

test('d23\'s problem screen in a session offers "Back to the session" in place of "Pick another video"', async () => {
  const { problemOf, waysOn } = await load('ui', 'problem-model.mjs');
  const p = problemOf(Object.assign(new Error('x'), { code: 'unreadable' }));
  assert.deepEqual(waysOn(p, false), ['another', 'home'], 'outside a session: unchanged');
  assert.deepEqual(waysOn(p, false, 'live'), ['session', 'home']);
  assert.deepEqual(waysOn(problemOf(Object.assign(new Error('x'), { code: 'storage-full' })), true, 'live'), ['retry', 'marks', 'home'], 'nothing to replace');
});

// ---- the screen ----

test('R3 plays through createPlayer, has no placeholder, and keeps to the tokens', () => {
  const src = fs.readFileSync(path.join(APP, 'src', 'ui', 'screens', 'R3.mjs'), 'utf8');
  assert.ok(!/Placeholder/.test(src), 'no placeholder');
  assert.ok(/createPlayer/.test(src), 'plays through createPlayer');
  assert.ok(/data-replay="keep"|data-replay=\$\{['"]keep/.test(src) || /data-replay="keep"/.test(src), 'the keep button hook');
  assert.ok(/data-replay="live"/.test(src), 'the back-to-live hook');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(src), 'no colour literal');
});

test('M and R3 never stop or close the capture (no call to stop/close/end on it)', () => {
  for (const f of ['screens/R3.mjs', 'replay-model.mjs']) {
    const src = fs.readFileSync(path.join(APP, 'src', 'ui', f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/capture\.(stop|close)\(|session\.end\(/.test(src), f);
  }
});
