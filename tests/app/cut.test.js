'use strict';
// Keeping the lift's video (package s32, D6): the marked range cut to MP4 by
// mediabunny at Analyse, a stream copy from the keyframe at or before the start
// (app/src/media/cut.mjs), and keepVideo over the store (c8). Node has no
// decoder and needs none: the cut is checked against the source by its packets
// (bytes, types, times) read with the same demuxer, on s9's committed clips
// (tests/app/clips/; tests/README.md has the commands that made them).
//
// What the clips are: testsrc2, 96×54, 30 fps, 90 frames, H.264 with B-frames and
// a keyframe every 30 frames, so keyframes at 0 s, 1 s and 2 s. The expected
// numbers below are worked out here from the clips' packets, not from cut.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createFakeStorage } = require('./fake-opfs.js');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const CLIPS = path.join(__dirname, 'clips');
const load = rel => import(pathToFileURL(path.join(APP, rel)).href);
const clip = name => new Blob([fs.readFileSync(path.join(CLIPS, name))], { type: 'video/mp4' });

const H264 = 'testsrc2-h264-30fps.mp4';
const ROT90 = 'testsrc2-h264-30fps-rot90.mp4';
const VFR = 'testsrc2-h264-vfr.mp4';
const ENGINE = { model: 'movenet-thunder', backend: 'webgl', runtime: 'tfjs 4.22.0' };
const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

/** A video read with mediabunny: its packets with data (decode order), decoder config, rotation, size. */
async function read(blob) {
  const mb = await load('vendor/mediabunny/mediabunny.mjs');
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const sink = new mb.EncodedPacketSink(track);
  const packets = [];
  for await (const p of sink.packets()) packets.push({ type: p.type, timestamp: p.timestamp, duration: p.duration, data: Buffer.from(p.data) });
  const config = await track.getDecoderConfig();
  const out = {
    packets, rotation: await track.getRotation(), codec: track.codec,
    config: { codec: config.codec, w: config.codedWidth, h: config.codedHeight, description: Buffer.from(config.description || []) },
  };
  input.dispose();
  return out;
}
/**
 * The packets a cut of [t0, t1] must hold, worked out from the source alone: from the
 * last key packet starting at or before t0 to the latest-stored of the frames starting
 * in [t0, t1] (B-frames are stored after a picture shown later).
 */
function expectedPackets(src, t0, t1) {
  const origin = Math.min(...src.packets.map(p => p.timestamp));
  const t = p => p.timestamp - origin;
  const wanted = src.packets.map((p, d) => ({ d, ts: t(p) })).filter(x => x.ts >= t0 - 1e-6 && x.ts <= t1 + 1e-6);
  const key = Math.max(...src.packets.map((p, d) => (p.type === 'key' && t(p) <= t0 + 1e-6 ? d : -1)));
  const last = Math.max(...wanted.map(x => x.d));
  return { packets: src.packets.slice(key, last + 1), start: t(src.packets[key]), origin };
}

test('cut.mjs exists with cutVideo and keepVideo, and no encoder in it', async () => {
  const mod = await load('src/media/cut.mjs');
  assert.equal(typeof mod.cutVideo, 'function');
  assert.equal(typeof mod.keepVideo, 'function');
  // D6: a stream copy. Nothing in the module can re-encode.
  const src = fs.readFileSync(path.join(APP, 'src', 'media', 'cut.mjs'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\bVideoEncoder\b|\bVideoSampleSource\b|\bCanvasSource\b|\bConversion\b|\bforceTranscode\b|\bVideoDecoder\b/);
  assert.match(src, /\bEncodedVideoPacketSource\b/);
});

test('a cut of [1.2, 2.0] starts on the keyframe at 1.0 s and covers 2.0 s', async () => {
  const { cutVideo } = await load('src/media/cut.mjs');
  const src = await read(clip(H264));
  const cut = await cutVideo(clip(H264), { t0: 1.2, t1: 2.0 });
  const got = await read(cut.blob);
  const want = expectedPackets(src, 1.2, 2.0);
  assert.equal(want.start, 1);                       // the keyframe at or before 1.2 s
  assert.equal(got.packets[0].type, 'key');
  assert.equal(got.packets[0].timestamp, 0);         // the cut's first frame is its time 0
  assert.equal(cut.start, 1);                        // and that was 1.0 s in the source
  assert.deepEqual(got.packets[0].data, src.packets.find(p => p.type === 'key' && p.timestamp - want.origin === 1).data);
  const last = Math.max(...got.packets.map(p => p.timestamp));
  assert.ok(last >= 1.0 - 1e-6, `the cut ends at ${last} s but 2.0 s in the source is 1.0 s in the cut`);
  assert.equal(got.packets.length, want.packets.length);
});

test('stream copy, no re-encode: same codec config and the same samples from that keyframe', async () => {
  const { cutVideo } = await load('src/media/cut.mjs');
  const src = await read(clip(H264));
  for (const [t0, t1] of [[1.2, 2.0], [0.5, 0.9], [0, 2.9], [1.0, 1.0], [2.5, 2.9]]) {
    const cut = await cutVideo(clip(H264), { t0, t1 });
    const got = await read(cut.blob);
    const want = expectedPackets(src, t0, t1);
    assert.deepEqual(got.config, src.config, `[${t0}, ${t1}]: codec config`);
    assert.equal(got.codec, src.codec);
    assert.equal(got.packets.length, want.packets.length, `[${t0}, ${t1}]: packet count`);
    got.packets.forEach((p, i) => {
      const w = want.packets[i];
      assert.equal(p.type, w.type, `[${t0}, ${t1}] packet ${i}: type`);
      assert.deepEqual(p.data, w.data, `[${t0}, ${t1}] packet ${i}: bytes`);
      near(p.timestamp, w.timestamp - want.origin - want.start);
      near(p.duration, w.duration);
    });
  }
});

test('the cut\'s duration and where t0 sits inside it', async () => {
  const { cutVideo } = await load('src/media/cut.mjs');
  const cut = await cutVideo(clip(H264), { t0: 1.2, t1: 2.0 });
  // frames 30 .. 60 at 30 fps (the next GOP's keyframe starts at 2.0 s, so it is covered): 31 frames
  near(cut.duration, 31 / 30);
  near(cut.range.t0, 0.2);                           // t0 is 0.2 s after the keyframe
  near(cut.range.t1, 1.0);
  const got = await read(cut.blob);
  const ends = got.packets.map(p => p.timestamp + p.duration);
  near(Math.max(...ends), cut.duration);
  // on a keyframe exactly: no offset
  const on = await cutVideo(clip(H264), { t0: 1.0, t1: 1.5 });
  near(on.range.t0, 0);
  assert.equal(on.start, 1);
  // a range past the end is held to the video's span, not refused
  const over = await cutVideo(clip(H264), { t0: 2.5, t1: 99 });
  near(over.range.t0, 0.5);
  near(over.range.t1, 1.0);
});

test('the rotation is kept', async () => {
  const { cutVideo } = await load('src/media/cut.mjs');
  const src = await read(clip(ROT90));
  assert.equal(src.rotation, 90);
  const cut = await cutVideo(clip(ROT90), { t0: 1.2, t1: 2.0 });
  const got = await read(cut.blob);
  assert.equal(got.rotation, 90);
  assert.deepEqual(got.config, src.config);
  const plain = await read((await cutVideo(clip(H264), { t0: 1.2, t1: 2.0 })).blob);
  assert.equal(plain.rotation, 0);
});

test('a variable frame rate keeps each frame\'s own time', async () => {
  const { cutVideo } = await load('src/media/cut.mjs');
  const src = await read(clip(VFR));
  const cut = await cutVideo(clip(VFR), { t0: 1.3, t1: 2.2 });
  const got = await read(cut.blob);
  const want = expectedPackets(src, 1.3, 2.2);
  assert.equal(got.packets.length, want.packets.length);
  got.packets.forEach((p, i) => {
    assert.deepEqual(p.data, want.packets[i].data);
    near(p.timestamp, want.packets[i].timestamp - want.origin - want.start);
  });
  near(cut.range.t0, 1.3 - want.start);
});

test('a range that is not a range, or not a video, is a MediaError', async () => {
  const { cutVideo } = await load('src/media/cut.mjs');
  const { MediaError } = await load('src/media/media-error.mjs');
  for (const r of [{ t0: 2, t1: 1 }, { t0: NaN, t1: 1 }, { t0: 0 }, { t0: -5, t1: -1 }, { t0: 50, t1: 60 }, null]) {
    await assert.rejects(() => cutVideo(clip(H264), r), e => e instanceof MediaError && e.code === 'range', JSON.stringify(r));
  }
  await assert.rejects(() => cutVideo(new Blob([Uint8Array.from([1, 2, 3, 4])]), { t0: 0, t1: 1 }),
    e => e instanceof MediaError && e.code === 'unreadable');
  await assert.rejects(() => cutVideo('not a blob', { t0: 0, t1: 1 }), TypeError);
});

async function setup(opts = {}) {
  const { createStore } = await load('src/store/index.mjs');
  const fake = createFakeStorage(opts.fake);
  const store = createStore({ storage: fake.storage, now: () => new Date('2026-11-01T17:42:05.120Z'), appVersion: '0.1.0' });
  return { store, fake };
}

test('keepVideo writes the cut into the lift\'s folder and returns the range in the cut\'s timeline', async () => {
  const { keepVideo, cutVideo } = await load('src/media/cut.mjs');
  const { validateStoredLift, liftPaths } = await load('src/contracts/stored-lift.mjs');
  const { store } = await setup();
  const kept = await keepVideo(store, 'snatch', clip(H264), { t0: 1.2, t1: 2.0 });
  near(kept.range.t0, 0.2);
  near(kept.range.t1, 1.0);
  // contract 3: the stored lift passes its validator, with the cut's path and the range in the cut's timeline
  assert.deepEqual(validateStoredLift(kept.lift), []);
  assert.equal(kept.lift.video, liftPaths(kept.lift.id).video);
  assert.match(kept.lift.video, /^lifts\/[^/]+\/cut\.mp4$/);
  assert.deepEqual(kept.lift.range, kept.range);
  assert.equal(kept.lift.lift, 'snatch');
  assert.equal(kept.lift.track, null);
  assert.deepEqual(await store.getLift(kept.lift.id), kept.lift);
  // the stored file is the cut: it reads back as an MP4 with the source's samples
  const stored = await store.readVideo(kept.lift.id);
  const got = await read(stored);
  const direct = await read((await cutVideo(clip(H264), { t0: 1.2, t1: 2.0 })).blob);
  assert.deepEqual(got.packets.map(p => p.data), direct.packets.map(p => p.data));
  assert.ok(stored.size < clip(H264).size);
  // and the job can complete it later, the range unchanged
  const { trackFromFrames, appTrackMeta } = await load('src/contracts/track.mjs');
  const { KEYPOINTS_EXAMPLE } = await load('src/contracts/keypoints.mjs');
  const { RESULT_VIEW_EXAMPLE } = await load('src/contracts/cue-view.mjs');
  const frames = [0, 1].map(i => ({ index: i, tMs: i * 1000 / 30, keypoints: KEYPOINTS_EXAMPLE }));
  const track = trackFromFrames(frames, appTrackMeta({ fps: 30, frameCount: 2, width: 96, height: 54 }));
  const done = await store.updateLift(kept.lift.id, { track, result: RESULT_VIEW_EXAMPLE, engine: ENGINE });
  assert.deepEqual(validateStoredLift(done), []);
  assert.deepEqual(done.range, kept.range);
});

test('a mark one ulp short of a keyframe keeps range.t0 at 0, and the lift passes the validator', async () => {
  const { keepVideo, cutVideo } = await load('src/media/cut.mjs');
  const { validateStoredLift } = await load('src/contracts/stored-lift.mjs');
  // the sample table accepts a time 1 µs short of a frame, so this starts on the keyframe at 1 s
  const range = { t0: 1 - Number.EPSILON / 2, t1: 2.0 };
  const cut = await cutVideo(clip(H264), range);
  assert.equal(cut.start, 1);
  assert.equal(cut.range.t0, 0);
  const { store } = await setup();
  const kept = await keepVideo(store, 'snatch', clip(H264), range);
  assert.equal(kept.range.t0, 0);
  assert.deepEqual(validateStoredLift(kept.lift), []);
  assert.deepEqual(kept.lift.range, kept.range);
});

test('"storage full" from the store passes through, and nothing half-saved stays', async () => {
  const { keepVideo } = await load('src/media/cut.mjs');
  const { StoreError, isStorageFull } = await load('src/store/index.mjs');
  const { store, fake } = await setup({ fake: { quota: 1000 } });
  const err = await keepVideo(store, 'lateral-raise', clip(H264), { t0: 0, t1: 2.9 }).then(() => null, e => e);
  assert.ok(err instanceof StoreError, String(err));
  assert.equal(err.code, 'storage-full');
  assert.ok(isStorageFull(err));
  assert.deepEqual(await store.listLifts(), []);
  assert.ok((await fake.storage.estimate()).usage <= 1000);
});

test('keepVideo refuses what the store would: a lift it does not know', async () => {
  const { keepVideo } = await load('src/media/cut.mjs');
  const { store } = await setup();
  await assert.rejects(() => keepVideo(store, 'deadlift', clip(H264), { t0: 0, t1: 1 }), { code: 'invalid' });
  assert.deepEqual(await store.listLifts(), []);
});

test('the frame source\'s sample table reads the cut as the source\'s frames from the keyframe, from 0', async () => {
  const { cutVideo } = await load('src/media/cut.mjs');
  const { buildSampleTable } = await load('src/media/sample-table.mjs');
  const tableOf = async blob => buildSampleTable((await read(blob)).packets.map(({ type, timestamp, duration }) => ({ type, timestamp, duration })));
  const whole = await tableOf(clip(VFR));
  const cut = await cutVideo(clip(VFR), { t0: 1.3, t1: 2.2 });
  const part = await tableOf(cut.blob);
  const shifted = whole.times.map(t => t - cut.start);
  const has = (times, t) => times.some(x => Math.abs(x - t) < 1e-5);
  // every frame of the cut is a frame of the source, and every source frame from the keyframe to t1 is in the cut
  // (beyond t1 the cut may hold a later picture a shown-earlier one was predicted from, and not the ones between)
  part.times.forEach(t => assert.ok(has(shifted, t), `${t} s is not a source frame`));
  shifted.filter(t => t > -1e-6 && t <= 2.2 - cut.start + 1e-6).forEach(t => assert.ok(has(part.times, t), `${t} s is missing`));
  near(part.times[0], 0);
  assert.ok(part.times.at(-1) >= 2.2 - cut.start - 1e-6, 't1 is covered');
});

test('an HEVC file is cut too: nothing is decoded, so the WebView\'s decoders do not matter', async () => {
  const { cutVideo } = await load('src/media/cut.mjs');
  const src = await read(clip('testsrc2-hevc-30fps.mp4'));
  const got = await read((await cutVideo(clip('testsrc2-hevc-30fps.mp4'), { t0: 1.2, t1: 2.0 })).blob);
  assert.deepEqual(got.config, src.config);
  assert.equal(got.codec, 'hevc');
  assert.equal(got.packets[0].type, 'key');
});
