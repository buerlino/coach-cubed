// SPDX-License-Identifier: AGPL-3.0-or-later
// node app/tools/check-capture.mjs [--browser <path>] [--seconds 12]
// npm --prefix app run check:capture
//
// The capture (app/src/media/capture.mjs, package c27) on a real camera stream, a real
// VideoEncoder and a real decoder: headless Brave's fake camera. Serves the repo's app/
// on 127.0.0.1 (a free port; a secure context, so getUserMedia exists), opens a page in
// headless Brave over the DevTools protocol, with --use-fake-ui-for-media-stream (the
// camera prompt answered yes) and the fake device, twice: with `=fps=30`, and without,
// where the fake device gives 20 fps whatever is asked (coach-a1's probe, 2026-11-02;
// the page also counts the device's frames itself before recording). Each run, with
// bufferS 5: open, start, 12 s, snapshot(3), snapshot(5), a follow() read for 2 s, stop,
// close. It checks:
//   - the reported rate is within 1 fps of the device's (as documented, and as counted);
//   - keyframes are 1 s apart, ±1 frame (the encoder's own output, on the camera's clock);
//   - the ring holds 5 s or more and less than 6 s;
//   - each snapshot opens with openFrameSource on the real decoder and gives its frames in
//     order, and its length is within one keyframe interval of what was asked;
//   - cutVideo of a range inside a snapshot opens too;
//   - follow() starts on a keyframe with the decoder config and then gives chunks live;
//   - the wake lock is held or refused, never an error; every track has ended after close();
//   - no console error, no exception.
// Prints JSON; exits 1 on a failed check. Laptop numbers (headless Brave, a software
// encoder, a synthetic picture): they say nothing about the Fairphone (c30).
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const SECONDS = Number(arg('--seconds', 12));
const BUFFER_S = 5;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// the fake device's rate with and without `fps=30` (coach-a1's probe of headless Brave, 2026-11-02)
const RUNS = [
  { name: 'fps=30', flag: '--use-fake-device-for-media-stream=fps=30', deviceFps: 30 },
  { name: 'default', flag: '--use-fake-device-for-media-stream', deviceFps: 20 },
];

const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import { createCapture } from './app/src/media/capture.mjs';
import { browserCaptureApi } from './app/src/media/capture-browser.mjs';
import { openFrameSource } from './app/src/media/frame-source.mjs';
import { cutVideo } from './app/src/media/cut.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const inOrder = v => v.every((x, i) => !i || x > v[i - 1]);
async function readBack(blob) {
  const t = performance.now();
  const src = await openFrameSource(blob);
  const openMs = Math.round(performance.now() - t);
  const stamps = [], sizes = new Set();
  const t2 = performance.now();
  for await (const f of src.frames(0, src.info.duration)) { stamps.push(f.timestamp); sizes.add(f.displayWidth + 'x' + f.displayHeight); f.close(); }
  const r = { openMs, decodeMs: Math.round(performance.now() - t2), info: src.info, frameTimes: src.frameTimes.length, frames: stamps.length, inOrder: inOrder(stamps), sizes: [...sizes] };
  src.close();
  return r;
}
window.check = (async () => {
  const out = {};
  try {
    // the device's own rate, counted before the capture records: frames over their timestamps' span
    const api = browserCaptureApi();
    const keys = [], outputs = [];
    const wrapped = { ...api, createEncoder: init => api.createEncoder({ ...init, output: (c, m) => {
      outputs.push({ type: c.type, timestamp: c.timestamp, bytes: c.byteLength, config: !!(m && m.decoderConfig) });
      init.output(c, m);
    } }) };
    const cap = createCapture({ camera: 'back', quality: '1080p30', bufferS: ${BUFFER_S} }, { api: wrapped });
    let t = performance.now();
    await cap.open();
    out.openMs = Math.round(performance.now() - t);
    const track = cap.stream.getVideoTracks()[0];
    out.trackSettings = track.getSettings();
    out.trackLabel = track.label;
    {
      const clone = track.clone(), reader = api.readFrames(clone), ts = [];
      const end = performance.now() + 3000;
      while (performance.now() < end) { const { value: f, done } = await reader.read(); if (done) break; ts.push(f.timestamp); f.close(); }
      reader.cancel(); clone.stop();
      out.deviceCounted = { frames: ts.length, fps: +((ts.length - 1) / ((ts.at(-1) - ts[0]) / 1e6)).toFixed(2) };
    }
    t = performance.now();
    await cap.start();
    out.startMs = Math.round(performance.now() - t);
    out.afterStart = cap.status;
    await sleep(${SECONDS * 1000});
    const s = cap.status;
    out.status = { state: s.state, fps: s.fps, width: s.width, height: s.height, rotation: s.rotation, sinceS: s.sinceS, heldS: s.heldS, bytes: s.bytes, dropped: s.dropped, wakeLock: s.wakeLock, error: s.error && { code: s.error.code, message: s.error.message } };
    out.encoded = { outputs: outputs.length, keys: outputs.filter(o => o.type === 'key').map(o => o.timestamp), configs: outputs.filter(o => o.config).length,
      bytes: outputs.reduce((a, o) => a + o.bytes, 0) };
    const ts = outputs.map(o => o.timestamp), d = ts.slice(1).map((x, i) => x - ts[i]).sort((a, b) => a - b);
    out.encoded.medianIntervalUs = d[d.length >> 1];
    out.snapshots = {};
    for (const seconds of [3, 5]) {
      t = performance.now();
      const snap = await cap.snapshot(seconds);
      const r = out.snapshots[seconds] = { ms: Math.round(performance.now() - t), bytes: snap.blob.size, duration: snap.duration, start: snap.start };
      try { r.readBack = await readBack(snap.blob); } catch (e) { r.readBack = { error: { code: e.code, message: e.message } }; }
      if (seconds === 5) {
        try {
          t = performance.now();
          const cut = await cutVideo(snap.blob, { t0: 1.5, t1: 3.5 });
          r.cut = { ms: Math.round(performance.now() - t), bytes: cut.blob.size, start: cut.start, duration: cut.duration, readBack: await readBack(cut.blob) };
        } catch (e) { r.cut = { error: { code: e.code, message: e.message } }; }
      }
    }
    // follow from 3 s before the newest frame, for 2 s
    {
      const f = out.follow = { chunks: 0, first: null, inOrder: true, live: 0 };
      // the recording's clock starts at its first frame, the encoder's first output
      const startT = Math.max(0, (outputs.at(-1).timestamp - outputs[0].timestamp) / 1e6 - 3);
      const it = cap.follow(startT)[Symbol.asyncIterator]();
      const end = performance.now() + 2000;
      let last = -Infinity;
      const newestAtStart = (outputs.at(-1).timestamp - outputs[0].timestamp);
      while (performance.now() < end) {
        const { value: c, done } = await it.next();
        if (done) break;
        if (!f.first) f.first = { type: c.type, timestamp: c.timestamp, config: !!c.decoderConfig, startT };
        if (c.timestamp <= last) f.inOrder = false;
        last = c.timestamp;
        f.chunks++;
        if (c.timestamp > newestAtStart + 1) f.live++;
      }
      await it.return();
    }
    const tracks = cap.stream.getTracks();
    await cap.stop();
    out.afterStop = { state: cap.status.state, heldS: cap.status.heldS, bytes: cap.status.bytes, wakeLock: cap.status.wakeLock };
    cap.close();
    out.afterClose = { state: cap.status.state, tracks: tracks.map(x => x.readyState), stream: cap.stream };
  } catch (e) { out.error = { code: e.code, name: e.name, message: e.message, stack: String(e.stack).slice(0, 600) }; }
  return out;
})();
</script>`;

const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html' };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/check.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  const file = p.startsWith('/app/') && normalize(join(APP, p.slice(5)));
  try {
    if (!file || !file.startsWith(APP + sep) || !statSync(file).isFile()) throw new Error('not served');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/check.html`;
const chromiumDirs = () => new Set(readdirSync(tmpdir()).filter(n => n.startsWith('org.chromium.Chromium.')));
const before = chromiumDirs();

async function runOnce(run) {
  const profile = mkdtempSync(join(tmpdir(), 'coach-check-capture-'));
  let browser = null, result;
  const errors = [];
  try {
    browser = await launchBrowser(profile, ['--headless=new', '--use-fake-ui-for-media-stream', run.flag, 'about:blank']);
    const port = browser.port;
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) {
        errors.push(`console.${m.params.type}: ${m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 300)}`);
      } else if (m.method === 'Runtime.exceptionThrown') {
        errors.push(`exception: ${(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300)}`);
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        errors.push(`log: ${m.params.entry.text.slice(0, 300)}${m.params.entry.url ? ` (${m.params.entry.url})` : ''}`);
      }
    };
    const send = (method, params = {}) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.navigate', { url });
    for (let i = 0; i < 100; i++) {
      const r = await send('Runtime.evaluate', { expression: 'typeof window.check' });
      if (r.result?.result?.value === 'object') break;
      await sleep(100);
    }
    const r = await send('Runtime.evaluate', { expression: 'window.check', awaitPromise: true, returnByValue: true, timeout: 180000 });
    result = r.result?.result?.value ?? { error: JSON.stringify(r).slice(0, 1000) };
    result.browser = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser;
    ws.close();
  } catch (e) {
    result = { error: String(e.message || e) };
  } finally {
    // the folder of the profile's singleton socket (org.chromium.Chromium.XXXXXX in the temp folder): a browser
    // ended by a signal leaves it behind, so it goes with the profile (only this one, found by the profile's link)
    let socketDir = null;
    try {
      const d = dirname(readlinkSync(join(profile, 'SingletonSocket')));
      if (dirname(d) === tmpdir() && basename(d).startsWith('org.chromium.Chromium.')) socketDir = d;
    } catch { /* no socket link */ }
    if (browser) await browser.close();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  }
  result.console = errors;
  return result;
}

// ---- judge ----
function judge(run, r) {
  const problems = [];
  const p = m => problems.push(`${run.name}: ${m}`);
  if (r.error) { p(`the page failed: ${JSON.stringify(r.error)}`); return problems; }
  for (const c of r.console) p(c);
  const s = r.status;
  if (s.state !== 'recording') p(`the capture is ${s.state} after ${SECONDS} s, not recording${s.error ? `: ${s.error.code} ${s.error.message}` : ''}`);
  if (s.error) p(`an error: ${JSON.stringify(s.error)}`);
  if (!(Math.abs(s.fps - run.deviceFps) <= 1)) p(`the capture reports ${s.fps} fps, the device gives ${run.deviceFps}`);
  if (!(Math.abs(s.fps - r.deviceCounted.fps) <= 1)) p(`the capture reports ${s.fps} fps, the page counted ${r.deviceCounted.fps}`);
  const frameUs = 1e6 / run.deviceFps;
  const gaps = r.encoded.keys.slice(1).map((k, i) => k - r.encoded.keys[i]);
  r.keyframeGapsMs = gaps.map(g => Math.round(g / 100) / 10);
  if (gaps.length < SECONDS - 2) p(`${r.encoded.keys.length} keyframes in ${SECONDS} s`);
  const off = gaps.filter(g => Math.abs(g - 1e6) > frameUs + 1000);
  if (off.length) p(`keyframes not 1 s ± 1 frame apart: ${off.map(g => (g / 1e3).toFixed(1) + ' ms').join(', ')}`);
  if (!(s.heldS >= BUFFER_S && s.heldS < BUFFER_S + 1)) p(`the ring holds ${s.heldS} s, not [${BUFFER_S}, ${BUFFER_S + 1}) s`);
  for (const [asked, snap] of Object.entries(r.snapshots)) {
    const rb = snap.readBack;
    if (rb.error) { p(`snapshot(${asked}) does not open: ${JSON.stringify(rb.error)}`); continue; }
    if (!rb.inOrder) p(`snapshot(${asked})'s frames are out of order`);
    if (rb.frames !== rb.frameTimes) p(`snapshot(${asked}) gave ${rb.frames} frames, its table lists ${rb.frameTimes}`);
    if (!(snap.duration >= Number(asked) - 1e-3 && snap.duration <= Number(asked) + 1 + frameUs / 1e6 + 1e-3)) p(`snapshot(${asked}) is ${snap.duration} s long, not within a keyframe interval of ${asked} s`);
    if (snap.cut) {
      if (snap.cut.error) p(`the cut of snapshot(${asked}) failed: ${JSON.stringify(snap.cut.error)}`);
      else if (snap.cut.readBack.error || !snap.cut.readBack.inOrder || !snap.cut.readBack.frames) p(`the cut of snapshot(${asked}) does not open: ${JSON.stringify(snap.cut.readBack)}`);
    }
  }
  const f = r.follow;
  if (!f.first || f.first.type !== 'key' || !f.first.config) p(`follow() did not start on a keyframe with its config: ${JSON.stringify(f.first)}`);
  if (!f.inOrder) p('follow() gave chunks out of order');
  if (!(f.live >= 1.5 * run.deviceFps * 0.8)) p(`follow() gave ${f.live} live chunks in 2 s`);
  if (!['held', 'refused'].includes(s.wakeLock)) p(`the wake lock is ${s.wakeLock}`);
  if (r.afterStop.state !== 'preview' || r.afterStop.heldS !== 0) p(`after stop(): ${JSON.stringify(r.afterStop)}`);
  if (r.afterClose.state !== 'closed' || !r.afterClose.tracks.length || r.afterClose.tracks.some(t => t !== 'ended')) p(`after close(): ${JSON.stringify(r.afterClose)}`);
  return problems;
}

const result = { seconds: SECONDS, bufferS: BUFFER_S, runs: {} };
const problems = [];
try {
  for (const run of RUNS) {
    const r = result.runs[run.name] = await runOnce(run);
    r.deviceFps = run.deviceFps;
    problems.push(...judge(run, r));
    if (r.encoded) delete r.encoded.keys;
    // laptop numbers: the encoder's real bitrate on the fake camera's picture, and 60 s of it
    if (r.status && r.status.heldS > 0) r.ringMbitPerS = +(r.status.bytes * 8 / r.status.heldS / 1e6).toFixed(2);
  }
} finally {
  server.close();
}
const left = [...chromiumDirs()].filter(n => !before.has(n));
// reported, not judged: other runs' browsers share the temp folder (this tool removes its own, above)
if (left.length) result.chromiumDirsNew = left;
result.ok = problems.length === 0;
if (problems.length) result.problems = problems;
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
