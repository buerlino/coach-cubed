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
