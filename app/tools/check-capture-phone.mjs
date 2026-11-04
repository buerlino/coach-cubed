// SPDX-License-Identifier: AGPL-3.0-or-later
// node app/tools/check-capture-phone.mjs <command> --serial S --shell apk|brave --port P [options]
//
// The capture (app/src/media/capture.mjs) on the phone's camera (package c30), in the debug APK's
// WebView or in Brave, over the DevTools port curie forwarded (`adb -s <serial> forward tcp:P
// localabstract:webview_devtools_remote_<pid>` or `…:chrome_devtools_remote`). The page is open
// already, and the camera allowed (`pm grant` in the APK; Brave's prompt by hand).
//
//   record --buffers 10,60,300 [--runs 5] [--extra 10] [--snapshots 20,60] [--cut 10] [--tag T] [--out FILE]
//       in debug/capture.html (window.c30): per run, per buffer, the capture recorded for buffer + extra
//       seconds, the snapshots read back and a cut of one (c30.record), with the phone's memory sampled
//       around it. Runs interleaved (run 1 of each buffer, then run 2 …).
//   session [--record 30] [--tag T] [--out FILE]
//       in the app (index.html): H's gym card, R1 (the preview), Start, `record` seconds on R2, Replay:
//       the time from the tap to R3's first frame playing, the snapshot played through to its end, then
//       paused (s38's stepper, the decoder's frames held), a scrub, ½× and back to live; Replay again;
//       End session. Every tap is a touch (Input.dispatchTouchEvent).
//   eval EXPR   an expression in the page, awaited, printed as JSON
//   tap SELECTOR   a touch on the element's centre
//
// Memory: a loop on the phone every second sums VmRSS and `dumpsys gpu --gpumem` of the shell's
// processes (spike/pose-bench/phone-sample.sh's way: the APK's process and the services it binds, its
// WebView renderer; Brave's every process, other tabs too), and, apart, the RSS of the media codec
// processes (the hardware encoder and decoder run there; the shell's figure doesn't count them). The
// samples carry the phone's clock, as the page's marks do (Date.now()), so each phase gets its own peak;
// the baseline is the median before the camera opened, after a garbage collection (HeapProfiler.collectGarbage),
// so a run's baseline doesn't hold the last run's ring. Before each run the battery is read: under 10 %
// it stops, over 36 °C it waits (up to 5 min) to cool.
// One JSON object per run, printed and appended (one line) to --out. Touches nothing but its own
// /data/local/tmp/coach-c30-* file.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name, dflt) => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : dflt; };
const SERIAL = arg('--serial');
const SHELL = arg('--shell', 'apk');
const PORT = Number(arg('--port', 9345));
const OUT = arg('--out', null) && resolve(arg('--out'));
const TAG = arg('--tag', null);
const PKG = SHELL === 'brave' ? 'com.brave.browser' : 'org.coach.placeholder';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function median(values) {
  const s = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The memory of a run from its samples ([ms, rssKb, gpuBytes, codecKb]) and the page's marks (ms on
 * the same clock): the baseline (the median before `from`), and per phase [a, b) the peak of RSS + GPU,
 * and its rise over the baseline, in MB; the codec processes' own the same way.
 */
export function memoryOf(samples, marks, phases, from = 'open') {
  const mb = v => (v == null ? null : Math.round(v / 1048576));
  const total = s => s[1] * 1024 + s[2];
  const before = samples.filter(s => s[0] < marks[from]);
  const base = median(before.map(total)), codecBase = median(before.map(s => s[3] * 1024));
  const out = { samples: samples.length, baseMb: mb(base), codecBaseMb: mb(codecBase) };
  for (const [name, a, b] of phases) {
    if (marks[a] == null || marks[b] == null) continue;
    // the samples inside, and the one on each side (a sample a second: a short phase may hold none)
    const i0 = samples.findIndex(s => s[0] >= marks[a]);
    let i1 = samples.findIndex(s => s[0] > marks[b]);
    if (i1 < 0) i1 = samples.length - 1;
    const within = samples.slice(Math.max(0, i0 - 1), i1 + 1);
    if (!within.length) continue;
    const peak = Math.max(...within.map(total)), codecPeak = Math.max(...within.map(s => s[3] * 1024));
    out[name] = { peakMb: mb(peak), overBaseMb: base == null ? null : mb(peak - base), codecPeakMb: mb(codecPeak), codecOverBaseMb: codecBase == null ? null : mb(codecPeak - codecBase) };
  }
  return out;
}

const adb = (...a) => execFileSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 120000, maxBuffer: 1 << 26 }).replace(/\r/g, '').trim();
const sh = c => adb('shell', c);
const TMP = '/data/local/tmp/coach-c30';

function pidsScript() {
  return SHELL === 'brave'
    ? `pids=$(ps -A -o PID,NAME | grep '${PKG}' | awk '{print $1}')`
    : `pids=$( (pidof ${PKG} | tr ' ' '\\n'; dumpsys activity services ${PKG} | grep -o 'app=ProcessRecord{[0-9a-f]* [0-9]*' | awk '{print $2}') | sort -u)`;
}

/** The phone's memory every second until the stop file appears (or 20 min): "ms rssKb gpuBytes codecKb". */
function sampler() {
  const stop = `${TMP}-stop`;
  sh(`rm -f ${stop}`);
  const loop = `i=0; while [ $i -lt 1200 ] && [ ! -e ${stop} ]; do ${pidsScript()}; `
    + `rss=0; for p in $pids; do r=$(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null); rss=$((rss + \${r:-0})); done; `
    + `g=0; mem=$(dumpsys gpu --gpumem); for p in $pids; do v=$(echo "$mem" | grep "Proc $p total" | awk '{print $4}'); g=$((g + \${v:-0})); done; `
    + `c=0; for p in $(ps -A -o PID,NAME | grep -E 'media\\.hwcodec|media\\.swcodec|media\\.codec|c2@' | awk '{print $1}'); do r=$(awk '/VmRSS/{print $2}' /proc/$p/status 2>/dev/null); c=$((c + \${r:-0})); done; `
    + `echo "$(date +%s%3N) $rss $g $c"; i=$((i+1)); sleep 1; done`;
  const child = spawn('adb', ['-s', SERIAL, 'shell', loop], { stdio: ['ignore', 'pipe', 'ignore'] });
  let text = '';
  child.stdout.on('data', d => { text += d; });
  const done = new Promise(r => child.on('exit', r));
  return {
    async stop() {
      try { sh(`touch ${stop}`); } catch { /* gone */ }
      await Promise.race([done, sleep(8000)]);
      child.kill();
      try { sh(`rm -f ${stop}`); } catch { /* gone */ }
      return text.trim().split('\n').map(l => l.trim().split(/\s+/).map(Number)).filter(a => a.length === 4 && a.every(Number.isFinite));
    },
  };
}

function battery() {
  const b = sh('dumpsys battery');
  const num = re => Number((b.match(re) || [])[1]);
  return { level: num(/\n\s*level: (\d+)/), tempC: num(/temperature: (\d+)/) / 10 };
}
async function coolDown() {
  let b = battery();
  for (let w = 0; b.tempC > 36 && w < 20; w++) { await sleep(15000); b = battery(); }
  return b;
}

async function cdp(port, match) {
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find(t => t.type === 'page' && (!match || t.url.includes(match)));
    } catch { /* not up yet */ }
    if (!page) await sleep(200);
  }
  if (!page) throw new Error(`no page${match ? ` matching ${match}` : ''} over DevTools on ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(`exception: ${(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300)}`);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(`console.error: ${m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 300)}`);
  };
  ws.onclose = () => { for (const res of pending.values()) res({ error: { message: 'DevTools closed' } }); pending.clear(); };
  const send = (method, params = {}) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression, opts = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...opts });
    if (r.error) throw new Error(r.error.message);
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  return { send, evaluate, errors, url: page.url, close: () => ws.close() };
}

/** A touch on the element's centre (or at fx, fy of its box), or a drag across it. */
async function tap(c, selector, { fx = 0.5, fy = 0.5 } = {}) {
  const box = await c.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, disabled: !!e.disabled }; })()`);
  if (!box) throw new Error(`no ${selector}`);
  const p = { x: box.x + box.w * fx, y: box.y + box.h * fy };
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  return box;
}
async function drag(c, selector, from, to, steps = 10, ms = 400) {
  const box = await c.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const y = box.y + box.h / 2;
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.w * from, y }] });
  for (let i = 1; i <= steps; i++) {
    await sleep(ms / steps);
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.w * (from + (to - from) * i / steps), y }] });
  }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const waitFor = async (c, expr, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await c.evaluate(expr)) return true; await sleep(150); }
  return false;
};

function device() {
  return {
    model: sh('getprop ro.product.model'), android: sh('getprop ro.build.version.release'), build: sh('getprop ro.build.display.id'),
    webview: (sh('dumpsys webviewupdate').match(/Current WebView package \(name, version\): \(([^)]*)\)/) || [])[1] || null,
    brave: (sh(`dumpsys package com.brave.browser | grep -m1 versionName`).split('=')[1] || '').trim() || null,
    rotation: sh("dumpsys window | grep -m1 -oE 'mRotation=[^ ]*|mCurrentRotation=[^ ]*' || true"),
  };
}

function emit(obj) {
  const line = JSON.stringify(obj);
  console.log(line);
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); appendFileSync(OUT, `${line}\n`); }
}

async function record() {
  const buffers = arg('--buffers', '10,60,300').split(',').map(Number);
  const runs = Number(arg('--runs', 5)), extra = Number(arg('--extra', 10)), cutS = Number(arg('--cut', 10));
  const snapshots = arg('--snapshots', '20,60').split(',').map(Number);
  const c = await cdp(PORT, 'debug/capture.html');
  const dev = device();
  for (let k = 1; k <= runs; k++) {
    for (const bufferS of buffers) {
      const b = await coolDown();
      if (b.level < 10) throw new Error(`battery at ${b.level} %: stopped`);
      // the last run's ring and snapshots collected first, so the baseline is this run's own
      await c.send('HeapProfiler.collectGarbage');
      await sleep(2000);
      const s = sampler();
      await sleep(5000);   // the baseline, before the camera opens
      let r;
      try {
        r = await c.evaluate(`window.c30.record(${JSON.stringify({ bufferS, seconds: bufferS + extra, snapshots: snapshots.filter(n => n <= bufferS + extra), cutS })})`, { timeout: (bufferS + extra + 300) * 1000 });
      } catch (e) { r = { error: { message: String(e.message || e) } }; }
      await sleep(3000);
      const samples = await s.stop();
      const m = r.marks || {};
      const snapPhases = Object.keys(r.snapshots || {}).map(n => [`snapshot${n}`, `snapshot${n}`, `snapshot${n}Done`]);
      r.memory = memoryOf(samples, m, [['recording', 'start', 'recorded'], ...snapPhases, ['cut', 'cut', 'cutDone'], ['afterClose', 'closed', 'closed']]);
      // the memory at the end of the recording, the ring full: the last sample before the snapshots
      const atFull = samples.filter(x => x[0] <= (m.recorded ?? 0)).at(-1);
      if (atFull) r.memory.atRecordedMb = Math.round((atFull[1] * 1024 + atFull[2]) / 1048576);
      emit({ shell: SHELL, tag: TAG, run: k, bufferS, battery: b, device: k === 1 ? dev : undefined, consoleErrors: c.errors.splice(0), ...r });
    }
  }
  c.close();
}

async function session() {
  const recordS = Number(arg('--record', 30));
  const c = await cdp(PORT, SHELL === 'brave' ? 'localhost:' : 'https://localhost');
  const out = { shell: SHELL, tag: TAG, device: device(), battery: battery(), steps: [] };
  const step = (name, extra = {}) => out.steps.push({ name, t: Date.now(), ...extra });
  await c.send('HeapProfiler.collectGarbage');
  await sleep(2000);
  const s = sampler();
  await sleep(5000);
  const marks = {};
  try {
    marks.open = Date.now();
    await tap(c, '[data-card="session"]');
    out.preview = await waitFor(c, "document.querySelector('[data-record=\"start\"]') && !document.querySelector('[data-record=\"start\"]').disabled", 20000);
    out.r1 = await c.evaluate("(() => { const v = document.querySelector('.camera-stage video'); const p = document.querySelector('[data-problem]'); return { video: v && { w: v.videoWidth, h: v.videoHeight }, problem: p && p.dataset.problem }; })()");
    if (!out.preview) throw new Error(`R1 shows no preview: ${JSON.stringify(out.r1)}`);
    marks.start = Date.now();
    await tap(c, '[data-record="start"]');
    await waitFor(c, "!!document.querySelector('[data-record=\"replay\"]')", 10000);
    await sleep(recordS * 1000);
    out.r2 = await c.evaluate("({ fps: document.querySelector('[data-live=\"fps\"]')?.textContent, wake: document.querySelector('[data-live=\"wake\"]')?.textContent, clock: document.querySelector('[data-live=\"clock\"]')?.textContent })");
    marks.replay = Date.now();
    for (const pass of [1, 2]) {
      // the tap, then the first frame the <video> presents (requestVideoFrameCallback) while it plays
      await c.evaluate(`window.__c30 = { tap: performance.now() }; (function watch() {
        const v = document.querySelector('[data-screen="R3"] video');
        if (!v) return requestAnimationFrame(watch);
        if (!window.__c30.videoAt) window.__c30.videoAt = performance.now();
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback((now, md) => { window.__c30.firstFrame = performance.now(); window.__c30.firstMedia = md.mediaTime; });
        v.addEventListener('playing', () => { window.__c30.playing ??= performance.now(); });
        let maxT = 0; v.addEventListener('timeupdate', () => { if (v.currentTime < maxT - 1) window.__c30.wrapped ??= { at: performance.now(), maxT }; maxT = Math.max(maxT, v.currentTime); window.__c30.maxT = maxT; window.__c30.duration = v.duration; });
        v.addEventListener('ended', () => { window.__c30.ended ??= performance.now(); });
      })(); true`);
      const t0 = Date.now();
      await tap(c, '[data-record="replay"]');
      await waitFor(c, '!!window.__c30.firstFrame || !!document.querySelector(\'[data-screen="R3"][data-phase="problem"]\')', 20000);
      const first = await c.evaluate('({ ...window.__c30, phase: document.querySelector(\'[data-screen="R3"]\')?.dataset.phase, total: document.querySelector(\'[data-replay="position"]\')?.textContent })');
      const r = { pass, tapToFirstFrameMs: first.firstFrame ? Math.round(first.firstFrame - first.tap) : null, tapToPlayingMs: first.playing ? Math.round(first.playing - first.tap) : null, phase: first.phase, total: first.total };
      step(`replay${pass}`, r);
      marks[`r3_${pass}`] = t0;
      if (pass === 1) {
        // played through: the loop wraps (or ends) once
        await waitFor(c, '!!(window.__c30.wrapped || window.__c30.ended)', 40000);
        const end = await c.evaluate('({ wrapped: window.__c30.wrapped, ended: window.__c30.ended, maxT: window.__c30.maxT, duration: window.__c30.duration, tap: window.__c30.tap, firstFrame: window.__c30.firstFrame })');
        r.playedThrough = { maxT: end.maxT, duration: end.duration, wrappedAfterMs: end.wrapped ? Math.round(end.wrapped.at - end.firstFrame) : null, endedAfterMs: end.ended ? Math.round(end.ended - end.firstFrame) : null };
        marks.pause = Date.now();
        await tap(c, '[data-replay="play"]');   // pause: the stepper shows the frame
        await sleep(4000);
        marks.scrub = Date.now();
        await drag(c, '.replay-bar', 0.8, 0.2, 20, 1500);
        await sleep(2500);
        r.afterScrub = await c.evaluate("({ position: document.querySelector('[data-replay=\"position\"]')?.textContent, playLabel: document.querySelector('[data-replay=\"play\"]')?.getAttribute('aria-label') })");
        marks.scrubDone = Date.now();
        await tap(c, '[data-replay="speed"]');
        r.speed = await c.evaluate("document.querySelector('[data-replay=\"speed\"]')?.textContent");
        const v0 = await c.evaluate("document.querySelector('[data-screen=\"R3\"] video').currentTime");
        await tap(c, '[data-replay="play"]');
        await sleep(3000);
        const v1 = await c.evaluate("({ t: document.querySelector('[data-screen=\"R3\"] video').currentTime, rate: document.querySelector('[data-screen=\"R3\"] video').playbackRate })");
        r.half = { rate: v1.rate, advancedS: Math.round((v1.t - v0) * 100) / 100, overS: 3 };
        marks.halfDone = Date.now();
      } else {
        await sleep(3000);
      }
      await tap(c, '[data-replay="live"]');
      await waitFor(c, "!!document.querySelector('[data-record=\"replay\"]')", 10000);
      await sleep(3000);
    }
    out.wake = await c.evaluate("document.querySelector('[data-live=\"wake\"]')?.textContent");
    marks.end = Date.now();
    await tap(c, '[data-record="end"]');
    await sleep(3000);
    marks.closed = Date.now();
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  const samples = await s.stop();
  out.marks = marks;
  out.memory = memoryOf(samples, marks, [['recording', 'start', 'replay'], ['r3first', 'r3_1', 'pause'], ['paused', 'pause', 'scrub'], ['scrub', 'scrub', 'scrubDone'], ['half', 'scrubDone', 'halfDone'], ['r3second', 'r3_2', 'end'], ['afterEnd', 'closed', 'closed']]);
  out.consoleErrors = c.errors.splice(0);
  c.close();
  emit(out);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  if (!SERIAL) { console.error('check-capture-phone: --serial is required'); process.exit(2); }
  try {
    if (cmd === 'record') await record();
    else if (cmd === 'session') await session();
    else if (cmd === 'tap') { const c = await cdp(PORT, arg('--match', null)); console.log(JSON.stringify(await tap(c, argv[1]))); c.close(); }
    else if (cmd === 'eval') { const c = await cdp(PORT, arg('--match', null)); console.log(JSON.stringify(await c.evaluate(argv[1], { timeout: 600000 }), null, 1)); c.close(); }
    else { console.error('usage: check-capture-phone.mjs record|session|eval …'); process.exit(2); }
  } catch (e) {
    console.error(String((e && e.stack) || e));
    process.exit(1);
  }
}
