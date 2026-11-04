// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// The capture on the phone's camera (package c30): the debug page app/debug/capture.mjs (window.c30)
// and its driver tools/check-capture-phone.mjs. The measurements run on the phone (app/README.md,
// "Capture and the rolling buffer", "On the phone"); here: the page's and the driver's helpers, that
// the driver names the phone in every adb call, and that the page stays out of the shipped dist/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { tempDir } = require('../fixtures.js');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const read = rel => fs.readFileSync(path.join(APP, rel), 'utf8');
const page = () => import(pathToFileURL(path.join(APP, 'debug', 'capture.mjs')).href);
const driver = () => import(pathToFileURL(path.join(APP, 'tools', 'check-capture-phone.mjs')).href);

test('capture.mjs loads in Node without a page and exposes record and permission', async () => {
  const { c30 } = await page();
  assert.equal(typeof c30.record, 'function');
  assert.equal(typeof c30.permission, 'function');
});

test('intervalStats: the frames\' rate, median interval, jitter and late frames from their timestamps', async () => {
  const { intervalStats } = await page();
  // 30 fps for 10 frames, then one frame held for three intervals
  const ts = Array.from({ length: 10 }, (_, i) => Math.round(i * 1e6 / 30));
  ts.push(ts.at(-1) + 100000);
  const s = intervalStats(ts);
  assert.equal(s.frames, 11);
  assert.equal(s.intervals, 10);
  assert.ok(Math.abs(s.medianMs - 33.333) < 0.01, s.medianMs);
  assert.equal(s.late, 1, 'the 100 ms interval is over 1.5 × the median');
  assert.equal(s.maxMs, 100);
  assert.ok(s.jitterMs > 19 && s.jitterMs < 21, `${s.jitterMs}`);
  assert.ok(Math.abs(s.fps - 10 / 0.4) < 0.01, `${s.fps}`);
  assert.deepEqual(intervalStats([5]), { frames: 1, intervals: 0 });
});

test('keyframeGapsMs: µs in, ms out to 0.1 ms, as check-capture.mjs reports them', async () => {
  const { keyframeGapsMs } = await page();
  assert.deepEqual(keyframeGapsMs([0, 1000000, 2045750, 3080000]), [1000, 1045.8, 1034.3]);
});

test('memoryOf: the baseline before the camera opened, each phase\'s peak and its rise over it, the codec processes apart', async () => {
  const { memoryOf } = await driver();
  const MB = 1024;   // kB
  // [ms, rssKb, gpuBytes, codecKb]
  const samples = [
    [0, 100 * MB, 0, 20 * MB], [1000, 102 * MB, 0, 20 * MB], [2000, 100 * MB, 0, 20 * MB],
    [3000, 150 * MB, 10 * 1048576, 30 * MB], [4000, 180 * MB, 20 * 1048576, 31 * MB], [5000, 170 * MB, 0, 25 * MB],
  ];
  const m = memoryOf(samples, { open: 2500, start: 3000, recorded: 4000, snap: 4500, snapDone: 4600 }, [['recording', 'start', 'recorded'], ['snap', 'snap', 'snapDone'], ['none', 'x', 'y']]);
  assert.equal(m.baseMb, 100);
  assert.equal(m.codecBaseMb, 20);
  assert.deepEqual(m.recording, { peakMb: 200, overBaseMb: 100, codecPeakMb: 31, codecOverBaseMb: 11 });
  // a phase between two samples takes the one on each side
  assert.deepEqual(m.snap, { peakMb: 200, overBaseMb: 100, codecPeakMb: 31, codecOverBaseMb: 11 });
  assert.equal(m.none, undefined, 'a phase without its marks is left out');
});

test('the driver names the phone in every adb call and touches only its own temp files', () => {
  const src = read('tools/check-capture-phone.mjs');
  const calls = [...src.matchAll(/(?:execFileSync|spawn)\('adb', \[([^\]]*)/g)].map(m => m[1]);
  assert.ok(calls.length >= 2);
  for (const c of calls) assert.match(c, /^'-s', SERIAL/, c);
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\binstall\b|uninstall|pm grant|pm revoke|kill-server/, 'installs, permissions and the server are curie\'s, by hand');
  for (const m of src.matchAll(/rm -f ([^`"';]+)/g)) assert.match(m[1], /\$\{TMP\}|\$\{stop\}/, m[0]);
});

test('the capture page is in debug/ only: the shipped dist/ has none of it, the debug one has it', async (t) => {
  const { assemble } = await import(pathToFileURL(path.join(APP, 'tools', 'assemble.mjs')).href);
  for (const debug of [false, true]) {
    const out = tempDir('coach-c30-');
    t.after(() => fs.rmSync(out, { recursive: true, force: true }));
    const { files } = assemble({ out, app: APP, src: path.join(ROOT, 'src'), debug, log: () => {} });
    assert.equal(fs.existsSync(path.join(out, 'debug', 'capture.html')), debug, `debug ${debug}`);
    assert.equal(files.some(f => f.startsWith('debug/')), false, 'never in files.json (the service worker\'s list)');
  }
  for (const f of ['index.html', 'src/main.mjs']) assert.doesNotMatch(read(f), /debug\//, f);
});
