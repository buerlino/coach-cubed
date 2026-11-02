'use strict';
// A3, view options (package d22): app/src/ui/view-options-model.mjs, the plain module the sheet (components/view-options.mjs)
// draws, and the two changes it needs in the player (loop inside the lift window, a new scene after a re-score) and
// in the overlay (unsure joints). What is real: the store (createStore on the in-memory OPFS), the scoring adapter
// (scoreLift on the committed lateral raise track), the flow, the player on contract 5's example source and M's
// model. What is fake: the <video> and the canvases. Expected strings: design/mockups/ViewOptions.dc.html; expected
// numbers: the adapter's own output for the same track and σ (never typed here).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadDiagnostics } = require('../loadDiagnostics');
const { loadManifests, trackPathFor } = require('../fixtures');
const { createFakeStorage } = require('./fake-opfs');

const APP = path.resolve(__dirname, '..', '..', 'app');
const load = rel => import(pathToFileURL(path.join(APP, 'src', rel)).href);
const read = rel => fs.readFileSync(path.join(APP, 'src', rel), 'utf8');

const LATERAL = 'global/example/lateral-raise-cable-1';
const manifest = loadManifests();
const rawTrack = JSON.parse(fs.readFileSync(trackPathFor(LATERAL), 'utf8'));
const D = loadDiagnostics();
const ENGINE = { model: 'movenet-thunder', backend: 'webgl', runtime: 'tfjs 4.22.0' };
const RANGE = { t0: 0, t1: 2.96 };

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
  constructor() { this.currentTime = 0; this.playbackRate = 1; this.paused = true; this.listeners = {}; this.cbs = []; this.n = 1; this.plays = 0; }
  play() { this.paused = false; this.plays++; return Promise.resolve(); }
  pause() { this.paused = true; }
  requestVideoFrameCallback(fn) { const id = this.n++; this.cbs.push([id, fn]); return id; }
  cancelVideoFrameCallback(id) { this.cbs = this.cbs.filter(c => c[0] !== id); }
  present(mediaTime) { const cb = this.cbs.shift(); assert.ok(cb, 'a frame callback is waiting'); cb[1](0, { mediaTime }); }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); }
}
const geometry = calls => calls.filter(c => ['moveTo', 'lineTo', 'arc'].includes(c[0])).map(c => (c[0] === 'arc' ? ['arc', c[1], c[2]] : c));
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m || ''} ${a} vs ${b}`);

// A stored, analysed lateral raise (σ 50, the app's default), a player over it, and A3's controller.
async function rig({ range = RANGE, flowState = 'result', extra = {} } = {}) {
  const [{ createPlayer }, { exampleFrameSource }, { scoreLift }, draw, { createStore }, { createFlow }, vo, { smoothKeypoints }] = await Promise.all([
    load('ui/player.mjs'), load('contracts/frame-source.mjs'), load('scoring/score.mjs'), load('draw/index.mjs'),
    load('store/index.mjs'), load('flow/flow.mjs'), load('ui/view-options-model.mjs'), load('track/smoothing.mjs'),
  ]);
  const fake = createFakeStorage();
  const store = createStore({ storage: fake.storage, now: () => new Date('2026-11-01T17:42:05.120Z'), appVersion: '0.1.0' });
  const first = scoreLift(rawTrack, 'lateral-raise', { Diagnostics: D, sigmaMs: 50 });
  const video = new Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'video/mp4' });
  const rec = await store.saveLift({ lift: 'lateral-raise', video, range, track: rawTrack, result: first.view, engine: ENGINE });
  const src = exampleFrameSource();
  const stepper = await src.stepper(range.t0, { height: 360 });
  const vid = new FakeVideo(), frame = fakeCanvas(), overlay = fakeCanvas();
  const scene = { track: draw.trackSamples(first.keypoints, rawTrack.meta), meta: rawTrack.meta, Diagnostics: D, view: first.view, computed: first.computed };
  const flags = { skeleton: true, cues: true, unsure: false, loop: true };
  const style = { ...draw.overlayStyle(() => '2px'), unsure: draw.unsureStyle(() => '2px') };
  const errors = [];
  const player = createPlayer({
    video: vid, frame, overlay, stepper, frameTimes: src.frameTimes, range, scene, style: () => style, flags: () => flags,
    lift: vo.loopSpan(first.view, range), onError: e => errors.push(e), raf: () => 1, caf: () => {},
  });
  const flow = createFlow(flowState);
  const scored = [];
  const calls = [];
  const spyStore = new Proxy(store, { get(t, k) { const v = t[k]; return typeof v === 'function' ? (...a) => { calls.push([k, ...a]); return v.apply(t, a); } : v; } });
  const score = (...a) => { calls.push(['score', ...a]); return scoreLift(...a); };
  const ctl = vo.createViewOptions({
    store: spyStore, rec, track: rawTrack, view: first.view, Diagnostics: D, flags, player, flow, score,
    onScored: s => scored.push(s), ...extra,
  });
  const expectOverlay = (t, f = flags, sc = scene) => {
    const c = fakeCanvas(); c.width = rawTrack.meta.width; c.height = rawTrack.meta.height;
    draw.paintOverlay(c.ctx, sc, t, { skeleton: f.skeleton, cues: f.cues, unsure: f.unsure, style });
    return c.ctx.calls;
  };
  return { vo, ctl, player, video: vid, overlay, frame, store, spyStore, calls, flow, flags, scene, rec, first, scored, scoreLift, draw, src, expectOverlay, errors, smoothKeypoints, fake };
}

// ---- the sheet's controls and strings (ViewOptions.dc.html) ----

test('view options: the sheet\'s controls and words are the mockup\'s; the lifter choice is not among them', async () => {
  const m = await load('ui/view-options-model.mjs');
  assert.deepEqual(m.SWITCHES.map(s => [s.key, s.label, s.sub]), [
    ['skeleton', 'Skeleton', 'The pose, joint by joint'],
    ['cues', 'Cue drawings', 'What each cue measures, like the elbow line'],
    ['unsure', 'Unsure joints', 'Joints the model was less than 30% sure of'],
    ['loop', 'Loop the lift only', 'Skip the walk-in and walk-out'],
  ]);
  assert.deepEqual(m.SPEED_BUTTONS.map(s => [s.value, s.label]), [[0.25, '¼×'], [0.5, '½×'], [1, '1×']]);
  assert.deepEqual({ ...m.SMOOTHING }, { min: 0, max: 300, step: 5, standard: 50 });
  assert.equal(m.TEXT.title, 'View options');
  assert.equal(m.TEXT.done, 'Done');
  assert.equal(m.TEXT.video, 'On the video');
  assert.equal(m.TEXT.speed, 'Playback speed');
  assert.equal(m.TEXT.advanced, 'Advanced');
  assert.equal(m.TEXT.smoothing, 'Smoothing');
  assert.equal(m.TEXT.smoothingNote, 'Changes the scores. The thresholds assume the default, 50 ms.');
  assert.equal(m.TEXT.remark, 'Re-mark this lift');
  assert.equal(m.TEXT.delete, 'Delete this lift');
  assert.equal(m.smoothingLabel(50), '50 ms');
  // the lifter stays hidden (MoveNet SinglePose tracks one person, app-plan.md "The pieces")
  const src = read('ui/components/view-options.mjs') + read('ui/view-options-model.mjs');
  assert.doesNotMatch(src, /Lifter|Person 1|brief detections/);
});

test('view options: the sheet is the component A1 opens from its "View options" button, and it is no longer disabled', () => {
  const a1 = read('ui/screens/A1.mjs');
  assert.match(a1, /ViewOptions/);
  assert.doesNotMatch(a1, /aria-label="View options" disabled/);
  const comp = read('ui/components/view-options.mjs');
  for (const w of ['TEXT.title', 'TEXT.done', 'TEXT.video', 'TEXT.speed', 'TEXT.advanced', 'TEXT.smoothing', 'TEXT.smoothingNote', 'TEXT.remark', 'TEXT.delete']) assert.ok(comp.includes(w), `the component draws ${w}`);
  assert.match(comp, /role="switch"/);
  assert.match(comp, /role="dialog"/);
  assert.match(comp, /type="range"/);
});

test('view options: colours, type and spacing come from the tokens only (no literal colour in app/src/ui/)', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(APP, 'src', 'ui'))) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /#[0-9a-fA-F]{3,8}\b/, f);
  const css = read('styles/base.css');
  const sheet = css.split('\n').filter(l => /^\.vo-|^\.sheet/.test(l)).join('\n');
  assert.ok(sheet.length > 0, 'base.css styles the sheet');
  assert.doesNotMatch(sheet, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});

// ---- each option's effect on the player's state ----

test('view options: Skeleton and Cue drawings switch the overlay the player paints, and are kept in the store\'s settings', async () => {
  const r = await rig();
  await r.player.seek(2.24);
  const t = r.player.state.t;
  await r.ctl.setSwitch('skeleton', false);
  assert.equal(r.flags.skeleton, false);
  assert.equal(r.ctl.state.skeleton, false);
  assert.deepStrictEqual(r.overlay.ctx.calls.slice(-r.expectOverlay(t).length), r.expectOverlay(t), 'repainted at once, on the frame shown');
  assert.ok(r.overlay.ctx.calls.some(c => c[0] === 'moveTo'), 'the cue drawings are still there');
  await r.ctl.setSwitch('cues', false);
  assert.equal(r.flags.cues, false);
  const n = r.overlay.ctx.calls.length;
  r.player.repaint();
  assert.deepStrictEqual(r.overlay.ctx.calls.slice(n), r.expectOverlay(t));
  assert.equal(geometry(r.overlay.ctx.calls.slice(n)).length, 0, 'nothing drawn with both off');
  assert.deepEqual(r.calls.filter(c => c[0] === 'saveSettings').map(c => c[1]), [{ view: { skeleton: false } }, { view: { cues: false } }]);
  const s = await r.store.getSettings();
  assert.equal(s.view.skeleton, false);
  assert.equal(s.view.cues, false);
});

test('view options: Unsure joints draws the joints below the confidence gate as rings, and only when on (default off)', async () => {
  const r = await rig();
  // a frame with one joint the model was unsure of
  const frames = Object.keys(r.scene.track.keypoints);
  const f0 = frames[0];
  const person = Object.keys(r.scene.track.keypoints[f0])[0];
  const pts = r.scene.track.keypoints[f0][person].map(p => (p ? [...p] : p));
  pts[10] = [500, 400, 0.1];
  assert.equal(r.ctl.state.unsure, false);
  const sure = r.draw.skeletonShapes(pts, r.draw.bonesOf(rawTrack.meta));
  assert.ok(!sure.joints.some(j => j[0] === 400 && j[1] === 500), 'the gate leaves it out');
  assert.deepStrictEqual(r.draw.unsureJoints(pts), [[400, 500]], 'unsureJoints names exactly the joint below the gate');
  assert.deepStrictEqual(r.draw.unsureJoints(pts.map(p => (p && p[2] < 0.3 ? null : p))), [], 'a missing joint is not unsure, it is missing');
  const ctx = recordingContext({ width: 1, height: 1 });
  r.draw.drawSkeleton(ctx, { 0: pts }, r.draw.bonesOf(rawTrack.meta), { ...r.draw.overlayStyle(() => '1px'), unsure: r.draw.unsureStyle(() => '1px') }, { unsure: true });
  const withIt = ctx.calls.filter(c => c[0] === 'arc').length;
  const ctx2 = recordingContext({ width: 1, height: 1 });
  r.draw.drawSkeleton(ctx2, { 0: pts }, r.draw.bonesOf(rawTrack.meta), { ...r.draw.overlayStyle(() => '1px'), unsure: r.draw.unsureStyle(() => '1px') });
  assert.equal(withIt, ctx2.calls.filter(c => c[0] === 'arc').length + 1, 'one more ring with the option on, none without');
  // through the controller: the player's overlay follows the flag
  await r.player.seek(2.24);
  const before = r.overlay.ctx.calls.length;
  await r.ctl.setSwitch('unsure', true);
  assert.equal(r.flags.unsure, true);
  assert.deepStrictEqual(r.overlay.ctx.calls.slice(before), r.expectOverlay(r.player.state.t));
  assert.equal((await r.store.getSettings()).view.unsure, true);
});

test('view options: speed is the player\'s playback rate and is kept; the buttons are the three speeds', async () => {
  const r = await rig();
  await r.ctl.setSpeed(0.5);
  assert.equal(r.player.state.speed, 0.5);
  assert.equal(r.video.playbackRate, 0.5);
  assert.equal(r.ctl.state.speed, 0.5);
  await r.ctl.setSpeed(0.25);
  assert.equal(r.player.state.speed, 0.25);
  assert.equal((await r.store.getSettings()).view.speed, 0.25);
  await assert.rejects(() => r.ctl.setSpeed(2));
  assert.equal(r.player.state.speed, 0.25, 'a speed the store has no value for changes nothing');
});

test('view options: the choices come back from the store as the controller\'s start (a new session reads settings.view)', async () => {
  const r = await rig();
  await r.ctl.setSwitch('loop', false);
  await r.ctl.setSpeed(0.5);
  await r.ctl.setSwitch('unsure', true);
  const settings = await r.store.getSettings();
  const again = r.vo.createViewOptions({ store: r.store, rec: r.rec, track: rawTrack, view: r.first.view, Diagnostics: D, flags: { ...r.flags }, player: r.player, flow: r.flow, settings: settings.view });
  assert.deepEqual({ ...again.state }, { ...r.ctl.state });
});

// ---- smoothing ----

test('view options: a smoothing change re-scores the stored track through the adapter and saves the new view with updateLift', async () => {
  const r = await rig();
  assert.equal(r.ctl.state.sigmaMs, 50, 'the slider starts at the σ the stored verdicts used');
  const out = await r.ctl.setSigma(120);
  const asked = r.calls.find(c => c[0] === 'score');
  assert.equal(asked[1], rawTrack, 'the stored raw track, not the smoothed one');
  assert.equal(asked[2], 'lateral-raise');
  assert.equal(asked[3].sigmaMs, 120);
  assert.equal(asked[3].keepVelocity, r.first.view.smoothing.keepVelocity);
  assert.equal(asked[3].Diagnostics, D);
  const expected = r.scoreLift(rawTrack, 'lateral-raise', { Diagnostics: D, sigmaMs: 120, keepVelocity: true });
  assert.deepStrictEqual(out.view, expected.view);
  const update = r.calls.find(c => c[0] === 'updateLift');
  assert.equal(update[1], r.rec.id);
  assert.deepStrictEqual(update[2], { result: expected.view });
  assert.equal(update[2].result.smoothing.sigmaMs, 120, 'the stored view says which σ its verdicts used');
  assert.deepStrictEqual(await r.store.readResult(r.rec.id), expected.view);
  assert.ok(r.calls.findIndex(c => c[0] === 'updateLift') > r.calls.findIndex(c => c[0] === 'score'));
  assert.equal(r.ctl.state.sigmaMs, 120);
  assert.equal((await r.store.getSettings()).view.smoothingSigmaMs, 120, 'later analyses use the choice too');
  assert.deepEqual(r.calls.filter(c => c[0] === 'saveSettings').map(c => c[1]), [{ view: { smoothingSigmaMs: 120 } }]);
  assert.equal(r.scored.length, 1);
  assert.deepStrictEqual(r.scored[0].view, expected.view, 'A1 gets the new view for its cards');
  // never silently: the σ is on the view as numbers and in the sheet, not in the notes
  const everyNote = [...expected.view.notes, ...expected.view.cues.flatMap(c => c.notes), expected.view.liftWindowReason].filter(Boolean);
  assert.ok(everyNote.every(n => !/\b120\b|σ|sigma|smooth/i.test(n)), 'the notes say nothing about σ');
});

test('view options: after a re-score the player paints the new smoothing\'s skeleton and cues', async () => {
  const r = await rig();
  await r.player.seek(2.24);
  const t = r.player.state.t;
  await r.ctl.setSigma(0);
  const raw = r.scoreLift(rawTrack, 'lateral-raise', { Diagnostics: D, sigmaMs: 0 });
  assert.equal(raw.keypoints, rawTrack.keypoints, 'σ 0 is the raw track');
  const scene = { track: r.draw.trackSamples(raw.keypoints, rawTrack.meta), meta: rawTrack.meta, Diagnostics: D, view: raw.view, computed: raw.computed };
  const n = r.overlay.ctx.calls.length;
  assert.deepStrictEqual(r.overlay.ctx.calls.slice(-r.expectOverlay(t, r.flags, scene).length), r.expectOverlay(t, r.flags, scene));
  assert.notDeepEqual(r.expectOverlay(t, r.flags, scene), r.expectOverlay(t), 'σ 0 and σ 50 draw different poses');
  assert.ok(r.overlay.ctx.calls.length >= n);
});

test('view options: a smoothing change that cannot be saved changes nothing and says so', async () => {
  const r = await rig();
  const asked = [];
  const failing = new Proxy(r.store, { get(t, k) { if (k === 'updateLift') return async () => { throw new Error('The phone is full.'); }; if (k === 'saveSettings') return (...a) => { asked.push(a); return t.saveSettings(...a); }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
  const ctl = r.vo.createViewOptions({ store: failing, rec: r.rec, track: rawTrack, view: r.first.view, Diagnostics: D, flags: r.flags, player: r.player, flow: r.flow, onScored: s => r.scored.push(s) });
  await ctl.setSigma(200);
  assert.equal(ctl.state.sigmaMs, 50, 'the slider goes back to the σ the stored verdicts used');
  assert.match(ctl.state.error, /full/);
  assert.equal(ctl.state.scoring, false);
  assert.equal(r.scored.length, 0);
  assert.deepEqual(asked, [], 'the choice is not kept either');
  assert.deepStrictEqual(await r.store.readResult(r.rec.id), r.first.view);
});

test('view options: the slider rounds to its step and stays in its range; a newer change wins over an older one', async () => {
  const r = await rig();
  const m = r.vo;
  assert.equal(m.sigmaChoice(52), 50);
  assert.equal(m.sigmaChoice(-10), 0);
  assert.equal(m.sigmaChoice(999), 300);
  assert.equal(m.sigmaChoice('80'), 80);
  const a = r.ctl.setSigma(100), b = r.ctl.setSigma(150);
  await Promise.all([a, b]);
  assert.equal(r.ctl.state.sigmaMs, 150);
  assert.equal((await r.store.readResult(r.rec.id)).smoothing.sigmaMs, 150);
  assert.equal((await r.store.getSettings()).view.smoothingSigmaMs, 150);
});

// ---- loop ----

test('view options: loopSpan is the lift window inside the marked range; a start-only window runs to the range\'s end; none is the whole range', async () => {
  const { loopSpan } = await load('ui/view-options-model.mjs');
  const range = { t0: 1, t1: 5 };
  const v = over => ({ hasLiftWindow: true, liftWindow: { t0: 2, t1: 3 }, ...over });
  assert.deepEqual(loopSpan(v(), range), { t0: 2, t1: 3 });
  assert.deepEqual(loopSpan(v({ liftWindow: { t0: 2, t1: null } }), range), { t0: 2, t1: 5 }, 'a start only (s35): from the start to the range\'s end');
  assert.equal(loopSpan(v({ liftWindow: null }), range), null, 'no lift found: the whole range');
  assert.equal(loopSpan(v({ hasLiftWindow: false, liftWindow: null }), range), null, 'a lift without a window (s36): the whole range');
  assert.deepEqual(loopSpan(v({ liftWindow: { t0: 0, t1: 9 } }), range), { t0: 1, t1: 5 }, 'held inside the range');
});

test('view options: loop keeps playback inside the lift window; off, it plays the whole range once and stops', async () => {
  const r = await rig();
  r.player.setLift({ t0: 0.8, t1: 1.6 });                     // frames 20 to 40 of the 25 fps example
  await r.player.start();
  await r.player.play();
  near(r.video.currentTime, 0.8, 'playing from the walk-in starts at the lift\'s start');
  r.video.present(0.8);
  r.video.present(1.2);
  assert.equal(r.player.state.index, 30);
  r.video.present(1.64);                                      // past the window's last frame: wraps
  near(r.video.currentTime, 0.8, 'back to the window\'s start');
  assert.equal(r.player.state.playing, true);
  r.video.present(0.84);
  assert.equal(r.player.state.index, 21);
  // a seek outside the window is allowed (the timeline), and playing from there jumps into the window
  await r.player.seek(2.5);
  await r.player.play();
  near(r.video.currentTime, 0.8);
  await r.player.pause();
  // loop off: the whole range, once
  await r.ctl.setSwitch('loop', false);
  await r.player.seek(0);
  await r.player.play();
  near(r.video.currentTime, 0, 'plays from where it is');
  r.video.present(1.6);
  assert.equal(r.player.state.playing, true, 'no wrap at the window\'s end');
  r.video.present(2.96 + 0.1);
  await new Promise(res => setImmediate(res));
  assert.equal(r.player.state.playing, false, 'stops on the range\'s last frame');
  assert.equal(r.player.state.index, r.player.bounds.last);
  assert.deepEqual(r.errors, []);
});

test('view options: loop with a start-only window runs from the start to the range\'s end and wraps there; with no window it wraps the whole range', async () => {
  const r = await rig();
  r.player.setLift({ t0: 1.2, t1: 2.96 });
  await r.player.start();
  await r.player.play();
  near(r.video.currentTime, 1.2);
  r.video.present(2.96);
  assert.equal(r.player.state.playing, true);
  r.video.present(3.2);                                       // past the range's end
  near(r.video.currentTime, 1.2, 'wraps to the lift\'s start');
  await r.player.pause();
  r.player.setLift(null);
  await r.player.seek(2.9);
  await r.player.play();
  r.video.present(3.2);
  near(r.video.currentTime, 0, 'no window: wraps to the range\'s start');
});

// ---- re-mark ----

test('view options: re-mark opens M with the stored cut and the lift\'s old marks, in M1–M3\'s ready state', async () => {
  const r = await rig({ range: { t0: 0.4, t1: 2.2 } });
  const seen = [];
  r.flow.subscribe(c => seen.push(c));
  await r.ctl.remark();
  assert.equal(r.flow.state, 'mark');
  assert.equal(seen.length, 1);
  const p = r.flow.params;
  assert.equal(p.lift, 'lateral-raise');
  assert.deepEqual(p.range, { t0: 0.4, t1: 2.2 });
  assert.equal(p.file.size, 4, 'the file is the stored cut');
  assert.deepEqual(Array.from(new Uint8Array(await p.file.arrayBuffer())), [1, 2, 3, 4]);
  // M turns the old range back into marks on the cut's frames, and they are exactly the old ones
  const mark = await load('ui/mark-model.mjs');
  const m = await load('ui/view-options-model.mjs');
  const marks = m.marksFromRange(p.range, r.src.frameTimes);
  assert.equal(mark.stepOf(marks), 'ready', 'both marks set: M3');
  assert.equal(marks.start, 10);
  assert.equal(marks.end, 55);
  const v = mark.markView(marks, { index: marks.start, frameTimes: r.src.frameTimes });
  assert.equal(v.step, 'ready');
  near(v.startAt, 0.4);
  near(v.endAt, 2.2);
  assert.equal(v.canAnalyse, true);
  assert.deepEqual(mark.markedRange(marks, r.src.frameTimes), { t0: 0.4, t1: 2.2, length: 2.2 - 0.4, frames: 46 });
  // Redo clears them, as in M3
  assert.equal(mark.stepOf(mark.redo()), 'start');
  // and M reads them from the flow's params
  assert.match(read('ui/screens/M.mjs'), /flow\.params\.range|marksFromRange/);
});

test('view options: marksFromRange gives no marks for a range that is not on the video or is too short to be marked', async () => {
  const m = await load('ui/view-options-model.mjs');
  const mark = await load('ui/mark-model.mjs');
  const times = Array.from({ length: 75 }, (_, i) => i / 25);
  assert.equal(mark.stepOf(m.marksFromRange({ t0: 1, t1: 1.02 }, times)), 'start', 'fewer frames than MIN_MARK_FRAMES');
  assert.equal(mark.stepOf(m.marksFromRange(null, times)), 'start');
  assert.equal(mark.stepOf(m.marksFromRange({ t0: 0, t1: 99 }, times)), 'ready', 'an end past the last frame is held to it');
});

test('view options: the flow has re-mark from the result: result → mark with the cut, and mark → queued after Analyse', async () => {
  const { createFlow } = await load('flow/flow.mjs');
  const f = createFlow('result');
  assert.equal(f.can('mark'), true);
  f.go('mark', { file: new Blob([]), lift: 'snatch', range: { t0: 1, t1: 2 } });
  assert.deepEqual(f.params.range, { t0: 1, t1: 2 });
  assert.equal(f.can('queued'), true);
});

// ---- delete ----

test('view options: delete asks first, and removes the lift through the store only when confirmed', async () => {
  const r = await rig();
  assert.equal(r.ctl.state.asking, false);
  r.ctl.askDelete();
  assert.equal(r.ctl.state.asking, true);
  assert.deepEqual(r.calls.filter(c => c[0] === 'deleteLift'), [], 'asking deletes nothing');
  assert.equal((await r.store.listLifts()).length, 1);
  r.ctl.cancelDelete();
  assert.equal(r.ctl.state.asking, false);
  await r.ctl.confirmDelete();
  assert.deepEqual(r.calls.filter(c => c[0] === 'deleteLift'), [], 'a confirm that was never asked for does nothing');
  assert.equal(r.flow.state, 'result');
  r.ctl.askDelete();
  await r.ctl.confirmDelete();
  assert.deepEqual(r.calls.filter(c => c[0] === 'deleteLift'), [['deleteLift', r.rec.id]]);
  assert.deepEqual(await r.store.listLifts(), []);
  assert.equal(await r.store.getLift(r.rec.id), null);
  assert.equal(r.flow.state, 'home', 'and the app goes home, there being no lift to show');
});

test('view options: a delete that fails keeps the lift on screen and says why', async () => {
  const r = await rig();
  const failing = new Proxy(r.store, { get(t, k) { if (k === 'deleteLift') return async () => { throw new Error('Could not remove the files.'); }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
  const ctl = r.vo.createViewOptions({ store: failing, rec: r.rec, track: rawTrack, view: r.first.view, Diagnostics: D, flags: r.flags, player: r.player, flow: r.flow });
  ctl.askDelete();
  await ctl.confirmDelete();
  assert.equal(r.flow.state, 'result');
  assert.match(ctl.state.error, /Could not remove/);
  assert.equal(ctl.state.asking, false);
  assert.equal((await r.store.listLifts()).length, 1);
});

test('view options: the controller tells its subscribers about every change and stops after unsubscribe', async () => {
  const r = await rig();
  const seen = [];
  const off = r.ctl.subscribe(s => seen.push(s));
  await r.ctl.setSwitch('loop', false);
  assert.ok(seen.length >= 1);
  assert.equal(seen[seen.length - 1].loop, false);
  off();
  const n = seen.length;
  await r.ctl.setSwitch('loop', true);
  assert.equal(seen.length, n);
});
