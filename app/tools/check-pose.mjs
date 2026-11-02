// node app/tools/check-pose.mjs [--frames N] [--browser <path>]
//
// The pose engine (app/src/pose/) at work in a real page: serves app/ on
// 127.0.0.1 (a free port), opens headless Brave, starts PoseEngine over its
// module worker on the WebGL bundle, and runs a few synthetic frames through
// estimate(): fixed hash noise on a canvas (MoveNet scores a pose in it, as in
// check-tfjs.mjs), wrapped in a VideoFrame; one frame with a drawn figure,
// which may come back as null (nobody); then reset(), and a noise frame again. It reports, as JSON,
// the engine's info, the init time (warm-up included), each estimate's
// keypoint count and ms, and the first point of the first pose; exits 1 unless
// every noise estimate answered with 17 keypoints [y, x, conf] inside a plausible
// range of the frame's pixels.
// Needs build-tfjs.mjs's bundle and fetch-models.sh's weights. Headless Brave's
// WebGL is SwiftShader (software): this checks that the engine loads and
// answers, not its speed or whether a drawn figure is "found" the way a lifter
// is. The phone's numbers are c20's and c26's. Heavy: run it through
// pipeline/devlock.sh slice.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const BROWSER = arg('--browser', '/usr/bin/brave-browser');
const FRAMES = Number(arg('--frames', 3));
const W = 640, H = 480;

// Run in the page. A gradient, with noise or without; a figure on it: a head,
// a trunk, arms and legs as thick lines, shifted 4 px per frame.
async function runCheck(frames, W, H) {
  const out = { frames: [] };
  try {
    const { PoseEngine } = await import('./src/pose/pose-client.mjs');
    const canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext('2d');
    const frameAt = (i, noise) => {
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#3a4a5a'); g.addColorStop(1, '#a89c8a');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      if (noise) {   // hash noise, the same every run: MoveNet scores a pose in it (check-tfjs.mjs's input is noise too)
        const img = ctx.getImageData(0, 0, W, H), d = img.data;
        let a = 12345;
        for (let k = 0; k < d.length; k += 4) {
          for (let c = 0; c < 3; c++) { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; d[k + c] = a >>> 24; }
        }
        ctx.putImageData(img, 0, 0);
      }
      const x = 320 + 4 * i;
      ctx.strokeStyle = '#e8d0b8'; ctx.fillStyle = '#e8d0b8'; ctx.lineWidth = 22; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(x, 110, 26, 0, 7); ctx.fill();
      for (const [x0, y0, x1, y1] of [[x, 150, x, 300], [x, 170, x - 90, 250], [x, 170, x + 90, 250],
        [x, 300, x - 40, 440], [x, 300, x + 40, 440]]) {
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      return new VideoFrame(canvas, { timestamp: i * 33333 });
    };
    const t0 = performance.now();
    const engine = await PoseEngine.create({ backend: 'webgl' });
    out.initMs = Math.round(performance.now() - t0);
    out.info = engine.info;
    const run = async (i, label, noise) => {
      const t = performance.now();
      const r = await engine.estimate(frameAt(i, noise), i * 33.333);
      const kp = r.keypoints;
      out.frames.push({ label, wallMs: Math.round(performance.now() - t), workerMs: Math.round(r.ms),
        keypoints: kp ? kp.length : 0, first: kp ? kp[0].map(v => Math.round(v * 100) / 100) : null,
        inFrame: kp ? kp.every(([y, x]) => y > -H && y < 2 * H && x > -W && x < 2 * W) : null });
    };
    for (let i = 0; i < frames; i++) await run(i, 'noise frame ' + i, true);
    await run(frames, 'figure frame', false);   // reported, not required: a drawn figure may be "nobody"
    const t1 = performance.now();
    await engine.reset();
    out.resetMs = Math.round(performance.now() - t1);
    await run(0, 'noise after reset', true);
    engine.close();
    out.ok = out.info.backend === 'webgl' && out.frames.filter(f => /noise/.test(f.label)).every(f => f.keypoints === 17 && f.inFrame);
  } catch (e) { out.error = String((e && e.stack) || e); }
  return out;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>check-pose</title>
<script type="module">
${runCheck}
window.check = runCheck(${FRAMES}, ${W}, ${H});
</script>`;

const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.bin': 'application/octet-stream', '.html': 'text/html' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/check-pose.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
  const file = normalize(join(APP, path));
  if (!file.startsWith(APP + sep)) { res.writeHead(403); return res.end(); }
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const url = `${base}/check-pose.html`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'coach-check-pose-'));
const browser = spawn(BROWSER, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--no-first-run', '--no-default-browser-check', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });

let result;
try {
  const port = await new Promise((res, rej) => {
    let err = '';
    const timer = setTimeout(() => rej(new Error('no DevTools port from the browser: ' + err.slice(-500))), 30000);
    browser.stderr.on('data', d => {
      err += d;
      const m = err.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(timer); res(m[1]); }
    });
    browser.on('exit', code => rej(new Error(`the browser exited (${code}): ${err.slice(-500)}`)));
  });
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });
  for (let i = 0; i < 100; i++) {
    const r = await send('Runtime.evaluate', { expression: 'typeof window.check' });
    if (r.result?.result?.value === 'object') break;
    await sleep(100);
  }
  const r = await send('Runtime.evaluate', { expression: 'window.check', awaitPromise: true, returnByValue: true, timeout: 240000 });
  result = r.result?.result?.value ?? { error: JSON.stringify(r).slice(0, 1000) };
  result.browser = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser;
  ws.close();
} catch (e) {
  result = { error: String(e.message || e) };
} finally {
  browser.kill();
  server.close();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
