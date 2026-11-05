// SPDX-License-Identifier: AGPL-3.0-or-later
// node app/tools/check-offline.mjs [--browser <path>]
//
// The app offline (package c19), in a real page: assembles app/ into a
// temporary folder (so it needs build-tfjs.mjs's bundle and fetch-models.sh's
// weights, both gitignored), serves it on 127.0.0.1, opens headless Brave over
// the DevTools protocol and
//   1. loads the app online and waits for the service worker to be active
//      with its whole cache (every file of files.json, and files.json) filled;
//   2. takes the network away: Network.emulateNetworkConditions offline, and
//      the server shut down, so a request that reached the network could not
//      be answered either way;
//   3. reloads. Then it checks that the app drew, that every same-origin
//      request of the reload was answered by the service worker (none failed,
//      none was an HTTP error, none reached the server), and that the engine
//      loads its weights: PoseEngine.create() on WebGL and one frame through
//      estimate() give 17 keypoints or null (nobody);
//   4. lists the caches: exactly coach-<version>, holding only files.json's files.
// Prints what it found as JSON; exits 1 unless all of that holds.
// Headless Brave's WebGL is SwiftShader (software): this checks that the app
// loads and the engine answers, not its speed. Heavy: run it through
// pipeline/devlock.sh slice.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble } from './assemble.mjs';
import { createApp } from './serve.mjs';
import { launchBrowser } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Run in the page after the offline reload: the engine loads its weights and answers.
async function engineCheck() {
  const out = {};
  try {
    const { PoseEngine } = await import('./src/pose/pose-client.mjs');
    const W = 640, H = 480;
    const canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H), d = img.data;
    let a = 12345;
    for (let k = 0; k < d.length; k += 4) {
      for (let c = 0; c < 3; c++) { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; d[k + c] = a >>> 24; }
      d[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const t0 = performance.now();
    const engine = await PoseEngine.create({ backend: 'webgl' });
    out.createMs = Math.round(performance.now() - t0);
    out.info = engine.info;
    const t1 = performance.now();
    const r = await engine.estimate(new VideoFrame(canvas, { timestamp: 0 }), 0);
    out.estimateMs = Math.round(performance.now() - t1);
    out.keypoints = r.keypoints ? r.keypoints.length : 0;
    engine.close();
    out.ok = out.info.backend === 'webgl' && (out.keypoints === 17 || out.keypoints === 0);
  } catch (e) { out.error = String((e && e.stack) || e); }
  return out;
}

async function cachesOf() {
  const out = {};
  for (const name of await caches.keys()) out[name] = (await (await caches.open(name)).keys()).map(r => r.url);
  return out;
}

const dist = mkdtempSync(join(tmpdir(), 'coach-offline-dist-'));
const profile = mkdtempSync(join(tmpdir(), 'coach-offline-profile-'));
const quiet = fn => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };
const built = quiet(() => assemble({ out: dist, app: APP, src: resolve(APP, '..', 'src'), log: () => {} }));
if (!built.files.some(f => f.startsWith('vendor/tfjs/')) || !built.files.some(f => f.startsWith('models/'))) {
  console.error('check-offline: run node app/tools/build-tfjs.mjs and app/tools/fetch-models.sh first: the engine needs both');
  process.exit(1);
}
const expected = new Set([...built.files, 'files.json']);

const served = [];
const server = quiet(() => createApp(dist));
server.on('request', req => served.push(req.url));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

let browser = null;

let result = { version: built.version, files: built.files.length };
try {
  browser = await launchBrowser(profile, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  'about:blank']);
  const port = browser.port;
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m);
  };
  const send = (method, params = {}) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression, timeout = 60000) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result?.result?.value;
  };
  for (const d of ['Page', 'Network', 'Runtime', 'Log']) await send(`${d}.enable`);

  // 1. online: load, wait for the worker and its full cache
  let t = performance.now();
  await send('Page.navigate', { url: `${origin}/` });
  let filled = null;
  for (let i = 0; i < 1800 && !filled; i++) {   // 3 minutes: the engine warms up first (SwiftShader), then the worker registers
    await sleep(100);
    filled = await evaluate(`(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg || !reg.active) return null;
      const c = await caches.open('coach-${built.version}').catch(() => null);
      const n = c ? (await c.keys()).length : 0;
      return n === ${expected.size} ? { active: reg.active.state, cached: n } : null;
    })()`).catch(() => null);
  }
  if (!filled) throw new Error('the service worker was not active with a full cache within 3 minutes');
  result.online = { ...filled, ms: Math.round(performance.now() - t), requestsServed: served.length };

  // 2. offline: the emulation, and the server gone
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  server.close();
  server.closeAllConnections();
  const servedBefore = served.length;

  // 3. reload
  events.length = 0;
  t = performance.now();
  await send('Page.reload', { ignoreCache: false });   // a plain reload: a hard one bypasses every service worker, by design
  let drew = false;
  for (let i = 0; i < 300 && !events.some(e => e.method === 'Page.loadEventFired'); i++) await sleep(100);
  const loaded = events.some(e => e.method === 'Page.loadEventFired');
  for (let i = 0; i < 300 && !drew; i++) {
    await sleep(100);
    drew = await evaluate(`document.querySelector('#app')?.children.length > 0 && !!navigator.serviceWorker.controller`).catch(() => false);
  }
  result.reload = { loaded, appDrew: !!drew, ms: Math.round(performance.now() - t) };
  await sleep(1500);   // the module graph and the fonts settle
  const sent = events.filter(e => e.method === 'Network.requestWillBeSent').map(e => e.params);
  const responded = events.filter(e => e.method === 'Network.responseReceived').map(e => e.params);
  const failed = events.filter(e => e.method === 'Network.loadingFailed').map(e => ({ url: e.params.requestId, error: e.params.errorText }));
  const byId = new Map(sent.map(p => [p.requestId, p.request.url]));
  result.reload.requests = sent.length;
  result.reload.answered = responded.length;
  result.reload.fromServiceWorker = responded.filter(p => p.response.fromServiceWorker).length;
  result.reload.failed = failed.map(f => ({ url: byId.get(f.url) || f.url, error: f.error }));
  result.reload.httpErrors = responded.filter(p => p.response.status >= 400).map(p => `${p.response.status} ${p.response.url}`);
  result.reload.notFromWorker = responded.filter(p => !p.response.fromServiceWorker && p.response.url.startsWith(origin)).map(p => p.response.url);
  result.reload.consoleErrors = events.filter(e => (e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
    || e.method === 'Runtime.exceptionThrown').map(e => JSON.stringify(e.params).slice(0, 300));
  result.reload.reachedServer = served.length - servedBefore;

  // the engine's weights, from the cache
  result.engine = await evaluate(`(${engineCheck})()`, 240000);

  // 4. the caches hold the app's own files and nothing else
  const stores = await evaluate(`(${cachesOf})()`);
  const names = Object.keys(stores);
  const urls = (stores[`coach-${built.version}`] || []).map(u => u.slice(origin.length + 1));
  result.caches = { names, files: urls.length, foreign: urls.filter(u => !expected.has(u)), missing: [...expected].filter(u => !urls.includes(u)) };

  result.browser = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser;
  result.ok = !!(result.reload.loaded && result.reload.appDrew && result.reload.requests > 0
    && result.reload.failed.length === 0 && result.reload.httpErrors.length === 0 && result.reload.notFromWorker.length === 0
    && result.reload.reachedServer === 0 && result.reload.consoleErrors.length === 0
    && result.engine && result.engine.ok
    && names.length === 1 && names[0] === `coach-${built.version}` && result.caches.foreign.length === 0 && result.caches.missing.length === 0);
  ws.close();
} catch (e) {
  result.error = String(e.message || e);
} finally {
  if (browser) await browser.close();
  server.close();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
  rmSync(dist, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
