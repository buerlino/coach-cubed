'use strict';
// A1's player (package d16): the controller (app/src/ui/player.mjs) and its plain functions
// (player-model.mjs) on fakes: a <video> with requestVideoFrameCallback, s38's stepper from
// contract 5's example source, recording canvases. What is real: the stepper's contract (the
// example source), the committed lateral raise's track, smoothing, scoring and the engine's
// drawCue. What is fake: the video and the canvases. Expected values: the frame times from the
// example source (25 fps, 75 frames), the overlay from draw/ (pinned to the old page in
// draw.test.js), the labels from the mockup (design/mockups/Result.dc.html).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadDiagnostics } = require('../loadDiagnostics');
const { loadManifests, trackPathFor } = require('../fixtures');

const APP = path.resolve(__dirname, '..', '..', 'app');
const load = rel => import(pathToFileURL(path.join(APP, 'src', rel)).href);

const LATERAL = 'global/example/lateral-raise-cable-1';
const manifest = loadManifests();
const rawTrack = JSON.parse(fs.readFileSync(trackPathFor(LATERAL), 'utf8'));

function recordingContext(canvas) {
  const calls = [];
  const props = {};
  return new Proxy({}, {
    get(_, k) {
      if (k === 'canvas') return canvas;
      if (k === 'calls') return calls;
      if (typeof k === 'symbol' || k === 'then') return undefined;
      if (Object.prototype.hasOwnProperty.call(props, k)) return props[k];
      return (...args) => { calls.push([k, ...args]); };
    },
    set(_, k, v) { props[k] = v; return true; },
  });
}
function fakeCanvas() {
  const c = { width: 0, height: 0 };
  const ctx = recordingContext(c);
  c.getContext = () => ctx;
  c.ctx = ctx;
  return c;
}
class FakeVideo {
  constructor({ rvfc = true } = {}) {
    this.currentTime = 0; this.playbackRate = 1; this.paused = true; this.listeners = {}; this.cbs = []; this.n = 1; this.plays = 0;
    if (!rvfc) { this.requestVideoFrameCallback = undefined; this.cancelVideoFrameCallback = undefined; }
  }
  play() { this.paused = false; this.plays++; return Promise.resolve(); }
  pause() { this.paused = true; }
  requestVideoFrameCallback(fn) { const id = this.n++; this.cbs.push([id, fn]); return id; }
  cancelVideoFrameCallback(id) { this.cbs = this.cbs.filter(c => c[0] !== id); }
  present(mediaTime) { const cb = this.cbs.shift(); assert.ok(cb, 'a frame callback is waiting'); cb[1](0, { mediaTime }); }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); }
  fire(t) { for (const f of this.listeners[t] || []) f(); }
}
const geometry = calls => calls.filter(c => ['moveTo', 'lineTo', 'arc'].includes(c[0])).map(c => (c[0] === 'arc' ? ['arc', c[1], c[2]] : c));

// The lateral raise, smoothed and scored as A1 does, over contract 5's example source (25 fps, 75 frames, as the clip).
async function rig({ range = { t0: 0, t1: 2.96 }, flags = { skeleton: true, cues: true, loop: true }, rvfc = true, wrapStepper } = {}) {
  const [{ createPlayer }, { exampleFrameSource }, { scoreLift }, draw] = await Promise.all([load('ui/player.mjs'), load('contracts/frame-source.mjs'), load('scoring/score.mjs'), load('draw/index.mjs')]);
  const { smoothKeypoints } = await load('track/smoothing.mjs');
  const D = loadDiagnostics();
  const { view, computed } = scoreLift(rawTrack, 'lateral-raise', { Diagnostics: D, sigmaMs: 50 });
  const keypoints = smoothKeypoints(rawTrack.keypoints, rawTrack.meta, 0.05, true);
  const src = exampleFrameSource();
  let stepper = await src.stepper(range.t0, { height: 360 });
  if (wrapStepper) stepper = wrapStepper(stepper);
  const video = new FakeVideo({ rvfc }), frame = fakeCanvas(), overlay = fakeCanvas();
  const scene = { track: draw.trackSamples(keypoints, rawTrack.meta), meta: rawTrack.meta, Diagnostics: D, view, computed };
  const changes = [], errors = [];
  const rafs = [];
  const style = draw.overlayStyle(() => '2px');
  const player = createPlayer({
    video, frame, overlay, stepper, frameTimes: src.frameTimes, range, scene, style: () => style, flags: () => flags,
    onChange: s => changes.push(s), onError: e => errors.push(e),
    raf: fn => rafs.push(fn), caf: () => {},
  });
  const expectOverlay = t => {
    const c = fakeCanvas(); c.width = rawTrack.meta.width; c.height = rawTrack.meta.height;
    draw.paintOverlay(c.ctx, scene, t, { skeleton: flags.skeleton, cues: flags.cues, style });
    return c.ctx.calls;
  };
  return { player, video, frame, overlay, stepper, src, scene, changes, errors, rafs, flags, expectOverlay, draw, view };
}
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m || ''} ${a} vs ${b}`);

// ---- stepping ----

test('player: a step shows the next frame and paints the overlay on exactly that frame\'s time', async () => {
  const r = await rig();
  await r.player.start();
  assert.equal(r.player.state.index, 0);
  await r.player.step(1);
  assert.equal(r.player.state.index, 1);
  near(r.player.state.t, 1 / 25);
  assert.ok(r.frame.ctx.calls.some(c => c[0] === 'drawImage'), 'the stepped frame is on the canvas');
  assert.equal(r.overlay.width, 1080, 'the overlay has the track\'s frame size');
  assert.equal(r.overlay.height, 1920);
  assert.deepStrictEqual(r.overlay.ctx.calls.slice(-r.expectOverlay(1 / 25).length), r.expectOverlay(1 / 25));
  await r.player.step(1);
  await r.player.step(-1);
  assert.equal(r.player.state.index, 1, '+1, +1, -1 lands one frame on');
  assert.deepStrictEqual(r.overlay.ctx.calls.slice(-r.expectOverlay(1 / 25).length), r.expectOverlay(1 / 25));
  assert.deepEqual(r.errors, []);
});

test('player: steps stop at the marked range\'s first and last frame', async () => {
  const r = await rig({ range: { t0: 0.4, t1: 1.2 } });
  assert.deepEqual(r.player.bounds, { first: 10, last: 30 });
  await r.player.start();
  assert.equal(r.player.state.index, 10);
  await r.player.step(-1);
  assert.equal(r.player.state.index, 10, 'held at the first frame');
  for (let i = 0; i < 25; i++) await r.player.step(1);
  assert.equal(r.player.state.index, 30, 'held at the last frame');
  await r.player.step(1);
  assert.equal(r.player.state.index, 30);
  assert.deepEqual(r.errors, []);
});

test('player: the skeleton and the cue drawings can each be left off, and repaint follows a change', async () => {
  const r = await rig();
  await r.player.seek(2.24);
  const t = r.player.state.t;
  assert.ok(geometry(r.overlay.ctx.calls).length > 0);
  r.flags.skeleton = false;
  const n = r.overlay.ctx.calls.length;
  r.player.repaint();
  const after = r.overlay.ctx.calls.slice(n);
  assert.equal(after[0][0], 'clearRect');
  assert.deepStrictEqual(after, r.expectOverlay(t));
  r.flags.skeleton = true;
  assert.ok(after.length < r.expectOverlay(t).length, 'the skeleton is what is missing');
  r.flags.skeleton = false;
  assert.ok(after.some(c => c[0] === 'moveTo'), 'the cue drawings are still there');
  r.flags.skeleton = false;
  r.flags.skeleton = true;
  r.flags.cues = false;
  const m = r.overlay.ctx.calls.length;
  r.player.repaint();
  assert.deepStrictEqual(r.overlay.ctx.calls.slice(m), r.expectOverlay(t));
});

test('player: the newest seek wins when several are asked while the stepper is busy', async () => {
  const slow = [];
  const r = await rig({ wrapStepper: s => ({ ...s, get index() { return s.index; }, seek: t => new Promise(res => slow.push(() => res(s.seek(t)))), step: d => s.step(d) }) });
  const a = r.player.seek(0.4), b = r.player.seek(1.2), c = r.player.seek(2.0);
  for (let i = 0; i < 20 && slow.length < 1; i++) await new Promise(res => setImmediate(res));
  while (slow.length) { slow.shift()(); await new Promise(res => setImmediate(res)); }
  await Promise.all([a, b, c]);
  near(r.player.state.t, 2.0);
  assert.deepEqual(r.errors, []);
});

// ---- playing ----

test('player: play runs the video from the playhead; the overlay is painted from the frame the video shows (its mediaTime), not currentTime', async () => {
  const r = await rig();
  await r.player.start();
  await r.player.step(1); await r.player.step(1);
  await r.player.play();
  assert.equal(r.video.paused, false);
  near(r.video.currentTime, 2 / 25, 'plays from the frame shown');
  assert.equal(r.player.state.playing, true);
  assert.equal(r.player.state.live, false, 'the stepped frame stays until the video shows one');
  r.video.currentTime = 99;                    // the media clock has run on; the frame shown is what the callback names
  const n = r.overlay.ctx.calls.length;
  r.video.present(10 / 25);
  assert.deepStrictEqual(r.overlay.ctx.calls.slice(n), r.expectOverlay(10 / 25));
  near(r.player.state.t, 10 / 25);
  assert.equal(r.player.state.index, 10);
  assert.equal(r.player.state.live, true);
  r.video.present(11 / 25 - 0.0004);           // a rounded media time still names frame 11
  assert.equal(r.player.state.index, 11);
  assert.equal(r.video.cbs.length, 1, 'one callback waits for the next frame');
});

test('player: pause stops the video and shows the frame it presented last, from the stepper, then a step goes on from it', async () => {
  const r = await rig();
  await r.player.start();
  await r.player.play();
  r.video.present(7 / 25);
  r.video.currentTime = 7 / 25 + 0.03;         // the clock is ahead of the frame shown
  await r.player.pause();
  assert.equal(r.video.paused, true);
  assert.equal(r.video.cbs.length, 0, 'no callback left');
  assert.equal(r.player.state.playing, false);
  assert.equal(r.player.state.live, false);
  assert.equal(r.player.state.index, 7);
  assert.deepStrictEqual(r.overlay.ctx.calls.slice(-r.expectOverlay(7 / 25).length), r.expectOverlay(7 / 25));
  await r.player.step(1);
  assert.equal(r.player.state.index, 8);
});

test('player: a step while playing pauses on the frame shown first, then steps one', async () => {
  const r = await rig();
  await r.player.start();
  await r.player.play();
  r.video.present(20 / 25);
  await r.player.step(-1);
  assert.equal(r.video.paused, true);
  assert.equal(r.player.state.index, 19);
});

test('player: speed is the video\'s playback rate, kept across plays', async () => {
  const r = await rig();
  r.player.setSpeed(0.25);
  assert.equal(r.video.playbackRate, 0.25);
  await r.player.play();
  assert.equal(r.video.playbackRate, 0.25);
  assert.equal(r.player.state.speed, 0.25);
});

test('player: at the range\'s end it wraps when looping and stops on the last frame when not; play from the end starts over', async () => {
  const r = await rig({ range: { t0: 0.4, t1: 1.2 } });
  await r.player.start();
  await r.player.play();
  r.video.present(30 / 25);
  r.video.present(31 / 25);                    // past the last frame of the range
  near(r.video.currentTime, 0.4, 'back to the start');
  assert.equal(r.player.state.playing, true);
  assert.equal(r.video.cbs.length, 1);
  r.video.paused = true;                       // an ended video has stopped itself
  r.video.fire('ended');
  assert.equal(r.video.cbs.length, 1, 'no second loop is started');
  assert.ok(r.video.plays >= 2, 'it plays again');

  const s = await rig({ range: { t0: 0.4, t1: 1.2 }, flags: { skeleton: true, cues: true, loop: false } });
  await s.player.start();
  await s.player.play();
  s.video.present(31 / 25);
  await s.player.pause().catch(() => {});
  for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res));
  assert.equal(s.player.state.playing, false);
  assert.equal(s.player.state.index, 30, 'stopped on the last frame');
  await s.player.play();
  near(s.video.currentTime, 0.4, 'play from the end starts at the first frame');
});

test('player: without requestVideoFrameCallback the overlay follows currentTime on animation frames', async () => {
  const r = await rig({ rvfc: false });
  await r.player.start();
  await r.player.play();
  assert.equal(r.rafs.length, 1);
  r.video.currentTime = 12 / 25;
  r.rafs.shift()();
  assert.equal(r.player.state.index, 12);
  assert.equal(r.rafs.length, 1, 'and asks for the next');
});

test('player: close stops the loop and the video; nothing is painted after it', async () => {
  const r = await rig();
  await r.player.play();
  r.player.close();
  assert.equal(r.video.paused, true);
  const n = r.overlay.ctx.calls.length;
  r.player.repaint();
  assert.equal(r.overlay.ctx.calls.length, n);
  assert.equal(r.video.listeners.ended.length, 0);
});

// ---- the plain functions ----

test('player model: speeds cycle 1×, ½×, ¼× as the mockup\'s button does', async () => {
  const m = await load('ui/player-model.mjs');
  assert.deepEqual(m.SPEEDS, [1, 0.5, 0.25]);
  assert.deepEqual([1, 0.5, 0.25].map(m.speedLabel), ['1×', '½×', '¼×']);
  assert.deepEqual([1, 0.5, 0.25].map(m.nextSpeed), [0.5, 0.25, 1]);
  assert.equal(m.nextSpeed(7), 1);
});

test('player model: header, clock and window label are the mockup\'s ("Today 14:27 · 3.0 s", "2.24 / 3.00 s", "lift 1.16–2.96 s")', async () => {
  const m = await load('ui/player-model.mjs');
  const created = new Date(2026, 10, 2, 14, 27, 5);
  const lift = { lift: 'lateral-raise', created: created.toISOString(), range: { t0: 0.4, t1: 3.4 } };
  assert.deepEqual(m.headerOf(lift, new Date(2026, 10, 2, 20, 0)), { title: 'Lateral raise', provisional: false, meta: 'Today 14:27 · 3.0 s' });
  assert.equal(m.headerOf(lift, new Date(2026, 10, 3, 9, 0)).meta, 'Mon 2 Nov 14:27 · 3.0 s');
  assert.deepEqual(m.clockOf(2.64, lift.range), { now: '2.24', total: '3.00' });
  assert.equal(m.clockOf(-5, lift.range).now, '0.00');
  assert.equal(m.clockOf(99, lift.range).now, '3.00');
  assert.equal(m.windowLabel({ liftWindow: { t0: 1.56, t1: 3.36 } }, lift.range), 'lift 1.16–2.96 s');
  assert.equal(m.windowLabel({ liftWindow: { t0: 1.56, t1: null } }, lift.range), 'lift starts 1.16 s, no end found');
  assert.equal(m.windowLabel({ liftWindow: null }, lift.range), null);
  assert.equal(m.momentTitle({ title: 'Elbow lead — wrist rises above elbow' }), 'Elbow lead: worst moment');
});

test('player model: the range\'s frames, steps held at its ends and a drag on the timeline', async () => {
  const m = await load('ui/player-model.mjs');
  const times = Array.from({ length: 75 }, (_, i) => i / 25);
  assert.deepEqual(m.framesOfRange(times, { t0: 0.4, t1: 1.2 }), { first: 10, last: 30 });
  assert.deepEqual(m.framesOfRange(times, { t0: 0.41, t1: 1.19 }), { first: 11, last: 29 }, 'only frames inside the range');
  assert.deepEqual(m.framesOfRange(times, { t0: 0, t1: 99 }), { first: 0, last: 74 });
  const b = { first: 10, last: 30 };
  assert.deepEqual([[10, -1], [10, 1], [30, 1], [20, -3]].map(([i, d]) => m.stepTarget(i, d, b)), [10, 11, 30, 17]);
  const rect = { left: 16, width: 200 };
  const range = { t0: 0.4, t1: 3.4 };
  near(m.timeAtPointer(116, rect, range), 1.9);
  near(m.timeAtPointer(-50, rect, range), 0.4);
  near(m.timeAtPointer(999, rect, range), 3.4);
  assert.equal(m.timeAtPointer(5, { left: 0, width: 0 }, range), 0.4);
  near(m.fractionAt(1.9, range), 0.5);
});

test('player: a refused video.play() leaves the player paused on the stepped frame and reports one error', async () => {
  const r = await rig();
  await r.player.start();
  await r.player.step(2);
  const t = r.player.state.t;
  r.video.play = () => Promise.reject(new Error('NotAllowedError'));
  await r.player.play();
  assert.equal(r.player.state.playing, false, 'not "playing" over a frozen frame');
  assert.equal(r.player.state.live, false, 'the stepped frame stays shown');
  assert.equal(r.errors.length, 1);
  near(r.player.state.t, t);
  assert.equal(r.video.cbs.length, 0, 'no frame callback is left waiting');
  assert.equal(r.changes.at(-1).playing, false, 'the screen was told');
  await r.player.step(1);   // and the player still works
  assert.equal(r.player.state.index, 3);
});

test('player: a refused video.play() when the loop restarts stops playing, with one error', async () => {
  const r = await rig();
  await r.player.start();
  await r.player.play();
  r.video.present(0.04);
  r.video.paused = true;   // an ended video has stopped by itself
  r.video.play = () => Promise.reject(new Error('NotAllowedError'));
  r.video.fire('ended');
  await new Promise(res => setTimeout(res, 10));
  assert.equal(r.player.state.playing, false);
  assert.equal(r.player.state.live, false);
  assert.equal(r.errors.length, 1);
});

test('d46 player: playFrom(t) shows the frame at t and plays from there at the speed the player was given', async () => {
  const r = await rig();
  r.player.setSpeed(0.5);
  await r.player.playFrom(1.16);
  assert.equal(r.player.state.playing, true);
  assert.equal(r.player.state.speed, 0.5);
  assert.equal(r.video.playbackRate, 0.5);
  near(r.video.currentTime, 29 / 25, 'the frame at 1.16 s is frame 29 of the 25 fps source');
  assert.equal(r.video.plays, 1);
});

test('d46 player model: ½× is the speed list\'s second entry, and the request\'s speed does not move the list', async () => {
  const m = await load('ui/player-model.mjs');
  assert.equal(m.HALF_SPEED, 0.5);
  assert.equal(m.SPEEDS[1], m.HALF_SPEED);
  assert.equal(m.speedLabel(m.HALF_SPEED), '½×');
});
