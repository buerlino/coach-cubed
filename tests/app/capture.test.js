// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Capture and the rolling buffer (package c27, milestone B; D2: a 60 s buffer, a 20 s
// replay): app/src/media/capture.mjs on fakes. Node has no camera, no VideoEncoder and
// no wake lock, so tests/app/fake-webcodecs.js's createFakeCapture() stands in for the
// browser: a camera whose frames carry timestamps at a chosen real rate, an encoder that
// outputs the packets of our own clips (tests/app/clips/, with their decoder config) so
// what the ring writes is a real MP4, and a wake lock. The real browser is
// app/tools/check-capture.mjs's (headless Brave's fake camera); the phone is c30's.
//
// The clock: the fake camera's frames are at k / fps seconds (µs, rounded), from 0 for
// each camera; the expected keyframes, ring lengths and snapshot starts below are worked
// out here from those times and the rules the package states, not from capture.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createFakeWebCodecs, createFakeCapture } = require('./fake-webcodecs');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const load = rel => import(pathToFileURL(path.join(APP, rel)).href);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);
const SETTINGS = { camera: 'back', quality: '1080p30', bufferS: 60 };
// the camera's timestamps are µs, rounded: a slack of 1 ms on "1 s or more"
const KEY_US = 1e6 - 1000;

async function setup(fakeOptions = {}, settings = {}) {
  const { createCapture } = await load('src/media/capture.mjs');
  const fake = await createFakeCapture(fakeOptions);
  const cap = createCapture({ ...SETTINGS, ...settings }, { api: fake.api, now: fake.now });
  const states = [];
  cap.subscribe(s => states.push(s));
  return { cap, fake, states, last: () => states.at(-1) };
}
async function recording(fakeOptions, settings) {
  const s = await setup(fakeOptions, settings);
  await s.cap.open();
  await s.cap.start();
  return s;
}

/** An MP4 read with mediabunny: its packets (decode order), decoder config, rotation. */
async function readMp4(blob) {
  const mb = await load('vendor/mediabunny/mediabunny.mjs');
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    const packets = [];
    for await (const p of new mb.EncodedPacketSink(track).packets()) packets.push({ type: p.type, timestamp: p.timestamp, duration: p.duration, bytes: p.data.byteLength });
    const c = await track.getDecoderConfig();
    return { packets, rotation: await track.getRotation(), config: { codec: c.codec, w: c.codedWidth, h: c.codedHeight, description: Buffer.from(c.description) } };
  } finally { input.dispose(); }
}
async function collect(iterable) { const out = []; for await (const x of iterable) out.push(x); return out; }

// ---- the frame rate and the keyframes --------------------------------------------------

test('the rate comes from the frames\' timestamps, not the track\'s settings: a camera that says 30 and delivers 20 reports 20', async () => {
  const { cap, fake, last } = await recording({ fps: 20, askedFps: 30 });
  assert.equal(fake.camera.track.getSettings().frameRate, 30);
  await fake.deliver(60);
  assert.equal(last().fps, 20);
  // the median interval over the last 2 s: after a drop to 15 fps, 3 s later it is 15
  fake.camera.setFps(15);
  await fake.deliver(45);
  assert.equal(last().fps, 15);
  cap.close();
});

test('a keyframe is forced by time, at the first frame 1 s or more after the last one, also when the rate drops from 30 to 15', async () => {
  const { cap, fake } = await recording();
  await fake.deliver(90);
  fake.camera.setFps(15);
  await fake.deliver(45);
  await fake.settle();
  const enc = fake.log.encoded;
  assert.equal(enc.length, 135);
  let lastKey = null;
  const expected = enc.map(e => {
    const key = lastKey === null || e.timestamp - lastKey >= KEY_US;
    if (key) lastKey = e.timestamp;
    return key;
  });
  assert.deepEqual(enc.map(e => e.key), expected);
  // 30 fps: every 30th frame (0, 1, 2 s); from 3 s at 15 fps: every 15th (3, 4, 5 s), not every 30th
  assert.deepEqual(enc.filter(e => e.key).map(e => e.timestamp), [0, 1e6, 2e6, 3e6, 4e6, 5e6]);
  assert.deepEqual(enc.map((e, i) => (e.key ? i : -1)).filter(i => i >= 0), [0, 30, 60, 90, 105, 120]);
  // the output chunks are key where the encoder was asked for one
  assert.deepEqual(fake.log.outputs.map(o => o.chunk.type === 'key'), expected);
  cap.close();
});

test('frames are dropped and counted while the encoder\'s queue is backed up (above 4), never queued without bound', async () => {
  const { cap, fake, last } = await recording({ holdOutputs: true });
  await fake.deliver(10);
  assert.equal(fake.encoder.encodeQueueSize, 5, 'the queue stops at 5');
  assert.equal(fake.log.encoded.length, 5);
  assert.equal(last().dropped, 5);
  assert.ok(fake.log.frames.every(f => f.closed), 'every frame, dropped or encoded, is closed');
  fake.encoder.release();
  await fake.deliver(3);
  assert.equal(fake.log.encoded.length, 8);
  assert.equal(last().dropped, 5);
  // the first frame after the gap is still key-checked by time: frame 0 was key, nothing else 1 s later yet
  assert.deepEqual(fake.log.encoded.map(e => e.key), [true, false, false, false, false, false, false, false]);
  cap.close();
});

// ---- the ring ----------------------------------------------------------------------------

test('the ring lets go of each chunk it drops: no dropped chunk is still referenced (not only at a compaction)', async () => {
  const { createRing } = await load('src/media/ring.mjs');
  // a full collection on demand: the flag set at run time, gc() taken from a fresh context
  require('node:v8').setFlagsFromString('--expose-gc');
  const gc = require('node:vm').runInNewContext('gc');
  const seg = { decoderConfig: { codec: 'avc1.42002A' }, rotation: 0, key: 'a' };
  const ring = createRing({ bufferS: 1 });
  const refs = [];
  // 600 chunks at 30 fps, a keyframe every 30: 20 s pushed, about 1 s held, 500+ dropped,
  // fewer than the 1024 that make the ring compact its array
  (() => {
    for (let i = 0; i < 600; i++) {
      const data = new Uint8Array(1000);
      refs.push(new WeakRef(data));
      ring.push({ type: i % 30 ? 'delta' : 'key', ts: Math.round(i * 1e6 / 30), dur: 0, data, seg });
    }
  })();
  const held = ring.size;
  assert.ok(held <= 90 && 600 - held > 500, `${held} chunks held`);
  assert.equal(ring.bytes, held * 1000);
  // a WeakRef read in this job stays alive until the job ends: collect after a turn
  for (let k = 0; k < 3; k++) { await new Promise(r => setImmediate(r)); gc(); }
  const live = refs.map(r => r.deref() !== undefined);
  const droppedLive = live.slice(0, 600 - held).filter(Boolean).length;
  assert.equal(droppedLive, 0, `${droppedLive} dropped chunks are still referenced by the ring`);
  assert.ok(live.slice(600 - held).every(Boolean), 'the held chunks are all there');
  ring.close();
});

test('the ring holds at least bufferS behind its newest frame, drops whole groups from the front, and says its seconds and bytes', async () => {
  const { cap, fake, last } = await recording({}, { bufferS: 3 });
  for (let k = 0; k < 180; k++) {
    await fake.deliver(1);
    const s = last(), newest = k / 30;
    assert.ok(s.heldS >= Math.min(3, newest) - 1e-6, `frame ${k}: ${s.heldS} s held, under ${Math.min(3, newest)}`);
    assert.ok(s.heldS < 4, `frame ${k}: ${s.heldS} s held, a whole group more than 3 s`);
  }
  await fake.settle();
  const snap = await cap.snapshot(1000);
  const mp4 = await readMp4(snap.blob);
  // whole groups: the oldest packet is a keyframe, and every frame encoded from it on is there
  assert.equal(mp4.packets[0].type, 'key');
  const startUs = Math.round(snap.start * 1e6);
  const kept = fake.log.encoded.filter(e => e.timestamp >= startUs);
  assert.ok(fake.log.encoded.find(e => e.timestamp === startUs).key, 'the ring starts on a keyframe');
  assert.equal(mp4.packets.length, kept.length);
  // newest 179/30 = 5.967 s; 3 s behind it is 2.967 s; the key at or before that is 2 s
  near(snap.start, 2);
  near(last().heldS, 179 / 30 - 2, 1e-5);
  const bytes = fake.log.outputs.filter(o => o.chunk.timestamp >= startUs).reduce((a, o) => a + o.chunk.byteLength, 0);
  assert.equal(last().bytes, bytes);
  assert.equal(mp4.packets.reduce((a, p) => a + p.bytes, 0), bytes);
  cap.close();
});

test('snapshot(seconds) is an MP4 from the keyframe at or before the newest frame minus seconds, decoder config first, times from 0', async () => {
  const { cap, fake } = await recording();
  await fake.deliver(150);   // 0 .. 149/30 s
  await fake.settle();
  const snap = await cap.snapshot(2);   // 149/30 - 2 = 2.967 s: the key at 2 s
  near(snap.start, 2);
  near(snap.duration, 3, 1e-3);   // 90 frames of 1/30 s
  assert.equal(snap.blob.type, 'video/mp4');
  const mp4 = await readMp4(snap.blob);
  assert.equal(mp4.packets.length, 90);
  assert.equal(mp4.packets[0].type, 'key');
  near(mp4.packets[0].timestamp, 0);
  assert.ok(mp4.packets.every((p, i) => !i || p.timestamp > mp4.packets[i - 1].timestamp));
  const clip = fake.clips['96x54'].config;
  assert.deepEqual([mp4.config.codec, mp4.config.w, mp4.config.h], [clip.codec, 96, 54]);
  assert.deepEqual(mp4.config.description, Buffer.from(clip.description));
  assert.equal(mp4.rotation, 0);
  // shorter than asked: the whole ring
  const all = await cap.snapshot(20);
  near(all.start, 0);
  assert.equal((await readMp4(all.blob)).packets.length, 150);

  // s9's frame source opens it and gives every frame in order
  const { openFrameSource } = await load('src/media/frame-source.mjs');
  const src = await openFrameSource(snap.blob, { webcodecs: createFakeWebCodecs({ reorder: 0 }), stallMs: 400 });
  assert.equal(src.frameTimes.length, 90);
  const frames = await collect(src.frames(0, snap.duration));
  assert.equal(frames.length, 90);
  assert.ok(frames.every((f, i) => !i || f.timestamp > frames[i - 1].timestamp));
  frames.forEach(f => f.close());
  src.close();
  // s32's cut takes a range of it, which the frame source opens too: from the key at 1 s to 2.5 s
  const { cutVideo } = await load('src/media/cut.mjs');
  const cut = await cutVideo(snap.blob, { t0: 1.2, t1: 2.5 });
  near(cut.start, 1);
  const src2 = await openFrameSource(cut.blob, { webcodecs: createFakeWebCodecs({ reorder: 0 }), stallMs: 400 });
  assert.equal(src2.frameTimes.length, 46);   // frames 30 .. 75 of the snapshot
  near(src2.frameTimes[0], 0);
  src2.close();
  cap.close();
});

test('a snapshot keeps the frames\' rotation in the MP4 track, as s32 keeps a file\'s', async () => {
  const { cap, fake } = await recording({ rotation: 90 });
  await fake.deliver(40);
  await fake.settle();
  const snap = await cap.snapshot(5);
  assert.equal((await readMp4(snap.blob)).rotation, 90);
  assert.equal(cap.status.rotation, 90);
  cap.close();
});

test('a snapshot never spans a change of decoder config: after the camera came back at another size it starts at the first keyframe after it', async () => {
  const { cap, fake, last } = await recording({ sizes: ['96x54', '108x192'] });
  await fake.deliver(90);
  fake.camera.end();
  await fake.settle();
  assert.equal(last().state, 'interrupted');
  await cap.resume();
  await fake.deliver(60);
  await fake.settle();
  assert.deepEqual([last().width, last().height], [108, 192]);
  const snap = await cap.snapshot(1000);
  const mp4 = await readMp4(snap.blob);
  assert.deepEqual([mp4.config.w, mp4.config.h], [108, 192]);
  assert.equal(mp4.packets.length, 60);
  assert.ok(snap.start > 89 / 30, `the snapshot starts at ${snap.start}, before the change`);
  assert.ok(last().heldS > snap.duration, 'the ring still holds the frames before the change');
  cap.close();
});

// ---- follow ------------------------------------------------------------------------------

test('follow(t) yields the ring\'s chunks from the keyframe at or before t, then each new chunk as it is encoded', async () => {
  const { cap, fake } = await recording();
  await fake.deliver(90);
  await fake.settle();
  const it = cap.follow(1.5)[Symbol.asyncIterator]();
  const got = [];
  for (let k = 0; k < 60; k++) got.push((await it.next()).value);
  assert.equal(got[0].type, 'key');
  assert.equal(got[0].timestamp, 1e6);
  assert.equal(got[0].decoderConfig.codec, fake.clips['96x54'].config.codec);
  assert.ok(got.slice(1).every(c => !c.decoderConfig));
  assert.ok(got.every(c => c.data instanceof Uint8Array && c.data.byteLength > 0));
  assert.deepEqual(got.map(c => c.timestamp), fake.log.encoded.slice(30, 90).map(e => e.timestamp));
  const pending = it.next();
  let settled = false;
  pending.then(() => { settled = true; });
  await fake.settle();
  assert.equal(settled, false, 'it waits for the next chunk');
  await fake.deliver(1);
  const live = await pending;
  assert.equal(live.value.timestamp, Math.round(90 * 1e6 / 30));
  assert.deepEqual(await it.return(), { value: undefined, done: true });
  cap.close();
});

test('follow ends at stop(), and when its caller stops reading', async () => {
  const { cap, fake } = await recording();
  await fake.deliver(30);
  await fake.settle();
  let n = 0;
  for await (const c of cap.follow(0)) { assert.ok(c); if (++n === 5) break; }
  assert.equal(n, 5);
  const ended = collect(cap.follow(0));
  await fake.settle();
  await cap.stop();
  assert.equal((await ended).length, 30);
});

test('a follower the ring has overtaken goes on from the oldest keyframe left', async () => {
  const { cap, fake } = await recording({}, { bufferS: 2 });
  await fake.deliver(10);
  await fake.settle();
  const it = cap.follow(0)[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.timestamp, 0);
  await fake.deliver(150);   // 5 s, the ring now starts at 2 s (newest 159/30 = 5.3 s, 2 s behind is 3.3 s: key 3 s)
  await fake.settle();
  const next = (await it.next()).value;
  assert.equal(next.type, 'key');
  assert.equal(next.timestamp, 3e6);
  assert.equal(next.decoderConfig.codec, fake.clips['96x54'].config.codec, 'after a gap the config comes again');
  near((await cap.snapshot(1000)).start, 3);
  await it.return();
  cap.close();
});

// ---- errors ------------------------------------------------------------------------------

const ERRORS = [
  ['insecure', { mediaDevices: false }, 'open', null],
  ['no-camera', { getUserMediaError: { name: 'NotFoundError', message: 'Requested device not found' } }, 'open', 'Requested device not found'],
  ['camera-denied', { getUserMediaError: { name: 'NotAllowedError', message: 'Permission denied' } }, 'open', 'Permission denied'],
  ['camera-busy', { getUserMediaError: { name: 'NotReadableError', message: 'Could not start video source' } }, 'open', 'Could not start video source'],
  ['no-encoder', { encoder: false }, 'start', null],
  ['no-encoder', { supported: false }, 'start', null],
];
for (const [code, fakeOptions, step, kept] of ERRORS) {
  test(`${code} (${JSON.stringify(fakeOptions)}): a CaptureError at ${step}(), the state failed`, async () => {
    const { CaptureError, CAPTURE_ERROR_CODES } = await load('src/media/capture.mjs');
    const { cap, last } = await setup(fakeOptions);
    if (step === 'start') await cap.open();
    const e = await cap[step]().then(() => null, x => x);
    assert.ok(e instanceof CaptureError, `${e} is a CaptureError`);
    assert.equal(e.code, code);
    assert.ok(CAPTURE_ERROR_CODES.includes(code));
    if (kept) {
      assert.ok(e.message.includes(kept), `"${e.message}" keeps the browser's message`);
      assert.equal(e.cause.message, kept);
    }
    assert.equal(last().state, 'failed');
    assert.equal(last().error, e);
    cap.close();
    assert.equal(last().state, 'closed');
  });
}

test('open() after a failure starts afresh: the camera the failed start() held is stopped, not leaked', async () => {
  const { cap, fake, last } = await setup({ supported: false });
  await cap.open();
  await assert.rejects(cap.start(), { code: 'no-encoder' });
  const first = fake.camera;
  await cap.open();
  assert.equal(last().state, 'preview');
  assert.notEqual(fake.camera, first);
  assert.ok(first.tracks.every(t => t.readyState === 'ended'), 'the first camera\'s tracks are stopped');
  cap.close();
});

test('an encoder that fails while recording: encoder-failed with its message, the state failed, the ring kept', async () => {
  const { CaptureError } = await load('src/media/capture.mjs');
  const { cap, fake, last } = await recording();
  await fake.deliver(40);
  await fake.settle();
  fake.encoder.fail('Encoder hardware gone');
  await fake.settle();
  assert.equal(last().state, 'failed');
  assert.ok(last().error instanceof CaptureError);
  assert.equal(last().error.code, 'encoder-failed');
  assert.match(last().error.message, /Encoder hardware gone/);
  assert.equal((await readMp4((await cap.snapshot(5)).blob)).packets.length, 40);
  cap.close();
});

/** The wake lock let go on a move to failed: off, the sentinel released, the visibility handler gone. */
function assertWakeLetGo(fake, last, asked) {
  assert.equal(last().wakeLock, 'off');
  assert.equal(fake.wakeLock.released, true, 'the sentinel was released');
  assert.equal(fake.wakeLock.releasedBy, 'page');
  fake.setVisible(false); fake.setVisible(true);
  assert.equal(fake.log.wakeLocks.length, asked, 'a failed capture asks for no new lock when the page is visible again');
}

test('an encoder that fails while recording lets the wake lock go and asks for no new one, the ring kept', async () => {
  const { cap, fake, last } = await recording();
  await fake.deliver(40);
  await fake.settle();
  assert.equal(last().wakeLock, 'held');
  fake.encoder.fail('Encoder hardware gone');
  await fake.settle();
  assert.equal(last().state, 'failed');
  assertWakeLetGo(fake, last, 1);
  await fake.settle();
  assert.equal(last().wakeLock, 'off');
  assert.equal((await readMp4((await cap.snapshot(5)).blob)).packets.length, 40, 'the ring kept for snapshot');
  cap.close();
});

test('resume() whose camera fails lets the wake lock go and asks for no new one, the ring kept', async () => {
  const { cap, fake, last } = await recording();
  await fake.deliver(30);
  fake.camera.end();
  await fake.settle();
  assert.equal(last().state, 'interrupted');
  fake.api.getUserMedia = async () => { const e = new Error('Could not start video source'); e.name = 'NotReadableError'; throw e; };
  await assert.rejects(cap.resume(), { code: 'camera-busy' });
  assert.equal(last().state, 'failed');
  assertWakeLetGo(fake, last, 1);
  assert.equal((await readMp4((await cap.snapshot(5)).blob)).packets.length, 30, 'the ring kept for snapshot');
  cap.close();
});

test('a wake lock granted after the capture failed is released at once, never held', async () => {
  const { cap, fake, last } = await setup();
  let grant;
  const request = fake.api.requestWakeLock;
  fake.api.requestWakeLock = () => new Promise(res => { grant = () => res(request()); });
  await cap.open();
  const started = cap.start();
  await fake.settle();
  fake.encoder.fail('Encoder hardware gone');
  await fake.settle();
  assert.equal(last().state, 'failed');
  grant();
  await started;
  assert.equal(last().wakeLock, 'off');
  assert.equal(fake.wakeLock.released, true, 'the late sentinel was released');
  cap.close();
});

// ---- the camera, the encoder's settings ------------------------------------------------

test('open() asks for the setting\'s camera and quality; nothing is recorded until start()', async () => {
  for (const [camera, facingMode] of [['back', 'environment'], ['front', 'user']]) {
    const { cap, fake, last } = await setup({}, { camera });
    await cap.open();
    const c = fake.log.getUserMedia[0];
    assert.equal(c.audio, false);
    assert.deepEqual(c.video.facingMode, { ideal: facingMode });
    assert.deepEqual([c.video.width, c.video.height, c.video.frameRate], [{ ideal: 1920 }, { ideal: 1080 }, { ideal: 30 }]);
    assert.equal(last().state, 'preview');
    assert.ok(cap.stream && cap.stream.getVideoTracks()[0] === fake.camera.track);
    await fake.deliver(10);
    assert.equal(fake.log.encoded.length, 0);
    assert.equal(fake.log.encoders.length, 0);
    cap.close();
  }
});

test('the encoder: H.264 at the frames\' size, the quality\'s rate, realtime, avc format, no preference for hardware', async () => {
  const { cap, fake } = await recording();
  await fake.deliver(2);
  const c = fake.log.configs[0];
  assert.match(c.codec, /^avc1\./);
  assert.deepEqual([c.width, c.height, c.framerate], [96, 54, 30]);
  assert.equal(c.hardwareAcceleration, 'no-preference');
  assert.equal(c.latencyMode, 'realtime');
  assert.deepEqual(c.avc, { format: 'avc' });
  assert.ok(Number.isInteger(c.bitrate) && c.bitrate > 0);
  cap.close();
});

test('sinceS is the time since start()', async () => {
  const { cap, fake, last } = await recording();
  await fake.deliver(61);
  near(last().sinceS, 2 + 0.5, 1e-6);   // the fake's clock: the camera opened 0.5 s before its first frame
  cap.close();
});

// ---- the wake lock ---------------------------------------------------------------------

test('the wake lock: asked at start(), asked again when the page is visible again, released at stop()', async () => {
  const { cap, fake, last } = await setup();
  await cap.open();
  assert.equal(fake.log.wakeLocks.length, 0);
  assert.equal(last().wakeLock, 'off');
  await cap.start();
  assert.equal(fake.log.wakeLocks.length, 1);
  assert.equal(last().wakeLock, 'held');
  fake.setVisible(false);
  fake.wakeLock._drop();   // the browser drops it while hidden
  await fake.settle();
  assert.equal(last().wakeLock, 'off');
  fake.setVisible(true);
  await fake.settle();
  assert.equal(fake.log.wakeLocks.length, 2);
  assert.equal(last().wakeLock, 'held');
  await cap.stop();
  assert.equal(fake.wakeLock.releasedBy, 'page');
  assert.equal(last().wakeLock, 'off');
  fake.setVisible(false); fake.setVisible(true);
  await fake.settle();
  assert.equal(fake.log.wakeLocks.length, 2, 'not asked again once stopped');
  cap.close();
});

for (const wakeLock of ['refuse', 'none']) {
  test(`a wake lock the browser ${wakeLock === 'none' ? 'lacks' : 'refuses'} is the state 'refused', never an error`, async () => {
    const { cap, fake, last } = await recording({ wakeLock });
    assert.equal(last().wakeLock, 'refused');
    assert.equal(last().state, 'recording');
    assert.equal(last().error, null);
    await fake.deliver(5);
    assert.equal(fake.log.encoded.length, 5);
    cap.close();
  });
}

// ---- interruptions, stop and close ------------------------------------------------------

for (const how of ['end', 'mute']) {
  test(`the camera track's ${how === 'end' ? 'ended' : 'mute'}: interrupted, the encoder flushed, the ring kept; resume() records on from a new keyframe`, async () => {
    const { cap, fake, last } = await recording();
    await fake.deliver(45);
    fake.camera[how]();
    await fake.settle();
    assert.equal(last().state, 'interrupted');
    assert.deepEqual(fake.log.flushes, [0], 'the encoder was flushed');
    assert.equal(fake.log.encoders[0].state, 'closed');
    assert.equal(fake.log.outputs.length, 45, 'every frame given to the encoder reached the ring');
    const held = last().heldS;
    near(held, 44 / 30, 1e-5);
    assert.equal((await readMp4((await cap.snapshot(60)).blob)).packets.length, 45);
    await cap.resume();
    assert.equal(fake.log.getUserMedia.length, 2);
    assert.equal(last().state, 'recording');
    await fake.deliver(15);
    await fake.settle();
    const after = fake.log.encoded.filter(e => e.encoder === 1);
    assert.equal(after.length, 15);
    assert.equal(after[0].keyFrame, true, 'a keyframe asked for at once');
    const mp4 = await readMp4((await cap.snapshot(60)).blob);
    assert.equal(mp4.packets.length, 60, 'the same ring, the same config: both runs in one snapshot');
    const ts = mp4.packets.map(p => p.timestamp);
    assert.ok(ts.every((t, i) => !i || t > ts[i - 1]), 'the times go on after the gap');
    assert.ok(ts[45] - ts[44] >= 0.5, 'the gap is kept on the recording\'s clock');
    cap.close();
  });
}

test('stop() stops the encoder and drops the ring and the wake lock, the camera stays for the preview; close() stops every track', async () => {
  const { cap, fake, last } = await recording();
  await fake.deliver(30);
  await fake.settle();
  await cap.stop();
  assert.equal(last().state, 'preview');
  assert.equal(fake.encoder.state, 'closed');
  assert.deepEqual([last().heldS, last().bytes], [0, 0]);
  assert.equal(await cap.snapshot(5), null, 'nothing recorded, no snapshot');
  assert.equal(fake.wakeLock.released, true);
  assert.equal(fake.camera.track.readyState, 'live');
  await fake.deliver(5);
  assert.equal(fake.log.encoded.length, 30, 'nothing encoded after stop()');
  // started again: a new recording, a new ring
  await cap.start();
  await fake.deliver(10);
  await fake.settle();
  assert.equal((await readMp4((await cap.snapshot(60)).blob)).packets.length, 10);
  cap.close();
  assert.equal(last().state, 'closed');
  assert.ok(fake.cameras.every(c => c.tracks.every(t => t.readyState === 'ended')), 'every track stopped, the clones too');
  assert.equal(cap.stream, null);
});

test('state changes reach every subscriber, now and at each change, until it unsubscribes', async () => {
  const { createCapture } = await load('src/media/capture.mjs');
  const fake = await createFakeCapture();
  const cap = createCapture(SETTINGS, { api: fake.api, now: fake.now });
  const seen = [];
  const off = cap.subscribe(s => seen.push(s.state));
  assert.deepEqual(seen, ['closed']);
  await cap.open();
  await cap.start();
  off();
  cap.close();
  assert.deepEqual([...new Set(seen)], ['closed', 'preview', 'recording']);
  const fields = ['state', 'fps', 'width', 'height', 'rotation', 'sinceS', 'heldS', 'bytes', 'dropped', 'wakeLock', 'error'];
  for (const f of fields) assert.ok(f in cap.status, `the state has ${f}`);
});

// ---- where the browser is touched -------------------------------------------------------

test('only app/src/media/ touches the camera, the encoder and the wake lock', () => {
  const hits = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.m?js$/.test(e.name) && /getUserMedia|VideoEncoder|MediaStreamTrackProcessor|navigator\.wakeLock/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(APP, p));
    }
  };
  walk(path.join(APP, 'src'));
  assert.ok(hits.length > 0, 'the capture is somewhere');
  assert.deepEqual(hits.filter(h => !h.startsWith(path.join('src', 'media') + path.sep)), []);
  // and the snapshot is a stream copy: nothing in the ring decodes or encodes
  const ring = fs.readFileSync(path.join(APP, 'src', 'media', 'ring.mjs'), 'utf8');
  assert.doesNotMatch(ring, /VideoDecoder|VideoEncoder|decodeFrames|createDecoder|createEncoder/);
});

test('the browser\'s side: browserCaptureApi() over a fake global, nothing there is not there', async () => {
  const { browserCaptureApi } = await load('src/media/capture-browser.mjs');
  const bare = browserCaptureApi({});
  assert.equal(bare.getUserMedia, null);
  assert.equal(bare.createEncoder, null);
  assert.equal(bare.readFrames, null);
  assert.equal(bare.requestWakeLock, null);
  const calls = [];
  const g = {
    navigator: { mediaDevices: { getUserMedia: c => { calls.push(c); return 'stream'; } }, wakeLock: { request: t => { calls.push(t); return 'sentinel'; } } },
    VideoEncoder: class { constructor(init) { this.init = init; } static isConfigSupported(c) { return { supported: true, config: c }; } },
    MediaStreamTrackProcessor: class { constructor({ track }) { this.readable = { getReader: () => ({ track }) }; } },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
  };
  const api = browserCaptureApi(g);
  assert.equal(await api.getUserMedia({ video: true }), 'stream');
  assert.equal(await api.requestWakeLock(), 'sentinel');
  assert.deepEqual(calls, [{ video: true }, 'screen']);
  assert.equal(api.readFrames('t').track, 't');
  assert.ok(api.createEncoder({}) instanceof g.VideoEncoder);
  assert.equal(api.isVisible(), true);
});

// ---- c61: one camera at a time, a Start that says when it didn't, a failed camera that keeps the lift ----

/** The fake's cameras with a track still live (the preview's or a clone), and the encoders not closed. */
const liveCameras = fake => fake.cameras.filter(c => c.tracks.some(t => t.readyState === 'live')).length;
const openEncoders = fake => fake.log.encoders.filter(e => e.state !== 'closed').length;
/** A promise the test lets go: `gate(f)` is f, called only once `release()` runs. */
function gated(f) {
  let release;
  const ready = new Promise(r => { release = r; });
  return { call: (...a) => ready.then(() => f(...a)), release: () => release() };
}
const busy = async () => { const e = new Error('Could not start video source'); e.name = 'NotReadableError'; throw e; };
/** The snapshot's packets: the first a keyframe, the times rising (one encoder's chunks, never two interleaved). */
function assertOneStream(mp4) {
  assert.equal(mp4.packets[0].type, 'key', 'the ring starts on a keyframe');
  const ts = mp4.packets.map(p => p.timestamp);
  assert.ok(ts.every((t, i) => !i || t > ts[i - 1]), `the times rise: ${ts.join(', ')}`);
}

test('c61: two resume() calls at once from interrupted open one camera and one encoder, none after close(); the ring holds one encoder\'s chunks', async () => {
  const { cap, fake, last } = await recording();
  await fake.deliver(30);
  fake.camera.end();
  await fake.settle();
  assert.equal(last().state, 'interrupted');
  const a = cap.resume(), b = cap.resume();   // a double tap on "Camera stopped"
  await Promise.all([a, b]);
  assert.equal(last().state, 'recording');
  assert.equal(fake.log.getUserMedia.length, 2, 'the camera asked for once more, not twice');
  assert.equal(liveCameras(fake), 1, 'one live camera');
  assert.equal(openEncoders(fake), 1, 'one encoder');
  // every camera still live gets frames: two would mean two encoders writing into the ring
  for (const cam of fake.cameras.filter(c => c.tracks.some(t => t.readyState === 'live'))) { fake.camera = cam; await fake.deliver(30); }
  await fake.settle();
  assert.deepEqual([...new Set(fake.log.encoded.slice(30).map(e => e.encoder))], [1], 'after the resume one encoder encodes');
  const mp4 = await readMp4((await cap.snapshot(60)).blob);
  assert.equal(mp4.packets.length, 60);
  assertOneStream(mp4);
  assert.equal(mp4.packets[30].type, 'key', 'the resumed run starts on a keyframe');
  cap.close();
  assert.equal(liveCameras(fake), 0, 'no track live after close()');
  assert.equal(openEncoders(fake), 0, 'no encoder open after close()');
});

test('c61: two open() calls at once (and two after a failure, "Try again" tapped twice) open one camera; none after close()', async () => {
  const { cap, fake, last } = await setup();
  await Promise.all([cap.open(), cap.open()]);
  assert.equal(last().state, 'preview');
  assert.equal(fake.log.getUserMedia.length, 1);
  assert.equal(liveCameras(fake), 1);
  await cap.start();
  assert.equal(openEncoders(fake), 1);
  cap.close();
  assert.deepEqual([liveCameras(fake), openEncoders(fake)], [0, 0]);

  const real = fake.api.getUserMedia;
  fake.api.getUserMedia = busy;
  await assert.rejects(cap.open(), { code: 'camera-busy' });
  fake.api.getUserMedia = real;
  await Promise.all([cap.open(), cap.open()]);
  assert.equal(fake.log.getUserMedia.length, 2, 'one camera more for two taps');
  assert.equal(liveCameras(fake), 1);
  cap.close();
  assert.equal(liveCameras(fake), 0);
});

test('c61: a camera that arrives after close() is stopped: the capture stays closed', async () => {
  const { cap, fake, last } = await setup();
  const g = gated(fake.api.getUserMedia);
  fake.api.getUserMedia = g.call;
  const opening = cap.open();
  await fake.settle();
  cap.close();
  g.release();
  await opening.catch(() => {});
  assert.equal(last().state, 'closed');
  assert.equal(cap.stream, null);
  assert.equal(liveCameras(fake), 0, 'the late camera is stopped');
});

test('c61: start() closed while it checks the encoder\'s configs rejects (code stopped): nothing recorded, no encoder, no wake lock', async () => {
  const { CaptureError } = await load('src/media/capture.mjs');
  const { cap, fake, last } = await setup();
  await cap.open();
  const g = gated(fake.api.isEncoderConfigSupported);
  fake.api.isEncoderConfigSupported = g.call;
  const starting = cap.start();
  await fake.settle();
  cap.close();   // R1's back
  g.release();
  await assert.rejects(starting, e => e instanceof CaptureError && e.code === 'stopped');
  assert.equal(last().state, 'closed');
  assert.equal(openEncoders(fake), 0);
  assert.equal(fake.log.wakeLocks.length, 0);
  assert.equal(liveCameras(fake), 0);
});

test('c61: start() whose camera ends while it checks the encoder\'s configs rejects (code stopped); interrupted with no ring, resume() is the preview again and Start works', async () => {
  const { CaptureError } = await load('src/media/capture.mjs');
  const { cap, fake, last } = await setup();
  await cap.open();
  const real = fake.api.isEncoderConfigSupported;
  const g = gated(real);
  fake.api.isEncoderConfigSupported = g.call;
  const starting = cap.start();
  await fake.settle();
  fake.camera.end();
  g.release();
  await assert.rejects(starting, e => e instanceof CaptureError && e.code === 'stopped');
  assert.equal(last().state, 'interrupted');
  assert.equal(last().ringHeld, false, 'no ring');
  assert.equal(openEncoders(fake), 0);
  fake.api.isEncoderConfigSupported = real;
  await cap.resume();
  assert.equal(last().state, 'preview');
  await cap.start();
  assert.equal(last().state, 'recording');
  cap.close();
});

test('c61: resume() that fails with camera-busy keeps the ring; a second resume() from failed reopens the camera and records on into the same ring from a new keyframe', async () => {
  const { cap, fake, last } = await recording();
  await fake.deliver(30);
  fake.camera.end();
  await fake.settle();
  const real = fake.api.getUserMedia;
  fake.api.getUserMedia = busy;
  await assert.rejects(cap.resume(), { code: 'camera-busy' });
  assert.equal(last().state, 'failed');
  assert.equal(last().ringHeld, true, 'the ring is held');
  assert.equal((await readMp4((await cap.snapshot(60)).blob)).packets.length, 30, 'snapshot() works while failed');
  fake.api.getUserMedia = real;
  await cap.resume();   // Try again
  assert.equal(last().state, 'recording');
  assert.equal(last().error, null);
  assert.equal(last().wakeLock, 'held', 'the screen kept on again');
  assert.equal(liveCameras(fake), 1);
  assert.equal(openEncoders(fake), 1);
  await fake.deliver(30);
  await fake.settle();
  const mp4 = await readMp4((await cap.snapshot(60)).blob);
  assert.equal(mp4.packets.length, 60, 'the same ring: both runs in one snapshot');
  assertOneStream(mp4);
  assert.equal(mp4.packets[30].type, 'key');
  // the page hidden and shown: the lock asked for again, as before the failure
  fake.setVisible(false); fake.wakeLock._drop(); await fake.settle(); fake.setVisible(true); await fake.settle();
  assert.equal(last().wakeLock, 'held');
  cap.close();
  assert.deepEqual([liveCameras(fake), openEncoders(fake)], [0, 0]);
});

test('c61: an encoder that failed while recording: resume() from failed reopens the camera and records on into the same ring from a new keyframe', async () => {
  const { cap, fake, last } = await recording();
  await fake.deliver(40);
  await fake.settle();
  const first = fake.camera;
  fake.encoder.fail('Encoder hardware gone');
  await fake.settle();
  assert.equal(last().state, 'failed');
  assert.equal(last().error.code, 'encoder-failed');
  assert.equal(last().ringHeld, true);
  await cap.resume();
  assert.equal(last().state, 'recording');
  assert.equal(fake.log.getUserMedia.length, 2, 'the camera asked for again');
  assert.ok(first.tracks.every(t => t.readyState === 'ended'), 'the old camera stopped');
  assert.deepEqual([liveCameras(fake), openEncoders(fake)], [1, 1]);
  await fake.deliver(20);
  await fake.settle();
  const mp4 = await readMp4((await cap.snapshot(60)).blob);
  assert.equal(mp4.packets.length, 60);
  assertOneStream(mp4);
  assert.equal(mp4.packets[40].type, 'key');
  cap.close();
  assert.deepEqual([liveCameras(fake), openEncoders(fake)], [0, 0]);
});

test('c61: resume() from failed without a ring (a failed open()) does nothing: R1\'s Try again is open()', async () => {
  const { cap, fake, last } = await setup({ getUserMediaError: { name: 'NotReadableError', message: 'busy' } });
  await assert.rejects(cap.open(), { code: 'camera-busy' });
  await cap.resume();
  assert.equal(last().state, 'failed');
  assert.equal(fake.log.getUserMedia.length, 1);
  assert.equal(last().ringHeld, false);
  cap.close();
});
