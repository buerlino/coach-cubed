// node app/tools/parity-tfjs.mjs [--calls N] [--json <file>]
//
// s7: does the from-source bundle (build-tfjs.mjs) give npm's numbers?
// MoveNet SinglePose Thunder on the CPU backend, in Node, on the same inputs
// through two builds of TF.js 4.22.0 and pose-detection 2.1.3:
//   npm     the packages at the spike's pinned versions (devDependencies of
//           app/package.json, never in dist/), bundled in memory the way the
//           spike bundles them (spike/pose-bench/build-tfjs.mjs: esbuild, the
//           packages' "module" builds, @mediapipe/pose stubbed);
//   source  app/vendor/tfjs/tfjs-cpu.mjs, built from source by build-tfjs.mjs.
// Each build runs in a child process of its own: tfjs-core keeps its engine,
// kernel registry and flags on globalThis, so two copies in one process would
// share them and compare a build with itself.
//
// The inputs, all drawn here (no third-party image, no random generator):
//   fixed-tensor   the graph model alone on one [1,256,256,3] int32 tensor;
//   noise          estimatePoses() on a 640x480 pattern, CALLS times in a row
//                  (MoveNet finds no person in it: raw outputs only);
//   figure         estimatePoses() on a shaded figure the script draws, moved a
//                  little each frame, CALLS times in a row (found, so the crop
//                  follows the pose);
//   figure-crop    the same frames with the crop set to the figure's box before
//                  each call, the same on both sides.
// MoveNet crops each call from the last pose, so the sequences check that the
// crop (filtered, carried from call to call) agrees as well. Per call the
// script keeps the model's raw output ([1,1,17,3], what graph.execute returns
// inside the detector), the keypoints estimatePoses() hands back and the crop
// region it used. The comparison: maximum and mean absolute difference per
// output, and the names of the CPU kernels each build registers. Expected zero, or float rounding; anything beyond is a finding (an op,
// a patch), not a number to tune: exit 1.
//
// Needs `npm --prefix app ci`, build-tfjs.mjs's bundle and fetch-models.sh's
// weights. About 3.5 minutes of CPU in all (the CPU backend runs MoveNet Thunder at
// several seconds a call; measured niced on the shared laptop): run it through
// `pipeline/devlock.sh slice` (one slice is ten minutes at most; it lowers its own priority too).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setPriority, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
export const MODEL_DIR = join(APP, 'models/movenet-thunder-4');
export const SOURCE_BUNDLE = join(APP, 'vendor/tfjs/tfjs-cpu.mjs');
export const CALLS = 6;
export const IMAGE = { width: 640, height: 480 };

// "Float rounding": the two builds run the same JavaScript, so zero is what
// is expected. A float32 is exact to about 6e-8 near 1; the model's raw
// output is in [0, 1] and the keypoints and the crop (pixels in the frame,
// up to 640) carry that spacing times 640. Beyond these is a difference.
export const ROUNDING = { raw: 1e-6, keypoints: 1e-4, crop: 1e-4 };

// The record build-tfjs.mjs keeps in build-info.json: after each bundle it
// checks that no input came from npm's @tensorflow packages (which sit in
// app/node_modules/ for this script) and stores the count, 0. Without it the
// "source" bundle may be npm's code and this comparison npm against npm.
export function sourceBundleProblem(info, file = 'tfjs-cpu.mjs') {
  const b = info && info.bundles && info.bundles[file];
  if (!b) return `build-info.json has no record of ${file}`;
  if (b.npmTensorflowInputs === undefined) return `build-info.json lacks the npmTensorflowInputs check for ${file} (build again: node app/tools/build-tfjs.mjs)`;
  if (b.npmTensorflowInputs !== 0) return `${file} has ${b.npmTensorflowInputs} inputs from npm's @tensorflow packages`;
  return null;
}

// ---- the inputs --------------------------------------------------------

// A byte from three integers, the same on every machine: an integer hash
// (Math.imul and shifts), no Math.random, no seeded generator from a library.
export function hashByte(a, b = 0, c = 0) {
  let h = Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b) ^ Math.imul(c + 1, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h & 255;
}

// The fixed tensor for the model alone: [1, 256, 256, 3] values 0..255.
export function fixedInput(side = 256) {
  const data = new Int32Array(side * side * 3);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) for (let c = 0; c < 3; c++) {
    data[(y * side + x) * 3 + c] = hashByte(y, x, c);
  }
  return { data, shape: [1, side, side, 3] };
}

// A 640x480 pattern: smooth gradients plus hash noise, so the model sees
// edges and texture (what it scores is not the point; both builds get it).
export function noiseImage({ width, height } = IMAGE, seed = 0) {
  const data = new Int32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    data[i] = (x * 255 / width + hashByte(y, x, seed) / 4) & 255;
    data[i + 1] = (y * 255 / height + hashByte(x, y, seed + 1) / 4) & 255;
    data[i + 2] = ((x + y) * 255 / (width + height) + hashByte(x + y, seed, 2) / 4) & 255;
  }
  return { data, shape: [height, width, 3] };
}

// COCO-17 stick figure as joint positions in 0..1 of the frame (x, y), for
// frame k of the sequence: it stands, the arms rise and the body drifts.
export function figureJoints(k, calls = CALLS) {
  const t = calls > 1 ? k / (calls - 1) : 0;
  const cx = 0.45 + 0.1 * t, top = 0.12 + 0.02 * t;
  const arm = 0.25 * t;
  return {
    nose: [cx, top + 0.04], lEye: [cx - 0.012, top + 0.03], rEye: [cx + 0.012, top + 0.03],
    lEar: [cx - 0.03, top + 0.04], rEar: [cx + 0.03, top + 0.04],
    lShoulder: [cx - 0.08, top + 0.14], rShoulder: [cx + 0.08, top + 0.14],
    lElbow: [cx - 0.11, top + 0.26 - arm], rElbow: [cx + 0.11, top + 0.26 - arm],
    lWrist: [cx - 0.12, top + 0.37 - 2 * arm], rWrist: [cx + 0.12, top + 0.37 - 2 * arm],
    lHip: [cx - 0.06, top + 0.42], rHip: [cx + 0.06, top + 0.42],
    lKnee: [cx - 0.07, top + 0.60], rKnee: [cx + 0.07, top + 0.60],
    lAnkle: [cx - 0.075, top + 0.80], rAnkle: [cx + 0.075, top + 0.80],
  };
}
export const FIGURE_BONES = [
  // [from, to, radius at 640 px wide, colour]: shirt, arms (sleeve then skin), trousers, shoes
  ['lShoulder', 'lHip', 30, [60, 90, 170]], ['rShoulder', 'rHip', 30, [60, 90, 170]],
  ['lHip', 'rHip', 30, [50, 60, 90]], ['lShoulder', 'rShoulder', 22, [60, 90, 170]],
  ['lShoulder', 'lElbow', 17, [60, 90, 170]], ['lElbow', 'lWrist', 13, [225, 175, 140]],
  ['rShoulder', 'rElbow', 17, [60, 90, 170]], ['rElbow', 'rWrist', 13, [225, 175, 140]],
  ['lHip', 'lKnee', 22, [50, 60, 90]], ['lKnee', 'lAnkle', 17, [50, 60, 90]],
  ['rHip', 'rKnee', 22, [50, 60, 90]], ['rKnee', 'rAnkle', 17, [50, 60, 90]],
];

// The figure drawn on a grey wall and a darker floor: filled limbs shaded
// towards their edges (a person-like silhouette, not a line drawing), a head
// with hair and eyes, hands and shoes. Pixels by distance to a segment;
// nothing outside this file.
export function figureImage(k, { width, height } = IMAGE, calls = CALLS) {
  const J = figureJoints(k, calls);
  const px = ([x, y]) => [x * width, y * height];
  const unit = width / 640;
  const data = new Int32Array(width * height * 3);
  const floor = 0.93 * height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3, g = y > floor ? 90 : 170 + (y * 30 / height | 0);
    data[i] = g; data[i + 1] = g; data[i + 2] = g + 6;
  }
  const paint = (x0, y0, x1, y1, r, rgb) => {
    const ax = x1 - x0, ay = y1 - y0, len2 = ax * ax + ay * ay || 1;
    const xa = Math.max(0, Math.floor(Math.min(x0, x1) - r)), xb = Math.min(width - 1, Math.ceil(Math.max(x0, x1) + r));
    const ya = Math.max(0, Math.floor(Math.min(y0, y1) - r)), yb = Math.min(height - 1, Math.ceil(Math.max(y0, y1) + r));
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      const u = Math.max(0, Math.min(1, ((x - x0) * ax + (y - y0) * ay) / len2));
      const dx = x - (x0 + u * ax), dy = y - (y0 + u * ay), d2 = (dx * dx + dy * dy) / (r * r);
      if (d2 <= 1) {
        const shade = 1 - 0.4 * d2, i = (y * width + x) * 3;
        data[i] = rgb[0] * shade | 0; data[i + 1] = rgb[1] * shade | 0; data[i + 2] = rgb[2] * shade | 0;
      }
    }
  };
  const disc = (j, r, rgb) => { const [x, y] = px(j); paint(x, y, x, y, r * unit, rgb); };
  const SKIN = [225, 175, 140], HAIR = [60, 40, 30], SHOE = [30, 30, 30];
  for (const [a, b, r, rgb] of FIGURE_BONES) paint(...px(J[a]), ...px(J[b]), r * unit, rgb);
  for (const j of ['lElbow', 'rElbow']) disc(J[j], 17, [60, 90, 170]);
  for (const j of ['lKnee', 'rKnee']) disc(J[j], 22, [50, 60, 90]);
  for (const j of ['lWrist', 'rWrist']) disc(J[j], 15, SKIN);
  for (const j of ['lAnkle', 'rAnkle']) { const [x, y] = px(J[j]); paint(x - 12 * unit, y + 14 * unit, x + 22 * unit, y + 14 * unit, 14 * unit, SHOE); }
  const [sx, sy] = px([(J.lShoulder[0] + J.rShoulder[0]) / 2, (J.lShoulder[1] + J.rShoulder[1]) / 2]), [nx, ny] = px(J.nose);
  paint(sx, sy, nx, ny + 12 * unit, 12 * unit, SKIN); // neck
  disc(J.nose, 34, SKIN); // head
  const [hx, hy] = px(J.nose);
  paint(hx - 30 * unit, hy - 22 * unit, hx + 30 * unit, hy - 22 * unit, 14 * unit, HAIR);
  for (const e of ['lEye', 'rEye']) disc(J[e], 3.5, [20, 20, 20]);
  const [mx, my] = px([J.nose[0], J.nose[1] + 0.03]);
  paint(mx - 8 * unit, my, mx + 8 * unit, my, 2 * unit, [150, 70, 70]);
  return { data, shape: [height, width, 3] };
}

// ---- the model's weights from disk ---------------------------------------

// An io.IOHandler for a converted model folder (model.json and its shards),
// the same for both builds: the weights are decoded inside each build.
export function diskHandler(dir, fs = { existsSync, readFileSync }) {
  return {
    async load() {
      const json = JSON.parse(fs.readFileSync(join(dir, 'model.json'), 'utf8'));
      const specs = [], buffers = [];
      for (const group of json.weightsManifest) {
        specs.push(...group.weights);
        for (const p of group.paths) {
          const b = fs.readFileSync(join(dir, p));
          buffers.push(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
        }
      }
      const total = buffers.reduce((n, b) => n + b.byteLength, 0);
      const weightData = new Uint8Array(total);
      let at = 0;
      for (const b of buffers) { weightData.set(b, at); at += b.byteLength; }
      return {
        modelTopology: json.modelTopology, weightSpecs: specs, weightData: weightData.buffer,
        format: json.format, generatedBy: json.generatedBy, convertedBy: json.convertedBy,
        signature: json.signature, userDefinedMetadata: json.userDefinedMetadata,
      };
    },
  };
}

// ---- one side ----------------------------------------------------------

// npm's packages as the spike bundles them, in memory, then imported from a
// temporary file outside the repo.
async function loadNpmBundle(tmp) {
  const { build } = await import('esbuild');
  const STUB = "export class Pose { constructor() { throw new Error('@mediapipe/pose is not bundled'); } }";
  const res = await build({
    stdin: {
      contents: `export * as tf from '@tensorflow/tfjs-core';
export * as converter from '@tensorflow/tfjs-converter';
export * as poseDetection from '@tensorflow-models/pose-detection';
import '@tensorflow/tfjs-backend-cpu';
`,
      resolveDir: APP, sourcefile: 'tfjs-npm-cpu-entry.mjs',
    },
    bundle: true, format: 'esm', minify: true, platform: 'node', target: 'es2020',
    mainFields: ['module', 'main'], external: ['node-fetch'],
    write: false, logLevel: 'warning',
    banner: { js: "import { createRequire as __coachCreateRequire } from 'node:module'; const require = __coachCreateRequire(import.meta.url);" },
    plugins: [{ name: 'stub-mediapipe-pose', setup(b) {
      b.onResolve({ filter: /^@mediapipe\/pose$/ }, () => ({ path: 'stub', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB, loader: 'js' }));
    } }],
  });
  const file = join(tmp, 'tfjs-npm-cpu.mjs');
  writeFileSync(file, res.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const f32 = t => Array.from(t.dataSync());

// Everything one build gives, as plain numbers (JSON keeps a double exactly).
export async function runSide(side, { calls = CALLS, tmp = tmpdir() } = {}) {
  const { tf, converter, poseDetection } = side === 'npm' ? await loadNpmBundle(tmp) : await import(pathToFileURL(SOURCE_BUNDLE).href);
  if (!(await tf.setBackend('cpu'))) throw new Error('the cpu backend is not available');
  await tf.ready();
  const out = { side, version: tf.version_core, backend: tf.getBackend(), scenarios: {} };

  const M = poseDetection.SupportedModels.MoveNet;
  const newDetector = () => poseDetection.createDetector(M, {
    modelType: poseDetection.movenet.modelType.SINGLEPOSE_THUNDER, enableSmoothing: false, modelUrl: diskHandler(MODEL_DIR),
  });

  // 1. the graph model alone, on the fixed tensor; then the detector's own
  // step from raw output to keypoints (runSinglePersonPoseModel: no pose-score
  // cut, so there are keypoints whatever the model thinks of the input)
  const graph = await converter.loadGraphModel(diskHandler(MODEL_DIR));
  const fx = fixedInput();
  const fixed = tf.tensor4d(fx.data, fx.shape, 'int32');
  const raw = graph.execute(fixed);
  const fixedCall = { raw: f32(raw), shape: raw.shape };
  fixed.dispose(); raw.dispose(); graph.dispose();
  const det0 = await newDetector();
  const fixed2 = tf.tensor4d(fx.data, fx.shape, 'int32');
  const pose0 = await det0.runSinglePersonPoseModel(fixed2);
  fixed2.dispose(); det0.dispose();
  fixedCall.keypoints = pose0.keypoints.flatMap(p => [p.y, p.x, p.score]);
  fixedCall.score = [pose0.score];
  out.scenarios['fixed-tensor'] = { calls: [fixedCall] };

  // 2. the detector on image sequences, each call cropped from the last pose.
  // MoveNet finds no person in a drawing (and in noise) and then starts again
  // from the whole frame; 'figure-crop' sets the crop to the figure's box
  // before every call, the same on both sides, so cropAndResize runs on a
  // crop that is not the whole frame.
  const figureBox = k => {
    const ys = Object.values(figureJoints(k, calls)).map(p => p[1]), xs = Object.values(figureJoints(k, calls)).map(p => p[0]);
    const yMin = Math.min(...ys) - 0.08, yMax = Math.max(...ys) + 0.08, xMin = Math.min(...xs) - 0.2, xMax = Math.max(...xs) + 0.2;
    return { yMin, xMin, yMax, xMax, height: yMax - yMin, width: xMax - xMin };
  };
  const sequences = {
    noise: { frame: k => noiseImage(IMAGE, k) },
    figure: { frame: k => figureImage(k, IMAGE, calls) },
    'figure-crop': { frame: k => figureImage(k, IMAGE, calls), seed: figureBox },
  };
  for (const [name, { frame, seed }] of Object.entries(sequences)) {
    const det = await newDetector();
    // Watch the model's raw output where the detector reads it.
    const model = det.moveNetModel, execute = model.execute.bind(model), rawOut = [];
    model.execute = (...a) => { const o = execute(...a); rawOut.push(f32(Array.isArray(o) ? o[0] : o)); return o; };
    const rec = [];
    for (let k = 0; k < calls; k++) {
      const im = frame(k), img = tf.tensor3d(im.data, im.shape, 'int32');
      if (seed) det.cropRegion = seed(k);
      const crop = det.cropRegion ? { ...det.cropRegion } : null; // the crop this call will use
      const poses = await det.estimatePoses(img, { maxPoses: 1, flipHorizontal: false });
      img.dispose();
      rec.push({
        raw: rawOut.pop(),
        keypoints: poses[0] ? poses[0].keypoints.flatMap(p => [p.y, p.x, p.score]) : null,
        score: poses[0] ? [poses[0].score] : null,
        cropBefore: crop && [crop.yMin, crop.xMin, crop.yMax, crop.xMax],
        cropAfter: det.cropRegion ? [det.cropRegion.yMin, det.cropRegion.xMin, det.cropRegion.yMax, det.cropRegion.xMax] : null,
      });
    }
    out.scenarios[name] = { calls: rec };
    det.dispose();
  }
  out.kernels = tf.getKernelsForBackend('cpu').map(k => k.kernelName).sort();
  out.tensors = tf.memory().numTensors;
  return out;
}

// ---- the comparison ------------------------------------------------------

// Max and mean |a-b| over two equal-length lists; null if either is missing
// or the lengths differ (a difference of shape is its own finding).
export function absDiff(a, b) {
  if (a == null && b == null) return { n: 0, max: 0, mean: 0 };
  if (a == null || b == null || a.length !== b.length) return null;
  let max = 0, sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (Number.isNaN(d)) return { n: a.length, max: NaN, mean: NaN };
    if (d > max) max = d;
    sum += d;
  }
  return { n: a.length, max, mean: a.length ? sum / a.length : 0 };
}

// One row per scenario and output, over all its calls: the maximum of the
// maxima, the mean over every value. `ok` is max <= the rounding allowed.
export function compare(npm, source) {
  const rows = [];
  for (const [scenario, s] of Object.entries(npm.scenarios)) {
    const t = source.scenarios[scenario];
    const outputs = [['raw', 'raw', ROUNDING.raw], ['keypoints', 'keypoints', ROUNDING.keypoints], ['score', 'raw', ROUNDING.raw],
      ['cropBefore', 'crop', ROUNDING.crop], ['cropAfter', 'crop', ROUNDING.crop]];
    for (const [key, kind, tol] of outputs) {
      // Keypoints stay in the table when no call found a pose (that is a result); the rest only when there are values.
      if (key !== 'keypoints' && !s.calls.some(c => c[key] != null) && !(t && t.calls.some(c => c[key] != null))) continue;
      let n = 0, max = 0, sum = 0, shape = false;
      for (let i = 0; i < s.calls.length; i++) {
        const d = t && t.calls[i] ? absDiff(s.calls[i][key], t.calls[i][key]) : null;
        if (!d) { shape = true; continue; }
        n += d.n; sum += d.mean * d.n; max = d.max > max || Number.isNaN(d.max) ? d.max : max;
      }
      const mean = n ? sum / n : 0;
      const found = c => c.filter(x => x[key] != null).length;
      rows.push({ scenario, output: key, calls: s.calls.length, values: n, found: [found(s.calls), t ? found(t.calls) : 0], max, mean, tolerance: tol,
        exact: !shape && max === 0, ok: !shape && max <= tol, shapeMismatch: shape });
    }
  }
  return rows;
}

export function formatRows(rows) {
  const num = v => (Number.isNaN(v) ? 'NaN' : v === 0 ? '0' : v.toExponential(2));
  const head = ['scenario', 'output', 'values', 'max |diff|', 'mean |diff|', 'verdict'];
  const lines = rows.map(r => [r.scenario, r.output, String(r.values), num(r.max), num(r.mean),
    r.shapeMismatch ? 'SHAPE DIFFERS' : r.values === 0 ? 'no pose found, both' : r.exact ? 'identical' : r.ok ? 'rounding' : 'DIFFERENT']);
  const w = head.map((h, i) => Math.max(h.length, ...lines.map(l => l[i].length)));
  return [head, ...lines].map(l => l.map((c, i) => c.padEnd(w[i])).join('  ')).join('\n');
}

// ---- main ----------------------------------------------------------------

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };

async function main() {
  const sideArg = arg('--side');
  if (sideArg) { // child: one build, its numbers as JSON on stdout
    const result = await runSide(sideArg, { calls: Number(arg('--calls', CALLS)), tmp: arg('--tmp') });
    process.stdout.write(JSON.stringify(result));
    return;
  }
  for (const [what, path] of [['the from-source bundle (node app/tools/build-tfjs.mjs)', SOURCE_BUNDLE],
    ['the MoveNet weights (app/tools/fetch-models.sh)', join(MODEL_DIR, 'model.json')],
    ["npm's packages (npm --prefix app ci)", join(APP, 'node_modules/@tensorflow/tfjs-core/package.json')]]) {
    if (!existsSync(path)) { console.error(`missing: ${what}`); process.exit(2); }
  }
  let info = null;
  try { info = JSON.parse(readFileSync(join(dirname(SOURCE_BUNDLE), 'build-info.json'), 'utf8')); } catch { /* reported below */ }
  const problem = sourceBundleProblem(info);
  if (problem) { console.error(`missing: ${problem}`); process.exit(2); }
  try { setPriority(10); } catch { /* niceness is a courtesy */ }
  const calls = Number(arg('--calls', CALLS));
  const tmp = mkdtempSync(join(tmpdir(), 'coach-parity-tfjs-'));
  const sides = {};
  try {
    for (const side of ['npm', 'source']) {
      const t0 = performance.now();
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--side', side, '--calls', String(calls), '--tmp', tmp],
        { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] });
      if (r.status !== 0) { console.error(`the ${side} side failed (exit ${r.status})`); process.exit(2); }
      sides[side] = JSON.parse(r.stdout);
      sides[side].ms = Math.round(performance.now() - t0);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  const rows = compare(sides.npm, sides.source);
  console.log(`TF.js ${sides.npm.version} (npm) vs ${sides.source.version} (from source), backend ${sides.npm.backend}/${sides.source.backend}, ${calls} calls per sequence`);
  console.log(formatRows(rows));
  const kernelsSame = JSON.stringify(sides.npm.kernels) === JSON.stringify(sides.source.kernels);
  console.log(`cpu kernels registered: ${sides.npm.kernels.length} (npm), ${sides.source.kernels.length} (source), ${kernelsSame ? 'the same names' : 'DIFFERENT NAMES'}`);
  const ok = rows.length > 0 && rows.every(r => r.ok) && kernelsSame && sides.npm.version === sides.source.version;
  console.log(ok ? 'parity: yes' : 'parity: NO, a difference beyond rounding: find the op or the patch before anything else');
  const json = arg('--json');
  if (json) writeFileSync(json, JSON.stringify({ rows, kernels: [sides.npm.kernels.length, sides.source.kernels.length, kernelsSame], ms: { npm: sides.npm.ms, source: sides.source.ms } }, null, 2) + '\n');
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
