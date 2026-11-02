'use strict';
// M1–M3, marking a lift (package d14): the marking state as plain functions
// (app/src/ui/mark-model.mjs). No Preact, no DOM; the screen (screens/M.mjs)
// draws what these give. What is real here: the flow, the frame source of s9 on
// the fake WebCodecs (as tests/app/frame-source.test.js opens one) with s38's
// stepper, the store and s32's keepVideo and the queue's own analyse() on the
// committed clip, and contract 2's validator. What is fake: the decoder, the
// pose engine (never started) and the browser.
//
// Where the expected values come from:
//  - the clips' frame times, from their commands (tests/README.md; the frame-source
//    test's header): testsrc2 at 30 fps, 90 frames; `-vfr` keeps the frames n of
//    0..89 with n % 5 < 3 at n/30 s, so the step from frame 2 is to 5/30 s, not 3/30 s;
//  - the filmstrip's scale and the playhead's place, from the mockup
//    (design/mockups/Mark.dc.html: 48 px a second, the playhead at the middle);
//  - the cost, from the queue's estimate (estimate.mjs, ui-design.md: about
//    2.9 s of processing per second of 30 fps video);
//  - the texts, from the mockup's HINTS, subHint and error strings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createFakeWebCodecs } = require('./fake-webcodecs');
const { createFakeStorage } = require('./fake-opfs.js');

const APP = path.resolve(__dirname, '..', '..', 'app');
const load = rel => import(pathToFileURL(path.join(APP, 'src', rel)).href);
const model = () => load('ui/mark-model.mjs');
const CLIPS = path.join(__dirname, 'clips');
const H264 = path.join(CLIPS, 'testsrc2-h264-30fps.mp4');
const VFR = path.join(CLIPS, 'testsrc2-h264-vfr.mp4');
const clip = file => new Blob([fs.readFileSync(file)], { type: 'video/mp4' });

const T30 = Array.from({ length: 90 }, (_, i) => i / 30);                 // 3 s at 30 fps
const TVFR = [0, 1, 2, 5, 6, 7, 10, 11, 12].map(n => n / 30);             // the vfr clip's first frames
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m || ''} ${a} vs ${b}`);

// no test here is about a stall; a short stallMs only made a loaded machine (the browser tests in the same run) fail with decode-stalled

async function openSource(file) {
  const { openFrameSource } = await load('media/frame-source.mjs');
  const fake = createFakeWebCodecs();
  const src = await openFrameSource(clip(file), { webcodecs: fake, stallMs: 10000 });
  return { src, fake };
}

// ---- the playhead from the drag and the filmstrip's scale ----

test('the filmstrip: 48 px a second, the playhead at the middle of the strip, the strip moves the other way', async () => {
  const m = await model();
  assert.equal(m.PX_PER_SECOND, 48);
  assert.equal(m.stripLeft(0, 390), 195, 'time 0 sits under the playhead at 195 px of 390');
  near(m.stripLeft(7.2, 390), 195 - 7.2 * 48);
  assert.equal(m.stripLeft(10, 400), 200 - 480, 'the middle follows the strip\'s width');
});

test('dragTarget: frame = last starting at or before the time (float slack), clamped to the first and last frame', async () => {
  const m = await model();
  const at = (time, dx) => m.dragTarget(T30, { time, dx });
  assert.deepEqual(at(1, -48), { index: 60, time: 2 }, 'dragging left moves later: 1.0 s + 48 px / 48 = 2.0 s');
  assert.deepEqual(at(1, 48).index, 0, 'dragging right moves back: 1.0 s - 1 s = 0');
  assert.equal(at(1, -48 * 0.5).index, 45, '0.5 s later');
  assert.equal(at(1, -(48 / 30) * 0.5).index, 30 + 0, 'half a frame later is still the same frame');
  assert.equal(at(1, -(48 / 30) * 1.5).index, 31, 'one and a half frames: the frame at or before');
  assert.equal(at(1, 9999).index, 0, 'past the start: the first frame');
  assert.equal(at(1, -9999).index, 89, 'past the end: the last frame');
  assert.equal(at(1, 9999).time, 0);
  near(at(1, -9999).time, 89 / 30);
});

test('dragTarget on a variable frame rate lands on a frame that exists', async () => {
  const m = await model();
  // 3/30 s and 4/30 s are not frames of the vfr clip: the frame at or before is frame 2 (2/30 s)
  assert.equal(m.dragTarget(TVFR, { time: 0, dx: -(48 * 3 / 30) }).index, 2);
  assert.equal(m.dragTarget(TVFR, { time: 0, dx: -(48 * 4 / 30) }).index, 2);
  assert.equal(m.dragTarget(TVFR, { time: 0, dx: -(48 * 5 / 30) }).index, 3);
  near(m.dragTarget(TVFR, { time: 0, dx: -(48 * 5 / 30) }).time, 5 / 30);
});

test('frameIndexAt: the last frame starting at or before t, 1 µs of slack', async () => {
  const m = await model();
  assert.equal(m.frameIndexAt(T30, 0), 0);
  assert.equal(m.frameIndexAt(T30, -1), 0);
  assert.equal(m.frameIndexAt(T30, 1 / 30), 1);
  assert.equal(m.frameIndexAt(T30, 1 / 30 - 1e-9), 1, 'a float that fell a hair short is the frame');
  assert.equal(m.frameIndexAt(T30, 1 / 30 - 0.001), 0);
  assert.equal(m.frameIndexAt(T30, 99), 89);
});

test('the clock reads minutes:seconds.tenths as the mockup does, and never "60.0"', async () => {
  const m = await model();
  assert.equal(m.formatClock(0), '0:00.0');
  assert.equal(m.formatClock(7.2), '0:07.2');
  assert.equal(m.formatClock(20.6), '0:20.6');
  assert.equal(m.formatClock(59.96), '1:00.0');
  assert.equal(m.formatClock(75.04), '1:15.0');
});

// ---- Set start, Set end, Redo ----

test('Set start then Set end: the marks are frame indexes, the range is their frames\' times', async () => {
  const m = await model();
  let marks = m.newMarks();
  assert.equal(m.stepOf(marks), 'start');
  marks = m.setMark(marks, 48, T30);
  assert.equal(marks.start, 48);
  assert.equal(marks.end, null);
  assert.equal(marks.error, null);
  assert.equal(m.stepOf(marks), 'end');
  marks = m.setMark(marks, 80, T30);
  assert.equal(marks.end, 80);
  assert.equal(m.stepOf(marks), 'ready');
  const r = m.markedRange(marks, T30);
  near(r.t0, 48 / 30); near(r.t1, 80 / 30); near(r.length, 32 / 30);
  assert.equal(r.frames, 33, 'both ends are in: the job poses every frame starting in [t0, t1]');
});

test('the end has to come after the start, a few frames at least: else the mark is refused and the hint says so', async () => {
  const m = await model();
  assert.ok(m.MIN_MARK_FRAMES >= 2 && m.MIN_MARK_FRAMES <= 10, 'a few frames');
  const start = m.setMark(m.newMarks(), 40, T30);
  for (const i of [10, 40, 40 + m.MIN_MARK_FRAMES - 1]) {
    const refused = m.setMark(start, i, T30);
    assert.equal(refused.end, null, `frame ${i} is not far enough after the start`);
    assert.equal(refused.start, 40, 'the start stays');
    assert.equal(refused.error, 'end-before-start');
    assert.equal(m.stepOf(refused), 'end');
  }
  const ok = m.setMark(start, 40 + m.MIN_MARK_FRAMES, T30);
  assert.equal(ok.end, 40 + m.MIN_MARK_FRAMES);
  assert.equal(ok.error, null);
  // a later good mark clears the error
  assert.equal(m.setMark(m.setMark(start, 41, T30), 70, T30).error, null);
});

test('Redo clears both marks and the error, and nothing else is kept', async () => {
  const m = await model();
  const ready = m.setMark(m.setMark(m.newMarks(), 10, T30), 60, T30);
  assert.equal(m.stepOf(ready), 'ready');
  assert.deepEqual(m.redo(ready), m.newMarks());
  assert.deepEqual(m.redo(m.setMark(m.setMark(m.newMarks(), 10, T30), 11, T30)), m.newMarks());
  // setMark on a ready state does nothing (Set is not offered; Redo first)
  assert.deepEqual(m.setMark(ready, 80, T30), ready);
});

test('marks never mutate: setMark and redo return new states', async () => {
  const m = await model();
  const a = m.newMarks();
  const b = m.setMark(a, 5, T30);
  assert.equal(a.start, null);
  assert.notEqual(a, b);
  assert.throws(() => { 'use strict'; m.newMarks().start = 3; }, TypeError, 'frozen');
});

test('a mark on a variable-rate source is the frame\'s own time, never index / fps', async () => {
  const m = await model();
  const marks = m.setMark(m.setMark(m.newMarks(), 3, TVFR), 8, TVFR);
  const r = m.markedRange(marks, TVFR);
  near(r.t0, 5 / 30);
  near(r.t1, 12 / 30);
  near(r.length, 7 / 30);
});

// ---- one-frame steps through the stepper ----

test('a +1/−1 step goes through the stepper and lands on the neighbouring frame by frameTimes (a variable rate too)', async () => {
  const m = await model();
  const { src } = await openSource(VFR);
  const ft = src.frameTimes;
  const calls = [];
  const real = src.frameAt;
  src.frameAt = async (...a) => { calls.push('frameAt'); return real.apply(src, a); };
  const st = await src.stepper(ft[1], { height: 36 });
  const wrapped = {
    seek: t => { calls.push(['seek', t]); return st.seek(t); },
    step: d => { calls.push(['step', d]); return st.step(d); },
  };
  const shown = [];
  const head = m.createPlayhead({ stepper: wrapped, draw: r => shown.push(r.index), fail: e => { throw e; } });
  await head.step(1);
  await head.step(1);
  await head.step(-1);
  await head.idle();
  assert.deepEqual(shown, [2, 3, 2]);
  assert.deepEqual(calls.filter(c => c[0] === 'step'), [['step', 1], ['step', 1], ['step', -1]]);
  assert.equal(calls.includes('frameAt'), false, 'never frameAt: that decodes again from the keyframe');
  assert.equal(st.index, 2);
  near(st.time, ft[2]);
  const next = await head.step(1);
  assert.equal(next.index, 3);
  near(next.time, 5 / 30, 'the step from frame 2 is to 5/30 s, not 3/30 s');
  head.close(); st.close(); src.close();
});

test('stepping at the ends stays put; a step reports the frame\'s time for the clock and the strip', async () => {
  const m = await model();
  const { src } = await openSource(H264);
  const st = await src.stepper(0, { height: 36 });
  const head = m.createPlayhead({ stepper: st, draw() {}, fail: e => { throw e; } });
  assert.equal((await head.step(-1)).index, 0);
  assert.equal((await head.seekTo(99)).index, 89);
  assert.equal((await head.step(1)).index, 89);
  head.close(); st.close(); src.close();
});

test('dragging never blocks: seeks that pile up while one decodes become one, to the latest time', async () => {
  const m = await model();
  const asked = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const stepper = {
    seek: async t => { asked.push(t); if (asked.length === 1) await gate; return { index: Math.round(t * 30), time: t, frame: { t }, cached: false }; },
    step: async () => { throw new Error('no step expected'); },
  };
  const drawn = [];
  const head = m.createPlayhead({ stepper, draw: r => drawn.push(r.index), fail: e => { throw e; } });
  head.request(0.1);                    // starts decoding, waits on the gate
  for (const t of [0.2, 0.3, 0.4, 0.5]) head.request(t);   // the drag goes on meanwhile
  assert.equal(asked.length, 1, 'the input path started one decode and returned at once');
  release();
  await head.idle();
  assert.deepEqual(asked, [0.1, 0.5], 'the frames between were skipped: only the latest is decoded');
  assert.deepEqual(drawn, [3, 15]);
  head.close();
});

test('a step asked while a drag\'s seek is decoding goes after it, from the frame the seek lands on', async () => {
  const m = await model();
  const { src } = await openSource(H264);
  const st = await src.stepper(0, { height: 36 });
  const drawn = [];
  const head = m.createPlayhead({ stepper: st, draw: r => drawn.push(r.index), fail: e => { throw e; } });
  head.request(1);
  const stepped = head.step(1);
  await head.idle();
  assert.equal((await stepped).index, 31, 'the step is one frame past the seek\'s frame (30)');
  assert.equal(drawn.at(-1), 31);
  head.close(); st.close(); src.close();
});

test('a failing stepper is reported, and the playhead goes on with the next request', async () => {
  const m = await model();
  let n = 0;
  const stepper = {
    seek: async t => { if (n++ === 0) throw new Error('decoder failed'); return { index: 1, time: t, frame: {}, cached: true }; },
    step: async () => ({ index: 2, time: 0.07, frame: {}, cached: true }),
  };
  const failed = [], drawn = [];
  const head = m.createPlayhead({ stepper, draw: r => drawn.push(r.index), fail: e => failed.push(e.message) });
  head.request(0.03);
  await head.idle();
  head.request(0.04);
  await head.idle();
  assert.deepEqual(failed, ['decoder failed']);
  assert.deepEqual(drawn, [1]);
  head.close();
});

test('a start with no room for an end is refused with a hint, so M2 can never be a dead end', async () => {
  const m = await model();
  const last = T30.length - 1;
  for (const i of [last, last - m.MIN_MARK_FRAMES + 1]) {
    const refused = m.setMark(m.newMarks(), i, T30);
    assert.equal(refused.start, null, `frame ${i} of ${T30.length}: no end could follow`);
    assert.equal(refused.error, 'start-too-late');
    assert.equal(m.stepOf(refused), 'start');
    const v = m.markView(refused, { index: i, frameTimes: T30 });
    assert.equal(v.hintIsError, true);
    assert.match(v.hint, /drag left/);
  }
  const edge = m.setMark(m.newMarks(), last - m.MIN_MARK_FRAMES, T30);
  assert.equal(edge.start, last - m.MIN_MARK_FRAMES, 'the last start an end can still follow');
  assert.equal(m.setMark(edge, last, T30).end, last, 'and that end is accepted');
});

test('a frame drawn after a failed one clears the note over the stage', async () => {
  const m = await model();
  let n = 0;
  const stepper = {
    seek: async t => { if (n++ === 0) throw new Error('decoder failed'); return { index: 1, time: t, frame: {}, cached: true }; },
    step: async () => ({ index: 2, time: 0.07, frame: {}, cached: true }),
  };
  let note = null;
  const head = m.createPlayhead({ stepper, draw: () => { note = m.playheadNote(); }, fail: e => { note = m.playheadNote({ error: e }); } });
  head.request(0.03);
  await head.idle();
  assert.equal(note, 'decoder failed');
  head.request(0.04);
  await head.idle();
  assert.equal(note, null, 'the drag seek that succeeded shows its frame and no error');
  assert.equal(m.playheadNote({ error: {} }), 'The video could not be decoded.');
  head.close();
});

test('closing the playhead drops what is pending and draws nothing after', async () => {
  const m = await model();
  let release;
  const gate = new Promise(r => { release = r; });
  const stepper = { seek: async t => { await gate; return { index: 1, time: t, frame: {}, cached: false }; }, step: async () => ({}) };
  const drawn = [];
  const head = m.createPlayhead({ stepper, draw: r => drawn.push(r), fail: e => { throw e; } });
  head.request(0.1);
  head.request(0.2);
  head.close();
  release();
  await head.idle();
  assert.deepEqual(drawn, []);
});

// ---- the frame's size, and the filmstrip's thumbnails ----

test('the stepper\'s size fits the stage at the pixel ratio, keeping the video\'s aspect, and never above the ratio 3 the budget is sized for', async () => {
  const m = await model();
  // portrait 1080 x 1920 in the mockup's 390 x 440 stage at ratio 3: 440 is the limit: 743 x 1320 (743.1 rounds)
  assert.deepEqual(m.fitSize({ width: 1080, height: 1920 }, { width: 390, height: 440 }, 3), { width: 743, height: 1320 });
  // landscape 1920 x 1080: the width is the limit
  assert.deepEqual(m.fitSize({ width: 1920, height: 1080 }, { width: 390, height: 440 }, 3), { width: 1170, height: 658 });
  assert.deepEqual(m.fitSize({ width: 1080, height: 1920 }, { width: 390, height: 440 }, 5), { width: 743, height: 1320 }, 'ratio capped at 3');
  assert.deepEqual(m.fitSize({ width: 1080, height: 1920 }, { width: 390, height: 440 }, 0), { width: 248, height: 440 }, 'no ratio: 1');
  // a frame is never made bigger than the video itself
  assert.deepEqual(m.fitSize({ width: 96, height: 54 }, { width: 390, height: 440 }, 3), { width: 96, height: 54 });
});

test('the thumbnails wanted: one a second, the window around the playhead (the strip\'s width, and a margin), never past the video', async () => {
  const m = await model();
  const sec = m.thumbSeconds({ time: 10, width: 390, duration: 30, margin: 2 });
  // visible: 10 s ± 195 px / 48 = ±4.06 s, so seconds 5..14 (a thumb covers [i, i+1)), plus 2 s each way
  assert.deepEqual(sec, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(m.thumbSeconds({ time: 0, width: 390, duration: 30, margin: 0 }), [0, 1, 2, 3, 4]);
  assert.deepEqual(m.thumbSeconds({ time: 29.9, width: 390, duration: 30, margin: 0 }), [25, 26, 27, 28, 29]);
  assert.deepEqual(m.thumbSeconds({ time: 1, width: 390, duration: 2.5, margin: 0 }), [0, 1, 2], 'a partial last second still has its thumbnail');
});

test('a thumbnail is the frame at the second\'s middle, held to the last frame', async () => {
  const m = await model();
  near(m.thumbTime(0, T30), 0.5);
  near(m.thumbTime(2, T30), 2.5);
  near(m.thumbTime(2, [0, 1 / 30, 2 / 30]), 2 / 30, 'a clip shorter than the second: its last frame');
});

test('the thumbnails are kept for the window and closed outside it', async () => {
  const m = await model();
  const held = new Map([[0, { closed: false, close() { this.closed = true; } }], [5, { closed: false, close() { this.closed = true; } }], [20, { closed: false, close() { this.closed = true; } }]]);
  m.dropFarThumbs(held, [4, 5, 6]);
  assert.deepEqual([...held.keys()], [5]);
});

// ---- the length, the time to analyse, the view ----

test('the length and its time come from the queue\'s estimate(t1 - t0, {fps})', async () => {
  const m = await model();
  const asked = [];
  const queue = { estimate: async (d, o) => { asked.push([d, o]); return { seconds: 2.9 * d, perSecond: 2.9, measured: false, basis: 'first-run default' }; } };
  const marks = m.setMark(m.setMark(m.newMarks(), 30, T30), 80, T30);   // frames 30 and 80
  const cost = await m.analyseCost(queue, marks, T30, 30);
  assert.equal(asked.length, 1);
  near(asked[0][0], 50 / 30);
  assert.deepEqual(asked[0][1], { fps: 30 });
  near(cost.seconds, 2.9 * 50 / 30);
  assert.equal(await m.analyseCost(queue, m.setMark(m.newMarks(), 30, T30), T30, 30), null, 'no estimate until both marks are set');
});

test('with the real queue the first-run cost is about 2.9 s per second of 30 fps video, 60 fps costs twice', async () => {
  const m = await model();
  const { queue } = await realQueue();
  const marks = m.setMark(m.setMark(m.newMarks(), 0, T30), 30, T30);   // 1 s
  near((await m.analyseCost(queue, marks, T30, 30)).seconds, 2.9);
  near((await m.analyseCost(queue, marks, T30, 60)).seconds, 5.8);
});

test('the view: the three steps as drawn, with the mockup\'s words', async () => {
  const m = await model();
  const view = (marks, index, extra = {}) => m.markView(marks, { index, frameTimes: T30, ...extra });
  const start = view(m.newMarks(), 36);               // frame 36: 1.2 s
  assert.equal(start.step, 'start');
  assert.equal(start.clock, '0:01.2');
  assert.equal(start.hint, 'Drag the filmstrip until the playhead sits just before the lift starts, then tap Set start.');
  assert.equal(start.subHint, 'Rough is fine: coach finds the exact lift inside your marks. Shorter marks analyse faster.');
  assert.equal(start.setLabel, 'Set start');
  assert.deepEqual(start.steps.map(s => [s.label, s.num, s.state]), [['Start', '1', 'now'], ['End', '2', 'todo'], ['Analyse', '3', 'todo']]);
  assert.equal(start.region, null);
  assert.equal(start.canAnalyse, false);
  assert.equal(start.canRedo, false);
  assert.equal(start.hintIsError, false);

  const end = view(m.setMark(m.newMarks(), 10, T30), 40);
  assert.equal(end.step, 'end');
  assert.equal(end.hint, 'Now drag to just after the last rep ends, then tap Set end.');
  assert.equal(end.setLabel, 'Set end');
  assert.deepEqual(end.steps.map(s => [s.num, s.state]), [['✓', 'done'], ['2', 'now'], ['3', 'todo']]);
  near(end.region.from, 10 / 30); near(end.region.to, 40 / 30);
  near(end.startAt, 10 / 30);
  assert.equal(end.endAt, null);
  assert.equal(end.canRedo, false);

  const refused = view(m.setMark(m.setMark(m.newMarks(), 10, T30), 10, T30), 10);
  assert.equal(refused.hint, 'The end has to come after the start: drag right, past the lift.');
  assert.equal(refused.hintIsError, true);

  const ready = view(m.setMark(m.setMark(m.newMarks(), 10, T30), 40, T30), 40, { cost: { seconds: 2.9 * 1, measured: true } });
  assert.equal(ready.step, 'ready');
  assert.equal(ready.lengthLabel, '1.0 s');
  assert.equal(ready.hint, '1.0 s marked. About 3 s to analyse on this phone; it runs in the background while you train.');
  assert.equal(ready.subHint, 'The marks only need to bracket the lift; the analysis finds its exact start and end.');
  assert.equal(ready.analyseLabel, 'Analyse 1.0 s');
  assert.deepEqual(ready.steps.map(s => [s.num, s.state]), [['✓', 'done'], ['✓', 'done'], ['3', 'now']]);
  assert.equal(ready.canAnalyse, true);
  assert.equal(ready.canRedo, true);
  assert.equal(ready.estimateNote, null, 'measured on this phone: nothing to qualify');
});

test('the time to analyse reads in seconds, then minutes; with no estimate yet the hint waits for it; a first-run default is labelled as one', async () => {
  const m = await model();
  const marks = m.setMark(m.setMark(m.newMarks(), 0, T30), 60, T30);   // 2.0 s
  const v = cost => m.markView(marks, { index: 60, frameTimes: T30, cost });
  assert.equal(v({ seconds: 5.8, measured: false }).hint, '2.0 s marked. About 6 s to analyse on this phone; it runs in the background while you train.');
  assert.equal(v({ seconds: 95, measured: true }).hint, '2.0 s marked. About 1 min 35 s to analyse on this phone; it runs in the background while you train.');
  assert.equal(v(null).hint, '2.0 s marked. It runs in the background while you train.');
  assert.match(v({ seconds: 5.8, measured: false }).estimateNote, /first-run|not yet measured/i);
});

test('the region and the length while the end is still open follow the playhead', async () => {
  const m = await model();
  const marks = m.setMark(m.newMarks(), 30, T30);
  const v = m.markView(marks, { index: 75, frameTimes: T30 });
  near(v.region.from, 1); near(v.region.to, 2.5);
  assert.equal(v.lengthLabel, '1.5 s');
  const before = m.markView(marks, { index: 10, frameTimes: T30 });
  assert.equal(before.region, null, 'a playhead before the start has no region');
});

// ---- the lift in the header (d53: chosen on L1, shown here, never switched) ----

test('d53 M has no lift switch: no otherLift, no mark-lift button, no default lift; it shows the lift it was given', async () => {
  const m = await model();
  assert.equal(m.otherLift, undefined);
  assert.equal(m.liftLabelOf, undefined);
  assert.equal(m.liftChoices, undefined);
  const screen = fs.readFileSync(path.join(APP, 'src', 'ui', 'screens', 'M.mjs'), 'utf8');
  const src = screen + fs.readFileSync(path.join(APP, 'src', 'ui', 'mark-model.mjs'), 'utf8');
  assert.doesNotMatch(src, /otherLift|mark-lift|Tap to change|setLift|ChevronDownIcon/);
  assert.doesNotMatch(screen, /'lateral-raise'|LIFTS\[0\]/, 'the lift comes from the flow only');
  assert.match(screen, /const \{[^}]*\blift = null\b[^}]*\} = flow\.params/);
  assert.match(screen, /<\$\{LiftIcon\} lift=\$\{lift\}/);
  assert.match(screen, /liftLabel\(lift\)/);
  assert.match(screen, /isProvisional\(lift\)/);
  assert.match(screen, /if \(!file \|\| !lift\)/, 'a flow without a file or a lift shows the no video state');
});

// ---- Analyse ----

function fakeTimers() {
  return { setInterval: () => 1, clearInterval() {} };
}
async function realQueue(opts = {}) {
  const { createStore } = await load('store/index.mjs');
  const { createQueue } = await load('analysis/index.mjs');
  const { keepVideo } = await load('media/cut.mjs');
  const fake = createFakeStorage();
  const store = createStore({ storage: fake.storage, now: () => new Date('2026-11-02T09:00:00.000Z'), appVersion: '0.1.0' });
  const queue = createQueue({
    store, keepVideo, timers: fakeTimers(), now: () => 0,
    createEngine: () => new Promise(() => {}),   // never starts: the job is only queued
    openFrameSource: async () => { throw new Error('not opened here'); },
    ...opts,
  });
  return { store, queue };
}

test('Analyse calls analyse(lift, file, {t0, t1}) with the marked frames\' times and hands Q1 the new lift\'s id', async () => {
  const m = await model();
  const { createFlow } = await load('flow/flow.mjs');
  const flow = createFlow('lift');
  const file = clip(H264);
  flow.go('mark', { file, lift: 'snatch' });
  const calls = [];
  const queue = { analyse: async (lift, f, range) => { calls.push([lift, f, range]); return { id: 'job-x', liftId: '20261102-090000-sn' }; } };
  const marks = m.setMark(m.setMark(m.newMarks(), 15, T30), 75, T30);
  const out = await m.analyse({ flow, queue, lift: 'snatch', file, marks, frameTimes: T30 });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'snatch');
  assert.equal(calls[0][1], file);
  near(calls[0][2].t0, 0.5); near(calls[0][2].t1, 2.5);
  assert.deepEqual(Object.keys(calls[0][2]).sort(), ['t0', 't1']);
  assert.equal(flow.state, 'queued');
  assert.deepEqual(flow.params, { liftId: '20261102-090000-sn' });
});

test('Analyse with no marks, one mark, or no file queues nothing and stays on M', async () => {
  const m = await model();
  const { createFlow } = await load('flow/flow.mjs');
  const flow = createFlow('lift');
  flow.go('mark', { file: clip(H264), lift: 'snatch' });
  let called = 0;
  const queue = { analyse: async () => { called++; return { liftId: 'x' }; } };
  for (const marks of [m.newMarks(), m.setMark(m.newMarks(), 4, T30)]) {
    const out = await m.analyse({ flow, queue, lift: 'snatch', file: clip(H264), marks, frameTimes: T30 });
    assert.equal(out.ok, false);
  }
  const ready = m.setMark(m.setMark(m.newMarks(), 4, T30), 40, T30);
  assert.equal((await m.analyse({ flow, queue, lift: 'snatch', file: null, marks: ready, frameTimes: T30 })).ok, false);
  assert.equal(called, 0);
  assert.equal(flow.state, 'mark');
});

test('when the cut cannot be stored the error is the user\'s to read, nothing is queued and the screen stays on M', async () => {
  const m = await model();
  const { createFlow } = await load('flow/flow.mjs');
  const flow = createFlow('lift');
  flow.go('mark', { file: clip(H264), lift: 'lateral-raise' });
  const queue = { analyse: async () => { const e = new Error('There is not enough room on this phone to keep the video.'); e.code = 'storage-full'; throw e; } };
  const ready = m.setMark(m.setMark(m.newMarks(), 4, T30), 40, T30);
  const out = await m.analyse({ flow, queue, lift: 'lateral-raise', file: clip(H264), marks: ready, frameTimes: T30 });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'There is not enough room on this phone to keep the video.');
  assert.equal(out.problem.kind, 'storage-full', 'M draws the error as its own screen (d23)');
  assert.equal(flow.state, 'mark');
});

test('Analyse twice in a row queues once: a second tap while the first is working does nothing', async () => {
  const m = await model();
  const { createFlow } = await load('flow/flow.mjs');
  const flow = createFlow('lift');
  flow.go('mark', { file: clip(H264), lift: 'lateral-raise' });
  let n = 0, release;
  const gate = new Promise(r => { release = r; });
  const queue = { analyse: async () => { n++; await gate; return { liftId: 'one' }; } };
  const ready = m.setMark(m.setMark(m.newMarks(), 4, T30), 40, T30);
  const args = { flow, queue, lift: 'lateral-raise', file: clip(H264), marks: ready, frameTimes: T30 };
  const first = m.analyse(args);
  const second = await m.analyse(args);
  assert.equal(second.ok, false);
  release();
  assert.deepEqual(await first, { ok: true });
  assert.equal(n, 1);
  assert.equal(flow.params.liftId, 'one');
});

test('the queued job from the real queue passes contract 2\'s validator, and is the stored lift\'s: its cut, its range, the new id in Q1\'s params', async () => {
  const m = await model();
  const { createFlow } = await load('flow/flow.mjs');
  const { validateAnalysisJob } = await load('contracts/analysis-job.mjs');
  const { validateStoredLift } = await load('contracts/stored-lift.mjs');
  const { store, queue } = await realQueue();
  const { src } = await openSource(H264);
  const ft = src.frameTimes;
  const flow = createFlow('lift');
  const file = clip(H264);
  flow.go('mark', { file, lift: 'lateral-raise' });
  const marks = m.setMark(m.setMark(m.newMarks(), 36, ft), 66, ft);   // 1.2 s .. 2.2 s
  const out = await m.analyse({ flow, queue, lift: 'lateral-raise', file, marks, frameTimes: ft });
  assert.deepEqual(out, { ok: true });
  assert.equal(flow.state, 'queued');
  const liftId = flow.params.liftId;
  const stored = await store.getLift(liftId);
  assert.deepEqual(validateStoredLift(stored), []);
  assert.equal(stored.lift, 'lateral-raise');
  const job = queue.jobs().find(j => j.liftId === liftId);
  assert.ok(job, 'the job for the lift Q1 will show');
  assert.deepEqual(validateAnalysisJob(job, { lift: stored }), []);
  assert.equal(job.liftId, liftId);
  assert.equal(job.source, stored.video);
  // the range is in the cut's timeline: about the marked 1.0 s long, keyframe lead-in included
  assert.ok(job.range.t1 - job.range.t0 >= 1.0 - 1e-6 && job.range.t1 - job.range.t0 <= 1.0 + 1e-6, JSON.stringify(job.range));
  src.close();
});

test('with two lifts queued, each Analyse hands Q1 its own lift\'s id', async () => {
  const m = await model();
  const { createFlow } = await load('flow/flow.mjs');
  const { store, queue } = await realQueue();
  const ids = [];
  for (const lift of ['lateral-raise', 'snatch']) {
    const flow = createFlow('lift');
    flow.go('mark', { file: clip(H264), lift });
    const marks = m.setMark(m.setMark(m.newMarks(), 36, T30), 66, T30);
    await m.analyse({ flow, queue, lift, file: clip(H264), marks, frameTimes: T30 });
    ids.push(flow.params.liftId);
  }
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual((await store.listLifts()).map(l => l.id).sort(), [...ids].sort());
});

// ---- thumbnails that fail, and a late step ----

test('a thumbnail batch that fails is asked again second by second; a second that fails alone is given up, so the retries end', async () => {
  const m = await model();
  const planner = m.createThumbPlanner({ batch: 4 });
  const held = new Map();
  const wanted = [0, 1, 2, 3, 4, 5];
  let asks = 0;
  const bad = 2;   // the one frame the decoder can't make (decode-failed)
  for (let guard = 0; guard < 50; guard++) {
    const batch = planner.next(wanted, held, 2.5);
    if (!batch.length) break;
    asks++;
    if (batch.includes(bad)) planner.failure(batch);
    else for (const s of batch) held.set(s, {});
  }
  assert.ok(asks < 12, `the retries end (${asks} requests)`);
  assert.deepEqual([...held.keys()].sort(), [0, 1, 3, 4, 5], 'every other second still gets its picture');
  assert.deepEqual(planner.given(), [bad]);
  assert.deepEqual(planner.next(wanted, held, 2.5), [], 'a given-up second is not asked for again');
  planner.reset();
  assert.deepEqual(planner.next(wanted, held, 2.5), [bad], 'a new video starts afresh');
});

test('a step that lands after a drag began does not move the playhead\'s index back', async () => {
  const m = await model();
  const latest = m.createLatest();
  const stepToken = latest.issue();   // tap a step
  assert.ok(latest.fresh(stepToken));
  latest.issue();                     // the drag starts before the step lands
  assert.ok(!latest.fresh(stepToken), 'the late step result is dropped');
  const second = latest.issue();      // two steps in a row: only the last answer counts
  const third = latest.issue();
  assert.ok(!latest.fresh(second));
  assert.ok(latest.fresh(third));
});

// ---- the screen's files ----

test('M changes the flow\'s state only through the model and the flow: no other screen, no store, no literal colour; every string of the mockup is in it', () => {
  const dir = path.join(APP, 'src', 'ui');
  const screen = fs.readFileSync(path.join(dir, 'screens', 'M.mjs'), 'utf8');
  const mdl = fs.readFileSync(path.join(dir, 'mark-model.mjs'), 'utf8');
  assert.doesNotMatch(screen, /from '\.\/(H|Import|Q1|A1|S1|R2|R3)\.mjs'/, 'screens never call each other');
  assert.doesNotMatch(screen + mdl, /store\/index\.mjs|localStorage|indexedDB/);
  assert.doesNotMatch(screen + mdl, /#[0-9a-fA-F]{3,8}\b/, 'colours come from tokens.css');
  assert.doesNotMatch(screen + mdl, /<video|createElement\('video'\)/, 'no <video> element: seeking one costs more than the pose model');
  // the strings of design/mockups/Mark.dc.html that the screen itself draws (the model's are pinned above)
  for (const s of ['Mark the lift', 'aria-label="Close"', 'Playhead position, drag the filmstrip', 'aria-label="Steps"',
    'One frame back', 'One frame forward', 'Redo the marks', '>S</span>', '>E</span>']) {
    assert.ok(screen.includes(s), `M.mjs draws ${s}`);
  }
  // role="img" hides its children from a screen reader: it sits on the canvas, not on the stage with the status and the alert
  assert.match(screen, /<canvas[^>]*role="img"[^>]*aria-label="The video at the playhead"/);
  assert.doesNotMatch(screen, /class="mark-stage"[^>]*role="img"/);
});

test('the app calls the queue once at boot and warms the engine after the first screen draws (s12\'s report, item 6)', () => {
  const main = fs.readFileSync(path.join(APP, 'src', 'main.mjs'), 'utf8');
  assert.equal((main.match(/appQueue\(/g) || []).length, 1);
  assert.match(main, /requestAnimationFrame[\s\S]*queue\.warmUp\(\)/);
});

test('the tokens M uses exist: every var(--x) in the screen\'s CSS is defined in tokens.css', () => {
  const css = fs.readFileSync(path.join(APP, 'src', 'styles', 'base.css'), 'utf8');
  const tokens = fs.readFileSync(path.join(APP, 'src', 'styles', 'tokens.css'), 'utf8');
  const markCss = css.slice(css.indexOf('M1–M3, Mark the lift'));
  const used = new Set([...markCss.matchAll(/var\((--[a-z0-9-]+)\)/g)].map(m => m[1]));
  assert.ok(used.size > 20);
  for (const t of used) assert.match(tokens, new RegExp(`${t}:`), `${t} is defined`);
});
