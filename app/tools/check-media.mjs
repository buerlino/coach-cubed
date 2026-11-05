// SPDX-License-Identifier: AGPL-3.0-or-later
// node app/tools/check-media.mjs [--browser <path>] [--clips <dir>]
//
// The frame source (app/src/media/) on a real WebCodecs decoder: serves the
// repo's app/ and tests/app/clips/ on 127.0.0.1 (a free port), opens each clip
// in a page of headless Brave over the DevTools protocol, and checks what the
// Node tests can't: that the real VideoDecoder gives a range's frames in order
// with the right timestamps, that the frame sizes are the upright ones, that
// the rotated clip's frame has the pixels ffmpeg's own autorotation gives
// (within 8 levels of colour-conversion difference; needs ffmpeg, else skipped),
// and that a codec the decoder lacks (HEVC, on a desktop build without it)
// fails with `unsupported-codec` rather than a hang. Then M1–M3's one-frame step
// (s38), the check page's own measurement (app/debug/media.mjs): frameAt on the
// next frame's time against the stepper, forwards and back, as fast as the steps
// come and at a tap every 150 ms, on the 30 fps clip and on c34's k1.mp4 and
// k2to5.mp4 (1080p, keyframes every 1 s and every 2–5 s) when --clips names their
// folder (app/tools/make-phone-clips.sh); each frame must be the next by frameTimes.
// And the stepper's seek against frameAt at the same 20 random times (on k1 and
// k2to5 also at 1320 px high, a pixel ratio of 3's budget of 34 frames). And
// (s38f1) the decoded frames still open while a stepper sits on a frame: at most 2.
// Prints JSON; exits 1 on a failed check. Headless desktop timings say nothing
// about the Fairphone (c26).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIPS = resolve(APP, '..', 'tests', 'app', 'clips');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const EXTRA = arg('--clips', null) && resolve(arg('--clips'));
const STEP_CLIPS = ['testsrc2-h264-30fps', ...(EXTRA ? ['k1', 'k2to5'].filter(c => existsSync(join(EXTRA, `${c}.mp4`))) : [])];
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
  // M1–M3's step: frameAt on the next frame against the stepper (s38), same frames, same seed
  const { c34 } = await import('./app/debug/media.mjs');
  const steps = out.steps = {};
  for (const name of ${JSON.stringify(STEP_CLIPS)}) {
    const url = name.startsWith('testsrc2') ? './clips/' + name + '.mp4' : './extra/' + name + '.mp4';
    c34.add(name, await (await fetch(url)).blob());
    const n = name.startsWith('testsrc2') ? 20 : 30;
    steps[name] = {
      frameAt: await c34.step(name, { n, seed: 1 }),
      stepper: await c34.stepCached(name, { n, seed: 1 }),
      stepperTap: await c34.stepCached(name, { n, seed: 1, gapMs: 150 }),
      stepperBack: await c34.stepCached(name, { n, seed: 1, dir: -1 }),
      stepperBackTap: await c34.stepCached(name, { n, seed: 1, dir: -1, gapMs: 150 }),
      frameAtRandom: await c34.frameAtRandom(name, { n: 20, seed: 1 }),
      seek: await c34.seekCached(name, { n: 20, seed: 1 }),
      ...(name.startsWith('testsrc2') ? {} : { seek1320: await c34.seekCached(name, { n: 20, seed: 1, height: 1320 }) }),
    };
    for (const r of Object.values(steps[name])) { delete r.each; delete r.times; delete r.got; }
  }
  // the decoder's VideoFrames still open while a stepper sits on a frame (s38f1):
  // the paused forward decoder's, outside the budget; counted by media.mjs's
  // idleDecoded (the decoder's output wrapped), at the default budget 440 px high,
  // opened at a third of the clip, then after 10 steps forwards, each time once the
  // refill has settled (the phone runs the same call, c26)
  const idle = out.idle = {};
  for (const name of ${JSON.stringify(STEP_CLIPS)}) idle[name] = await c34.idleDecoded(name, { height: 440, at: 1 / 3, steps: 10 });
  return out;
})();
</script>`;

const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html', '.mp4': 'video/mp4' };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/check.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
  const [root, rest] = p.startsWith('/clips/') ? [CLIPS, p.slice(7)] : p.startsWith('/app/') ? [APP, p.slice(5)]
    : EXTRA && p.startsWith('/extra/') ? [EXTRA, p.slice(7)] : [null, null];
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
let browser = null;

let result;
try {
  browser = await launchBrowser(profile, ['--headless=new', 'about:blank']);
  const port = browser.port;
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
  const r = await send('Runtime.evaluate', { expression: 'window.check', awaitPromise: true, returnByValue: true, timeout: 480000 });
  result = r.result?.result?.value ?? { error: JSON.stringify(r).slice(0, 1000) };
  result.browser = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser;
  ws.close();
} catch (e) {
  result = { error: String(e.message || e) };
} finally {
  if (browser) await browser.close();
  server.close();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}

// ---- judge ----
const problems = [];
if (result.error) problems.push(result.error);
for (const [name, r] of Object.entries(result.idle || {})) {
  if (r.error) { problems.push(`idle ${name}: ${JSON.stringify(r.error)}`); continue; }
  for (const how of ['opened', 'stepped']) {
    if (r[how].decodedOpen > 2) problems.push(`idle ${name} ${how}: ${r[how].decodedOpen} decoded frames open beyond the stepper's budget, more than 2`);
  }
}
for (const [name, r] of Object.entries(result.steps || {})) {
  for (const [how, m] of Object.entries(r)) {
    if (m.error) { problems.push(`steps ${name} ${how}: ${JSON.stringify(m.error)}`); continue; }
    if (how.startsWith('seek')) { if (!m.right) problems.push(`steps ${name} ${how}: a seek did not give the frame shown at its time`); continue; }
    if (how === 'frameAtRandom') continue;
    if (!m.consecutive) problems.push(`steps ${name} ${how}: a step did not give the next frame by frameTimes`);
    if (how !== 'frameAt' && m.frame !== m.size) problems.push(`steps ${name} ${how}: frames are ${m.frame}, not the ${m.size} asked for`);
  }
}
for (const [name, r] of Object.entries(result)) {
  if (typeof r !== 'object' || !r || name === 'browser' || name === 'steps' || name === 'idle') continue;
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
