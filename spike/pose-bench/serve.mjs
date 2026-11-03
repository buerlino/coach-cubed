// SPDX-License-Identifier: AGPL-3.0-or-later
// node serve.mjs [PORT]: dev tooling for the spike only (the app has no
// server). Serves, read-only, from the repo root so the page reaches the
// app's own modules by relative paths:
//
//   spike/pose-bench/...            the page, its runtimes (node_modules/)
//                                   and models (models/)
//   spike/capture-check/...         step 3.4's capture page (it imports
//                                   pose-bench's decoder and engine)
//   src/...                         src/pose/coco17.mjs, src/track/, diagnostics.js
//   tests/fixtures/...              the clips under local/ and the tracks
//   spike/pose-bench/clips.json     every clip under tests/fixtures/local/,
//                                   with the fixture slug and cue set its
//                                   manifest gives it
//   POST spike/<page>/results/<name>   writes that page's results/<name>
//                                   (gitignored)
//
// Open http://127.0.0.1:PORT/spike/pose-bench/ (localhost is a secure
// context; on the phone, through `adb reverse`). COOP/COEP make the page
// cross-origin isolated, which multi-threaded WebAssembly needs.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const FIXTURES = join(REPO, 'tests', 'fixtures');
const CLIPS = join(FIXTURES, 'local');
const PORT = Number(process.argv[2] || 8790);
const PAGES = ['pose-bench', 'capture-check'];
const SERVED = [...PAGES.map(p => `spike/${p}/`), 'src/', 'tests/fixtures/'];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.cjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.css': 'text/css',
};
const VIDEO = /\.(mp4|mov|webm)$/i;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (VIDEO.test(e.name)) out.push(p);
  }
  return out;
}

// Each clip under local/, with the fixture it belongs to: a global fixture
// keeps its clip at the same <stance>/<file> path under local/.
function clipIndex() {
  const fixtures = {};
  for (const scope of ['global', 'local']) {
    const f = join(FIXTURES, scope, 'manifest.json');
    if (!existsSync(f)) continue;
    for (const [key, e] of Object.entries(JSON.parse(readFileSync(f, 'utf8')))) {
      const clip = `${key.split('/')[0]}/${e.source_file}`;
      fixtures[clip] ||= { slug: `${scope}/${key}`, set: e.diagnostics || null };
    }
  }
  return walk(CLIPS).map(p => {
    const path = relative(CLIPS, p).split(sep).join('/');
    return { path, url: `../../tests/fixtures/local/${path}`, bytes: statSync(p).size,
      ...(fixtures[path] || { slug: null, set: null }) };
  });
}

function send(res, code, body, type = 'text/plain') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');   // every run is a cold load
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');

  const post = path.match(/^spike\/([\w-]+)\/results\/(.*)$/);
  if (req.method === 'POST' && post && PAGES.includes(post[1])) {
    const name = post[2], dir = join(REPO, 'spike', post[1], 'results');
    if (!/^[\w.@+-]+\.json$/.test(name)) return send(res, 400, 'bad name');
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), Buffer.concat(chunks));
      console.log(`wrote ${post[1]}/results/${name}`);
      send(res, 200, 'ok');
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method');
  if (path === '' ) { res.writeHead(302, { Location: 'spike/pose-bench/' }); return res.end(); }
  if (path === 'spike/pose-bench/clips.json') return send(res, 200, JSON.stringify(clipIndex()), TYPES['.json']);

  let file = resolve(REPO, '.' + sep + path);
  if (!file.startsWith(REPO + sep) || !SERVED.some(p => (relative(REPO, file).split(sep).join('/') + '/').startsWith(p))) {
    return send(res, 404, 'not served');
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found');
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    'Content-Length': statSync(file).size,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`pose-bench on http://127.0.0.1:${PORT}/spike/pose-bench/`));
