// app/tools/parity-tfjs.mjs (package s7): the parts that run without the
// from-source bundle, the weights or npm's packages: the inputs the script
// draws, the weights handler, the comparison, and the pins. The run itself
// (both builds on MoveNet Thunder) is by hand: app/README.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'app');
const load = () => import(path.join(APP, 'tools/parity-tfjs.mjs'));

test('npm\'s packages are dev-only in app/package.json, at the versions the spike pins', () => {
  const app = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  const spike = JSON.parse(fs.readFileSync(path.join(ROOT, 'spike/pose-bench/package.json'), 'utf8')).dependencies;
  for (const name of ['@tensorflow/tfjs-core', '@tensorflow/tfjs-converter', '@tensorflow/tfjs-backend-webgpu',
    '@tensorflow-models/pose-detection']) {
    assert.equal(app.devDependencies[name], spike[name], name);
    assert.equal(app.dependencies?.[name], undefined, `${name} must not be a runtime dependency`);
  }
  // The CPU backend is not in the spike's package.json (it runs the browser backends); it is 4.22.0 like the rest.
  assert.equal(app.devDependencies['@tensorflow/tfjs-backend-cpu'], spike['@tensorflow/tfjs-core']);
});

test('the lock file carries the packages', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(APP, 'package-lock.json'), 'utf8')).packages;
  for (const name of ['@tensorflow/tfjs-core', '@tensorflow/tfjs-converter', '@tensorflow/tfjs-backend-cpu',
    '@tensorflow-models/pose-detection']) {
    assert.ok(lock[`node_modules/${name}`], name);
    assert.equal(lock[`node_modules/${name}`].dev, true, `${name} is dev-only`);
  }
});

test('the fixed tensor is the same every time, in 0..255, and not flat', async () => {
  const { fixedInput } = await load();
  const a = fixedInput(), b = fixedInput();
  assert.deepEqual(a.shape, [1, 256, 256, 3]);
  assert.equal(a.data.length, 256 * 256 * 3);
  assert.deepEqual(a.data, b.data);
  assert.ok(a.data.every(v => v >= 0 && v <= 255));
  assert.ok(new Set(a.data).size > 200);
});

test('the noise pattern is deterministic and differs by seed', async () => {
  const { noiseImage } = await load();
  const a = noiseImage({ width: 64, height: 48 }, 0), b = noiseImage({ width: 64, height: 48 }, 0), c = noiseImage({ width: 64, height: 48 }, 1);
  assert.deepEqual(a.shape, [48, 64, 3]);
  assert.deepEqual(a.data, b.data);
  assert.notDeepEqual(a.data, c.data);
  assert.ok(a.data.every(v => v >= 0 && v <= 255));
});

test('the figure is drawn at its joints, moves between frames, and is the same on a redraw', async () => {
  const { figureImage, figureJoints, IMAGE } = await load();
  const f0 = figureImage(0), f5 = figureImage(5), again = figureImage(0);
  assert.deepEqual(f0.shape, [IMAGE.height, IMAGE.width, 3]);
  assert.deepEqual(f0.data, again.data);
  assert.notDeepEqual(f0.data, f5.data);
  const px = (img, [x, y]) => {
    const i = (Math.round(y * IMAGE.height) * IMAGE.width + Math.round(x * IMAGE.width)) * 3;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  // The head disc is skin-coloured at the nose; the wall behind it is grey.
  px(f0, figureJoints(0).nose).forEach((v, i) => assert.ok(Math.abs(v - [225, 175, 140][i]) <= 3, 'skin at the nose, shaded at most a little'));
  assert.deepEqual(px(f0, [0.02, 0.5]).slice(0, 2).every(v => v >= 170 && v <= 200), true);
  // The arms rise: the wrists are higher up in the last frame (smaller y).
  assert.ok(figureJoints(5).lWrist[1] < figureJoints(0).lWrist[1]);
});

test('diskHandler joins the shards in manifest order and lists the specs', async () => {
  const { diskHandler } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-parity-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify({
      format: 'graph-model', generatedBy: 'g', convertedBy: 'c', modelTopology: { node: [] },
      weightsManifest: [
        { paths: ['a.bin', 'b.bin'], weights: [{ name: 'w1', shape: [2], dtype: 'float32' }] },
        { paths: ['c.bin'], weights: [{ name: 'w2', shape: [1], dtype: 'int32' }] },
      ],
    }));
    fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.from([1, 2]));
    fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([3]));
    fs.writeFileSync(path.join(dir, 'c.bin'), Buffer.from([4, 5]));
    const art = await diskHandler(dir).load();
    assert.deepEqual([...new Uint8Array(art.weightData)], [1, 2, 3, 4, 5]);
    assert.deepEqual(art.weightSpecs.map(s => s.name), ['w1', 'w2']);
    assert.equal(art.format, 'graph-model');
    assert.deepEqual(art.modelTopology, { node: [] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('absDiff: max and mean of |a-b|; a different length is no number', async () => {
  const { absDiff } = await load();
  assert.deepEqual(absDiff([1, 2, 4], [1, 2.5, 3]), { n: 3, max: 1, mean: 0.5 });
  assert.equal(absDiff([1], [1, 2]), null);
  assert.equal(absDiff([1], null), null);
  assert.deepEqual(absDiff(null, null), { n: 0, max: 0, mean: 0 });
  assert.ok(Number.isNaN(absDiff([NaN], [1]).max), 'a NaN is a difference, not a pass');
});

const side = (raw, kp = [10, 20, 0.5]) => ({
  scenarios: { figure: { calls: [
    { raw, keypoints: kp, cropBefore: null, cropAfter: [0, 0, 1, 1] },
    { raw, keypoints: kp, cropBefore: [0, 0, 1, 1], cropAfter: [0, 0, 1, 1] },
  ] } },
});

test('compare: identical sides are identical, rounding passes, a real difference does not', async () => {
  const { compare, ROUNDING } = await load();
  const base = [0.1, 0.2, 0.3];
  const same = compare(side(base), side(base));
  assert.ok(same.length >= 3);
  assert.ok(same.every(r => r.exact && r.ok && r.max === 0 && r.mean === 0));
  const round = compare(side(base), side(base.map(v => v + ROUNDING.raw / 2)));
  const raw = round.find(r => r.output === 'raw');
  assert.ok(raw.ok && !raw.exact);
  const off = compare(side(base), side([0.1, 0.2, 0.31]));
  const rawOff = off.find(r => r.output === 'raw');
  assert.equal(rawOff.ok, false);
  assert.ok(Math.abs(rawOff.max - 0.01) < 1e-12);
  assert.ok(Math.abs(rawOff.mean - 0.01 / 3) < 1e-12, 'the mean is over every value of every call');
  assert.ok(off.filter(r => r.output !== 'raw').every(r => r.ok), 'one output at a time');
});

test('compare: a missing call or a different size is a finding, and formatRows names it', async () => {
  const { compare, formatRows } = await load();
  const a = side([1, 2, 3]), b = side([1, 2]);
  const rows = compare(a, b);
  const raw = rows.find(r => r.output === 'raw');
  assert.ok(raw.shapeMismatch && !raw.ok);
  assert.match(formatRows(rows), /SHAPE DIFFERS/);
  assert.match(formatRows(compare(a, side([1, 2, 4]))), /DIFFERENT/);
  assert.match(formatRows(compare(a, a)), /identical/);
});

test('without the build, the weights or npm\'s packages the script says what is missing and exits 2', () => {
  // A copy of the script in <tmp>/app/tools/: its APP is an empty tree, so the
  // test runs whatever this tree holds.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-parity-test-'));
  try {
    fs.mkdirSync(path.join(tmp, 'app/tools'), { recursive: true });
    const script = path.join(tmp, 'app/tools/parity-tfjs.mjs');
    fs.copyFileSync(path.join(APP, 'tools/parity-tfjs.mjs'), script);
    const r = require('node:child_process').spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /missing: /);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a source bundle whose build-info.json lacks the npm-free record is refused, exit 2', async () => {
  const { sourceBundleProblem } = await load();
  assert.match(sourceBundleProblem(null), /no record/);
  assert.match(sourceBundleProblem({ bundles: { 'tfjs-cpu.mjs': { inputs: 3 } } }), /lacks the npmTensorflowInputs/);
  assert.match(sourceBundleProblem({ bundles: { 'tfjs-cpu.mjs': { npmTensorflowInputs: 2 } } }), /2 inputs from npm/);
  assert.equal(sourceBundleProblem({ bundles: { 'tfjs-cpu.mjs': { npmTensorflowInputs: 0 } } }), null);
});

test('main exits 2 on a build-info.json without the record (everything else in place)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-parity-test-'));
  try {
    const a = path.join(tmp, 'app');
    fs.mkdirSync(path.join(a, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(a, 'vendor/tfjs'), { recursive: true });
    fs.mkdirSync(path.join(a, 'models/movenet-thunder-4'), { recursive: true });
    fs.mkdirSync(path.join(a, 'node_modules/@tensorflow/tfjs-core'), { recursive: true });
    fs.writeFileSync(path.join(a, 'vendor/tfjs/tfjs-cpu.mjs'), '');
    fs.writeFileSync(path.join(a, 'models/movenet-thunder-4/model.json'), '{}');
    fs.writeFileSync(path.join(a, 'node_modules/@tensorflow/tfjs-core/package.json'), '{}');
    fs.writeFileSync(path.join(a, 'vendor/tfjs/build-info.json'), JSON.stringify({ bundles: { 'tfjs-cpu.mjs': { inputs: 5 } } }));
    const script = path.join(a, 'tools/parity-tfjs.mjs');
    fs.copyFileSync(path.join(APP, 'tools/parity-tfjs.mjs'), script);
    const r = require('node:child_process').spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /missing: .*npmTensorflowInputs/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
