// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// rules-core.md, "Paths stay relative", as a test: no new absolute path
// ('/...') where the app loads or links something. The deploy mounts coach
// at /coach/ and strips the prefix, so an absolute path passes on localhost
// and 404s behind the proxy. Scans our own HTML, JS, MJS and Python in src/,
// launchers/ and parked/, and the new app's (app/: HTML, JS, MJS, CSS, the
// manifest and JSON, but not its dist/, android/ or node_modules/); vendored
// third-party code (any vendor/ folder) is skipped. Built-ins only, like
// docs.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCANNED = /^(?:(?:src|launchers|parked)\/.*\.(?:html|js|mjs|py)|app\/.*\.(?:html|js|mjs|css|webmanifest|json))$/;
const VENDOR = /(^|\/)vendor\//;
const NOT_SCANNED = /^app\/(?:dist|android|node_modules)\//;

// Each pattern ends just before an absolute path's `/`: after a quote (or,
// in an HTML attribute, none), and only if the next character isn't `/` or
// `*`, so neither a protocol-relative URL nor a comment counts.
const Q = '["\'`]';
const ABS = '(?=\\/(?![/*]))';
const PATTERNS = [
  { kind: 'src/href', re: new RegExp(`\\b(?:src|href|action)\\s*=\\s*${Q}?${ABS}`, 'g') },
  { kind: 'import', re: new RegExp(`\\b(?:import\\s*\\(?|from)\\s*${Q}${ABS}`, 'g') },
  { kind: 'fetch', re: new RegExp(`\\bfetch\\s*\\(\\s*${Q}${ABS}`, 'g') },
  { kind: 'redirect', re: new RegExp(`\\bredirect\\s*\\(\\s*${Q}${ABS}`, 'g') },
  { kind: 'redirect', re: new RegExp(`['"]Location['"]\\s*,\\s*${Q}${ABS}`, 'g') },
  { kind: 'css url', re: new RegExp(`\\burl\\(\\s*['"]?${ABS}`, 'g') },
  // An import map's entries (`"three": "/vendor/..."`), JSON-quoted.
  { kind: 'import map', re: new RegExp(`"[^"\\s]+"\\s*:\\s*"${ABS}`, 'g') },
  // Helpers that wrap fetch (`post('/api/...')`, `json('/api/...')`). Not
  // in Python, where Flask's own routes are `/api/...` on purpose.
  { kind: 'api call', re: new RegExp(`\\(\\s*${Q}(?=\\/api\\/)`, 'g'), skip: /\.py$/ },
];

// Today's absolute paths, all in code frozen with the old page until step
// 5.8 parks it (docs/backlog.md lists them). One entry covers every use of
// that path in that file. Don't add to this list: write the path relative.
const FROZEN_OVERLAY = 'anatomy overlay of the frozen old page; 404s under /coach/';
const FROZEN_LAB = 'Movement Lab, frozen with the old page; 404s under /coach/';
const KNOWN = [
  { file: 'src/anatomy/integration.mjs', path: '/anatomy/shared.css', reason: FROZEN_OVERLAY },
  { file: 'src/anatomy/integration.mjs', path: '/anatomy/models/ATTRIBUTION.md', reason: FROZEN_OVERLAY },
  { file: 'src/anatomy/integration.mjs', path: '/anatomy/ROM.md', reason: FROZEN_OVERLAY },
  { file: 'src/anatomy/review.mjs', path: '/squat/METHOD.md', reason: FROZEN_OVERLAY },
  { file: 'src/anatomy/review.mjs', path: '/squat/', reason: FROZEN_OVERLAY },
  { file: 'src/anatomy/ui.mjs', path: '/squat/', reason: FROZEN_OVERLAY },
  { file: 'src/squat/index.html', path: '/diagnostics.js', reason: FROZEN_LAB },
  { file: 'src/squat/app.mjs', path: '/api/examples', reason: FROZEN_LAB },
  { file: 'src/squat/app.mjs', path: '/api/examples/', reason: FROZEN_LAB },
  { file: 'src/squat/original-tools.mjs', path: '/api/depth/generate', reason: FROZEN_LAB },
  { file: 'src/squat/original-tools.mjs', path: '/api/depth/methods', reason: FROZEN_LAB },
  { file: 'src/squat/original-tools.mjs', path: '/api/depth/optimize_limbs', reason: FROZEN_LAB },
  { file: 'src/squat/original-tools.mjs', path: '/api/profiles/', reason: FROZEN_LAB },
  { file: 'src/squat/original-tools.mjs', path: '/api/profiles/limbs/', reason: FROZEN_LAB },
];

// Tracked files plus untracked ones that aren't ignored, as in docs.test.js,
// so a new file is checked before `git add`.
function scannedFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT });
  return out.toString('utf8').split('\0')
    .filter((f) => SCANNED.test(f) && !VENDOR.test(f) && !NOT_SCANNED.test(f) && fs.existsSync(path.join(ROOT, f)));
}

// Every absolute path in `text`, as { line, kind, path }. The path runs from
// its `/` to the next quote, space or closing bracket. A path two patterns
// match (`fetch('/api/x')`) counts once.
function absolutePaths(file, text) {
  const hits = new Map();
  text.split('\n').forEach((line, i) => {
    for (const { kind, re, skip } of PATTERNS) {
      if (skip && skip.test(file)) continue;
      for (const m of line.matchAll(re)) {
        const start = m.index + m[0].length;
        const key = `${i}:${start}`;
        if (!hits.has(key)) hits.set(key, { line: i + 1, kind, path: line.slice(start).match(/^\/[^'"`\s)>]*/)[0] });
      }
    }
  });
  return [...hits.values()];
}

test('no new absolute asset path or URL in src/, launchers/, parked/ or app/', () => {
  const known = new Map(KNOWN.map((k) => [`${k.file} ${k.path}`, k]));
  const used = new Set();
  const found = [];
  for (const file of scannedFiles()) {
    for (const hit of absolutePaths(file, fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      const key = `${file} ${hit.path}`;
      if (known.has(key)) { used.add(key); continue; }
      found.push(`${file}:${hit.line}: ${hit.kind} '${hit.path}'`);
    }
  }
  for (const key of known.keys()) if (!used.has(key)) found.push(`KNOWN lists ${key}, which is gone: remove it`);
  assert.deepEqual(found, [], `absolute paths (make them relative; docs/rules-core.md#paths-stay-relative):\n${found.join('\n')}`);
});

test('the pattern catches each kind of absolute path, and leaves relative ones alone', () => {
  const bad = [
    `<script src="/x.js"></script>`, `<a href=/x>`, `el.src = '/x.png'`, `import a from '/x.mjs'`,
    `import('/x.mjs')`, `export { a } from "/x.mjs"`, `fetch('/api/x')`, `fetch(\`/x\`)`,
    `return redirect('/x')`, `self.send_header('Location', '/x')`, `background: url(/x.png)`,
    `await post('/api/x', body)`, `{ "imports": { "three": "/vendor/three.module.js" } }`,
  ];
  const good = [
    `<script src="./x.js"></script>`, `<a href="../x">`, `import a from './x.mjs'`, `fetch(BASE + '/api/x')`,
    `fetch(\`\${BASE}/api/x\`)`, `<a href="//example.org/x">`, `src="https://example.org/x"`,
    `return redirect('../')`, `{ "imports": { "three": "./vendor/three.module.js" } }`,
  ];
  for (const s of bad) assert.equal(absolutePaths('t.mjs', s).length, 1, `missed: ${s}`);
  for (const s of good) assert.deepEqual(absolutePaths('t.mjs', s), [], `flagged: ${s}`);
  assert.deepEqual(absolutePaths('t.py', `@app.route('/api/x')\nf('/api/x')`), [], 'a Flask route is not a path to load');
});

test('app/ is scanned (its HTML, modules, styles and manifest), but not its vendored, built or Android files', () => {
  const files = scannedFiles();
  for (const f of ['app/index.html', 'app/manifest.webmanifest', 'app/src/main.mjs', 'app/src/styles/base.css', 'app/tools/assemble.mjs']) {
    assert.ok(files.includes(f), `${f} is not scanned`);
  }
  assert.ok(files.every((f) => !/^app\/(vendor|dist|android|node_modules)\//.test(f)));
  assert.ok(SCANNED.test('app/dist/index.html') && NOT_SCANNED.test('app/dist/index.html'));
  assert.ok(SCANNED.test('app/android/app/src/main/assets/index.html') && NOT_SCANNED.test('app/android/app/src/main/assets/index.html'));
  assert.ok(!SCANNED.test('app/README.md') && !SCANNED.test('tests/app/flow.test.js'));
  // An absolute path in app/ is found like one in src/.
  assert.equal(absolutePaths('app/src/styles/base.css', `@font-face { src: url(/vendor/f.woff2); }`).length, 1);
  assert.equal(absolutePaths('app/manifest.webmanifest', `{ "icons": [{ "src": "icons/a.png" }] }`).length, 0);
});
