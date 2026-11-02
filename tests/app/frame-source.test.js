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
  // MPL-2.0 is GPL-3.0-or-later compatible (§3.3) unless a Source Code Form carries
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
