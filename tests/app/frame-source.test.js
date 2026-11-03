// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// The frame source (package s9), app/src/media/: mediabunny demuxes, WebCodecs
// decodes (contract 5, app/src/contracts/frame-source.mjs). Node has no
// VideoDecoder, so what runs here is everything but the pixels: the real
// demuxer on our own clips (tests/app/clips/, made by the commands in
// tests/README.md), the sample table and its keyframe search, and the decode
// loop against a fake decoder (fake-webcodecs.js) that reorders B-frames and
// insists on a key chunk first. The real decoder, the canvas turn for rotation
// and the speed are the Fairphone's (c26).
//
// What the clips are, from their commands: testsrc2, 96×54, 30 fps, 3 s = 90
// frames, H.264 with B-frames and a keyframe every 30 frames (every second);
// `-rot90` is the same stream with the file's rotation set to 90° clockwise
// (so it is 54×96 upright); `-vfr` keeps the frames n of 0..89 with n % 5 < 3
// (54 frames, at n/30 s); the HEVC one has the same frames in H.265.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createFakeWebCodecs } = require('./fake-webcodecs');

const ROOT = path.resolve(__dirname, '..', '..');
const MEDIA = path.join(ROOT, 'app', 'src', 'media');
const CLIPS = path.join(__dirname, 'clips');
const load = (dir, name) => import(pathToFileURL(path.join(dir, name)).href);
const media = () => load(MEDIA, 'frame-source.mjs');
const contract = () => load(path.join(ROOT, 'app', 'src', 'contracts'), 'frame-source.mjs');
const clip = name => new Blob([fs.readFileSync(path.join(CLIPS, name))], { type: 'video/mp4' });

const H264 = 'testsrc2-h264-30fps.mp4';
const ROT90 = 'testsrc2-h264-30fps-rot90.mp4';
const VFR = 'testsrc2-h264-vfr.mp4';
const HEVC = 'testsrc2-hevc-30fps.mp4';

// µs the way the source rounds a time
const us = s => Math.round(s * 1e6);
const frameTime = i => i / 30;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);

async function open(name, options = {}, fakeOptions = {}) {
  const { openFrameSource } = await media();
  const fake = createFakeWebCodecs(fakeOptions);
  const src = await openFrameSource(clip(name), { webcodecs: fake, stallMs: 400, ...options });
  return { src, fake, base: fake.log.decoders.length };
}
async function collect(iterable) {
  const out = [];
  for await (const f of iterable) out.push(f);
  return out;
}
const openFrames = fake => fake.log.frames.filter(f => !f.closed);
const closeAll = frames => frames.forEach(f => f.close());

// ---- the sample table: keyframes and presentation order, no file needed -----

// two closed GOPs of six frames, I B B P B B written as the encoder stores
// them (decode order): presentation numbers 0 3 1 2 5 4, then 6 9 7 8 11 10
const GOP = [0, 3, 1, 2, 5, 4];
const SYNTH = [...GOP, ...GOP.map(n => n + 6)].map((n, i) => ({
  type: i % 6 === 0 ? 'key' : 'delta', timestamp: 10 + n / 30, duration: 1 / 30,
}));

test('the sample table puts the frames in presentation order, from time 0', async () => {
  const { buildSampleTable } = await load(MEDIA, 'sample-table.mjs');
  const t = buildSampleTable(SYNTH);
  assert.equal(t.count, 12);
  assert.equal(t.times.length, 12);
  t.times.forEach((v, i) => assert.ok(Math.abs(v - i / 30) < 1e-9, `frame ${i} at ${v}`));
  assert.equal(t.times[0], 0, 'the earliest frame is the origin, not the container\'s 10 s');
  assert.ok(Math.abs(t.duration - 12 / 30) < 1e-9);
  assert.ok(Math.abs(t.fps - 30) < 1e-9);
  assert.equal(t.timestampUs(3), us(3 / 30));
});

test('the keyframe search: the last key at or before a frame, in decode order', async () => {
  const { buildSampleTable } = await load(MEDIA, 'sample-table.mjs');
  const t = buildSampleTable(SYNTH);
  assert.equal(t.keyBefore(0), 0);
  assert.equal(t.keyBefore(5), 0);
  assert.equal(t.keyBefore(6), 6);
  assert.equal(t.keyBefore(11), 6);
  // frames 1 and 2 (pictures 1 and 2) are stored 3rd and 4th: decoding them needs
  // the chunks 0..3, the keyframe's and the P-frame 3 that they are predicted from
  assert.deepEqual(t.plan(1, 2), { startDec: 0, endDec: 3 });
  // presentation 4..7 are stored at 5, 4, 6 and 8: from the first key to the last of them
  assert.deepEqual(t.plan(4, 7), { startDec: 0, endDec: 8 });
  assert.deepEqual(t.plan(6, 6), { startDec: 6, endDec: 6 });
});

test('the time to a frame: the last one starting at or before t, within float slack', async () => {
  const { buildSampleTable } = await load(MEDIA, 'sample-table.mjs');
  const t = buildSampleTable(SYNTH);
  assert.equal(t.indexAt(0), 0);
  assert.equal(t.indexAt(1 / 30), 1);
  assert.equal(t.indexAt(1 / 30 - 1e-9), 1, 'a float time that is one ulp short of the frame still shows it');
  assert.equal(t.indexAt(1 / 30 - 1e-3), 0);
  assert.equal(t.indexAt(-5), 0, 'before the start: the first frame');
  assert.equal(t.indexAt(99), 11, 'after the end: the last frame');
  assert.deepEqual(t.indexRange(2 / 30, 4 / 30), { first: 2, last: 4 }, 'both ends are inclusive');
  assert.deepEqual(t.indexRange(0.5 / 30, 3.5 / 30), { first: 1, last: 3 });
  assert.equal(t.indexRange(0.5, 0.6), null, 'no frame starts in a range after the end');
  assert.equal(t.indexRange(3 / 30, 1 / 30), null, 'an empty range');
});

test('a stream with no keyframe first is refused, not guessed at', async () => {
  const { buildSampleTable } = await load(MEDIA, 'sample-table.mjs');
  const { MediaError } = await load(MEDIA, 'media-error.mjs');
  assert.throws(() => buildSampleTable([{ type: 'delta', timestamp: 0, duration: 1 }]),
    e => e instanceof MediaError && e.code === 'unreadable');
  assert.throws(() => buildSampleTable([]), e => e instanceof MediaError && e.code === 'unreadable');
});

// ---- the metadata -----------------------------------------------------------

test('the metadata of the H.264 clip: duration, rate, size, rotation, codec', async () => {
  const { src } = await open(H264);
  const { validateFrameSource, validateFrameSourceInfo } = await contract();
  assert.deepEqual(validateFrameSourceInfo(src.info), []);
  assert.deepEqual(validateFrameSource(src), []);
  assert.equal(src.info.width, 96);
  assert.equal(src.info.height, 54);
  assert.equal(src.info.rotation, 0);
  assert.ok(Math.abs(src.info.duration - 3) < 1e-6, `duration ${src.info.duration}`);
  assert.ok(Math.abs(src.info.fps - 30) < 1e-6, `fps ${src.info.fps}`);
  assert.match(src.info.codec, /^avc1\./);
  src.close();
});

test('rotation is applied once, at the source: the info and every frame are upright', async () => {
  const { src, fake, base } = await open(ROT90);
  assert.equal(src.info.rotation, 90, 'what the file asked for');
  assert.equal(src.info.width, 54, 'the upright width: the stored 54 high side');
  assert.equal(src.info.height, 96);
  const frames = await collect(src.frames(0, 0.2));
  assert.equal(frames.length, 7);
  for (const f of frames) {
    assert.equal(f.displayWidth, 54);
    assert.equal(f.displayHeight, 96);
  }
  assert.ok(fake.log.rotations.every(r => r.rotation === 90));
  const turned = fake.log.rotations.length;
  const one = await src.frameAt(0.5);
  assert.equal(one.displayWidth, 54);
  assert.equal(fake.log.rotations.length, turned + 1, 'a frame is turned once, not once per consumer or per call');
  closeAll(frames); one.close();
  assert.deepEqual(openFrames(fake).map(f => f.timestamp), [], 'the undecoded-for-nothing frames and the unturned originals are closed');
  src.close();
  void base;
});

test('an upright clip is not turned at all', async () => {
  const { src, fake } = await open(H264);
  const frames = await collect(src.frames(0, 0.1));
  assert.equal(fake.log.rotations.length, 0);
  closeAll(frames); src.close();
});

test('the thumbnails of a rotated clip have the upright aspect', async () => {
  const { src, fake } = await open(ROT90);
  const thumbs = await src.thumbnails([0.5, 2.5], { height: 48 });
  assert.deepEqual(thumbs.map(b => [b.width, b.height]), [[27, 48], [27, 48]], '54 × 96 upright, scaled to 48 high');
  thumbs.forEach(b => b.close());
  assert.deepEqual(openFrames(fake), []);
  src.close();
});

// ---- the frame times --------------------------------------------------------

test('the frame times of the 30 fps clip: n / 30 from 0, in order, despite the B-frame reordering', async () => {
  const { src } = await open(H264);
  const times = src.frameTimes;
  assert.equal(times.length, 90);
  times.forEach((t, i) => assert.ok(Math.abs(t - frameTime(i)) < 1e-9, `frame ${i}: ${t}`));
  src.close();
});

test('a variable frame rate has its own times, and the average rate is frames over duration', async () => {
  const { src } = await open(VFR);
  const kept = range(0, 89).filter(n => n % 5 < 3);
  assert.equal(kept.length, 54);
  assert.equal(src.frameTimes.length, 54);
  const { validateFrameSource } = await contract();
  assert.deepEqual(validateFrameSource(src), [], 'contract 5 takes a variable rate\'s own times');
  src.frameTimes.forEach((t, i) => assert.ok(Math.abs(t - kept[i] / 30) < 1e-9, `frame ${i}: ${t}`));
  // the last frame (n = 87) lasts to 88/30 s; the table's duration is the span of the frames
  assert.ok(Math.abs(src.info.duration - 88 / 30) < 1e-6, `duration ${src.info.duration}`);
  assert.ok(Math.abs(src.info.fps - 54 / (88 / 30)) < 1e-6, `fps ${src.info.fps}`);
  // the frame at 0.15 s: the kept frame at 2/30 = 0.067 s; the next is n = 5 at 0.167 s
  const f = await src.frameAt(0.15);
  assert.equal(f.timestamp, us(2 / 30));
  f.close();
  src.close();
});

// ---- a range, in order, from the keyframe before it -------------------------

test('a range gives its frames in order, ends included, decoded from the keyframe before it', async () => {
  const { src, fake, base } = await open(H264);
  const frames = await collect(src.frames(1.2, 1.5));
  assert.deepEqual(frames.map(f => f.timestamp), range(36, 45).map(i => us(frameTime(i))));
  const decoders = fake.log.decoders.slice(base);
  assert.equal(decoders.length, 1);
  const fed = decoders[0].fed;
  assert.equal(fed[0].type, 'key');
  assert.equal(fed[0].timestamp, us(1), 'the keyframe at 1 s, not the one at 0');
  assert.ok(fed.every(c => c.timestamp >= us(1)), 'nothing from before that keyframe');
  assert.ok(fed.length >= 16 && fed.length < 30, `${fed.length} chunks: up to the last frame wanted, not to the end`);
  assert.equal(fed.filter(c => c.type === 'key').length, 1);
  closeAll(frames);
  assert.deepEqual(openFrames(fake), [], 'the frames decoded only to get there were closed by the source');
  src.close();
});

test('a range over a keyframe is one continuous run', async () => {
  const { src, fake, base } = await open(H264);
  const frames = await collect(src.frames(0.9, 2.1));
  assert.deepEqual(frames.map(f => f.timestamp), range(27, 63).map(i => us(frameTime(i))));
  assert.equal(fake.log.decoders.slice(base).length, 1);
  assert.equal(fake.log.decoders[base].fed[0].timestamp, 0);
  closeAll(frames); src.close();
});

test('the whole clip, and a range past the end', async () => {
  const { src, fake } = await open(H264);
  const all = await collect(src.frames(0, 3));
  assert.equal(all.length, 90);
  closeAll(all);
  const tail = await collect(src.frames(2.9, 99));
  assert.deepEqual(tail.map(f => f.timestamp), range(87, 89).map(i => us(frameTime(i))));
  closeAll(tail);
  assert.deepEqual(await collect(src.frames(5, 6)), []);
  assert.deepEqual(await collect(src.frames(1.0001, 1.0002)), [], 'a range between two frames is empty');
  assert.deepEqual(openFrames(fake), []);
  src.close();
});

test('stopping early closes the decoder and every frame it holds', async () => {
  const { src, fake, base } = await open(H264);
  let n = 0;
  for await (const f of src.frames(0, 3)) { f.close(); if (++n === 5) break; }
  assert.equal(n, 5);
  assert.equal(fake.log.decoders[base].state, 'closed');
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.deepEqual(openFrames(fake), []);
  src.close();
});

test('decoding stays a few frames ahead of a slow consumer, not the whole clip', async () => {
  const { src, fake, base } = await open(H264);
  const it = src.frames(0, 3)[Symbol.asyncIterator]();
  const first = await it.next();
  await new Promise(r => setTimeout(r, 30));
  const fed = fake.log.decoders[base].fed.length;
  assert.ok(fed < 40, `${fed} chunks fed while the consumer held one frame`);
  first.value.close();
  await it.return();
  src.close();
});

// ---- the frame at a time ----------------------------------------------------

test('the frame at t is the last one starting at or before t', async () => {
  const { src, fake } = await open(H264);
  const at = async t => { const f = await src.frameAt(t); const ts = f.timestamp; f.close(); return ts; };
  assert.equal(await at(0), 0);
  assert.equal(await at(1.0), us(1));
  assert.equal(await at(1.02), us(1), 'between frames 30 and 31');
  assert.equal(await at(1.05), us(frameTime(31)));
  assert.equal(await at(frameTime(31)), us(frameTime(31)), 'exactly on a frame');
  assert.equal(await at(0.99), us(frameTime(29)));
  assert.equal(await at(-1), 0, 'before the start: the first frame');
  assert.equal(await at(100), us(frameTime(89)), 'after the end: the last frame');
  assert.deepEqual(openFrames(fake), []);
  src.close();
});

test('the frame at t is decoded from the keyframe before it, and needs the chunks stored after it', async () => {
  const { src, fake, base } = await open(H264);
  // B-frames: the picture at 2/30 s is stored after the one at 3/30 s
  const f = await src.frameAt(2 / 30);
  assert.equal(f.timestamp, us(2 / 30));
  let fed = fake.log.decoders[base].fed;
  assert.equal(fed[0].type, 'key');
  assert.equal(fed[0].timestamp, 0);
  assert.ok(fed.some(c => c.timestamp === us(3 / 30)), 'the later picture it is predicted from was fed');
  assert.ok(fed.length < 10, `${fed.length} chunks for one early frame`);
  f.close();

  const g = await src.frameAt(2.5);
  fed = fake.log.decoders[base + 1].fed;
  assert.equal(fed[0].timestamp, us(2), 'the keyframe at 2 s');
  assert.ok(fed.every(c => c.timestamp >= us(2)));
  g.close();
  assert.equal(fake.log.decoders[base].state, 'closed', 'one decoder per call, closed after it');
  assert.deepEqual(openFrames(fake), []);
  src.close();
});

test('a time that is not a number is a range error, not a hang', async () => {
  const { src } = await open(H264);
  const { MediaError } = await media();
  await assert.rejects(src.frameAt(NaN), e => e instanceof MediaError && e.code === 'range');
  await assert.rejects(src.frameAt('1'), e => e.code === 'range');
  await assert.rejects(collect(src.frames(0, NaN)), e => e.code === 'range');
  src.close();
});

// ---- thumbnails -------------------------------------------------------------

test('a thumbnail per time, in the order asked, `height` high, one decode per keyframe group', async () => {
  const { src, fake, base } = await open(H264);
  const thumbs = await src.thumbnails([2.5, 0.5, 1.5, 1.51, 0.5], { height: 36 });
  assert.equal(thumbs.length, 5);
  for (const b of thumbs) {
    assert.equal(b.height, 36);
    assert.equal(b.width, 64, '96 × 54 scaled to 36 high');
  }
  assert.deepEqual(thumbs.map(b => b.timestamp), [2.5, 0.5, 1.5, 1.51, 0.5].map(t => us(frameTime(Math.floor(t * 30 + 1e-6)))));
  assert.equal(fake.log.decoders.slice(base).length, 3, 'three keyframes: three decodes, not five');
  assert.deepEqual(openFrames(fake), [], 'the frames are closed once drawn');
  thumbs.forEach(b => b.close());
  src.close();
});

test('no thumbnails asked: no decoder made', async () => {
  const { src, fake, base } = await open(H264);
  assert.deepEqual(await src.thumbnails([], { height: 36 }), []);
  assert.equal(fake.log.decoders.length, base);
  await assert.rejects(src.thumbnails([1], { height: 0 }), e => e.code === 'range');
  src.close();
});

// ---- a video it can't read or decode ----------------------------------------

test('HEVC where the decoder lacks it fails at open, with a message that names the codec', async () => {
  const { openFrameSource, MediaError } = await media();
  const fake = createFakeWebCodecs({ supported: config => !/^hev1|^hvc1/.test(config.codec) });
  await assert.rejects(openFrameSource(clip(HEVC), { webcodecs: fake, stallMs: 400 }), e => {
    assert.ok(e instanceof MediaError);
    assert.equal(e.code, 'unsupported-codec');
    assert.match(e.message, /hev1|hvc1|HEVC/);
    assert.match(e.message, /can't|cannot/i);
    assert.match(e.codec, /^hev1|^hvc1/);
    return true;
  });
  assert.equal(fake.log.decoders.length, 0, 'it asked isConfigSupported and did not try to decode');
});

test('the same HEVC clip opens when the decoder supports it', async () => {
  const { src } = await open(HEVC);
  assert.match(src.info.codec, /^hev1|^hvc1/);
  assert.equal(src.info.width, 96);
  src.close();
});

test('bytes that are not a video are unreadable, a clear error', async () => {
  const { openFrameSource, MediaError } = await media();
  const fake = createFakeWebCodecs();
  for (const bytes of [new Uint8Array(0), new Uint8Array(100), Buffer.from('<html>not a video</html>')]) {
    await assert.rejects(openFrameSource(new Blob([bytes]), { webcodecs: fake }),
      e => e instanceof MediaError && e.code === 'unreadable' && /video/i.test(e.message));
  }
});

test('a decoder that errors on the probe frame fails open with decode-failed', async () => {
  const { openFrameSource, MediaError } = await media();
  const fake = createFakeWebCodecs({ failOnChunk: 1 });
  await assert.rejects(openFrameSource(clip(H264), { webcodecs: fake, stallMs: 400 }),
    e => e instanceof MediaError && e.code === 'decode-failed' && /decod/i.test(e.message));
  assert.equal(fake.log.decoders[0].state, 'closed');
  assert.deepEqual(openFrames(fake), []);
});

test('a decoder that errors halfway through a range ends the stream with decode-failed, closing what it held', async () => {
  const { openFrameSource } = await media();
  // the open's probe decodes with a good decoder; the later call gets one that breaks on its 8th chunk
  const good = createFakeWebCodecs();
  const bad = createFakeWebCodecs({ failOnChunk: 8 });
  let made = 0;
  const flaky = { ...good, createDecoder: init => (made++ === 0 ? good : bad).createDecoder(init) };
  const src = await openFrameSource(clip(H264), { webcodecs: flaky, stallMs: 400 });
  const got = [];
  await assert.rejects(async () => { for await (const f of src.frames(0, 3)) got.push(f); }, e => e.code === 'decode-failed');
  assert.ok(got.length < 8, 'only frames that came out before the failure');
  closeAll(got);
  assert.equal(bad.log.decoders[0].state, 'closed');
  assert.deepEqual(openFrames(bad), []);
  assert.deepEqual(openFrames(good), []);
  src.close();
});

test('a decoder that never answers is a stall error after stallMs, never a hang', { timeout: 5000 }, async () => {
  const { openFrameSource, MediaError } = await media();
  for (const fakeOptions of [{ silent: true, hangFlush: true }, { hangFlush: true, reorder: 1000 }]) {
    const fake = createFakeWebCodecs(fakeOptions);
    const t0 = Date.now();
    await assert.rejects(openFrameSource(clip(H264), { webcodecs: fake, stallMs: 150 }),
      e => e instanceof MediaError && e.code === 'decode-stalled' && /not answer|stalled|responding/i.test(e.message));
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(fake.log.decoders[0].state, 'closed');
  }
});

test('a decoder that takes the chunks but outputs nothing is decode-failed, not an empty result', { timeout: 5000 }, async () => {
  const { openFrameSource } = await media();
  const fake = createFakeWebCodecs({ silent: true });
  await assert.rejects(openFrameSource(clip(H264), { webcodecs: fake, stallMs: 150 }), e => e.code === 'decode-failed');
});

test('without WebCodecs (Node, an old WebView) it says so', async () => {
  const { openFrameSource, MediaError } = await media();
  assert.equal(typeof globalThis.VideoDecoder, 'undefined', 'this test is for a runtime with no WebCodecs');
  await assert.rejects(openFrameSource(clip(H264)), e => e instanceof MediaError && e.code === 'no-webcodecs' && /WebCodecs|decoder/i.test(e.message));
});

test('the file is read lazily: a Blob that reads whole is not needed', async () => {
  // mediabunny asks the Blob for slices; count what a probe open reads of a larger file
  const { openFrameSource } = await media();
  const bytes = fs.readFileSync(path.join(CLIPS, H264));
  let sliced = 0;
  class Spy extends Blob { slice(...a) { sliced++; return super.slice(...a); } }
  const src = await openFrameSource(new Spy([bytes]), { webcodecs: createFakeWebCodecs() });
  assert.ok(sliced > 0, 'read through slice()');
  src.close();
});

// ---- close ------------------------------------------------------------------

test('close() stops what is running, frees the decoder, and the source refuses further calls', async () => {
  const { src, fake, base } = await open(H264);
  const { MediaError } = await media();
  const it = src.frames(0, 3)[Symbol.asyncIterator]();
  const first = await it.next();
  first.value.close();
  src.close();
  await assert.rejects(it.next(), e => e instanceof MediaError && e.code === 'closed');
  assert.equal(fake.log.decoders[base].state, 'closed');
  await assert.rejects(src.frameAt(1), e => e.code === 'closed');
  await assert.rejects(src.thumbnails([1], { height: 10 }), e => e.code === 'closed');
  await assert.rejects(collect(src.frames(0, 1)), e => e.code === 'closed');
  src.close();   // twice is fine
  await new Promise(r => setImmediate(r));
  assert.deepEqual(openFrames(fake), []);
});

test('close() while a packet read is pending is `closed`, not "unreadable" (the disposed input rejects the read)', async () => {
  const { MediaError } = await media();
  const { decodeFrames } = await load(MEDIA, 'decode.mjs');
  const fake = createFakeWebCodecs();
  const controller = new AbortController();
  // chunks whose read waits on a gate; close() = abort, then the file is
  // disposed under the read, which rejects it (as mediabunny's Input does)
  let rejectRead;
  const chunks = { [Symbol.asyncIterator]: () => ({
    next: () => new Promise((_, reject) => { rejectRead = reject; }),
    return: async () => ({ done: true }),
  }) };
  const it = decodeFrames({ webcodecs: fake, config: { codec: 'avc1.64001f', codedWidth: 96, codedHeight: 54 },
    chunks, wants: () => true, signal: controller.signal, stallMs: 400 })[Symbol.asyncIterator]();
  const pending = it.next();
  await new Promise(r => setImmediate(r));
  assert.ok(rejectRead, 'the loop is waiting on a read');
  controller.abort();
  rejectRead(new Error('Input has been disposed.'));
  await assert.rejects(pending, e => e instanceof MediaError && e.code === 'closed');
  // a read that fails with no close is still the file's fault
  const chunks2 = { [Symbol.asyncIterator]: () => ({ next: async () => { throw new Error('boom'); }, return: async () => ({ done: true }) }) };
  await assert.rejects(decodeFrames({ webcodecs: createFakeWebCodecs(), config: { codec: 'avc1.64001f', codedWidth: 96, codedHeight: 54 },
    chunks: chunks2, wants: () => true })[Symbol.asyncIterator]().next(), e => e.code === 'unreadable');
});

// ---- the stepper: one-frame steps from a cache (s38) ------------------------
//
// M1–M3 step one frame at a time. frameAt decodes again from the keyframe for
// every call; the stepper keeps the frames around the playhead, as bitmaps at the
// caller's size, and refills them in the background. The clip's keyframes are at
// frames 0, 30 and 60 (1 s apart), so its groups are 0–29, 30–59 and 60–89.

const sleep = ms => new Promise(r => setTimeout(r, ms));
// the key chunks fed to the decoders made since `base`, by their time in µs
const keysFed = (fake, base, t) => fake.log.decoders.slice(base)
  .reduce((k, d) => k + d.fed.filter(c => c.type === 'key' && c.timestamp === us(t)).length, 0);
const openBitmaps = fake => fake.log.bitmaps.filter(b => !b.closed);
const heldIndices = fake => openBitmaps(fake).map(b => Math.round(b.timestamp / 1e6 * 30)).sort((a, b) => a - b);
// steps one at a time, each awaited, `pauseMs` apart: the results, and what was fed when each step was asked
async function stepMany(st, fake, delta, count, pauseMs) {
  const out = [];
  for (let k = 0; k < count; k++) {
    if (pauseMs) await sleep(pauseMs);
    const fedBefore = fake.log.chunks.slice();
    const r = await st.step(delta);
    out.push({ index: r.index, time: r.time, ts: r.frame.timestamp, cached: r.cached, fedBefore });
  }
  return out;
}

test('a stepper opened at a time gives that frame; +1 and −1 give its neighbours by frameTimes, and a held frame decodes nothing', async () => {
  const { src, fake } = await open(H264);
  // at frame 44 the default budget (90 frames) holds the whole 3 s clip once the refill is done
  const st = await src.stepper(frameTime(44) + 0.01, { height: 36 });
  assert.equal(st.index, 44, 'the frame shown at the time: the last starting at or before it');
  assert.ok(Math.abs(st.time - frameTime(44)) < 1e-9);
  assert.equal(st.frame.timestamp, us(frameTime(44)));
  assert.deepEqual([st.frame.width, st.frame.height], [64, 36]);
  await st.settled();
  const decoders = fake.log.decoders.length, chunks = fake.log.chunks.length;
  const seen = [];
  for (const d of [1, 1, -1, -1, -1, 1]) {
    const r = await st.step(d);
    assert.equal(r.cached, true, 'the frame was held when the step was asked');
    assert.equal(r.frame, st.frame);
    assert.equal(r.index, st.index);
    assert.ok(Math.abs(r.time - src.frameTimes[r.index]) < 1e-12, 'its time is frameTimes\'s');
    assert.equal(r.frame.timestamp, us(src.frameTimes[r.index]));
    seen.push(r.index);
  }
  assert.deepEqual(seen, [45, 46, 45, 44, 43, 44]);
  assert.equal(fake.log.decoders.length, decoders, 'no decoder made for a held frame');
  assert.equal(fake.log.chunks.length, chunks, 'no chunk decoded for a held frame');
  // at the ends a step stays put
  assert.equal((await st.seek(0)).index, 0);
  assert.equal((await st.step(-1)).index, 0);
  assert.equal((await st.seek(99)).index, 89);
  assert.equal((await st.step(1)).index, 89);
  st.close(); src.close();
});

test('a variable frame rate is stepped by its own frame times', async () => {
  const { src } = await open(VFR);
  const ft = src.frameTimes;
  const st = await src.stepper(ft[10], { height: 36 });
  assert.equal(st.index, 10);
  const next = await st.step(1);
  assert.equal(next.frame.timestamp, us(ft[11]), `frame 11 at ${ft[11]} s, not 1/30 s on`);
  await st.step(-1);
  const back = await st.step(-1);
  assert.equal(back.frame.timestamp, us(ft[9]));
  assert.ok(Math.abs(back.time - ft[9]) < 1e-12);
  st.close(); src.close();
});

test('forwards across a keyframe: the refill is ahead of the steps, and the group after it is decoded once', async () => {
  const { src, fake, base } = await open(H264);
  const st = await src.stepper(frameTime(40), { height: 36, maxFrames: 20 });
  await st.settled();
  const steps = await stepMany(st, fake, 1, 35, 3);
  assert.deepEqual(steps.map(s => s.index), range(41, 75));
  steps.forEach(s => assert.equal(s.ts, us(frameTime(s.index))));
  assert.ok(steps.every(s => s.cached), `every step found its frame held: ${steps.filter(s => !s.cached).map(s => s.index)}`);
  const into60 = steps.find(s => s.index === 60);
  assert.ok(into60.fedBefore.some(c => c.type === 'key' && c.timestamp === us(2)), 'the keyframe at 2 s was fed before the step to frame 60 was asked');
  assert.equal(keysFed(fake, base, 2), 1, 'the group from 2 s was decoded once');
  assert.equal(keysFed(fake, base, 1), 1, 'and the group from 1 s once');
  st.close(); src.close();
});

test('backwards across a keyframe: the group before is decoded once, by a refill started before the step needs it', async () => {
  const { src, fake, base } = await open(H264);
  const st = await src.stepper(frameTime(40), { height: 36, maxFrames: 60 });
  await st.settled();
  const steps = await stepMany(st, fake, -1, 35, 3);
  assert.deepEqual(steps.map(s => s.index), range(5, 39).reverse());
  steps.forEach(s => assert.equal(s.ts, us(frameTime(s.index))));
  assert.ok(steps.every(s => s.cached), `every step found its frame held: ${steps.filter(s => !s.cached).map(s => s.index)}`);
  const into29 = steps.find(s => s.index === 29);
  assert.ok(into29.fedBefore.some(c => c.type === 'key' && c.timestamp === 0), 'the keyframe at 0 s was fed before the step to frame 29 was asked');
  assert.equal(keysFed(fake, base, 0), 1, 'the group from 0 s was decoded once');
  assert.equal(keysFed(fake, base, 1), 1, 'the group from 1 s once');
  st.close(); src.close();
});

test('a step that outruns the refill waits for it, gets its frame, and no group is decoded twice', async () => {
  {
    const { src, fake, base } = await open(H264);
    const st = await src.stepper(frameTime(40), { height: 36, maxFrames: 60 });
    const steps = await stepMany(st, fake, 1, 35, 0);
    assert.deepEqual(steps.map(s => s.index), range(41, 75));
    steps.forEach(s => assert.equal(s.ts, us(frameTime(s.index))));
    assert.ok(steps.some(s => !s.cached), 'the steps ran ahead of the refill (else this test shows nothing)');
    assert.equal(keysFed(fake, base, 2), 1, 'forwards: the group from 2 s decoded once');
    assert.equal(keysFed(fake, base, 1), 1);
    st.close(); src.close();
  }
  {
    const { src, fake, base } = await open(H264);
    const st = await src.stepper(frameTime(40), { height: 36, maxFrames: 60 });
    const steps = await stepMany(st, fake, -1, 40, 0);
    assert.deepEqual(steps.map(s => s.index), range(0, 39).reverse());
    steps.forEach(s => assert.equal(s.ts, us(frameTime(s.index))));
    assert.ok(steps.some(s => !s.cached), 'the steps ran ahead of the refill');
    assert.equal(keysFed(fake, base, 0), 1, 'backwards: the group from 0 s decoded once');
    assert.equal(keysFed(fake, base, 1), 1);
    st.close(); src.close();
  }
});

test('the cache holds at most its budget, evicts the frames farthest from the playhead and closes each one it drops', async () => {
  const { openFrameSource, MediaError } = await media();
  const fake = createFakeWebCodecs();
  // the stepper's bitmaps open at the moment each new one is made: never the budget already
  let cap = 0;
  const over = [];
  const toBitmap = fake.toBitmap;
  fake.toBitmap = (frame, size) => {
    const open = openBitmaps(fake).length;
    if (open >= cap) over.push(open);
    return toBitmap(frame, size);
  };
  const src = await openFrameSource(clip(H264), { webcodecs: fake, stallMs: 400 });
  cap = 10;
  const st = await src.stepper(frameTime(45), { height: 36, maxFrames: 10 });
  assert.deepEqual(st.budget, { maxFrames: 10, maxBytes: 128 * 1024 * 1024, frameBytes: 64 * 36 * 4, frames: 10 });
  await st.settled();
  assert.deepEqual(heldIndices(fake), range(41, 50), 'the ten frames around frame 45');
  assert.equal(st.held, 10);
  assert.equal(st.bytes, 10 * 64 * 36 * 4);
  const before = openBitmaps(fake);
  assert.equal((await st.step(4)).index, 49);
  await st.settled();
  assert.deepEqual(heldIndices(fake), range(47, 56), 'stepping on: the frames farthest behind made room for the frames ahead');
  const dropped = before.filter(b => b.closed).map(b => Math.round(b.timestamp / 1e6 * 30)).sort((a, b) => a - b);
  assert.deepEqual(dropped, range(41, 46), 'each dropped frame was closed');
  await stepMany(st, fake, -1, 30, 0);
  await stepMany(st, fake, 1, 50, 0);
  await st.settled();
  assert.deepEqual(over, [], 'never more than the budget open');
  assert.ok(st.held <= 10);
  st.close();

  // a byte budget: frames of 64 × 36 × 4 bytes, seven of them
  cap = 7;
  const small = await src.stepper(frameTime(45), { height: 36, maxBytes: 64 * 36 * 4 * 7 + 5 });
  assert.equal(small.budget.frames, 7);
  await stepMany(small, fake, 1, 20, 0);
  await small.settled();
  assert.ok(openBitmaps(fake).length <= 7);
  assert.deepEqual(over, []);
  small.close();

  // the default budget, and one that can't hold a frame
  cap = Infinity;
  const dflt = await src.stepper(1, { height: 36 });
  assert.deepEqual(dflt.budget, { maxFrames: 90, maxBytes: 128 * 1024 * 1024, frameBytes: 9216, frames: 90 });
  dflt.close();
  await assert.rejects(src.stepper(1, { height: 36, maxBytes: 9000 }), e => e instanceof MediaError && e.code === 'range');
  await assert.rejects(src.stepper(1, { height: 36, maxFrames: 0 }), e => e.code === 'range');
  src.close();
});

test('a seek with a full cache to a far frame keeps the frame on screen open until the new one is in', async () => {
  // the audit of s38's first round: the frame on screen, when it was the costliest
  // held, was closed before the seek's own frame was made, so for the whole
  // createImageBitmap st.frame was undefined and the last step's bitmap was closed
  for (const maxFrames of [2, 1]) {
    const { openFrameSource } = await media();
    const fake = createFakeWebCodecs();
    const target = us(frameTime(80));
    let st = null, prev = null;
    const seen = [];
    const toBitmap = fake.toBitmap;
    fake.toBitmap = (frame, size) => {
      if (prev && frame.timestamp === target) seen.push({ prevOpen: !prev.closed, frame: st.frame, index: st.index });
      return toBitmap(frame, size);
    };
    const src = await openFrameSource(clip(H264), { webcodecs: fake, stallMs: 400 });
    // two frames: 10 and 11 once settled, so frame 10 on screen is the costliest from 80
    st = await src.stepper(frameTime(10), { height: 36, maxFrames });
    await st.settled();
    assert.equal(st.held, maxFrames, `${maxFrames}: the cache is full before the seek`);
    prev = st.frame;
    assert.equal(prev.timestamp, us(frameTime(10)));
    const r = await st.seek(frameTime(80));
    assert.equal(r.index, 80);
    assert.equal(r.frame.timestamp, target);
    assert.equal(seen.length, 1, `${maxFrames}: frame 80 made into a bitmap once`);
    assert.equal(seen[0].prevOpen, true, `${maxFrames}: the frame on screen is still open while the seek's frame is made`);
    assert.equal(seen[0].index, 10);
    assert.equal(seen[0].frame, prev, `${maxFrames}: st.frame is still frame 10 meanwhile, not undefined`);
    await st.settled();
    assert.ok(st.held <= maxFrames, `${maxFrames}: within the budget after the seek`);
    assert.equal(prev.closed, true, `${maxFrames}: frame 10 is dropped once frame 80 is in`);
    st.close(); src.close();
    assert.deepEqual(openBitmaps(fake), []);
  }
});

test('a frame outside the window is closed without a bitmap, however far its keyframe is', async () => {
  // the audit of s38's second round: the refill decodes from the keyframe, and every
  // frame on the way that fit the room or was nearer than the farthest one held was
  // turned and made into a bitmap, then evicted; at frame 140 of a phone camera's
  // 150-frame group that was about 125 bitmaps at display size before the playhead's
  const { src, fake } = await open(H264);
  const idx = b => Math.round(b.timestamp / 1e6 * 30);
  const madeSince = k => fake.log.bitmaps.slice(k).map(idx);
  const counts = list => list.reduce((m, i) => m.set(i, (m.get(i) || 0) + 1), new Map());
  // six frames, three ahead and two behind before the first step: at frame 29, the
  // last of the group 0–29, the window is 27–32
  const st = await src.stepper(frameTime(29), { height: 36, maxFrames: 6 });
  assert.equal(st.index, 29);
  await st.settled();
  const opened = madeSince(0);
  assert.deepEqual(opened.filter(i => i < 27 || i > 32), [], `opening at 29: bitmaps only in the window 27–32, made: ${opened}`);
  assert.ok([...counts(opened).values()].every(c => c === 1), `each frame made once: ${opened}`);
  assert.ok(opened.includes(29) && opened.includes(28) && opened.includes(32));
  // a seek to the last frame, of the group 60–89: the window is 87–89
  let k = fake.log.bitmaps.length;
  assert.equal((await st.seek(frameTime(89))).index, 89);
  await st.settled();
  const seeked = madeSince(k);
  assert.deepEqual(seeked.filter(i => i < 87), [], `seeking to 89: bitmaps only in the window 87–89, made: ${seeked}`);
  assert.ok([...counts(seeked).values()].every(c => c === 1), `each frame made once: ${seeked}`);
  // stepping back to 84 (four behind, one ahead): each window's decode from frame 60 makes no bitmap before it
  k = fake.log.bitmaps.length;
  for (let s = 0; s < 5; s++) { await st.step(-1); await st.settled(); }
  assert.equal(st.index, 84);
  const back = madeSince(k);
  assert.deepEqual(back.filter(i => i < 80), [], `stepping back to 84: bitmaps only from 80 on, made: ${back}`);
  st.close(); src.close();
  assert.deepEqual(openBitmaps(fake), []);
  assert.deepEqual(openFrames(fake), []);
});

test('a seek away from a refill behind the playhead gives that decode up instead of waiting for it', async () => {
  // s38's second round, headless Brave: a seek waited for the decode of the group
  // behind the last playhead to reach its frame, a whole group of 1080p decoding
  const { src, fake, base } = await open(H264);
  const st = await src.stepper(frameTime(62), { height: 36, maxFrames: 6 });
  await st.settled();
  // stepping back to 60: the frame behind it, 59, is a window's quarter away, so the
  // refill decodes the group 30–59 from its keyframe at 1 s
  await st.step(-1);
  await st.settled();
  assert.equal((await st.step(-1)).index, 60);
  const backDecoder = () => fake.log.decoders.slice(base).find(d => d.fed[0] && d.fed[0].type === 'key' && d.fed[0].timestamp === us(1));
  for (let k = 0; k < 200 && !backDecoder(); k++) await new Promise(r => setImmediate(r));
  const d = backDecoder();
  assert.ok(d, 'the refill behind the playhead started');
  assert.ok(d.fed.length < 20, 'the seek comes while it is still decoding');
  const r = await st.seek(frameTime(5));
  assert.equal(r.index, 5);
  assert.equal(r.frame.timestamp, us(frameTime(5)));
  await st.settled();
  assert.ok(d.fed.length < 25, `the decode of 30–59 was given up: ${d.fed.length} chunks fed, 30 to reach frame 59`);
  assert.equal(d.state, 'closed');
  st.close(); src.close();
  assert.deepEqual(openBitmaps(fake), []);
  assert.deepEqual(openFrames(fake), []);
});

test('a step to a held frame returns before the refill does any work for it', async () => {
  // measured in headless Brave (s38's report): a refill started inside the step held a
  // 1080p step at a 150 ms tap rate for 23 ms while its frame was already held
  const { src, fake } = await open(H264);
  const st = await src.stepper(frameTime(45), { height: 36, maxFrames: 10 });
  await st.settled();
  // the forward decoder, paused, gets the frames of the chunks it was fed: they wait in its queue
  for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r));
  const made = fake.log.bitmaps.length, fed = fake.log.chunks.length;
  const r = await st.step(4);
  assert.equal(r.cached, true);
  // the caller's own continuation (drawing the frame) runs in microtasks: the refill waits for the next task
  for (let k = 0; k < 50; k++) await null;
  assert.equal(fake.log.bitmaps.length, made, 'no frame turned into a bitmap before the step returned');
  assert.equal(fake.log.chunks.length, fed, 'no chunk fed before the step returned');
  await st.settled();
  assert.ok(fake.log.bitmaps.length > made, 'the refill ran after it');
  st.close(); src.close();
});

test('an idle stepper with a full window holds at most 2 decoded frames beyond its budget (the paused forward decoder)', async () => {
  // s38's third audit: the forward stream, paused at a yield between steps, used
  // decodeFrames' default queues (4 frames waiting, 8 chunks fed), and the chunks
  // already fed still came out as frames: about 12 full-size VideoFrames held
  // outside maxBytes for as long as the user stays on a frame
  const idle = async () => { for (let k = 0; k < 20; k++) await new Promise(r => setImmediate(r)); await sleep(5); };
  for (const [at, maxFrames, steps] of [[10, 10, 0], [10, 20, 0], [20, 10, 6], [50, 20, 3]]) {
    const { src, fake } = await open(H264);
    const st = await src.stepper(frameTime(at), { height: 36, maxFrames });
    await st.settled();
    for (let k = 0; k < steps; k++) { await st.step(1); await st.settled(); }
    await idle();
    assert.equal(st.held, maxFrames, `the window is full (at ${at}, ${maxFrames} frames, ${steps} steps)`);
    assert.equal(openBitmaps(fake).length, st.held, 'the bitmaps open are the ones the stepper counts');
    const left = openFrames(fake).length;
    assert.ok(left <= 2, `${left} decoded frames open beyond the budget (at ${at}, ${maxFrames} frames, ${steps} steps)`);
    // and it still steps on from the paused decoder: no new keyframe for the next frames
    const decoders = fake.log.decoders.length;
    for (let k = 0; k < 3; k++) { await st.step(1); await st.settled(); }
    if (st.index < 89 && Math.floor(st.index / 30) === Math.floor((st.index + maxFrames) / 30)) {
      assert.equal(fake.log.decoders.length, decoders, 'stepping on inside a group reuses the paused decoder');
    }
    st.close(); src.close();
  }
  // the other callers keep decodeFrames' default queues: a range read with a
  // consumer that holds its first frame still decodes a few frames ahead of it
  const { src, fake } = await open(H264);
  const it = src.frames(0, 3)[Symbol.asyncIterator]();
  const first = await it.next();
  await idle();
  assert.ok(openFrames(fake).length > 3, `frames() runs ahead with the default queues (${openFrames(fake).length} open)`);
  first.value.close();
  await it.return();
  src.close();
});

test('close() closes every frame and stops the refill; the source\'s close() closes its steppers', async () => {
  const { src, fake, base } = await open(H264);
  const { MediaError } = await media();
  const st = await src.stepper(frameTime(45), { height: 36 });   // the refill is still running
  st.close();
  const fed = fake.log.chunks.length, made = fake.log.bitmaps.length;
  await sleep(30);
  assert.equal(fake.log.chunks.length, fed, 'no chunk fed after close()');
  assert.equal(fake.log.bitmaps.length, made, 'no frame kept after close()');
  assert.deepEqual(openBitmaps(fake), [], 'every frame it held is closed');
  assert.deepEqual(openFrames(fake), [], 'and every decoded frame on the way');
  assert.ok(fake.log.decoders.slice(base).every(d => d.state === 'closed'), 'its decoders are closed');
  await assert.rejects(st.step(1), e => e instanceof MediaError && e.code === 'closed');
  st.close();   // twice is fine

  const a = await src.stepper(0.5, { height: 36 });
  const b = await src.stepper(2.5, { height: 18, maxFrames: 30 });
  await a.step(1);
  src.close();
  await sleep(30);
  assert.deepEqual(openBitmaps(fake), []);
  assert.deepEqual(openFrames(fake), []);
  await assert.rejects(a.step(1), e => e.code === 'closed');
  await assert.rejects(b.step(-1), e => e.code === 'closed');
  await assert.rejects(src.stepper(1, { height: 36 }), e => e.code === 'closed');
});

test('the stepper\'s frames are upright and the size asked for, as thumbnails are', async () => {
  const { src, fake } = await open(ROT90);
  const st = await src.stepper(1, { height: 48 });
  assert.deepEqual([st.width, st.height], [27, 48], '54 × 96 upright, scaled to 48 high');
  assert.deepEqual([st.frame.width, st.frame.height], [27, 48]);
  await st.step(1);
  await st.settled();
  assert.ok(fake.log.bitmaps.length > 2);
  for (const b of fake.log.bitmaps) {
    assert.deepEqual([b.width, b.height], [27, 48]);
    assert.deepEqual(b.source, { width: 54, height: 96, rotated: 90 }, 'drawn from the turned frame, not the stored one');
  }
  st.close();
  const byWidth = await src.stepper(1, { width: 27 });
  assert.deepEqual([byWidth.width, byWidth.height], [27, 48], 'a width alone keeps the upright aspect');
  byWidth.close();
  src.close();

  const h = await open(H264);
  const both = await h.src.stepper(1, { width: 100, height: 20 });
  assert.deepEqual([both.frame.width, both.frame.height], [100, 20], 'both sides: the caller\'s');
  assert.deepEqual(both.frame.source, { width: 96, height: 54, rotated: 0 }, 'an upright file is not turned');
  both.close();
  await assert.rejects(h.src.stepper(1, {}), e => e.code === 'range', 'a size is needed');
  await assert.rejects(h.src.stepper(1, { height: 0 }), e => e.code === 'range');
  await assert.rejects(h.src.stepper(NaN, { height: 36 }), e => e.code === 'range');
  await assert.rejects(h.src.stepper(1, { height: 36 }).then(s => s.step(0.5)), e => e.code === 'range');
  h.src.close();
});

// decoders made in turn by `kinds` (the open's probe is the first), each a fake of its own
function sequenced(kinds) {
  const fakes = kinds.map(k => createFakeWebCodecs(k));
  let made = 0;
  const pick = () => fakes[Math.min(made, fakes.length - 1)];
  return {
    fakes,
    webcodecs: { ...fakes[0], createDecoder: init => { const f = pick(); made++; return f.createDecoder(init); }, rotate: (fr, r) => pick().rotate(fr, r), toBitmap: (fr, s) => fakes[0].toBitmap(fr, s) },
  };
}

test('a decoder error during a refill is the source\'s MediaError on the next step, and the step after decodes again', { timeout: 5000 }, async () => {
  const { openFrameSource, MediaError } = await media();
  // the probe's decoder is good, the refill's breaks on its 40th chunk, the ones after are good
  const { fakes, webcodecs } = sequenced([{}, { failOnChunk: 40 }, {}]);
  const src = await openFrameSource(clip(H264), { webcodecs, stallMs: 400 });
  const st = await src.stepper(frameTime(15), { height: 36 });
  await st.settled();
  assert.equal(fakes[1].log.decoders[0].state, 'closed', 'the refill\'s decoder failed');
  await assert.rejects(st.step(1), e => e instanceof MediaError && e.code === 'decode-failed');
  assert.equal(st.index, 15, 'the failed step did not move the playhead');
  const r = await st.step(1);
  assert.equal(r.index, 16);
  assert.equal(r.frame.timestamp, us(frameTime(16)));
  await st.settled();
  st.close(); src.close();
  for (const f of fakes) assert.deepEqual(openFrames(f), []);
});

test('a decoder that stalls during a refill is decode-stalled on the next step, never a hang', { timeout: 5000 }, async () => {
  const { openFrameSource, MediaError } = await media();
  // probe and the forward refill good; the refill of the group before stalls
  {
    const { fakes, webcodecs } = sequenced([{}, {}, { silent: true, hangFlush: true }]);
    const src = await openFrameSource(clip(H264), { webcodecs, stallMs: 150 });
    const st = await src.stepper(frameTime(45), { height: 36, maxFrames: 60 });
    await st.settled();
    assert.equal((await st.step(-1)).index, 44, 'a held frame; it starts the refill of the group before');
    const t0 = Date.now();
    await st.settled();
    await assert.rejects(st.step(-1), e => e instanceof MediaError && e.code === 'decode-stalled');
    assert.ok(Date.now() - t0 < 3000);
    st.close(); src.close();
    for (const f of fakes) assert.deepEqual(openFrames(f), []);
  }
  // a stepper waiting for its first frame on a decoder that stalls: rejected, not hung
  {
    const { webcodecs } = sequenced([{}, { silent: true, hangFlush: true }]);
    const src = await openFrameSource(clip(H264), { webcodecs, stallMs: 150 });
    await assert.rejects(src.stepper(1, { height: 36 }), e => e instanceof MediaError && e.code === 'decode-stalled');
    src.close();
  }
});

// ---- the frame source as the contract describes it --------------------------

test('the frames it hands out have the shape the contract says, in microseconds', async () => {
  const { src } = await open(H264);
  const [f] = await collect(src.frames(1, 1));
  assert.equal(f.timestamp, 1e6);
  assert.equal(f.displayWidth, src.info.width);
  assert.equal(f.displayHeight, src.info.height);
  assert.ok(Number.isInteger(f.timestamp) && Number.isInteger(f.duration));
  assert.ok(Math.abs(f.duration - 33333) <= 1);
  f.close(); src.close();
});

test('the decoder is configured from the file: its codec string, description and coded size', async () => {
  const { fake } = await open(H264);
  const config = fake.log.checked[0];
  assert.match(config.codec, /^avc1\./);
  assert.equal(config.codedWidth, 96);
  assert.equal(config.codedHeight, 54);
  assert.ok(config.description && config.description.byteLength > 0, 'the avcC record');
});

// ---- nothing else demuxes; the vendored library -----------------------------

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};

test('mediabunny is the only demuxer in the app, and only app/src/media/ imports it', () => {
  const sources = walk(path.join(ROOT, 'app', 'src')).filter(f => /\.(mjs|js)$/.test(f));
  for (const f of sources) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /mp4box|jswebm|web-demuxer|libav/i, `${path.relative(ROOT, f)} names another demuxer`);
    if (!f.startsWith(MEDIA)) assert.doesNotMatch(text, /(from|import\()\s*['"][^'"]*mediabunny/, `${path.relative(ROOT, f)} imports mediabunny outside media/`);
  }
  const app = fs.readFileSync(path.join(ROOT, 'app', 'package.json'), 'utf8');
  assert.doesNotMatch(app, /mp4box|mediabunny/, 'no demuxer as an npm dependency of the app: it is vendored');
});

const VENDOR = path.join(ROOT, 'app', 'vendor', 'mediabunny');

test('mediabunny is vendored pinned, with its licence, and carries no "Incompatible With Secondary Licenses" notice', () => {
  const lib = fs.readFileSync(path.join(VENDOR, 'mediabunny.mjs'), 'utf8');
  const licence = fs.readFileSync(path.join(VENDOR, 'LICENSE'), 'utf8');
  assert.match(licence, /^Mozilla Public License Version 2\.0/);
  // MPL-2.0 is AGPL-3.0-or-later compatible (§3.3, §1.12) unless a Source Code Form carries
  // the Exhibit B notice. The licence text itself quotes the notice as its template
  // (and in §1's definitions); what must not be there is a file that applies it.
  assert.match(licence, /Exhibit A - Source Code Form License Notice/);
  assert.doesNotMatch(lib, /Incompatible With Secondary Licenses/i);
  assert.match(lib.slice(0, 400), /Mozilla Public\s+\* License, v\. 2\.0/, 'the MPL header (Exhibit A) is the bundle\'s first comment');
  // the pin: THIRD_PARTY.md names version and SHA-256 of the file in the repo
  const row = fs.readFileSync(path.join(ROOT, 'THIRD_PARTY.md'), 'utf8').split('## In the new app (`app/`)')[1].split('\n## ')[0]
    .split('\n').find(l => /^\| mediabunny/.test(l));
  assert.ok(row, 'a mediabunny row in the new-app section');
  assert.match(row, /1\.61\.6/);
  assert.match(row, /MPL-2\.0/);
  assert.match(row, /app\/vendor\/mediabunny\//);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(VENDOR, 'mediabunny.mjs'))).digest('hex');
  assert.ok(row.includes(sha), 'the row has the SHA-256 of the vendored file');
});

test('the vendored file is the one npm ships: the spike\'s copy of the pinned version, when it is installed', t => {
  const spike = path.join(ROOT, 'spike', 'capture-check', 'node_modules', 'mediabunny');
  if (!fs.existsSync(spike)) return t.skip('spike/capture-check/node_modules is not installed in this worktree');
  assert.equal(JSON.parse(fs.readFileSync(path.join(spike, 'package.json'), 'utf8')).version, '1.61.6');
  assert.ok(fs.readFileSync(path.join(spike, 'dist', 'bundles', 'mediabunny.mjs')).equals(fs.readFileSync(path.join(VENDOR, 'mediabunny.mjs'))));
  assert.ok(fs.readFileSync(path.join(spike, 'LICENSE')).equals(fs.readFileSync(path.join(VENDOR, 'LICENSE'))));
});
