'use strict';
// app/tools/assemble.mjs: app/ (without tools/, android/, dist/, debug/, node_modules/,
// capacitor.config.json; debug/ and the test clip only with --debug),
// plus src/diagnostics.js and src/track/, into one folder, with files.json for
// the service worker. Every run goes into a temporary folder. The tests need
// neither of the gitignored folders (app/vendor/tfjs/, app/models/): a fresh
// worktree has neither, and the runs that must not have them use a fake app/.
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const ASSEMBLE = path.join(APP, 'tools', 'assemble.mjs');

// Every folder a test makes is recorded; one after() hook removes them all, whether the tests passed or failed.
const made = [];
const tmp = (name) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `coach-${name}-`)); made.push(dir); return dir; };
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const put = (base, rel, text = rel) => {
  fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  fs.writeFileSync(path.join(base, rel), text);
};
const assemble = (args) => execFileSync(process.execPath, [ASSEMBLE, ...args], { encoding: 'utf8', timeout: 60000 });
const walk = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
}).sort();
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel));
const manifestOf = (dir) => JSON.parse(read(dir, 'files.json'));

// A small app/ and src/ to assemble: what is excluded, and what the optional folders do.
function fakeTree({ tfjs = false, models = false } = {}) {
  const root = tmp('tree');
  const app = path.join(root, 'app');
  const src = path.join(root, 'src');
  put(app, 'index.html', '<!doctype html>');
  put(app, 'package.json', '{}');
  put(app, 'src/main.mjs', 'export {};');
  put(app, 'vendor/preact/preact.mjs', 'p');
  put(app, 'tools/assemble.mjs', 'no');
  put(app, 'android/build.gradle', 'no');
  put(app, 'dist/old.txt', 'no');
  put(app, 'node_modules/x/index.js', 'no');
  put(app, 'capacitor.config.json', '{}');
  put(app, 'out/coach-debug.apk', 'the last APK');
  put(app, 'debug/check.html', 'check page');
  put(app, 'debug/check.mjs', 'export {};');
  put(root, 'tests/app/clips/testsrc2-h264-30fps.mp4', 'clip');
  if (tfjs) put(app, 'vendor/tfjs/tf.js', 'tf');
  if (models) put(app, 'models/movenet/model.json', '{}');
  put(src, 'diagnostics.js', '// diagnostics');
  put(src, 'track/smoothing.mjs', '// smoothing');
  put(src, 'track/lift-window.mjs', '// window');
  put(src, 'app.py', 'not shipped');
  put(src, 'vendor/three.module.js', 'not shipped');
  return { root, app, src };
}

test('the real app assembles into a temporary folder: shell, manifest, vendored files, licences', () => {
  const out = tmp('real');
  assemble(['--out', out]);
  const files = walk(out);
  for (const f of [
    'index.html', 'manifest.webmanifest', 'files.json', 'src/main.mjs', 'src/flow/flow.mjs',
    'src/styles/tokens.css', 'src/styles/base.css',
    'vendor/preact/preact.mjs', 'vendor/preact/hooks.mjs', 'vendor/preact/LICENSE',
    'vendor/htm/htm.mjs', 'vendor/htm/LICENSE',
    'vendor/fonts/barlow/OFL.txt', 'vendor/fonts/barlow-condensed/OFL.txt',
    'vendor/fonts/barlow/barlow-latin-400-normal.woff2', 'vendor/fonts/barlow-condensed/barlow-condensed-latin-700-normal.woff2',
  ]) assert.ok(files.includes(f), `${f} is missing from the assembled app`);
  for (const f of files) assert.ok(!/^(tools|android|dist|debug|node_modules)\//.test(f), `${f} must not be copied`);
  assert.ok(!files.includes('capacitor.config.json'));
});

test('the shipped dist/ has no check page; --debug adds it and its clip (the debug APK, c20)', () => {
  const plain = tmp('shipped');
  assemble(['--out', plain]);
  const shipped = walk(plain);
  assert.ok(!shipped.some((f) => f.startsWith('debug/')), 'the check page must never reach the shipped dist/');
  assert.ok(!shipped.includes('capacitor.config.json'));
  const dbg = tmp('debug');
  const stdout = assemble(['--debug', '--out', dbg]);
  assert.match(stdout, /debug: with the check page/);
  const files = walk(dbg);
  for (const f of ['debug/check.html', 'debug/check.mjs', 'debug/clips/testsrc2-h264-30fps.mp4']) {
    assert.ok(files.includes(f), `${f} is missing from the debug build`);
  }
  assert.deepEqual(read(dbg, 'debug/clips/testsrc2-h264-30fps.mp4'), fs.readFileSync(path.join(ROOT, 'tests/app/clips/testsrc2-h264-30fps.mp4')));
  assert.deepEqual(manifestOf(dbg).files, files.filter((f) => f !== 'files.json'));
  // Everything else is the shipped build's, byte for byte; sw.js differs by its stamp, the build's own version (c19).
  const unstamped = (dir) => read(dir, 'sw.js').toString().replace(/const BUILT_VERSION = "[0-9a-f]+";/, 'const BUILT_VERSION = null;');
  assert.equal(unstamped(dbg), unstamped(plain));
  for (const f of shipped.filter((f) => f !== 'files.json' && f !== 'sw.js')) assert.deepEqual(read(dbg, f), read(plain, f), f);
});

test('--debug on a fake tree: app/debug/ and the clip are listed, and nothing else changes', () => {
  const t = fakeTree();
  const out = tmp('fake-debug');
  assemble(['--app', t.app, '--src', t.src, '--out', out, '--debug']);
  assert.deepEqual(walk(out), [
    'debug/check.html', 'debug/check.mjs', 'debug/clips/testsrc2-h264-30fps.mp4',
    'files.json', 'index.html', 'package.json', 'src/diagnostics.js', 'src/main.mjs', 'src/track/lift-window.mjs',
    'src/track/smoothing.mjs', 'vendor/preact/preact.mjs',
  ]);
  // A second run without --debug leaves no check page behind.
  assemble(['--app', t.app, '--src', t.src, '--out', out]);
  assert.ok(!walk(out).some((f) => f.startsWith('debug/')));
});

test('diagnostics.js and src/track/ are copied from src/, byte for byte, into src/ of the assembled app', () => {
  const out = tmp('shared');
  assemble(['--out', out]);
  assert.deepEqual(read(out, 'src/diagnostics.js'), fs.readFileSync(path.join(ROOT, 'src', 'diagnostics.js')));
  const tracks = fs.readdirSync(path.join(ROOT, 'src', 'track')).filter((n) => n.endsWith('.mjs'));
  assert.ok(tracks.length >= 2);
  for (const f of tracks) assert.deepEqual(read(out, `src/track/${f}`), fs.readFileSync(path.join(ROOT, 'src', 'track', f)), f);
});

test('the app\'s own imports of src/track/ resolve in the repo and in the assembled folder', () => {
  // In the repo, app/src/track/ holds one-line stubs that re-export root src/track/;
  // the assembled folder has the real files in their place (app/README.md says why).
  const out = tmp('imports');
  assemble(['--out', out]);
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'track')).filter((n) => n.endsWith('.mjs'))) {
    const stub = fs.readFileSync(path.join(APP, 'src', 'track', f), 'utf8');
    assert.match(stub, new RegExp(`export \\* from '\\.\\./\\.\\./\\.\\./src/track/${f.replace('.', '\\.')}'`), `app/src/track/${f} is not a stub of src/track/${f}`);
    assert.equal(read(out, `src/track/${f}`).toString(), fs.readFileSync(path.join(ROOT, 'src', 'track', f), 'utf8'));
  }
});

test('the manifest: the placeholder name, start_url and scope ./, standalone, the ground colour, relative icons', () => {
  const m = JSON.parse(fs.readFileSync(path.join(APP, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.name, 'coach');
  assert.equal(m.short_name, 'coach');
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.display, 'standalone');
  assert.equal(m.background_color.toLowerCase(), '#0e0f11');
  assert.ok(m.icons.length >= 1);
  for (const icon of m.icons) {
    assert.ok(!icon.src.startsWith('/') && !/^[a-z]+:/i.test(icon.src), `icon src ${icon.src} is not relative`);
    assert.ok(fs.existsSync(path.join(APP, icon.src)), `${icon.src} is missing`);
  }
});

test('index.html: relative paths only, an import map that pins Preact, no network address', () => {
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']?(?:\/|[a-z]+:)/i, 'an absolute or network src/href');
  assert.match(html, /<link[^>]+rel="manifest"[^>]+href="\.\/manifest\.webmanifest"/);
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  for (const name of ['preact', 'preact/hooks', 'htm']) {
    assert.match(map.imports[name] || '', /^\.\/vendor\//, `${name} maps to a relative vendored file`);
    assert.ok(fs.existsSync(path.join(APP, map.imports[name])), `${name}: ${map.imports[name]} is missing`);
  }
  assert.match(html, /<script type="module" src="\.\/src\/main\.mjs">/);
});

test('files.json lists every file copied (not itself), sorted, with a version hash', () => {
  const out = tmp('files');
  assemble(['--out', out]);
  const m = manifestOf(out);
  assert.match(m.version, /^[0-9a-f]{16,}$/);
  assert.deepEqual(m.files, walk(out).filter((f) => f !== 'files.json'));
  assert.ok(m.files.includes('index.html') && m.files.includes('src/diagnostics.js'));
});

test('the version hash is stable for the same files and changes with any file\'s content or name', () => {
  const t = fakeTree();
  const a = tmp('a'); const b = tmp('b'); const c = tmp('c'); const d = tmp('d');
  const run = (out) => assemble(['--app', t.app, '--src', t.src, '--out', out]);
  run(a); run(b);
  assert.equal(manifestOf(a).version, manifestOf(b).version);
  put(t.app, 'src/main.mjs', 'export const changed = 1;');
  run(c);
  assert.notEqual(manifestOf(c).version, manifestOf(a).version);
  put(t.src, 'track/extra.mjs', '// new');
  run(d);
  assert.notEqual(manifestOf(d).version, manifestOf(c).version);
});

test('without app/vendor/tfjs/ and app/models/ it says so and goes on', () => {
  const t = fakeTree();
  const out = tmp('absent');
  const stdout = assemble(['--app', t.app, '--src', t.src, '--out', out]);
  assert.match(stdout, /vendor\/tfjs[^\n]*(absent|not found|skipp)/i);
  assert.match(stdout, /models[^\n]*(absent|not found|skipp)/i);
  const files = walk(out);
  assert.deepEqual(files, [
    'files.json', 'index.html', 'package.json', 'src/diagnostics.js', 'src/main.mjs', 'src/track/lift-window.mjs',
    'src/track/smoothing.mjs', 'vendor/preact/preact.mjs',
  ]);
  assert.deepEqual(manifestOf(out).files, files.filter((f) => f !== 'files.json'));
});

test('with them present they are copied and listed', () => {
  const t = fakeTree({ tfjs: true, models: true });
  const out = tmp('present');
  const stdout = assemble(['--app', t.app, '--src', t.src, '--out', out]);
  assert.doesNotMatch(stdout, /(absent|not found)/i);
  const m = manifestOf(out);
  assert.ok(m.files.includes('vendor/tfjs/tf.js'));
  assert.ok(m.files.includes('models/movenet/model.json'));
  assert.deepEqual(m.files, walk(out).filter((f) => f !== 'files.json'));
});

test('only src/diagnostics.js and src/track/ come from src/; tools/, android/, dist/, out/ and node_modules/ never', () => {
  const t = fakeTree({ tfjs: true, models: true });
  const out = tmp('only');
  assemble(['--app', t.app, '--src', t.src, '--out', out, '--debug']);
  const files = walk(out);
  assert.ok(!files.some((f) => /^(tools|android|dist|out|node_modules)\//.test(f)), 'the last APK must never land in the next one');
  assert.ok(!files.includes('src/app.py') && !files.includes('src/vendor/three.module.js'));
});

test('a second run replaces the first: nothing stale is left or listed', () => {
  const t = fakeTree();
  const out = tmp('twice');
  assemble(['--app', t.app, '--src', t.src, '--out', out]);
  put(t.app, 'extra.txt');
  assemble(['--app', t.app, '--src', t.src, '--out', out]);
  assert.ok(manifestOf(out).files.includes('extra.txt'));
  fs.rmSync(path.join(t.app, 'extra.txt'));
  assemble(['--app', t.app, '--src', t.src, '--out', out]);
  assert.ok(!fs.existsSync(path.join(out, 'extra.txt')));
  assert.ok(!manifestOf(out).files.includes('extra.txt'));
});

test('it refuses to empty a folder that isn\'t an earlier assemble output', () => {
  const t = fakeTree();
  const out = tmp('refuse');
  put(out, 'precious.txt', 'mine');
  assert.throws(() => execFileSync(process.execPath, [ASSEMBLE, '--app', t.app, '--src', t.src, '--out', out], { stdio: 'pipe' }));
  assert.equal(fs.readFileSync(path.join(out, 'precious.txt'), 'utf8'), 'mine');
  const own = t.app;
  assert.throws(() => execFileSync(process.execPath, [ASSEMBLE, '--app', t.app, '--src', t.src, '--out', own], { stdio: 'pipe' }));
  assert.ok(fs.existsSync(path.join(t.app, 'index.html')));
});

test('files.json\'s hash is a sha256 over the listed paths and contents (so the service worker can trust it)', () => {
  const t = fakeTree();
  const out = tmp('hash');
  assemble(['--app', t.app, '--src', t.src, '--out', out]);
  const m = manifestOf(out);
  const h = crypto.createHash('sha256');
  for (const f of m.files) { h.update(f); h.update('\0'); h.update(read(out, f)); h.update('\0'); }
  assert.equal(m.version, h.digest('hex').slice(0, 16));
});
