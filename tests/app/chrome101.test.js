// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// c65: Chrome 101's fallbacks. The Samsung S8+ (c60) has Chrome 101 as its browser and its WebView, and it stays at 101.
// The Chrome versions named here are from memory and MDN, not measured: c60 checks each one on the phone with the probe
// (app/debug/compat.mjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createFakeWebCodecs } = require('./fake-webcodecs');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const load = (...p) => import(pathToFileURL(path.join(APP, ...p)).href);

// ---- the decode loop without the decoder's `dequeue` event (Chrome 106) ---------------------------------------------
//
// decode.mjs fed the next chunk when `dequeue` or an output woke the loop. The stepper's stream (STREAM_QUEUES: one
// chunk fed at a time) on a decoder that holds B-frames back waited for an output that never came: 0 frames and
// decode-stalled after stallMs.

const CONFIG = { codec: 'avc1.64001f', codedWidth: 96, codedHeight: 54 };
// 30 chunks, a key one first, 1/30 s apart (the fake outputs them in timestamp order)
async function* thirtyChunks() {
  for (let i = 0; i < 30; i++) yield { type: i === 0 ? 'key' : 'delta', timestamp: Math.round(i * 1e6 / 30), duration: 33333, data: new Uint8Array(4) };
}
async function decodeAll(fakeOptions, queues) {
  const { decodeFrames } = await load('src', 'media', 'decode.mjs');
  const fake = createFakeWebCodecs({ reorder: 3, ...fakeOptions });
  const got = [];
  let error = null;
  try {
    for await (const f of decodeFrames({ webcodecs: fake, config: CONFIG, chunks: thirtyChunks(), wants: () => true, stallMs: 400, ...queues })) {
      got.push(f.timestamp);
      f.close();
    }
  } catch (e) { error = e; }
  return { got, error, fake };
}

test('c65: the fake decoder without dequeue (Chrome before 106) fires no event and has no ondequeue; with it, it has both', () => {
  const plain = createFakeWebCodecs().createDecoder({ output() {}, error() {} });
  assert.ok('ondequeue' in plain, 'Chrome 106+ has VideoDecoder.prototype.ondequeue');
  const old = createFakeWebCodecs({ dequeue: false }).createDecoder({ output() {}, error() {} });
  assert.ok(!('ondequeue' in old));
});

test('c65: the stepper\'s queues (one chunk fed, one frame waiting) get every frame from a decoder with no dequeue event, B-frames held back', { timeout: 10000 }, async () => {
  const { STREAM_QUEUES } = await load('src', 'media', 'stepper.mjs');
  assert.deepEqual({ ...STREAM_QUEUES }, { maxQueued: 1, maxQueueSize: 1 });
  for (const dequeue of [false, true]) {
    const { got, error, fake } = await decodeAll({ dequeue }, STREAM_QUEUES);
    assert.equal(error, null, `dequeue ${dequeue}: ${error && error.code}`);
    assert.deepEqual(got, Array.from({ length: 30 }, (_, i) => Math.round(i * 1e6 / 30)), `dequeue ${dequeue}: all 30 frames in order`);
    assert.ok(fake.log.frames.every(f => f.closed));
  }
  // and the default queues (frameAt, frames(), thumbnails) too
  const { got, error } = await decodeAll({ dequeue: false }, {});
  assert.equal(error, null);
  assert.equal(got.length, 30);
});

test('c65: a stepper on a fake source with no dequeue event steps across the whole clip, no decode-stalled', { timeout: 20000 }, async () => {
  const fs = require('node:fs');
  const { openFrameSource } = await load('src', 'media', 'frame-source.mjs');
  const fake = createFakeWebCodecs({ dequeue: false });
  const blob = new Blob([fs.readFileSync(path.join(__dirname, 'clips', 'testsrc2-h264-30fps.mp4'))], { type: 'video/mp4' });
  const src = await openFrameSource(blob, { webcodecs: fake, stallMs: 400 });
  const st = await src.stepper(0, { height: 36, maxFrames: 20 });
  try {
    await st.settled();
    const seen = [];
    for (let k = 0; k < 89; k++) seen.push((await st.step(1)).index);
    assert.deepEqual(seen, Array.from({ length: 89 }, (_, k) => k + 1), 'frames 1 to 89, across both keyframes');
    for (let k = 0; k < 89; k++) await st.step(-1);
    assert.equal(st.index, 0, 'and back to frame 0');
  } finally { st.close(); src.close(); }
});

test('c65: where the decoder has the dequeue event, the loop runs no timer of its own but the stall\'s; without it, a short re-check while it waits', { timeout: 10000 }, async () => {
  const { DEQUEUE_POLL_MS } = await load('src', 'media', 'decode.mjs');
  assert.ok(DEQUEUE_POLL_MS > 0 && DEQUEUE_POLL_MS <= 10, 'a short re-check, never a busy loop');
  const real = globalThis.setInterval;
  const count = async dequeue => {
    let n = 0;
    globalThis.setInterval = (fn, ms, ...a) => { n++; assert.equal(ms, DEQUEUE_POLL_MS); return real(fn, ms, ...a); };
    try {
      const { got, error } = await decodeAll({ dequeue }, { maxQueued: 1, maxQueueSize: 1 });
      assert.equal(error, null);
      assert.equal(got.length, 30);
    } finally { globalThis.setInterval = real; }
    return n;
  };
  assert.equal(await count(true), 0, 'no re-check where the event exists');
  assert.ok(await count(false) > 0, 'the re-check runs where it does not');
});

// ---- the screen's height without dvh (Chrome 108) ------------------------------------------------------------------
//
// d62 keeps the height of a window-high screen in one token, --screen-h: calc(100dvh - var(--inset-top)). Chrome 101 has
// no dvh, and a 100vh line before a declaration holding var() doesn't help (such a declaration is invalid only when
// computed, and then falls back to `unset`), so the fallback is an @supports block after :root.

const fs = require('node:fs');
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('c65: tokens.css gives --screen-h a 100vh fallback where 100dvh is not supported, after the token, and nowhere else', () => {
  const css = stripComments(fs.readFileSync(path.join(APP, 'src', 'styles', 'tokens.css'), 'utf8'));
  const token = css.search(/--screen-h:\s*calc\(100dvh - var\(--inset-top\)\)\s*;/);
  assert.ok(token > 0, 'd62\'s token');
  const fallback = css.match(/@supports not \(height: 100dvh\) \{\s*:root \{\s*--screen-h:\s*calc\(100vh - var\(--inset-top\)\);\s*\}\s*\}/);
  assert.ok(fallback, 'the @supports fallback');
  assert.ok(fallback.index > token, 'after the token, so it wins where it applies');
  assert.equal([...css.matchAll(/@supports/g)].length, 1);
  assert.equal([...css.matchAll(/100vh/g)].length, 1, 'no other vh');
  // base.css keeps no dvh of its own (d62's test pins its var(--screen-h) uses); .licence's 50vh is plain vh, Chrome 20
  assert.doesNotMatch(stripComments(fs.readFileSync(path.join(APP, 'src', 'styles', 'base.css'), 'utf8')), /\d+dvh\b/);
});
