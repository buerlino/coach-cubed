// node app/tools/check-tfjs.mjs [--backend webgl|webgpu|cpu] [--browser <path>]
//
// The from-source bundle at work: serves app/ on 127.0.0.1 (a free port),
// imports vendor/tfjs/tfjs-<backend>.mjs, sets the backend, creates a MoveNet
// SinglePose Thunder detector from models/movenet-thunder-4/ and runs it on
// one fixed random image. WebGL and WebGPU in a page of headless Brave over
// the DevTools protocol; CPU in this Node process (its bundle is Node's).
// Prints what it found as JSON; exits 1 on an error.
// Needs build-tfjs.mjs's bundles and fetch-models.sh's weights. Headless
// Brave's WebGL is SwiftShader (software): this checks that the bundle loads
// and runs, not its speed. Heavy: run it through pipeline/devlock.sh slice.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const BROWSER = arg('--browser', '/usr/bin/brave-browser');
const BACKEND = arg('--backend', 'webgl');

// The check itself, run in the page (WebGL, WebGPU) or in Node (CPU).
async function runCheck(bundleUrl, modelUrl, backend) {
  const out = { backend };
  try {
    const t0 = performance.now();
    const { tf, poseDetection } = await import(bundleUrl);
    out.importMs = Math.round(performance.now() - t0);
    out.registered = ['webgl', 'webgpu', 'cpu'].filter(b => tf.findBackendFactory(b));
    out.setBackend = await tf.setBackend(backend);
    await tf.ready();
    out.active = tf.getBackend();
    out.version = tf.version_core;
    if (out.active === 'webgl') {
      const gl = tf.backend().gpgpu.gl, ext = gl.getExtension('WEBGL_debug_renderer_info');
      out.webglVersion = tf.env().getNumber('WEBGL_VERSION');
      out.renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    }
    const t1 = performance.now();
    const det = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
      modelType: poseDetection.movenet.modelType.SINGLEPOSE_THUNDER, enableSmoothing: false, modelUrl });
    out.createMs = Math.round(performance.now() - t1);
    const img = tf.randomUniform([480, 640, 3], 0, 255, 'int32', 7);
    const t2 = performance.now();
    const poses = await det.estimatePoses(img, { maxPoses: 1, flipHorizontal: false });
    out.firstEstimateMs = Math.round(performance.now() - t2);
    img.dispose();
    out.keypoints = poses[0] ? poses[0].keypoints.length : 0;
    out.ok = out.active === backend && out.keypoints === 17;
  } catch (e) { out.error = String((e && e.stack) || e); }
  return out;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>check-tfjs</title>
<script type="module">
${runCheck}
window.check = runCheck('./vendor/tfjs/tfjs-${BACKEND}.mjs', './models/movenet-thunder-4/model.json', ${JSON.stringify(BACKEND)});
</script>`;

const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.bin': 'application/octet-stream', '.html': 'text/html' };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/check.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
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
const url = `${base}/check.html`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (BACKEND === 'cpu') {
  const result = await runCheck(join(APP, 'vendor/tfjs/tfjs-cpu.mjs'), `${base}/models/movenet-thunder-4/model.json`, 'cpu');
  result.node = process.version;
  server.close();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

const profile = mkdtempSync(join(tmpdir(), 'coach-check-tfjs-'));
const browser = spawn(BROWSER, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--no-first-run', '--no-default-browser-check', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  ...(BACKEND === 'webgpu' ? ['--enable-unsafe-webgpu'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });

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
