// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Milestone A on the phone (package c26): app/tools/check-phone.mjs walks the app
// over a page's DevTools on the Fairphone. The walk itself needs the phone; here:
// how it reads a job's progress events for s12's numbers (the stages, the longest
// wait and what it was, the time left against the real time) and how it compares
// M's boxes (d54's 0.5 px), and that it runs no adb of its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const TOOL = path.resolve(__dirname, '..', '..', 'app', 'tools', 'check-phone.mjs');
const load = () => import(pathToFileURL(TOOL).href);

// a job as the queue emits it: queued, reading 0/1 and 1/1, the engine, pose 0..4, scoring, done
const ev = (t, state, stage, done, total, etaS = null) => ({ t, state, stage, done, total, etaS });
const EVENTS = [
  ev(0, 'queued', null, null, null),
  ev(10, 'reading', 'reading', 0, 1, 12),
  ev(60, 'reading', 'reading', 1, 1, 10),
  ev(1060, 'pose', 'pose', 0, 4, 10),          // the engine: 1 s
  ev(1260, 'pose', 'pose', 1, 4, 0.3),         // the first frame: 200 ms
  ev(1360, 'pose', 'pose', 2, 4, 0.2),
  ev(1460, 'pose', 'pose', 3, 4, 0.1),
  ev(1560, 'pose', 'pose', 4, 4, 0),
  ev(1600, 'scoring', 'scoring', 0, 1, 0),
  ev(1900, 'scoring', 'scoring', 1, 1, 0),
  ev(1910, 'done', 'scoring', 1, 1, 0),
];

test('jobTimes: the stages, the first frame, ms per frame and the longest wait with what it was', async () => {
  const { jobTimes } = await load();
  const j = jobTimes(EVENTS);
  assert.equal(j.state, 'done');
  assert.equal(j.totalMs, 1900, 'from the first running event (queued time is not the job\'s)');
  assert.deepEqual(j.stagesMs, { reading: 50, engine: 1000, pose: 540, scoring: 310 });
  assert.equal(j.frames, 4);
  assert.equal(j.firstFrameMs, 200);
  assert.equal(j.msPerFrame, 100);
  assert.deepEqual(j.longestWait, { ms: 1000, from: 'reading 1/1', to: 'pose 0/4', what: "the engine (its start, or the clip's reset)" });
});

test('jobTimes: the time left shown at each stage beside the real time to done', async () => {
  const { jobTimes } = await load();
  const at = Object.fromEntries(jobTimes(EVENTS).timeLeft.map(x => [x.at, x]));
  assert.deepEqual(at['reading 0'], { at: 'reading 0', etaS: 12, realS: 1.9 });
  assert.deepEqual(at['pose 0'], { at: 'pose 0', etaS: 10, realS: 0.9 });
  assert.equal(at['pose 50 %'].realS, 0.6, 'frame 2 of 4 at 1360 ms, done at 1910');
  assert.equal(at['scoring 0'].realS, 0.3);
});

test('jobTimes: a first frame slower than the engine is the longest wait; a failed job ends it; none ran is null', async () => {
  const { jobTimes } = await load();
  const slow = EVENTS.map(e => ({ ...e }));
  for (const e of slow.slice(4)) e.t += 2000;   // the first frame takes 2.2 s
  assert.equal(jobTimes(slow).longestWait.what, 'the first frame');
  const failed = [...EVENTS.slice(0, 5), { ...ev(1300, 'failed', 'pose', 1, 4), error: 'x' }];
  assert.equal(jobTimes(failed).state, 'failed');
  assert.equal(jobTimes([ev(0, 'queued', null, null, null)]), null);
});

test('movedBoxes: equal within 0.5 px passes; a control that moved or went is named', async () => {
  const { movedBoxes } = await load();
  const a = { one: { x: 0, y: 10, w: 50, h: 20 }, text: { x: 0, y: 40, w: 50, h: 20 } };
  assert.deepEqual(movedBoxes(a, { one: { x: 0.4, y: 10, w: 50, h: 20.5 }, text: a.text }), []);
  assert.deepEqual(movedBoxes(a, { one: { x: 0, y: 11, w: 50, h: 20 }, text: null }), ['one: y 10 → 11', 'text: gone']);
});

test('check-phone.mjs runs no adb (curie forwards the port and drives the phone\'s own screens) and taps by touch', () => {
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.doesNotMatch(src, /child_process/);
  assert.match(src, /Input\.dispatchTouchEvent/);
  assert.match(src, /import\('\.\/src\/analysis\/index\.mjs'\)/, "the app's own queue, the module main.mjs imports");
});
