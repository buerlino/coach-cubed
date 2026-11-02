// node app/tools/check-media.mjs [--browser <path>]
//
// The frame source (app/src/media/) on a real WebCodecs decoder: serves the
// repo's app/ and tests/app/clips/ on 127.0.0.1 (a free port), opens each clip
// in a page of headless Brave over the DevTools protocol, and checks what the
// Node tests can't: that the real VideoDecoder gives a range's frames in order
// with the right timestamps, that the frame sizes are the upright ones, that
// the rotated clip's frame has the pixels ffmpeg's own autorotation gives
// (within 8 levels of colour-conversion difference; needs ffmpeg, else skipped),
// and that a codec the decoder lacks (HEVC, on a desktop build without it)
// fails with `unsupported-codec` rather than a hang. Prints JSON; exits 1 on a
// failed check. Headless desktop timings say nothing about the Fairphone (c26).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIPS = resolve(APP, '..', 'tests', 'app', 'clips');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const BROWSER = arg('--browser', '/usr/bin/brave-browser');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import { openFrameSource } from './app/src/media/frame-source.mjs';
const CLIP_NAMES = ['testsrc2-h264-30fps', 'testsrc2-h264-30fps-rot90', 'testsrc2-h264-vfr', 'testsrc2-hevc-30fps'];
window.check = (async () => {
  const out = {};
  for (const name of CLIP_NAMES) {
    const r = out[name] = {};
    try {
      const blob = await (await fetch('./clips/' + name + '.mp4')).blob();
      let t = performance.now();
      const src = await openFrameSource(blob);
      r.openMs = Math.round(performance.now() - t);
      r.info = src.info;
      t = performance.now();
      const stamps = [], sizes = new Set();
      for await (const f of src.frames(0.8, 2.2)) { stamps.push(f.timestamp); sizes.add(f.displayWidth + 'x' + f.displayHeight); f.close(); }
      r.range = { frames: stamps.length, first: stamps[0], last: stamps.at(-1), inOrder: stamps.every((v, i) => !i || v > stamps[i - 1]), sizes: [...sizes], ms: Math.round(performance.now() - t) };
      r.expectedInRange = src.frameTimes.filter(x => x >= 0.8 - 1e-6 && x <= 2.2 + 1e-6).length;
      const f = await src.frameAt(1.5);
      r.frameAt = { timestamp: f.timestamp, size: f.displayWidth + 'x' + f.displayHeight, rotation: f.rotation ?? 0 };
      if (name.endsWith('rot90')) {
        const c = new OffscreenCanvas(f.displayWidth, f.displayHeight), x = c.getContext('2d');
        x.drawImage(f, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height).data;
        let bin = ''; for (let i = 0; i < d.length; i++) bin += String.fromCharCode(d[i]);
        r.rgba = btoa(bin);
      }
      f.close();
      const th = await src.thumbnails([0.1, 1.5, 2.9], { height: 32 });
      r.thumbs = th.map(b => b.width + 'x' + b.height); th.forEach(b => b.close());
      src.close();
    } catch (e) { r.error = { code: e.code, message: e.message }; }
  }
  return out;
})();
</script>`;

const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.mp4': 'video/mp4' };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/check.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
  const [root, rest] = p.startsWith('/clips/') ? [CLIPS, p.slice(7)] : p.startsWith('/app/') ? [APP, p.slice(5)] : [null, null];
  const file = root && normalize(join(root, rest));
  try {
    if (!file || !file.startsWith(root + sep) || !statSync(file).isFile()) throw new Error('not served');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/check.html`;
const profile = mkdtempSync(join(tmpdir(), 'coach-check-media-'));
const browser = spawn(BROWSER, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });

let result;
try {
  const port = await new Promise((res, rej) => {
    let err = '';
    const timer = setTimeout(() => rej(new Error('no DevTools port from the browser: ' + err.slice(-500))), 30000);
    browser.stderr.on('data', d => { err += d; const m = err.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//); if (m) { clearTimeout(timer); res(m[1]); } });
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
  const r = await send('Runtime.evaluate', { expression: 'window.check', awaitPromise: true, returnByValue: true, timeout: 90000 });
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

// ---- judge ----
const problems = [];
if (result.error) problems.push(result.error);
for (const [name, r] of Object.entries(result)) {
  if (typeof r !== 'object' || !r || name === 'browser') continue;
  if (name.includes('hevc')) {
    // a desktop build may decode HEVC; then it must open like the others
    if (r.error && r.error.code !== 'unsupported-codec') problems.push(`${name}: ${JSON.stringify(r.error)}`);
    continue;
  }
  if (r.error) { problems.push(`${name}: ${JSON.stringify(r.error)}`); continue; }
  if (!r.range.inOrder) problems.push(`${name}: the range is out of order`);
  if (r.range.frames !== r.expectedInRange) problems.push(`${name}: ${r.range.frames} frames in the range, the sample table says ${r.expectedInRange}`);
  const upright = `${r.info.width}x${r.info.height}`;
  if (r.range.sizes.join() !== upright || r.frameAt.size !== upright) problems.push(`${name}: frames are not ${upright}`);
  if (r.frameAt.rotation !== 0) problems.push(`${name}: a frame still carries rotation ${r.frameAt.rotation}`);
  if (r.rgba) {
    const ff = spawnSync('ffmpeg', ['-v', 'error', '-i', join(CLIPS, `${name}.mp4`), '-vf', 'select=eq(n\\,45)', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 24 });
    if (ff.status === 0 && ff.stdout.length) {
      const mine = Buffer.from(r.rgba, 'base64');
      let max = ff.stdout.length === mine.length ? 0 : 255;
      for (let i = 0; max < 255 && i < mine.length; i += 4) for (let k = 0; k < 3; k++) max = Math.max(max, Math.abs(mine[i + k] - ff.stdout[i + k]));
      r.rotationVsFfmpegMaxDiff = max;
      if (max > 8) problems.push(`${name}: frame 45 differs from ffmpeg's autorotated one by ${max} levels`);
    } else r.rotationVsFfmpegMaxDiff = 'skipped (no ffmpeg)';
    delete r.rgba;
  }
}
result.ok = problems.length === 0;
if (problems.length) result.problems = problems;
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
