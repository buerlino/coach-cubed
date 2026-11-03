// SPDX-License-Identifier: AGPL-3.0-or-later
// node app/tools/check-media-apk.mjs --serial <serial> --clips <dir> [--runs N] [--only a,b] [--out FILE] [--apk PATH] [--port P] [--keep]
//
// s9's frame source and s32's cut on a phone (package c34), from the debug
// APK's check page (app/debug/media.mjs) over the WebView's DevTools, like
// check-apk.mjs does for c20's checks. It installs app/out/coach-debug.apk,
// copies the clips (tools/make-phone-clips.sh: k1, k2to5, p60, rot90,
// rot90p60, vfr, hevc, big) into the app's own files/c34/ with run-as, sets
// them on the page's #media input (DOM.setFileInputFiles: no picker, no tap),
// then runs each measurement N times (5), interleaved (run 1 of everything,
// then run 2 ...), and prints one JSON object (also written to --out as it goes).
//
// Memory: around every call a sampler on the phone reads VmRSS of the app's
// process and of the WebView renderer it binds (/proc/<pid>/status, every
// 200 ms; 2 s idle first for the baseline), so each run has its baseline and
// peak (the samples from the last one before the call to the first after it). The hardware decoder's own process (the codec service) isn't counted.
// Before every run the battery is read: under 10 % it stops; over 36 °C it waits
// (up to 5 min) for the phone to cool.
//
// After: the clips and the sampler's files removed, the forward removed, the app
// uninstalled (unless --keep). Touches nothing but coach's own app and its own
// /data/local/tmp/coach-c34-* files. The phone's lock and stay-awake are the
// caller's (docs/pipeline.md, "The phone").
import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = 'org.coach.placeholder';
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const SERIAL = arg('--serial', process.env.ANDROID_SERIAL);
const CLIPS = arg('--clips');
const RUNS = Number(arg('--runs', 5));
const ONLY = arg('--only') ? arg('--only').split(',') : null;
const OUT = resolve(arg('--out', resolve(APP, 'out/check-media-apk.json')));
const APK = resolve(arg('--apk', resolve(APP, 'out/coach-debug.apk')));
const PORT = Number(arg('--port', 9336));
const KEEP = process.argv.includes('--keep');
if (!SERIAL || !CLIPS) { console.error('check-media-apk: --serial <serial> and --clips <dir> are required'); process.exit(2); }

// The measurements: [id, call, clip, args]. Every id runs RUNS times; k is the run (1..RUNS), the seed of the random ones.
const PLAN = [
  ...['k1', 'k2to5', 'p60', 'rot90', 'rot90p60', 'vfr', 'hevc', 'big'].map(c => [`open-${c}`, 'open', c, () => undefined]),
  ...['k1', 'k2to5', 'p60', 'rot90', 'rot90p60', 'vfr', 'big'].map(c => [`decode-${c}`, 'decodeRate', c, () => ({ t0: 0, t1: 60, consumerMs: 0 })]),
  ['decode-hevc', 'decodeRate', 'hevc', () => ({ t0: 0, t1: 10, consumerMs: 0 })],
  ['rotate-k1', 'rotateCost', 'k1', () => ({ t0: 0, t1: 10, rotation: 90 })],
  ['rotate-p60', 'rotateCost', 'p60', () => ({ t0: 0, t1: 10, rotation: 90 })],
  ['frameAt-k1', 'frameAtRandom', 'k1', k => ({ n: 20, seed: k })],
  ['frameAt-k2to5', 'frameAtRandom', 'k2to5', k => ({ n: 20, seed: k })],
  ['step-k1', 'step', 'k1', k => ({ n: 30, seed: k })],
  ['step-k2to5', 'step', 'k2to5', k => ({ n: 30, seed: k })],
  // s38's stepper on the same frames: as fast as the steps come, and at a tap every 150 ms; forwards and back
  ...['k1', 'k2to5'].flatMap(c => [
    [`stepCached-${c}`, 'stepCached', c, k => ({ n: 30, seed: k })],
    [`stepCached-tap-${c}`, 'stepCached', c, k => ({ n: 30, seed: k, gapMs: 150 })],
    [`stepCached-back-${c}`, 'stepCached', c, k => ({ n: 30, seed: k, dir: -1, gapMs: 150 })],
    [`seekCached-${c}`, 'seekCached', c, k => ({ n: 20, seed: k })],
  ]),
  ['cut-k1', 'cut', 'k1', () => ({ t0: 0, t1: 60 })],
  ['keep-k1', 'cut', 'k1', () => ({ t0: 0, t1: 60, keep: true })],
  ['cut-big', 'cut', 'big', () => ({ t0: 0, t1: 60 })],
  ['backpressure-k1', 'decodeRate', 'k1', () => ({ t0: 0, t1: 60, consumerMs: 100 })],
].filter(([id]) => !ONLY || ONLY.some(o => id === o || id.startsWith(`${o}-`)));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const adb = (...a) => execFileSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 26 }).replace(/\r/g, '').trim();
const sh = cmd => adb('shell', cmd);
const median = v => { const s = v.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const TMP = '/data/local/tmp/coach-c34';

async function cdp(port) {
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find(t => t.type === 'page');
    } catch { /* not up yet */ }
    if (!page) await sleep(200);
  }
  if (!page) throw new Error('no page target over DevTools');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  ws.onclose = () => { for (const res of pending.values()) res({ error: { message: 'DevTools closed' } }); pending.clear(); };
  const send = (method, params = {}) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression, opts = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...opts });
    if (r.error) throw new Error(r.error.message);
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

// VmRSS (kB) of the app and its renderers every 200 ms, until the stop file appears (or 15 min)
function sampler(appPid, rendererPids) {
  const stop = `${TMP}-stop`;
  sh(`rm -f ${stop}`);
  const rss = p => `$(awk '/VmRSS/{print $2}' /proc/${p}/status 2>/dev/null)`;
  const loop = `i=0; while [ $i -lt 4500 ] && [ ! -e ${stop} ]; do a=${rss(appPid)}; r=0; `
    + `for p in ${rendererPids.join(' ') || 'none'}; do v=${rss('$p')}; r=$((r + \${v:-0})); done; `
    + `echo "$(date +%s%3N) \${a:-0} $r"; i=$((i+1)); sleep 0.2; done`;
  const child = spawn('adb', ['-s', SERIAL, 'shell', loop], { stdio: ['ignore', 'pipe', 'ignore'] });
  let text = '';
  child.stdout.on('data', d => { text += d; });
  const done = new Promise(r => child.on('exit', r));
  return {
    // the samples received so far: those before a call are its baseline (the phone's clock isn't the laptop's)
    mark: () => (text.match(/\n/g) || []).length,
    async stop() {
      try { sh(`touch ${stop}`); } catch { /* gone */ }
      await Promise.race([done, sleep(5000)]);
      child.kill();
      try { sh(`rm -f ${stop}`); } catch { /* gone */ }
      return text.trim().split('\n').map(l => l.trim().split(/\s+/).map(Number)).filter(a => a.length === 3 && a.every(Number.isFinite));
    },
  };
}

function battery() {
  const b = sh('dumpsys battery');
  const num = re => Number((b.match(re) || [])[1]);
  return { level: num(/\n\s*level: (\d+)/), tempC: num(/temperature: (\d+)/) / 10 };
}

async function coolDown(log) {
  let b = battery();
  for (let w = 0; b.tempC > 36 && w < 20; w++) { log.push({ cooling: b }); await sleep(15000); b = battery(); }
  return b;
}

const out = { serial: SERIAL, package: PKG, runs: RUNS, results: {}, started: new Date().toISOString() };
const save = () => { try { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(out, null, 2)); } catch { /* best effort */ } };
let forwarded = false, copied = false;
try {
  out.device = {
    model: sh('getprop ro.product.model'), android: sh('getprop ro.build.version.release'),
    build: sh('getprop ro.build.display.id'),
    webview: (sh('dumpsys webviewupdate').match(/Current WebView package \(name, version\): \(([^)]*)\)/) || [])[1] || null,
    dataFree: sh('df -h /data | tail -1'),
  };
  out.apk = { path: APK, bytes: Number(execFileSync('stat', ['-c', '%s', APK], { encoding: 'utf8' }).trim()) };
  adb('install', '-r', APK);
  sh(`am force-stop ${PKG}`);
  sh(`am start -n ${PKG}/.MainActivity`);
  let pid = '';
  for (let i = 0; i < 50 && !pid; i++) { await sleep(200); try { pid = sh(`pidof ${PKG}`); } catch { pid = ''; } }
  if (!pid) throw new Error('the app did not start');
  adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
  forwarded = true;
  let c = await cdp(PORT);
  for (let i = 0; i < 50; i++) {
    if (await c.evaluate("document.readyState === 'complete' && !!document.querySelector('#app')?.children.length")) break;
    await sleep(200);
  }
  const origin = new URL(await c.evaluate('location.href')).origin;
  await c.send('Page.navigate', { url: `${origin}/debug/check.html` });
  await sleep(1000);
  c.close();
  c = await cdp(PORT);
  for (let i = 0; i < 100; i++) {
    if (await c.evaluate("typeof window.c34 === 'object' && typeof window.c20 === 'object'")) break;
    await sleep(200);
  }
  out.basics = await c.evaluate('window.c20.basics', { timeout: 60000 });

  // The clips into the app's own files/c34/, one at a time through /data/local/tmp.
  const names = readdirSync(CLIPS).filter(f => f.endsWith('.mp4')).sort();
  sh(`run-as ${PKG} mkdir -p files/c34`);
  copied = true;
  for (const f of names) {
    adb('push', join(CLIPS, f), `${TMP}-clip.mp4`);
    try { sh(`run-as ${PKG} cp ${TMP}-clip.mp4 files/c34/${f}`); } finally { sh(`rm -f ${TMP}-clip.mp4`); }
  }
  out.clips = sh(`run-as ${PKG} ls -l files/c34`);
  const doc = await c.send('DOM.getDocument', {});
  const node = await c.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#media' });
  const set = await c.send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: names.map(f => `/data/user/0/${PKG}/files/c34/${f}`) });
  if (set.error) throw new Error(`setFileInputFiles: ${set.error.message}`);
  out.names = await c.evaluate('window.c34.ready', { timeout: 30000 });

  // The renderer the app binds (Android WebView's sandboxed process), for the memory.
  const bound = sh(`dumpsys activity services ${PKG}`).match(/app=ProcessRecord\{[0-9a-f]+ (\d+):/g) || [];
  const renderers = [...new Set(bound.map(m => m.match(/ (\d+):/)[1]))].filter(p => p !== pid);
  out.processes = { app: pid, renderers, names: renderers.map(p => { try { return sh(`cat /proc/${p}/cmdline`).replace(/\0/g, ' ').trim(); } catch { return null; } }) };
  save();

  out.log = [];
  for (let k = 1; k <= RUNS; k++) {
    for (const [id, call, clip, args] of PLAN) {
      if (id === 'decode-hevc' && out.results['open-hevc']?.runs?.[0]?.error) continue;   // it doesn't open: once is enough
      const b = await coolDown(out.log);
      if (b.level < 10) throw new Error(`battery at ${b.level} %: stopped`);
      const s = sampler(pid, renderers);
      await sleep(2000);
      const t = s.mark();
      let r;
      try {
        r = await c.evaluate(`window.c34.${call}(${JSON.stringify(clip)}${args(k) ? `, ${JSON.stringify(args(k))}` : ''})`, { timeout: 600000 });
      } catch (e) { r = { error: { message: String(e.message || e) } }; }
      const samples = await s.stop();
      // during: from the call's start to the first sample after it ended
      const before = samples.slice(0, t), during = samples.slice(Math.max(0, t - 1));
      const mb = kb => (kb == null ? null : Math.round(kb / 1024));
      r.rss = {
        samples: samples.length,
        appBaseMb: mb(median(before.map(x => x[1]))), appPeakMb: mb(Math.max(...during.map(x => x[1]))),
        rendererBaseMb: mb(median(before.map(x => x[2]))), rendererPeakMb: mb(Math.max(...during.map(x => x[2]))),
        totalBaseMb: mb(median(before.map(x => x[1] + x[2]))), totalPeakMb: mb(Math.max(...during.map(x => x[1] + x[2]))),
      };
      r.battery = b;
      (out.results[id] ||= { call, clip, args: args(1), runs: [] }).runs.push(r);
      process.stderr.write(`${id} run ${k}: ${JSON.stringify(r).slice(0, 300)}\n`);
      save();
    }
  }
  c.close();
  // Which decoder Android gave the WebView: Codec2's component names in our own processes' log lines only.
  try {
    const lines = [pid, ...renderers].map(p => { try { return sh(`logcat -d --pid=${p}`); } catch { return ''; } }).join('\n');
    out.decoders = [...new Set(lines.match(/c2\.[A-Za-z0-9_.]+\.(?:decoder|encoder)[A-Za-z0-9_.]*/g) || [])];
  } catch (e) { out.decoders = String(e.message || e); }
} catch (e) {
  out.error = String((e && e.stack) || e);
} finally {
  if (copied) try { sh(`run-as ${PKG} rm -r files/c34`); } catch { /* uninstalled anyway */ }
  try { sh(`rm -f ${TMP}-clip.mp4 ${TMP}-stop`); } catch { /* gone */ }
  if (forwarded) try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* gone */ }
  if (!KEEP) try { adb('uninstall', PKG); out.uninstalled = true; } catch (e) { out.uninstalled = String(e.message || e); }
  out.finished = new Date().toISOString();
  save();
}
console.log(JSON.stringify({ out: OUT, error: out.error ?? null, uninstalled: out.uninstalled, measurements: Object.keys(out.results) }, null, 2));
process.exit(out.error ? 1 : 0);
