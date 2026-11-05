// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// 0.1.0 on https://coach-cubed.org (package c67): the version, a release assemble (CNAME, no
// dot files, no debug or test folders, no dev files), app/tools/check-dist.mjs on it, and the
// Pages workflow, read as text. Built-ins only; every folder is a temp folder (tempDir). The
// worktree has neither gitignored folder (app/vendor/tfjs/, app/models/), so the --release
// case gets a fake app/ that has them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../fixtures.js');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const ASSEMBLE = path.join(APP, 'tools', 'assemble.mjs');
const CHECK = path.join(APP, 'tools', 'check-dist.mjs');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'pages.yml');
const DOMAIN = 'coach-cubed.org';

const tmp = (name) => tempDir(`coach-release-${name}-`);
const put = (base, rel, text = rel) => {
  fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  fs.writeFileSync(path.join(base, rel), text);
};
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
}).sort();
const node = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60000 });
const assemble = (args) => {
  const r = node(ASSEMBLE, args);
  assert.equal(r.status, 0, `assemble failed: ${r.stderr}`);
  return r.stdout;
};
const check = (args) => { const r = node(CHECK, args); return { status: r.status, out: `${r.stdout}${r.stderr}` }; };

// The real app/ assembled once for a release.
let realDist;
const real = () => {
  if (!realDist) { realDist = tmp('real'); assemble(['--cname', DOMAIN, '--out', realDist]); }
  return realDist;
};

// A small app/ with the two gitignored folders a release needs, and a src/ for assemble.
function fakeApp() {
  const root = tmp('fake');
  const app = path.join(root, 'app');
  const src = path.join(root, 'src');
  put(app, 'index.html', '<!doctype html>');
  put(app, 'sw.js', fs.readFileSync(path.join(APP, 'sw.js'), 'utf8'));
  put(app, 'src/main.mjs', 'export {};');
  put(app, 'vendor/tfjs/tfjs-webgl.mjs', 'tf');
  put(app, 'models/movenet-thunder-4/model.json', '{}');
  put(src, 'diagnostics.js', '// diagnostics');
  put(src, 'track/smoothing.mjs', '// smoothing');
  return { root, app, src };
}
const assembleFake = (t, extra = []) => {
  const out = tmp('fake-out');
  assemble(['--app', t.app, '--src', t.src, '--out', out, ...extra]);
  return out;
};
// A copy of a dist/ to break.
const copyOf = (dir) => { const c = tmp('copy'); fs.cpSync(dir, c, { recursive: true }); return c; };

// ---- the version ----
test('the version: app/package.json says 0.1.0 and equals APP_VERSION (store.mjs)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.1.0');
  const m = fs.readFileSync(path.join(APP, 'src', 'store', 'store.mjs'), 'utf8').match(/export const APP_VERSION = '([^']+)';/);
  assert.ok(m, 'APP_VERSION not found in store.mjs');
  assert.equal(m[1], pkg.version);
  const lock = JSON.parse(fs.readFileSync(path.join(APP, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

// ---- an assembled release ----
test('a release assemble: CNAME listed, no dot file, no debug or test folder, no video, no dev file, sw.js stamped', () => {
  const dist = real();
  const files = walk(dist);
  assert.equal(read(dist, 'CNAME'), `${DOMAIN}\n`);
  const list = JSON.parse(read(dist, 'files.json'));
  assert.deepEqual(list.files, files.filter((f) => f !== 'files.json'), 'files.json lists every file but itself, and only those');
  assert.ok(list.files.includes('CNAME'));
  for (const f of files) {
    assert.ok(!f.startsWith('debug/') && !f.startsWith('page-test/'), `${f} is a debug or test file`);
    assert.ok(!/\.mp4$/i.test(f), `${f} is a video`);
    assert.ok(!f.split('/').some((s) => s.startsWith('.')), `${f} starts with a dot`);
    assert.ok(!['README.md', 'package.json', 'package-lock.json'].includes(f), `${f} is a dev file`);
  }
  assert.ok(files.includes('.npmrc') === false);
  assert.match(read(dist, 'sw.js'), new RegExp(`const BUILT_VERSION = "${list.version}";`));
});

test('without --cname nothing changes: no CNAME', () => {
  const t = fakeApp();
  const files = walk(assembleFake(t));
  assert.ok(!files.includes('CNAME'));
});

test('--cname writes CNAME before the hash: the version changes with the domain', () => {
  const t = fakeApp();
  const a = JSON.parse(read(assembleFake(t, ['--cname', DOMAIN]), 'files.json'));
  const b = JSON.parse(read(assembleFake(t, ['--cname', 'example.org']), 'files.json'));
  assert.notEqual(a.version, b.version);
  assert.ok(a.files.includes('CNAME'));
});

// ---- check-dist.mjs ----
test('check-dist passes on a release assemble and says how many files and bytes', () => {
  const r = check([real()]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\b\d+ files\b/);
  assert.match(r.out, /\b\d+ bytes\b/);
});

test('check-dist names the problem in a copy with a debug/ file, an unlisted file, a dot file, or another sw.js version', () => {
  const dist = real();
  const cases = [
    ['debug file', (c) => put(c, 'debug/check.html'), /debug\/check\.html/],
    ['page-test file', (c) => put(c, 'page-test/boot.mjs'), /page-test\/boot\.mjs/],
    ['video', (c) => put(c, 'clips/x.mp4'), /clips\/x\.mp4/],
    ['unlisted file', (c) => put(c, 'extra.txt'), /extra\.txt/],
    ['dot file', (c) => put(c, '.npmrc'), /\.npmrc/],
    ['dot folder', (c) => put(c, '.well-known/x'), /\.well-known/],
    ['another sw.js version', (c) => fs.writeFileSync(path.join(c, 'sw.js'), read(c, 'sw.js').replace(/const BUILT_VERSION = "[0-9a-f]+";/, 'const BUILT_VERSION = "0000000000000000";')), /sw\.js.*0000000000000000|0000000000000000.*sw\.js/],
    ['listed file missing', (c) => fs.rmSync(path.join(c, 'index.html')), /index\.html/],
    ['no files.json', (c) => fs.rmSync(path.join(c, 'files.json')), /files\.json/],
  ];
  for (const [what, damage, expected] of cases) {
    const c = copyOf(dist);
    damage(c);
    const r = check([c]);
    assert.equal(r.status, 1, `${what}: exit status`);
    assert.match(r.out, expected, what);
  }
});

test('check-dist without --release does not want the model, TF.js or CNAME; with --release it does', () => {
  const plain = assembleFake(fakeApp());   // has the model and TF.js, no CNAME
  const bare = tmp('bare-app');
  put(path.join(bare, 'app'), 'index.html', '<!doctype html>');
  put(path.join(bare, 'app'), 'sw.js', fs.readFileSync(path.join(APP, 'sw.js'), 'utf8'));
  put(path.join(bare, 'src'), 'diagnostics.js', '//');
  put(path.join(bare, 'src'), 'track/x.mjs', 'export {};');
  const none = tmp('bare-out');
  assemble(['--app', path.join(bare, 'app'), '--src', path.join(bare, 'src'), '--out', none]);
  assert.equal(check([none]).status, 0, 'the plain check passes without them');
  const r = check(['--release', none]);
  assert.equal(r.status, 1);
  for (const f of ['models/movenet-thunder-4/model.json', 'vendor/tfjs/tfjs-webgl.mjs', 'CNAME']) assert.match(r.out, new RegExp(f.replace(/\./g, '\\.')), f);
  // a release with all three passes
  const full = assembleFake(fakeApp(), ['--cname', DOMAIN]);
  const ok = check(['--release', full]);
  assert.equal(ok.status, 0, ok.out);
  // and each one missing is named alone
  for (const f of ['models/movenet-thunder-4/model.json', 'vendor/tfjs/tfjs-webgl.mjs']) {
    const c = copyOf(full);
    fs.rmSync(path.join(c, f));
    const bad = check(['--release', c]);
    assert.equal(bad.status, 1, f);
    assert.match(bad.out, new RegExp(f.replace(/\./g, '\\.')));
  }
  assert.equal(check(['--release', plain]).status, 1, 'no CNAME');
});

test('check-dist refuses a missing folder and a missing argument', () => {
  assert.equal(check([path.join(tmp('nothing'), 'absent')]).status, 1);
  assert.notEqual(check([]).status, 0);
});

// ---- dev files stay off the site ----
test('assemble leaves the app\'s README, package.json, package-lock.json and every dot file out', () => {
  const t = fakeApp();
  put(t.app, 'README.md', 'dev');
  put(t.app, 'package.json', '{}');
  put(t.app, 'package-lock.json', '{}');
  put(t.app, '.npmrc', 'legacy-peer-deps=true');
  put(t.app, '.DS_Store', 'x');
  put(t.app, 'vendor/.hidden/x.js', 'x');
  const files = walk(assembleFake(t));
  assert.deepEqual(files, ['files.json', 'index.html', 'models/movenet-thunder-4/model.json', 'src/diagnostics.js', 'src/main.mjs', 'src/track/smoothing.mjs', 'sw.js', 'vendor/tfjs/tfjs-webgl.mjs']);
});

test('nothing at runtime fetches the dev files', () => {
  const runtime = [];
  const walkSrc = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') walkSrc(full); } else if (/\.(mjs|js|html)$/.test(e.name)) runtime.push(full);
  } };
  walkSrc(path.join(APP, 'src'));
  runtime.push(path.join(APP, 'sw.js'), path.join(APP, 'index.html'));
  for (const f of runtime) {
    const text = fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(text, /['"`][^'"`\n]*(package(-lock)?\.json|README\.md)['"`]/, `${path.relative(ROOT, f)} names a dev file`);
  }
});

// ---- the workflow ----
const workflow = () => fs.readFileSync(WORKFLOW, 'utf8');
const lines = () => workflow().split('\n');

test('the workflow runs on pushed v* tags and by hand (a deploy input, off by default), nothing else', () => {
  const text = workflow();
  assert.match(text, /^on:\s*$/m);
  assert.match(text, /^\s+push:\s*\n\s+tags:\s*\[\s*['"]v\*['"]\s*\]/m);
  assert.match(text, /^\s+workflow_dispatch:/m);
  assert.doesNotMatch(text, /^\s+(pull_request|pull_request_target|schedule|branches|release|workflow_run):/m);
  assert.match(text, /deploy:\s*\n\s+description:[^\n]*\n\s+type:\s*boolean\s*\n\s+default:\s*false/);
  assert.match(text, /if:\s*github\.ref_type == 'tag' \|\| inputs\.deploy/);
});

test('every action is pinned to a full commit SHA followed by its version in a comment; no secrets anywhere', () => {
  const uses = lines().filter((l) => /\buses:/.test(l));
  assert.ok(uses.length >= 4, 'checkout, setup-node, upload-pages-artifact and deploy-pages');
  for (const l of uses) assert.match(l, /^\s*-?\s*uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+# v\d+(\.\d+)*\s*$/, l);
  assert.doesNotMatch(workflow(), /secrets\./);
});

test('permissions: contents read, pages write, id-token write; one deployment at a time; ubuntu-24.04', () => {
  const text = workflow();
  assert.match(text, /^permissions:\s*\n\s+contents:\s*read\s*\n\s+pages:\s*write\s*\n\s+id-token:\s*write\s*$/m);
  assert.match(text, /concurrency:\s*\n\s+group:\s*pages\s*\n\s+cancel-in-progress:\s*false/);
  assert.match(text, /runs-on:\s*ubuntu-24\.04/);
  for (const l of lines().filter((x) => /runs-on:/.test(x))) assert.match(l, /runs-on:\s*ubuntu-24\.04\s*$/, l);
});

test('the build: assemble without --debug and --test, with the domain; check-dist --release before the upload; the deploy needs it', () => {
  const ls = lines();
  const code = ls.filter((l) => !/^\s*#/.test(l));
  const asm = code.findIndex((l) => /npm --prefix app run assemble/.test(l));
  assert.ok(asm >= 0, 'an assemble step');
  assert.match(code[asm], /--cname coach-cubed\.org/);
  assert.doesNotMatch(code[asm], /--debug|--test/);
  for (const l of code.filter((x) => /assemble/.test(x))) assert.doesNotMatch(l, /--debug|--test/, l);
  const chk = code.findIndex((l) => /node app\/tools\/check-dist\.mjs --release app\/dist/.test(l));
  const up = code.findIndex((l) => /upload-pages-artifact@/.test(l));
  assert.ok(chk > asm && up > chk, 'assemble, then check-dist --release, then the upload');
  const text = code.join('\n');
  assert.match(text, /path:\s*app\/dist/);
  const order = ['npm --prefix app ci', 'npm --prefix app test', 'node app/tools/build-tfjs.mjs', 'app/tools/fetch-models.sh'].map((s) => text.indexOf(s));
  assert.ok(order.every((n) => n >= 0) && order.every((n, i) => i === 0 || n > order[i - 1]), 'ci, test, build-tfjs, fetch-models, in that order');
  assert.ok(order[3] < text.indexOf('run assemble'));
  assert.match(text, /node-version:\s*22/);
  assert.match(text, /deploy:\s*\n\s+needs:\s*build/);
  assert.match(text, /name:\s*github-pages/);
  assert.match(text, /id:\s*deployment/);
});

test('on a tag the build fails unless the tag equals app/package.json\'s version', () => {
  const text = workflow();
  assert.match(text, /github\.ref_type == 'tag'/);
  assert.match(text, /GITHUB_REF_NAME/);
  assert.match(text, /app\/package\.json/);
});
