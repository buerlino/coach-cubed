// SPDX-License-Identifier: AGPL-3.0-or-later
// app/tools/build-tfjs.mjs and app/tools/fetch-models.sh (package s6): the
// parts that run without the network, the cache or app/node_modules. The
// full build (two clones, three bundles) runs by hand: app/README.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'app');
const load = () => import(path.join(APP, 'tools/build-tfjs.mjs'));

test('the sources are the tags the plan names, each pinned to a full commit', async () => {
  const { SOURCES } = await load();
  // docs/app-plan.md, "The build": tfjs-v4.22.0 and pose-detection-v2.1.3.
  assert.equal(SOURCES.tfjs.tag, 'tfjs-v4.22.0');
  assert.equal(SOURCES['tfjs-models'].tag, 'pose-detection-v2.1.3');
  assert.equal(SOURCES.tfjs.url, 'https://github.com/tensorflow/tfjs.git');
  assert.equal(SOURCES['tfjs-models'].url, 'https://github.com/tensorflow/tfjs-models.git');
  for (const s of Object.values(SOURCES)) assert.match(s.commit, /^[0-9a-f]{40}$/);
});

test('one bundle per backend: WebGL, WebGPU and CPU', async () => {
  const { BUNDLES } = await load();
  assert.deepEqual(Object.keys(BUNDLES).sort(), ['cpu', 'webgl', 'webgpu']);
  assert.equal(BUNDLES.webgl.backend, '@tensorflow/tfjs-backend-webgl');
  assert.equal(BUNDLES.webgpu.backend, '@tensorflow/tfjs-backend-webgpu');
  assert.equal(BUNDLES.cpu.backend, '@tensorflow/tfjs-backend-cpu');
});

test('the cache is $XDG_CACHE_HOME/coach, by default ~/.cache/coach', async () => {
  const { cacheDir } = await load();
  assert.equal(cacheDir({ XDG_CACHE_HOME: '/var/tmp/xdg' }), '/var/tmp/xdg/coach');
  assert.equal(cacheDir({}), path.join(os.homedir(), '.cache', 'coach'));
  // The XDG spec ignores a relative value; so does the build.
  assert.equal(cacheDir({ XDG_CACHE_HOME: 'rel/cache' }), path.join(os.homedir(), '.cache', 'coach'));
});

test('a cache inside the repo is refused before anything is cloned', async () => {
  const { buildTfjs, isInside } = await load();
  assert.ok(isInside(path.join(ROOT, 'app/vendor'), ROOT));
  assert.ok(isInside(ROOT, ROOT));
  assert.ok(!isInside(path.join(os.homedir(), '.cache/coach'), ROOT));
  assert.ok(!isInside(ROOT + '-other', ROOT));
  const inside = path.join(ROOT, 'app', '.cache-test-never-made');
  await assert.rejects(buildTfjs({ cache: inside, out: inside, log() {} }), /inside the repo/);
  assert.ok(!fs.existsSync(inside), 'nothing was made');
});

test("the converter's op lists are written as tfjs's gen_op.ts writes them", async () => {
  const { opListTs } = await load();
  const ts = opListTs('[{"tfOpName": "Add", "category": "arithmetic"}]');
  // gen_op.ts (tfjs-converter/scripts/ at tfjs-v4.22.0): the JSON with its
  // double quotes made single, typed as OpMapper[], under Google's header;
  // the year is the one npm's tfjs-converter 4.22.0 carries
  // (dist/operations/op_list/arithmetic.js: "Copyright 2023 Google LLC").
  assert.match(ts, /\nimport \{OpMapper\} from '\.\.\/types';\n/);
  assert.match(ts, /export const json: OpMapper\[\] = \[\{'tfOpName': 'Add', 'category': 'arithmetic'\}\];\n$/);
  assert.match(ts, / \* @license\n \* Copyright 2023 Google LLC\. All Rights Reserved\./);
});

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'coach-s6-')); }

test('a patch names its files and its reason, and the notice lists each changed file', async () => {
  const { readPatches, patchNotice } = await load();
  const dir = tmpdir();
  try {
    fs.writeFileSync(path.join(dir, '0001-enum.patch'), [
      'Reason: esbuild cannot inline a const enum across files',
      '--- a/tfjs-core/src/a.ts', '+++ b/tfjs-core/src/a.ts', '@@ -1 +1 @@', '-x', '+y',
      '--- a/tfjs-core/src/b.ts', '+++ b/tfjs-core/src/b.ts', '@@ -1 +1 @@', '-x', '+y', ''].join('\n'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a patch');
    const ps = readPatches(dir);
    assert.equal(ps.length, 1);
    assert.deepEqual(ps[0].files, ['tfjs-core/src/a.ts', 'tfjs-core/src/b.ts']);
    assert.equal(ps[0].reason, 'esbuild cannot inline a const enum across files');
    const notice = patchNotice({ tfjs: ps, 'tfjs-models': [] });
    assert.match(notice, /Apache-2\.0 §4\(b\)/);
    assert.match(notice, /tfjs\/tfjs-core\/src\/a\.ts: changed by coach \(0001-enum\.patch: esbuild cannot/);
    assert.match(notice, /tfjs\/tfjs-core\/src\/b\.ts: changed by coach/);
    assert.match(patchNotice({ tfjs: [], 'tfjs-models': [] }), /none; built from the tags unchanged/);
    assert.deepEqual(readPatches(path.join(dir, 'missing')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("every patched file is named in app/README.md (Apache-2.0 §4(b))", async () => {
  const { readPatches } = await load();
  const readme = fs.readFileSync(path.join(APP, 'README.md'), 'utf8');
  const dir = path.join(APP, 'tools/patches');
  const repos = fs.existsSync(dir) ? fs.readdirSync(dir).filter(d => fs.statSync(path.join(dir, d)).isDirectory()) : [];
  for (const repo of repos) {
    assert.ok(['tfjs', 'tfjs-models'].includes(repo), `patches/${repo}: not a source`);
    for (const p of readPatches(path.join(dir, repo))) {
      assert.ok(p.reason, `${repo}/${p.name} has no "Reason:" line`);
      for (const f of p.files) assert.ok(readme.includes(`${repo}/${f}`), `app/README.md doesn't name ${repo}/${f}`);
    }
  }
  assert.match(readme, /## TF\.js from source/);
});

test('fetch-models.sh pins Thunder v4 to the spike\'s source and SHA-256', () => {
  const app = fs.readFileSync(path.join(APP, 'tools/fetch-models.sh'), 'utf8');
  const spike = fs.readFileSync(path.join(ROOT, 'spike/pose-bench/fetch-models.sh'), 'utf8');
  const row = s => s.match(/"movenet-thunder-4[^|]*\|([^|]+)\|([0-9a-f]{64})"/).slice(1);
  assert.deepEqual(row(app), row(spike));
});

test('fetch-models.sh refuses an archive whose SHA-256 is wrong, and leaves app/models/ alone', () => {
  const xdg = tmpdir();
  const models = path.join(APP, 'models');
  const before = fs.existsSync(models) ? fs.readdirSync(models).sort() : null;
  try {
    fs.mkdirSync(path.join(xdg, 'coach/downloads'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'coach/downloads/movenet-thunder-4.tgz'), 'not the archive');
    const r = spawnSync('bash', [path.join(APP, 'tools/fetch-models.sh')],
      { env: { ...process.env, XDG_CACHE_HOME: xdg }, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /SHA-256 MISMATCH for movenet-thunder-4/);
    const after = fs.existsSync(models) ? fs.readdirSync(models).sort() : null;
    assert.deepEqual(after && after.filter(f => f !== '.gitkeep'), before && before.filter(f => f !== '.gitkeep'));
  } finally { fs.rmSync(xdg, { recursive: true, force: true }); }
});

// The audit of s6, fix round 1: pose-detection 2.1.3's MoveNet load()
// (movenet/detector.ts:518-526 at the tag) falls back to
// https://tfhub.dev/google/tfjs-model/movenet/singlepose/thunder/4 when
// modelUrl is missing. The entry is ours, so its createDetector refuses that.
// Run here on the entry's own text, its imports swapped for stubs (no cache,
// no esbuild): load() must never be reached without a modelUrl.
test("the MoveNet entry's createDetector refuses a config without modelUrl (no tfhub.dev fallback)", async () => {
  const { MOVENET_ENTRY } = await load();
  const body = MOVENET_ENTRY.split('\n')
    .filter(l => !/^import /.test(l) && !/^export (\*|\{[^}]*\}) from /.test(l)).join('\n');
  const stubs = `globalThis.__coachLoads = [];
const load = async c => { globalThis.__coachLoads.push(c); return { detector: c }; };
const SINGLEPOSE_LIGHTNING = 'L', SINGLEPOSE_THUNDER = 'T', MULTIPOSE_LIGHTNING = 'M';
const SupportedModels = { MoveNet: 'MoveNet', BlazePose: 'BlazePose' };
`;
  const entry = await import('data:text/javascript,' + encodeURIComponent(stubs + body));
  for (const cfg of [undefined, {}, { modelType: 'SinglePose.Thunder' }, { modelUrl: '' }]) {
    await assert.rejects(entry.createDetector('MoveNet', cfg), /modelUrl is required/, JSON.stringify(cfg));
  }
  assert.deepEqual(globalThis.__coachLoads, [], 'load() was never called');
  await assert.rejects(entry.createDetector('BlazePose', { modelUrl: 'models/x/model.json' }), /MoveNet only/);
  const cfg = { modelType: 'SinglePose.Thunder', modelUrl: 'models/movenet-thunder-4/model.json' };
  assert.deepEqual(await entry.createDetector('MoveNet', cfg), { detector: cfg });
  delete globalThis.__coachLoads;
});

// The audit of s6, fix round 1: the unpacking folder sits in app/models/,
// which assemble.mjs copies whole into dist/. When tar fails after the
// SHA-256 check (a full disk, a broken archive), set -e stops the script and
// the folder must go with it. A fake sha256sum on PATH lets a broken archive
// past the check, so the real tar fails on it.
test('fetch-models.sh leaves no unpacking folder in app/models/ when tar fails', () => {
  const xdg = tmpdir();
  const bin = tmpdir();
  const models = path.join(APP, 'models');
  const hidden = () => (fs.existsSync(models) ? fs.readdirSync(models) : []).filter(f => f.startsWith('.movenet-thunder-4.'));
  const before = hidden();
  try {
    const sha = fs.readFileSync(path.join(APP, 'tools/fetch-models.sh'), 'utf8')
      .match(/"movenet-thunder-4\|[^|]+\|([0-9a-f]{64})"/)[1];
    fs.writeFileSync(path.join(bin, 'sha256sum'), `#!/bin/sh\necho "${sha}  $1"\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(xdg, 'coach/downloads'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'coach/downloads/movenet-thunder-4.tgz'), 'not a gzip archive');
    const r = spawnSync('bash', [path.join(APP, 'tools/fetch-models.sh')],
      { env: { ...process.env, XDG_CACHE_HOME: xdg, PATH: bin + path.delimiter + process.env.PATH },
        encoding: 'utf8', timeout: 30000 });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /sha256 ok/, 'the fake hash got the archive past the check');
    assert.deepEqual(hidden().filter(f => !before.includes(f)), [], 'no .movenet-thunder-4.* left in app/models/');
  } finally {
    for (const f of hidden().filter(f => !before.includes(f))) fs.rmSync(path.join(models, f), { recursive: true, force: true });
    fs.rmSync(xdg, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("npm's @tensorflow packages among a bundle's inputs are found, the tag's sources are not", async () => {
  const { npmTensorflowInputs } = await load();
  const fromSource = ['../../.cache/coach/tfjs-v4.22.0/tfjs-core/src/index.ts', 'node_modules/long/src/long.js',
    'node_modules/seedrandom/seedrandom.js', '../../.cache/coach/pose-detection-v2.1.3/pose-detection/src/movenet/detector.ts'];
  assert.deepEqual(npmTensorflowInputs(fromSource), []);
  const npm = ['node_modules/@tensorflow/tfjs-core/dist/index.js', 'app/node_modules/@tensorflow-models/pose-detection/dist/index.js',
    'C:\\x\\node_modules\\@tensorflow\\tfjs-converter\\dist\\index.js'];
  assert.deepEqual(npmTensorflowInputs([...fromSource, ...npm]), npm);
  // build-info.json records the count, and the parity script reads the same key
  const src = fs.readFileSync(path.join(APP, 'tools/build-tfjs.mjs'), 'utf8');
  assert.match(src, /npmTensorflowInputs: npmInputs\.length/);
  assert.match(fs.readFileSync(path.join(APP, 'tools/parity-tfjs.mjs'), 'utf8'), /\.npmTensorflowInputs/);
});
