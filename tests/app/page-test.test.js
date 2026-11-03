'use strict';
// The page test's parts that run in Node (package c21): the replay engine behind the real pose client, the test
// build (assemble.mjs --test) and that the shipped dist/ has none of it, and the script's no-browser behaviour.
// The page test itself, in a real browser, is `npm --prefix app run test:page` (app/tools/page-test.mjs); its
// faults (--break) are how it is shown to fail.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const load = (...p) => import(pathToFileURL(path.join(ROOT, ...p)).href);
const readTrack = stem => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'global', 'example', `${stem}.track.json`), 'utf8'));

// a stand-in VideoFrame, as pose-engine.test.js has
function fakeFrame(w = 108, h = 192, timestamp = 0) {
  const f = { displayWidth: w, displayHeight: h, timestamp, closes: 0, close() { f.closes++; } };
  return f;
}

async function replayOf() {
  const { createReplay } = await load('app', 'page-test', 'replay.mjs');
  return createReplay([
    { id: 'example/lateral-raise-cable-1', lift: 'lateral-raise', track: readTrack('lateral-raise-cable-1') },
    { id: 'example/athlete-a-trim', lift: 'snatch', track: readTrack('athlete-a-trim') },
  ]);
}

const frameTimes = (n, fps) => Array.from({ length: n }, (_, i) => i / fps);

test('replay: through the real pose client, the k-th frame gets the k-th frame of the fixture track', async () => {
  const replay = await replayOf();
  const { PoseEngine } = await load('app', 'src', 'pose', 'pose-client.mjs');
  const { framesFromTrack } = await load('app', 'src', 'contracts', 'track.mjs');
  const track = readTrack('lateral-raise-cable-1');
  const want = framesFromTrack(track);
  const src = replay.source({ info: { fps: 25, width: 108, height: 192 }, frameTimes: frameTimes(75, 25) });
  const engine = await PoseEngine.create({ backend: 'cpu', createWorker: () => replay.createWorker() });
  assert.deepEqual(engine.info.model, 'replay-fixture');
  for (let k = 0; k < 75; k++) {
    const frame = fakeFrame(src.info.width, src.info.height);
    const r = await engine.estimate(frame, k * 40);
    assert.deepEqual(r.keypoints, want[k].keypoints, `frame ${k}`);
    assert.equal(frame.closes, 1, 'the worker closes the frame, once');
  }
  // past the end is a failed estimate, not a made-up pose
  await assert.rejects(engine.estimate(fakeFrame(), 3000), /frame 75 was asked for/);
  // a reset starts the track again
  await engine.reset();
  const again = await engine.estimate(fakeFrame(), 0);
  assert.deepEqual(again.keypoints, want[0].keypoints);
  engine.close();
});

test('replay: the clip picks the track by its rate and frame count, and the job gets the fixture’s fps, width and height', async () => {
  const replay = await replayOf();
  const snatch = readTrack('athlete-a-trim').meta;
  const src = replay.source({ info: { fps: 30, width: 108, height: 192, duration: 3.57 }, frameTimes: frameTimes(107, 30), close() {} });
  assert.equal(src.info.fps, snatch.fps);
  assert.equal(src.info.width, snatch.width);
  assert.equal(src.info.height, snatch.height);
  assert.equal(src.info.duration, 3.57, 'the rest of the clip’s info is the clip’s');
  assert.equal(src.frameTimes.length, 107);
  assert.throws(() => replay.source({ info: { fps: 24, width: 108, height: 192 }, frameTimes: frameTimes(75, 24) }), /no fixture track matches a clip of 24 fps and 75 frames/);
  // an engine asked before any clip was opened has no track
  const bare = await replayOf();
  await assert.rejects(bare.engine.estimate(fakeFrame(), 0), /no clip was opened/);
});

test('replay: each lift’s clips match their fixture (the committed test clips, ffprobe when present)', t => {
  const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_frames', '-of', 'csv=p=0',
    path.join(ROOT, 'tests', 'app', 'clips', 'testsrc2-lateral-raise-25fps-75f.mp4')], { encoding: 'utf8' });
  if (probe.error) { t.skip('no ffprobe'); return; }
  for (const [clip, stem, fps, frames] of [['testsrc2-lateral-raise-25fps-75f.mp4', 'lateral-raise-cable-1', 25, 75], ['testsrc2-snatch-30fps-107f.mp4', 'athlete-a-trim', 30, 107]]) {
    const file = path.join(ROOT, 'tests', 'app', 'clips', clip);
    const out = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim();
    assert.equal(out, `h264,108,192,${fps}/1,${frames}`, clip);
    const meta = readTrack(stem).meta;
    assert.equal(meta.fps, fps);
    assert.equal(meta.frame_count, frames);
    assert.ok(fs.statSync(file).size < 20000, `${clip} is a few kB`);
  }
});

const listAll = dir => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/'));

test('assemble --test: the replay engine, the boot, the two tracks and the boot before main.mjs; the shipped dist has none', async () => {
  const { assemble, TEST_TRACKS } = await load('app', 'tools', 'assemble.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-page-test-'));
  try {
    const shipped = path.join(tmp, 'shipped'), testing = path.join(tmp, 'test');
    const a = assemble({ out: shipped, app: APP, src: path.join(ROOT, 'src'), log: () => {} });
    const b = assemble({ out: testing, app: APP, src: path.join(ROOT, 'src'), test: true, log: () => {} });

    // the shipped one: no replay engine, no fixture track, no boot, index.html as in app/
    assert.ok(!a.files.some(f => f.startsWith('page-test/')), 'no page-test/ in the shipped dist');
    for (const f of listAll(shipped)) {
      assert.ok(!/replay|\.track\.json$/.test(f), `${f} must not ship`);
      if (/\.(mjs|js|json|html)$/.test(f) && f !== 'package.json') {   // package.json lists the scripts, test:page among them
        const text = fs.readFileSync(path.join(shipped, f), 'utf8');
        assert.ok(!text.includes('replay-fixture') && !text.includes('page-test'), `${f} must not mention the replay engine or the page-test folder`);
      }
    }
    assert.equal(fs.readFileSync(path.join(shipped, 'index.html'), 'utf8'), fs.readFileSync(path.join(APP, 'index.html'), 'utf8'));

    // the test one
    for (const f of ['page-test/boot.mjs', 'page-test/replay.mjs', 'page-test/tracks.json', ...TEST_TRACKS.map(t => `page-test/${t.file}`)]) assert.ok(b.files.includes(f), `${f} is in the test build`);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(testing, 'page-test', 'tracks.json'), 'utf8')), TEST_TRACKS);
    for (const t of TEST_TRACKS) {   // the committed track, byte for byte
      assert.deepEqual(fs.readFileSync(path.join(testing, 'page-test', t.file)), fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'global', 'example', t.file)));
    }
    const html = fs.readFileSync(path.join(testing, 'index.html'), 'utf8');
    const boot = html.indexOf('./page-test/boot.mjs'), main = html.indexOf('./src/main.mjs');
    assert.ok(boot > 0 && main > boot, 'the boot is loaded before main.mjs');
    assert.notEqual(a.version, b.version);
    // files.json lists the test files, so the service worker caches them for the offline reload
    assert.ok(JSON.parse(fs.readFileSync(path.join(testing, 'files.json'), 'utf8')).files.includes('page-test/replay.mjs'));
    assert.equal(a.files.filter(f => !f.startsWith('page-test/')).length, b.files.filter(f => !f.startsWith('page-test/')).length, 'the test build is the shipped one plus page-test/');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the app’s own sources never name the replay engine', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (e.name === 'node_modules' || e.name === 'android' || e.name === 'dist' || e.name === 'vendor' || e.name === 'page-test' || e.name === 'tools' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
  for (const f of walk(APP).filter(f => /\.(mjs|js|html)$/.test(f))) {
    assert.ok(!/replay-fixture|page-test/.test(fs.readFileSync(f, 'utf8')), `${path.relative(ROOT, f)}`);
  }
});

test('page-test.mjs: no browser fails with one clear line, and COACH_PAGE_TEST_SKIP=1 skips', () => {
  const script = path.join(APP, 'tools', 'page-test.mjs');
  const env = { ...process.env, PATH: '/nonexistent', COACH_BROWSER: '' };
  const failed = spawnSync(process.execPath, [script, '--browser', '/nonexistent/browser'], { encoding: 'utf8', env });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /^page-test: FAILED: no Brave or Chromium found/);
  assert.equal(failed.stderr.trim().split('\n').length, 1);
  const skipped = spawnSync(process.execPath, [script, '--browser', '/nonexistent/browser'], { encoding: 'utf8', env: { ...env, COACH_PAGE_TEST_SKIP: '1' } });
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /^page-test: SKIPPED: no Brave or Chromium found/);
  const bad = spawnSync(process.execPath, [script, '--break', 'nonsense'], { encoding: 'utf8', env });
  assert.equal(bad.status, 2);
});

test('d54 the shift check: the same boxes to 0.5 px pass; a control that moved, or is gone, fails naming the control and the step', async () => {
  const { MARK_CONTROLS, SHIFT_STEPS, SHIFT_TOLERANCE_PX, compareBoxes, readBoxes, SHIFT_BREAK } = await load('app', 'tools', 'shift-check.mjs');
  assert.deepEqual(MARK_CONTROLS.map(c => c[0]), ['the header', 'the strip', '‹', 'the text line', '›', '↶', '1 Start', '2 End', '3 Analyse']);
  assert.deepEqual(SHIFT_STEPS, ['M1 before any mark', 'after 1', 'after a refused 2', 'after 2', 'after ↶', 'after 2 again']);
  assert.equal(SHIFT_TOLERANCE_PX, 0.5);
  const base = Object.fromEntries(MARK_CONTROLS.map(([name], i) => [name, { x: 16, y: 60 + 50 * i, w: 84, h: 44 }]));
  assert.deepEqual(compareBoxes(base, structuredClone(base), 'after 1'), []);
  const nudged = structuredClone(base);
  nudged['the strip'].y += 0.4;
  assert.deepEqual(compareBoxes(base, nudged, 'after 1'), [], 'under half a pixel is the same place');
  const moved = structuredClone(base);
  moved['3 Analyse'].y += 6;
  moved['the text line'].h += 20;
  const problems = compareBoxes(base, moved, 'after 2');
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^M moved after 2: the text line .*h 44 → 64/);
  assert.match(problems[1], /^M moved after 2: 3 Analyse .*y 460 → 466/);
  const gone = structuredClone(base);
  gone['↶'] = null;
  assert.deepEqual(compareBoxes(base, gone, 'after ↶'), ['M moved after ↶: ↶ is not on the screen']);
  // the page side reads each control's box by its selector, as stringified for the page
  const boxes = { '.a': { left: 1, top: 2, width: 3, height: 4 } };
  globalThis.document = { querySelector: s => (boxes[s] ? { getBoundingClientRect: () => boxes[s] } : null) };
  try { assert.deepEqual(readBoxes([['a', '.a'], ['b', '.b']]), { a: { x: 1, y: 2, w: 3, h: 4 }, b: null }); } finally { delete globalThis.document; }
  assert.match(SHIFT_BREAK, /data-step="end"/, '--break shift: a row that grows once the start is set');
  // the page test runs it in every walk, and --break shift is one of its faults
  const script = fs.readFileSync(path.join(APP, 'tools', 'page-test.mjs'), 'utf8');
  assert.match(script, /'console', 'http', 'rejection', 'stall', 'hang', 'cards', 'shift'/);
  for (const step of ['after 1', 'after a refused 2', 'after 2', 'after ↶', 'after 2 again']) assert.ok(script.includes(`shift('${step}')`), `the walk compares ${step}`);
  assert.match(script, /button\[data-mark="\$\{kind\}"\]/, 'the walk presses the steps by their hooks');
  assert.doesNotMatch(script, /mark-main/);
});

test('setAppQueueDefaults: the queue made after it uses the store its caller passes, with the defaults\' parts', async () => {
  const { appQueue, setAppQueueDefaults } = await load('app', 'src', 'analysis', 'index.mjs');
  const engine = async () => ({ info: {}, estimate: async () => null, reset: async () => {}, close() {} });
  const open = async () => ({});
  const reads = [];
  const store = { readQueue: async () => { reads.push('callers'); return { jobs: [], rate: null }; }, getLift: async () => null, saveQueue: async () => {} };
  setAppQueueDefaults({ store: { readQueue: async () => { reads.push('defaults'); return { jobs: [], rate: null }; } }, createEngine: engine, openFrameSource: open });
  const queue = appQueue({ store });
  try {
    await queue.load();
    assert.deepEqual(reads, ['callers'], 'the caller\'s store wins over a default');
    assert.equal(appQueue({ store: {} }), queue, 'the queue stays the one');
  } finally { queue.close(); }
});
