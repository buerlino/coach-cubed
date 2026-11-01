'use strict';
// app/tools/serve.mjs: app/dist/ on a port option, no COOP/COEP, the right types.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVE = path.join(ROOT, 'app', 'tools', 'serve.mjs');

function get(port, url) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// Starts the server on a free port (it prints the address) over a folder with one file of each type.
async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-serve-'));
  for (const [name, text] of Object.entries({
    'index.html': '<!doctype html>', 'a.mjs': 'export {};', 'a.js': '1', 'm.webmanifest': '{}', 'f.woff2': 'x',
    'w.wasm': 'x', 's.css': 'a{}', 'd.json': '{}', 'i.png': 'x',
  })) fs.writeFileSync(path.join(dir, name), text);
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'index.html'), 'sub');
  const child = spawn(process.execPath, [SERVE, '--dir', dir, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`no address printed: ${buf}`)), 10000);
      child.stdout.on('data', (d) => {
        buf += d;
        const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (m) { clearTimeout(timer); resolve(+m[1]); }
      });
      child.on('exit', () => reject(new Error(`serve exited: ${buf}`)));
    });
    await fn(port, dir);
  } finally { child.kill(); }
}

test('serves the right content types for .mjs, .webmanifest, .woff2 and .wasm', async () => {
  await withServer(async (port) => {
    const type = async (u) => (await get(port, u)).headers['content-type'];
    assert.match(await type('/a.mjs'), /^text\/javascript/);
    assert.match(await type('/a.js'), /^text\/javascript/);
    assert.match(await type('/m.webmanifest'), /^application\/manifest\+json/);
    assert.equal(await type('/f.woff2'), 'font/woff2');
    assert.equal(await type('/w.wasm'), 'application/wasm');
    assert.match(await type('/s.css'), /^text\/css/);
    assert.match(await type('/'), /^text\/html/);
  });
});

test('no COOP or COEP header (the WebView can\'t be cross-origin isolated)', async () => {
  await withServer(async (port) => {
    const { headers } = await get(port, '/index.html');
    assert.equal(headers['cross-origin-opener-policy'], undefined);
    assert.equal(headers['cross-origin-embedder-policy'], undefined);
  });
});

test('/ is index.html, a missing file is a 404, a path out of the folder is not served', async () => {
  await withServer(async (port) => {
    assert.equal((await get(port, '/')).body.toString(), '<!doctype html>');
    assert.equal((await get(port, '/sub/')).body.toString(), 'sub');
    assert.equal((await get(port, '/nope.js')).status, 404);
    assert.notEqual((await get(port, '/..%2f..%2fpackage.json')).status, 200);
    assert.notEqual((await get(port, '/%2e%2e/%2e%2e/etc/passwd')).status, 200);
  });
});
