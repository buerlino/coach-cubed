// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// The session (package d28, milestone B): app/src/session.mjs, the app's one gym session. A plain module
// that holds the capture across screens: R1 opens the camera, Start begins the session, R2 and H read it,
// End session stops and closes the capture. Tested on a stand-in capture (what the session does with it)
// and on the real createCapture over tests/app/fake-webcodecs.js's fake camera (what the camera sees).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createFakeCapture } = require('./fake-webcodecs');

const APP = path.resolve(__dirname, '..', '..', 'app');
const load = (...p) => import(pathToFileURL(path.join(APP, ...p)).href);
const SETTINGS = { camera: 'back', quality: '1080p30', bufferS: 60 };

/** A stand-in capture that keeps a log; `state` moves as capture.mjs's would. */
function stub({ openError = null, startError = null } = {}) {
  const log = [];
  const subs = new Set();
  let state = 'closed';
  const c = {
    log,
    get status() { return { state, fps: null, sinceS: 0, wakeLock: 'off', error: null }; },
    get stream() { return state === 'closed' ? null : { id: 'stream' }; },
    subscribe(fn) { subs.add(fn); fn(c.status); return () => subs.delete(fn); },
    async open() { log.push('open'); if (openError) { state = 'failed'; throw openError; } state = 'preview'; },
    async start() { log.push('start'); if (startError) { state = 'failed'; throw startError; } state = 'recording'; },
    async stop() { log.push('stop'); state = 'preview'; },
    close() { log.push('close'); state = 'closed'; },
  };
  return c;
}

test('nothing opens at boot: a new session has no capture, no camera and nothing running', async () => {
  const { createSession } = await load('src', 'session.mjs');
  const made = [];
  const session = createSession({ makeCapture: s => { made.push(s); return stub(); } });
  assert.equal(made.length, 0, 'no capture made');
  assert.equal(session.active, false);
  assert.equal(session.lift, null);
  assert.equal(session.startedAt, null);
  assert.equal(session.capture, null);
  assert.equal(session.elapsedS(), 0);
});

test('open() makes the capture from the settings and opens the camera, once, when R1 first asks', async () => {
  const { createSession } = await load('src', 'session.mjs');
  const made = [];
  const caps = [];
  const session = createSession({ makeCapture: s => { made.push(s); const c = stub(); caps.push(c); return c; } });
  const cap = await session.open(SETTINGS);
  assert.deepEqual(made, [SETTINGS]);
  assert.equal(cap, session.capture);
  assert.deepEqual(caps[0].log, ['open']);
  assert.equal(session.active, false, 'a preview is not a session');
  await session.open(SETTINGS);
  assert.equal(made.length, 1, 'the same capture while it is open');
});

test('start(lift) starts the capture and keeps the lift and the start time; active and lift say what runs', async () => {
  const { createSession } = await load('src', 'session.mjs');
  let t = 1000;
  const c = stub();
  const session = createSession({ makeCapture: () => c, now: () => t });
  await session.open(SETTINGS);
  t = 5000;
  await session.start('snatch');
  assert.deepEqual(c.log, ['open', 'start']);
  assert.equal(session.active, true);
  assert.equal(session.lift, 'snatch');
  assert.equal(session.startedAt, 5000);
});

test('a second start while a session runs is refused, and changes nothing', async () => {
  const { createSession } = await load('src', 'session.mjs');
  const c = stub();
  const session = createSession({ makeCapture: () => c, now: () => 7 });
  await session.open(SETTINGS);
  await session.start('lateral-raise');
  await assert.rejects(() => session.start('snatch'), /already/);
  assert.equal(session.lift, 'lateral-raise');
  assert.equal(c.log.filter(x => x === 'start').length, 1);
});

test('start() refuses a lift the registry lacks, and a session with no preview', async () => {
  const { createSession } = await load('src', 'session.mjs');
  const session = createSession({ makeCapture: () => stub() });
  await assert.rejects(() => session.start('lateral-raise'), /open/);
  await session.open(SETTINGS);
  await assert.rejects(() => session.start('curl'), /lift/);
  assert.equal(session.active, false);
});

test('a start the capture refuses (no encoder) leaves no session running', async () => {
  const { createSession } = await load('src', 'session.mjs');
  const err = Object.assign(new Error('no encoder'), { code: 'no-encoder' });
  const session = createSession({ makeCapture: () => stub({ startError: err }) });
  await session.open(SETTINGS);
  await assert.rejects(() => session.start('snatch'), e => e === err);
  assert.equal(session.active, false);
  assert.equal(session.lift, null);
  assert.equal(session.startedAt, null);
});

test('a camera the browser refuses does not throw from open(); the capture says why', async () => {
  const { createSession } = await load('src', 'session.mjs');
  const err = Object.assign(new Error('denied'), { code: 'camera-denied' });
  const c = stub({ openError: err });
  const session = createSession({ makeCapture: () => c });
  await session.open(SETTINGS);
  assert.equal(c.status.state, 'failed');
  await session.open(SETTINGS);
  assert.deepEqual(c.log, ['open', 'open'], 'asking again opens afresh (Try again)');
});

test('end() stops and closes the capture and clears the session; a new one can start', async () => {
  const { createSession } = await load('src', 'session.mjs');
  const caps = [];
  const session = createSession({ makeCapture: () => { const c = stub(); caps.push(c); return c; } });
  await session.open(SETTINGS);
  await session.start('snatch');
  await session.end();
  assert.deepEqual(caps[0].log, ['open', 'start', 'stop', 'close']);
  assert.equal(session.active, false);
  assert.equal(session.lift, null);
  assert.equal(session.startedAt, null);
  assert.equal(session.capture, null);
  await session.open(SETTINGS);
  await session.start('lateral-raise');
  assert.equal(caps.length, 2, 'a fresh capture, from the settings of then');
  assert.equal(session.lift, 'lateral-raise');
});

test('end() with only a preview closes the camera (R1\'s back), and with nothing open does nothing', async () => {
  const { createSession } = await load('src', 'session.mjs');
  const c = stub();
  const session = createSession({ makeCapture: () => c });
  await session.end();
  await session.open(SETTINGS);
  await session.end();
  assert.deepEqual(c.log, ['open', 'close']);
  await session.end();
  assert.deepEqual(c.log, ['open', 'close']);
});

test('R1 left while the camera is still opening: the camera that arrives late is closed', async () => {
  const { createSession } = await load('src', 'session.mjs');
  let release;
  const c = stub();
  c.open = () => new Promise(r => { release = () => { c.log.push('open'); r(); }; });
  const session = createSession({ makeCapture: () => c });
  const opening = session.open(SETTINGS);
  await session.end();
  release();
  await opening;
  assert.equal(c.log.at(-1), 'close', 'closed again after it opened');
  assert.equal(session.capture, null);
});

test('subscribe() hears the session now and at each change: start, end', async () => {
  const { createSession } = await load('src', 'session.mjs');
  const session = createSession({ makeCapture: () => stub(), now: () => 42 });
  const heard = [];
  const off = session.subscribe(s => heard.push(s));
  await session.open(SETTINGS);
  await session.start('snatch');
  await session.end();
  off();
  await session.open(SETTINGS);
  assert.deepEqual(heard.map(s => [s.active, s.lift]), [[false, null], [true, 'snatch'], [false, null]]);
  assert.equal(heard[1].startedAt, 42);
});

test('on the real capture and its fake camera: preview, a recording whose clock moves, and every track ended at the end', async () => {
  const { createSession } = await load('src', 'session.mjs');
  const { createCapture } = await load('src', 'media', 'capture.mjs');
  const fake = await createFakeCapture({ fps: 30 });
  const session = createSession({ makeCapture: s => createCapture(s, { api: fake.api, now: fake.now }) });
  const cap = await session.open(SETTINGS);
  assert.equal(cap.status.state, 'preview');
  assert.ok(cap.stream, 'the preview has a stream');
  await session.start('lateral-raise');
  assert.equal(cap.status.state, 'recording');
  await fake.deliver(60);   // 2 s
  assert.ok(session.elapsedS() > 1.5, `the clock moved: ${session.elapsedS()}`);
  assert.ok(Math.abs(cap.status.fps - 30) < 1, `the real rate: ${cap.status.fps}`);
  await session.end();
  assert.equal(cap.status.state, 'closed');
  for (const t of fake.cameras.flatMap(c => c.tracks)) assert.equal(t.readyState, 'ended');
  assert.equal(session.active, false);
});

test('main.mjs makes the session once and passes it to every screen as a prop, as the queue and the store', () => {
  const main = fs.readFileSync(path.join(APP, 'src', 'main.mjs'), 'utf8');
  assert.equal((main.match(/createSession\(/g) || []).length, 1, 'one session');
  assert.match(main, /session=\$\{session\}/);
  assert.match(main, /sessionRunning:\s*\(\)\s*=>\s*session\.active/, 'the flow lets H go back to a running session');
  assert.doesNotMatch(main, /\.open\(|getUserMedia/, 'no camera at boot');
  const app = fs.readFileSync(path.join(APP, 'src', 'ui', 'app.mjs'), 'utf8');
  assert.match(app, /session=\$\{session\}/);
  assert.match(app, /\bR1\b/);
});

test('d29b: the session\'s live state is live or delayed, by the replay mode it started with; none when nothing runs', async () => {
  const { createSession } = await load('src', 'session.mjs');
  const session = createSession({ makeCapture: () => stub() });
  assert.equal(session.liveState, null, 'nothing runs');
  await session.open(SETTINGS);
  await session.start('lateral-raise');
  assert.equal(session.liveState, 'live', 'no mode given: the replay');
  await session.end();
  assert.equal(session.liveState, null, 'ended');
  await session.open(SETTINGS);
  const mode = { replayMode: 'delayed' };
  await session.start('lateral-raise', mode);
  assert.equal(session.liveState, 'delayed');
  mode.replayMode = 'replay';   // a change after Start does not change the running session
  assert.equal(session.liveState, 'delayed');
  await session.end();
  await session.open(SETTINGS);
  await session.start('lateral-raise', { replayMode: 'replay' });
  assert.equal(session.liveState, 'live');
});

test('d29b: a start that is refused leaves no live state', async () => {
  const { createSession } = await load('src', 'session.mjs');
  const err = Object.assign(new Error('no encoder'), { name: 'CaptureError', code: 'no-encoder' });
  const session = createSession({ makeCapture: () => stub({ startError: err }) });
  await session.open(SETTINGS);
  await assert.rejects(() => session.start('lateral-raise', { replayMode: 'delayed' }));
  assert.equal(session.liveState, null);
});
