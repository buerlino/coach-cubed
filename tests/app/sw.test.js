'use strict';
// The service worker (package c19): app/sw.js precaches assemble's files.json
// under a versioned cache, answers the app's own files from it and never from
// the network, installs a new version alongside the old, and takes over only
// when the page says the queue is idle (app/src/updates.mjs). The worker is
// run for real, as a classic script in a vm context with a fake Cache Storage,
// a fake fetch and fake events; the registration module runs on a fake
// navigator.serviceWorker and a fake queue. The real browser check, with the
// network off, is app/tools/check-offline.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const SW = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');
const SCOPE = 'http://localhost:8090/';
const tools = () => import(pathToFileURL(path.join(APP, 'tools', 'assemble.mjs')).href);
const updatesModule = () => import(pathToFileURL(path.join(APP, 'src', 'updates.mjs')).href);

// ---- a fake Cache Storage, fetch and event loop ----
class FakeCache {
  constructor() { this.entries = new Map(); }
  async put(request, response) {
    const url = typeof request === 'string' ? request : request.url;
    this.entries.set(url, { status: response.status, body: Buffer.from(await response.arrayBuffer()) });
  }
  async match(request, opts = {}) {
    let url = typeof request === 'string' ? request : request.url;
    if (opts.ignoreSearch) url = url.split('?')[0];
    const e = this.entries.get(url);
    return e ? new Response(e.body, { status: e.status }) : undefined;
  }
  async keys() { return [...this.entries.keys()]; }
}
class FakeCaches {
  constructor() { this.stores = new Map(); }
  async open(name) { if (!this.stores.has(name)) this.stores.set(name, new FakeCache()); return this.stores.get(name); }
  async has(name) { return this.stores.has(name); }
  async keys() { return [...this.stores.keys()]; }
  async delete(name) { return this.stores.delete(name); }
  async match(request, opts) {
    for (const s of this.stores.values()) { const r = await s.match(request, opts); if (r) return r; }
    return undefined;
  }
}

// A server: a version and its files (name -> text), at SCOPE.
function server(version, files, { missing = [], listVersion = version } = {}) {
  const net = { log: [], version, files };
  net.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    net.log.push(url);
    if (url === `${SCOPE}files.json`) {
      return new Response(JSON.stringify({ version: listVersion, files: Object.keys(files) }), { status: 200 });
    }
    const name = url.slice(SCOPE.length).split('?')[0];
    if (url.startsWith(SCOPE) && name in files && !missing.includes(name)) return new Response(`${version}:${files[name]}`, { status: 200 });
    return new Response('not found', { status: 404 });
  };
  return net;
}

// The worker, loaded as the browser loads it, stamped as assemble stamps it.
async function worker({ caches = new FakeCaches(), net, stamped = true, scope = SCOPE } = {}) {
  const { stampWorker } = await tools();
  const code = stamped ? stampWorker(SW, net.version) : SW;
  const handlers = {};
  const calls = { skipWaiting: 0, claim: 0 };
  const sandbox = {
    caches, fetch: net.fetch, URL, Response, console,
    registration: { scope },
    clients: { claim: async () => { calls.claim++; } },
    skipWaiting: async () => { calls.skipWaiting++; },
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
  };
  sandbox.self = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'sw.js' });
  const dispatch = async (type, props = {}) => {
    const waits = [];
    let answer;
    const event = { ...props, waitUntil: p => { waits.push(Promise.resolve(p)); }, respondWith: p => { answer = Promise.resolve(p); } };
    for (const fn of handlers[type] || []) fn(event);
    await Promise.all(waits);
    return { answered: answer !== undefined, response: answer && await answer };
  };
  const get = (url, extra = {}) => dispatch('fetch', { request: { url, method: 'GET', mode: 'cors', ...extra } });
  return { dispatch, get, calls, handlers, caches };
}

const FILES = {
  'index.html': '<html>',
  'sw.js': 'worker',
  'src/main.mjs': 'main',
  'vendor/tfjs/tfjs-webgl.mjs': 'tfjs',
  'models/movenet-thunder-4/model.json': '{}',
  'models/movenet-thunder-4/group1-shard1of3.bin': 'w1',
  'vendor/fonts/barlow/barlow-latin-400-normal.woff2': 'font',
};

test('install precaches every file in files.json (and files.json) under coach-<version>', async () => {
  const net = server('aaaa1111', FILES);
  const w = await worker({ net });
  await w.dispatch('install');
  assert.deepEqual(await w.caches.keys(), ['coach-aaaa1111']);
  const cache = await w.caches.open('coach-aaaa1111');
  const keys = (await cache.keys()).sort();
  assert.deepEqual(keys, [...Object.keys(FILES).map(f => SCOPE + f), `${SCOPE}files.json`].sort());
  for (const f of Object.keys(FILES)) assert.equal(await (await cache.match(SCOPE + f)).text(), `aaaa1111:${FILES[f]}`);
  assert.equal(w.calls.skipWaiting, 0, 'an install never takes over by itself: the page says when');
});

test('every app file is answered from the cache, never the network', async () => {
  const net = server('aaaa1111', FILES);
  const w = await worker({ net });
  await w.dispatch('install');
  await w.dispatch('activate');
  net.log.length = 0;
  for (const f of Object.keys(FILES)) {
    const r = await w.get(SCOPE + f);
    assert.ok(r.answered, `${f} is answered by the worker`);
    assert.equal(await r.response.text(), `aaaa1111:${FILES[f]}`);
  }
  const root = await w.get(SCOPE, { mode: 'navigate' });
  assert.equal(await root.response.text(), 'aaaa1111:<html>', 'the start URL is index.html');
  const q = await w.get(`${SCOPE}src/main.mjs?v=2`);
  assert.equal(await q.response.text(), 'aaaa1111:main', 'a query string does not miss the cache');
  assert.deepEqual(net.log, [], 'no request reached the network');
});

test('the worker caches only the app\'s own files: other origins, other methods and unlisted files pass to the network, unstored', async () => {
  const net = server('aaaa1111', FILES);
  const w = await worker({ net });
  await w.dispatch('install');
  const cache = await w.caches.open('coach-aaaa1111');
  const before = (await cache.keys()).sort();
  for (const req of [
    { url: 'https://cdn.example.com/lib.js', method: 'GET' },
    { url: 'http://localhost:9999/index.html', method: 'GET' },
    { url: `${SCOPE}index.html`, method: 'POST' },
  ]) {
    const r = await w.dispatch('fetch', { request: { mode: 'cors', ...req } });
    assert.equal(r.answered, false, `${req.method} ${req.url} is left to the browser`);
  }
  // in scope, same origin, but not in files.json: the network answers, the worker stores nothing
  net.log.length = 0;
  const extra = await w.get(`${SCOPE}not-listed.txt`);
  assert.equal(extra.response.status, 404);
  assert.deepEqual(net.log, [`${SCOPE}not-listed.txt`]);
  assert.deepEqual((await cache.keys()).sort(), before, 'nothing was added to the cache');
  assert.deepEqual(before, [...Object.keys(FILES).map(f => SCOPE + f), `${SCOPE}files.json`].sort());
});

test('a new version installs alongside the old, which keeps answering, and takes over only on the page\'s message', async () => {
  const caches = new FakeCaches();
  const net1 = server('v1v1v1v1', FILES);
  const w1 = await worker({ caches, net: net1 });
  await w1.dispatch('install');
  await w1.dispatch('activate');

  const net2 = server('v2v2v2v2', FILES);
  const w2 = await worker({ caches, net: net2 });
  await w2.dispatch('install');
  assert.deepEqual((await caches.keys()).sort(), ['coach-v1v1v1v1', 'coach-v2v2v2v2'], 'both versions are stored');
  assert.equal(w2.calls.skipWaiting, 0, 'the new worker waits');
  const old = await w1.get(`${SCOPE}src/main.mjs`);
  assert.equal(await old.response.text(), 'v1v1v1v1:main', 'the running version still serves its own files');
  const fresh = await w2.get(`${SCOPE}src/main.mjs`);
  assert.equal(await fresh.response.text(), 'v2v2v2v2:main', 'and the new one its own');

  await w2.dispatch('message', { data: { type: 'something-else' } });
  assert.equal(w2.calls.skipWaiting, 0, 'an unknown message does nothing');
  await w2.dispatch('message', { data: { type: 'skip-waiting' } });
  assert.equal(w2.calls.skipWaiting, 1);
});

test('activate removes the old caches and claims the pages, and leaves other caches alone', async () => {
  const caches = new FakeCaches();
  await caches.open('coach-oldoldold');
  await caches.open('coach-older');
  await caches.open('somebody-elses');
  const net = server('cafe0123', FILES);
  const w = await worker({ caches, net });
  await w.dispatch('install');
  await w.dispatch('activate');
  assert.deepEqual((await caches.keys()).sort(), ['coach-cafe0123', 'somebody-elses']);
  assert.equal(w.calls.claim, 1);
});

test('a listed file that is missing fails the install loudly and leaves no half-filled cache', async () => {
  const caches = new FakeCaches();
  const net = server('bad00001', FILES, { missing: ['models/movenet-thunder-4/group1-shard1of3.bin'] });
  const w = await worker({ caches, net });
  await assert.rejects(() => w.dispatch('install'), /group1-shard1of3\.bin/);
  assert.deepEqual(await caches.keys(), [], 'a failed install stores nothing');
});

test('the install fails when files.json is missing, malformed, or not the version the worker was built for', async () => {
  const net = server('aaaa1111', FILES);
  const gone = { ...net, fetch: async () => new Response('', { status: 404 }), version: 'aaaa1111' };
  await assert.rejects(() => worker({ net: gone }).then(w => w.dispatch('install')), /files\.json/);

  const bad = { ...net, fetch: async () => new Response('{"version": 3}', { status: 200 }), version: 'aaaa1111' };
  await assert.rejects(() => worker({ net: bad }).then(w => w.dispatch('install')), /files\.json/);

  const odd = { ...net, fetch: async () => new Response(JSON.stringify({ version: 'aaaa1111', files: ['../secret'] }), { status: 200 }), version: 'aaaa1111' };
  await assert.rejects(() => worker({ net: odd }).then(w => w.dispatch('install')), /\.\.\/secret/);

  // sw.js stamped for one version, files.json already at another (a deploy half done)
  const half = server('aaaa1111', FILES, { listVersion: 'bbbb2222' });
  await assert.rejects(() => worker({ net: half }).then(w => w.dispatch('install')), /aaaa1111.*bbbb2222|bbbb2222.*aaaa1111/);

  // an unstamped sw.js (app/sw.js as it is in the repo) knows no version: it refuses to install
  await assert.rejects(() => worker({ net, stamped: false }).then(w => w.dispatch('install')), /stamp/i);
});

test('with its cache gone (evicted) the worker lets the network answer instead of failing', async () => {
  const net = server('aaaa1111', FILES);
  const w = await worker({ net });
  await w.dispatch('install');
  await w.caches.delete('coach-aaaa1111');
  net.log.length = 0;
  const r = await w.get(`${SCOPE}src/main.mjs`);
  assert.equal(await r.response.text(), 'aaaa1111:main');
  assert.deepEqual(net.log, [`${SCOPE}src/main.mjs`]);
});

test('sw.js names no host and no absolute path: its scope is where it is served from', () => {
  const text = SW.replace(/\/\/.*$/gm, '');
  assert.ok(!/https?:\/\//.test(text), 'no URL in sw.js');
  assert.ok(!/['"`]\/[a-z]/i.test(text), 'no absolute path in sw.js');
  assert.match(SW, /const BUILT_VERSION = null;/, 'the repo\'s copy carries assemble\'s stamp point');
});

// ---- assemble stamps the version into the copy in dist/ ----
test('assemble stamps sw.js in dist/ with files.json\'s version; the hash covers sw.js as it is in app/', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-swstamp-'));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('app/index.html', '<!doctype html>');
  put('app/sw.js', SW);
  put('src/diagnostics.js', '//');
  put('src/track/x.mjs', 'export {};');
  const run = (out) => execFileSync(process.execPath, [path.join(APP, 'tools', 'assemble.mjs'), '--app', path.join(root, 'app'), '--src', path.join(root, 'src'), '--out', out], { encoding: 'utf8' });
  const out = path.join(root, 'dist');
  run(out);
  const m = JSON.parse(fs.readFileSync(path.join(out, 'files.json'), 'utf8'));
  assert.ok(m.files.includes('sw.js'), 'sw.js is in the list');
  const stamped = fs.readFileSync(path.join(out, 'sw.js'), 'utf8');
  assert.ok(stamped.includes(`const BUILT_VERSION = ${JSON.stringify(m.version)};`));
  assert.equal(fs.readFileSync(path.join(root, 'app', 'sw.js'), 'utf8'), SW, 'app/sw.js itself is untouched');
  // a change to sw.js changes the version, and so the stamped bytes the browser compares
  put('app/sw.js', `${SW}\n// changed`);
  const out2 = path.join(root, 'dist2');
  run(out2);
  const m2 = JSON.parse(fs.readFileSync(path.join(out2, 'files.json'), 'utf8'));
  assert.notEqual(m2.version, m.version);
  // a sw.js that lost its stamp point is an error, not a worker that cannot install
  put('app/sw.js', '// no stamp point');
  assert.throws(() => run(path.join(root, 'dist3')), /BUILT_VERSION|stamp/i);
});

// ---- the page's side: register outside the APK, take over when idle ----
function fakeQueue({ busy = false } = {}) {
  const q = { busy: () => busy, waiters: [], idleCalls: 0 };
  q.idle = () => { q.idleCalls++; return busy ? new Promise(res => q.waiters.push(res)) : Promise.resolve(); };
  q.finish = () => { busy = false; q.waiters.splice(0).forEach(r => r()); };
  return q;
}
function fakeBrowser({ controller = true, waiting = null, native = false } = {}) {
  const swListeners = {};
  const regListeners = {};
  const registration = {
    waiting, installing: null,
    addEventListener: (t, f) => { (regListeners[t] ||= []).push(f); },
    update: async () => {},
  };
  const calls = { register: [] };
  const serviceWorker = {
    controller: controller ? { state: 'activated' } : null,
    register: async (url, opts) => { calls.register.push([url, opts]); return registration; },
    addEventListener: (t, f) => { (swListeners[t] ||= []).push(f); },
  };
  const win = native ? { Capacitor: { isNativePlatform: () => true } } : {};
  const emit = (listeners, t, ev = {}) => (listeners[t] || []).forEach(f => f(ev));
  return {
    navigator: { serviceWorker }, window: win, registration, calls,
    controllerChange: () => emit(swListeners, 'controllerchange'),
    updateFound: (w) => { registration.installing = w; emit(regListeners, 'updatefound'); },
  };
}
const aWorker = (state = 'installed') => {
  const listeners = {};
  return { state, messages: [], postMessage(m) { this.messages.push(m); }, addEventListener: (t, f) => { (listeners[t] ||= []).push(f); }, set(s) { this.state = s; (listeners.statechange || []).forEach(f => f()); } };
};
const tick = () => new Promise(r => setImmediate(r));

test('the worker is registered at ./sw.js with scope ./ in a browser', async () => {
  const { createUpdates } = await updatesModule();
  const b = fakeBrowser();
  const u = createUpdates({ queue: fakeQueue(), navigator: b.navigator, window: b.window });
  await u.register();
  assert.deepEqual(b.calls.register, [['./sw.js', { scope: './' }]]);
  assert.equal(u.state(), 'current');
});

test('not in the APK: Capacitor\'s native platform registers nothing', async () => {
  const { createUpdates } = await updatesModule();
  const b = fakeBrowser({ native: true });
  const u = createUpdates({ queue: fakeQueue(), navigator: b.navigator, window: b.window });
  await u.register();
  assert.deepEqual(b.calls.register, []);
  assert.equal(u.state(), 'off');
  // Capacitor present but on the web (isNativePlatform false) registers as any browser
  const w = fakeBrowser();
  w.window.Capacitor = { isNativePlatform: () => false };
  const v = createUpdates({ queue: fakeQueue(), navigator: w.navigator, window: w.window });
  await v.register();
  assert.equal(w.calls.register.length, 1);
});

test('a browser without service workers is not an error: the app runs as it is', async () => {
  const { createUpdates } = await updatesModule();
  const u = createUpdates({ queue: fakeQueue(), navigator: {}, window: {} });
  await u.register();
  assert.equal(u.state(), 'off');
});

test('a new version waits while a job runs and takes over once the queue is idle; then "ready"', async () => {
  const { createUpdates } = await updatesModule();
  const b = fakeBrowser();
  const queue = fakeQueue({ busy: true });
  const u = createUpdates({ queue, navigator: b.navigator, window: b.window });
  const seen = [];
  u.subscribe(s => seen.push(s));
  await u.register();

  const nw = aWorker('installing');
  b.updateFound(nw);
  nw.set('installed');
  await tick();
  assert.equal(u.state(), 'waiting');
  assert.deepEqual(nw.messages, [], 'a running job is not interrupted');
  queue.finish();
  await tick();
  assert.deepEqual(nw.messages, [{ type: 'skip-waiting' }]);
  b.controllerChange();
  assert.equal(u.state(), 'ready');
  assert.deepEqual(seen, ['off', 'current', 'waiting', 'ready'], 'subscribe gives the state now, then each change');
});

test('a worker already waiting at start (found on a later visit) is handled the same way', async () => {
  const { createUpdates } = await updatesModule();
  const waiting = aWorker('installed');
  const b = fakeBrowser({ waiting });
  const queue = fakeQueue({ busy: false });
  const u = createUpdates({ queue, navigator: b.navigator, window: b.window });
  await u.register();
  await tick();
  assert.deepEqual(waiting.messages, [{ type: 'skip-waiting' }], 'idle at once: it takes over at once');
});

test('the first install is not an update: no waiting, no "ready" line', async () => {
  const { createUpdates } = await updatesModule();
  const b = fakeBrowser({ controller: false });
  const u = createUpdates({ queue: fakeQueue(), navigator: b.navigator, window: b.window });
  await u.register();
  const first = aWorker('installing');
  b.updateFound(first);
  first.set('installed');
  b.controllerChange();   // clients.claim() on the first activation
  await tick();
  assert.deepEqual(first.messages, []);
  assert.equal(u.state(), 'current');
});

test('H shows the "update ready" line from the updates it is given, and main.mjs registers after the first draw', () => {
  const h = fs.readFileSync(path.join(APP, 'src', 'ui', 'screens', 'H.mjs'), 'utf8');
  assert.match(h, /updates/);
  assert.match(h, /Update ready/);
  const app = fs.readFileSync(path.join(APP, 'src', 'ui', 'app.mjs'), 'utf8');
  assert.match(app, /updates/, 'the shell hands the updates to its screens');
  const main = fs.readFileSync(path.join(APP, 'src', 'main.mjs'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.equal((main.match(/createUpdates\(/g) || []).length, 1);
  assert.equal((main.match(/\.register\(/g) || []).length, 1);
  assert.ok(main.indexOf('render(') < main.indexOf('.register('), 'registered after the first draw');
});
