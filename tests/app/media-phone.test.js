'use strict';
// The phone's media measurements (package c34): the check page's media.mjs
// (debug builds only), its driver tools/check-media-apk.mjs and the clips'
// script tools/make-phone-clips.sh. The measurements themselves run on the
// phone (app/README.md, "On the phone"); here: the page's helpers, that the
// driver runs every measurement the package asks for and puts the phone back,
// and that nothing of it reaches the shipped dist/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const APP = path.resolve(__dirname, '..', '..', 'app');
const read = rel => fs.readFileSync(path.join(APP, rel), 'utf8');
const media = () => import(pathToFileURL(path.join(APP, 'debug', 'media.mjs')).href);

test('media.mjs loads in Node without a page and exposes the measurements', async () => {
  const m = await media();
  for (const k of ['open', 'decodeRate', 'frameAtRandom', 'step', 'stepCached', 'seekCached', 'rotateCost', 'cut']) assert.equal(typeof m.c34[k], 'function', k);
});

test('prng: seeded, so a run\'s random times can be drawn again; values in [0, 1)', async () => {
  const { prng } = await media();
  const a = prng(3), b = prng(3), c = prng(4);
  const xs = Array.from({ length: 50 }, () => a());
  assert.deepEqual(Array.from({ length: 50 }, () => b()), xs);
  assert.notDeepEqual(Array.from({ length: 50 }, () => c()), xs);
  assert.ok(xs.every(x => x >= 0 && x < 1));
  assert.ok(new Set(xs).size === 50);
});

test('spacing: the gaps between frame times in ms, with how many distinct ones', async () => {
  const { spacing } = await media();
  const cfr = spacing(Array.from({ length: 61 }, (_, i) => i / 60));
  assert.equal(cfr.frames, 61);
  assert.equal(cfr.ms.n, 60);
  assert.equal(cfr.ms.median, 16.7);
  assert.equal(cfr.distinctSpacings, 1);
  // frames n of 0..9 with n % 5 < 3 kept, at n/30 s (tests/app/clips' -vfr)
  const vfr = spacing([0, 1, 2, 5, 6, 7].map(n => n / 30));
  assert.deepEqual(vfr.first, [33.333, 33.333, 100, 33.333, 33.333]);
  assert.equal(vfr.distinctSpacings, 2);
  assert.equal(vfr.ms.max, 100);
});

test('median: of the finite numbers, null for none', async () => {
  const { median } = await media();
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([null, NaN, 'x']), null);
});

test('check-media-apk.mjs runs every measurement of c34 five times and puts the phone back', () => {
  const src = read('tools/check-media-apk.mjs');
  assert.match(src, /arg\('--runs', 5\)/, 'five runs by default: numbers are medians of at least five');
  for (const clip of ['k1', 'k2to5', 'p60', 'rot90', 'rot90p60', 'vfr', 'hevc', 'big']) assert.match(src, new RegExp(`'${clip}'`), clip);
  for (const call of ["'open'", "'decodeRate'", "'frameAtRandom'", "'step'", "'stepCached'", "'seekCached'", "'rotateCost'", "'cut'"]) assert.ok(src.includes(call), call);
  assert.match(src, /consumerMs: 100/, 'the backpressure run: a consumer taking 100 ms a frame');
  assert.match(src, /consumerMs: 0/, 'the plain decode rate');
  assert.match(src, /keep: true/, 'keepVideo itself, into OPFS');
  // the phone named in every adb call, and put back after
  assert.match(src, /execFileSync\('adb', \['-s', SERIAL/);
  assert.match(src, /spawn\('adb', \['-s', SERIAL/);
  assert.doesNotMatch(src, /'adb', \[(?!'-s')/, 'no adb call without -s');
  assert.match(src, /forward', '--remove'/);
  assert.match(src, /adb\('uninstall', PKG\)/);
  assert.match(src, /run-as \$\{PKG\} rm -r files\/c34/);
  assert.match(src, /rm -f \$\{TMP\}-clip\.mp4/);
  assert.doesNotMatch(src, /\breverse\b/, 'no adb reverse');
  // the clips go into the app's own files/, set on the input with no picker
  assert.match(src, /DOM\.setFileInputFiles/);
  assert.match(src, /files\/c34\//);
});

test('make-phone-clips.sh: the clips c34 names, into a folder given outside the repo; an unknown clip is refused', () => {
  const src = read('tools/make-phone-clips.sh');
  for (const c of ['k1)', 'k2to5)', 'p60)', 'rot90)', 'rot90p60)', 'vfr)', 'hevc)', 'big)']) assert.ok(src.includes(c), c);
  assert.match(src, /-g 30 -keyint_min 30 -sc_threshold 0/, 'a keyframe every 1 s');
  assert.match(src, /-force_key_frames 0,3,5,9,11,16,20,22,27,30,34,36,41,45,47,52,55/, 'keyframes 2-5 s apart');
  assert.match(src, /-display_rotation -90/, "the file's 90° clockwise rotation");
  assert.match(src, /libx265/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c34-clips-'));
  try {
    const r = spawnSync('bash', [path.join(APP, 'tools', 'make-phone-clips.sh'), dir, 'nope'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no clip 'nope'/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the media checks are on the check page only: debug/check.html loads media.mjs, the app links nowhere into it', () => {
  const page = read('debug/check.html');
  assert.match(page, /<input id="media" type="file" accept="video\/\*" multiple>/);
  assert.match(page, /<script type="module" src="\.\/media\.mjs"><\/script>/);
  for (const f of ['index.html', 'src/main.mjs']) assert.doesNotMatch(read(f), /media\.mjs|c34/, f);
});

test('the shipped dist/ has no media checks; --debug has them', async () => {
  const { assemble } = await import(pathToFileURL(path.join(APP, 'tools', 'assemble.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c34-dist-'));
  try {
    const src = path.resolve(APP, '..', 'src');
    assemble({ out: path.join(tmp, 'ship'), app: APP, src, log: () => {} });
    assemble({ out: path.join(tmp, 'debug'), app: APP, src, debug: true, log: () => {} });
    assert.ok(!fs.existsSync(path.join(tmp, 'ship', 'debug')), 'no debug/ in the shipped dist/');
    const files = JSON.parse(fs.readFileSync(path.join(tmp, 'ship', 'files.json'), 'utf8'));
    assert.ok(!JSON.stringify(files).includes('media.mjs'), 'files.json lists no media.mjs');
    assert.ok(fs.existsSync(path.join(tmp, 'debug', 'debug', 'media.mjs')));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
