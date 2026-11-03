// SPDX-License-Identifier: AGPL-3.0-or-later
// The debug APK's check page (package c20): what the WebView gives the app,
// and s10's pose engine on s9's test clip, on the phone. Debug build only
// (assemble.mjs --debug); tools/check-apk.mjs drives it over DevTools.
//
//   window.c20.basics    the WebView, WebGL, OPFS, persist(): run at load
//   window.c20.engine    the engine, when ?engine=N (N runs) or the button
//   window.c20.import    the picked file opened by the frame source (after a pick)
//   window.c20.runEngine(n)   starts the engine's runs (once), returns its promise
//
// Each is a promise of a plain object (JSON), also shown on the page. A
// failure is reported in the object (`error`), never thrown.
import { openFrameSource } from '../src/media/frame-source.mjs';
import { PoseEngine } from '../src/pose/pose-client.mjs';

const CLIP = './clips/testsrc2-h264-30fps.mp4';
const now = () => performance.now();
const r1 = v => (v == null ? v : Math.round(v * 10) / 10);
const words = e => String((e && (e.stack || e.message)) || e);

export function median(values) {
  const s = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const results = {};
const out = document.getElementById('out');
const show = () => { out.textContent = JSON.stringify(results, null, 2); };

async function step(name, fn) {
  try { results[name] = await fn(); } catch (e) { results[name] = { error: words(e) }; }
  show();
  return results[name];
}

function environment() {
  const cap = window.Capacitor;
  const ua = navigator.userAgent;
  return {
    userAgent: ua,
    webview: (ua.match(/Chrome\/([\d.]+)/) || [])[1] || null,
    origin: location.origin,
    secureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated,
    capacitor: cap ? { platform: cap.getPlatform?.(), native: cap.isNativePlatform?.() } : null,
    webcodecs: typeof VideoDecoder === 'function',
    webgpu: 'gpu' in navigator,
    offscreenCanvas: typeof OffscreenCanvas === 'function',
    cores: navigator.hardwareConcurrency,
    deviceMemoryGb: navigator.deviceMemory ?? null,
    serviceWorker: { api: 'serviceWorker' in navigator, controlled: !!navigator.serviceWorker?.controller },
    screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
  };
}

function webgl() {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return { webgl2: false, webgl1: !!document.createElement('canvas').getContext('webgl') };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const res = {
    webgl2: true,
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    version: gl.getParameter(gl.VERSION),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    floatColorBuffer: !!gl.getExtension('EXT_color_buffer_float'),
  };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return res;
}

// A folder of its own in OPFS, written, read back and removed: nothing else is touched.
async function opfs() {
  const root = await navigator.storage.getDirectory();
  const name = 'c20-check';
  const dir = await root.getDirectoryHandle(name, { create: true });
  const bytes = new Uint8Array(4 << 20);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761) >>> 24;
  try {
    const fh = await dir.getFileHandle('probe.bin', { create: true });
    let t = now();
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    const writeMs = now() - t;
    t = now();
    const back = new Uint8Array(await (await fh.getFile()).arrayBuffer());
    const readMs = now() - t;
    const same = back.length === bytes.length && back.every((v, i) => v === bytes[i]);
    return { ok: same, bytes: bytes.length, writeMs: r1(writeMs), readMs: r1(readMs) };
  } finally {
    await root.removeEntry(name, { recursive: true });
  }
}

async function persistence() {
  const s = navigator.storage;
  const before = await s.persisted();
  const granted = await s.persist();
  const after = await s.persisted();
  const { usage, quota } = await s.estimate();
  return { persistedBefore: before, persistAnswer: granted, persistedAfter: after, usage, quota };
}

// The frame source on a Blob: what import does with a picked file.
async function openBlob(blob) {
  const t = now();
  const src = await openFrameSource(blob);
  const openMs = now() - t;
  try {
    let n = 0;
    const t1 = now();
    for await (const f of src.frames(0, src.info.duration)) { n++; f.close(); }
    return { name: blob.name ?? null, bytes: blob.size, type: blob.type, info: src.info, openMs: r1(openMs), frames: n, decodeMs: r1(now() - t1) };
  } finally { src.close(); }
}

// One run: create (weights and warm-up), every frame of the clip, reset
// (contract 1's reset since s35: the crop cleared, the worker and its model
// kept; before, a new worker, weights and warm-up again), frames 0 and 1 again.
async function engineRun(blob, k) {
  const src = await openFrameSource(blob);
  let engine = null;
  try {
    let t = now();
    engine = await PoseEngine.create({ backend: 'webgl' });
    const createMs = now() - t;
    const frames = [];
    for await (const f of src.frames(0, src.info.duration)) {
      const tMs = f.timestamp / 1000;
      t = now();
      const r = await engine.estimate(f, tMs);
      frames.push({ wallMs: now() - t, workerMs: r.ms, keypoints: r.keypoints ? r.keypoints.length : 0, kp: r.keypoints });
    }
    t = now();
    await engine.reset();
    const resetMs = now() - t;
    const after = [];
    for await (const f of src.frames(0, src.frameTimes[1])) {
      t = now();
      const r = await engine.estimate(f, f.timestamp / 1000);
      after.push({ wallMs: now() - t, workerMs: r.ms, keypoints: r.keypoints ? r.keypoints.length : 0 });
    }
    const rest = frames.slice(2);
    return {
      run: k, info: engine.info, createMs: r1(createMs), resetMs: r1(resetMs), frames: frames.length,
      keypointCounts: [...new Set(frames.map(f => f.keypoints))],
      nulls: frames.filter(f => !f.kp).length,
      frame0: { wallMs: r1(frames[0]?.wallMs), workerMs: r1(frames[0]?.workerMs) },
      frame1: { wallMs: r1(frames[1]?.wallMs), workerMs: r1(frames[1]?.workerMs) },
      rest: { wallMs: r1(median(rest.map(f => f.wallMs))), workerMs: r1(median(rest.map(f => f.workerMs))) },
      afterReset: after.map(f => ({ wallMs: r1(f.wallMs), workerMs: r1(f.workerMs), keypoints: f.keypoints })),
      firstPose: frames[0]?.kp ? frames[0].kp.slice(0, 3).map(p => p.map(v => r1(v))) : null,
    };
  } finally {
    engine?.close();
    src.close();
  }
}

async function engineRuns(n) {
  const blob = await (await fetch(CLIP)).blob();
  const clip = await openBlob(blob);
  const runs = [];
  for (let k = 1; k <= n; k++) {
    runs.push(await engineRun(blob, k));
    results.engine = { clip, runs, done: false };
    show();
  }
  const m = f => r1(median(runs.map(f)));
  return {
    clip, done: true,
    summary: {
      runs: n, frames: runs[0].frames, keypointCounts: [...new Set(runs.flatMap(r => r.keypointCounts))],
      createMs: m(r => r.createMs), resetMs: m(r => r.resetMs), initMs: m(r => r.info.initMs),
      frame0WallMs: m(r => r.frame0.wallMs), frame1WallMs: m(r => r.frame1.wallMs),
      frame0WorkerMs: m(r => r.frame0.workerMs), frame1WorkerMs: m(r => r.frame1.workerMs),
      afterResetFrame0WallMs: m(r => r.afterReset[0]?.wallMs), afterResetFrame1WallMs: m(r => r.afterReset[1]?.wallMs),
      msPerFrameWall: m(r => r.rest.wallMs), msPerFrameWorker: m(r => r.rest.workerMs),
    },
    runs,
  };
}

let engineRunning = null;
function runEngine(n) {
  if (!engineRunning) {
    engineRunning = step('engine', () => engineRuns(n));
    window.c20.engine = engineRunning;
  }
  return engineRunning;
}

window.c20 = { runEngine };
window.c20.basics = (async () => {
  await step('environment', environment);
  await step('webgl', webgl);
  await step('opfs', opfs);
  await step('persist', persistence);
  return { environment: results.environment, webgl: results.webgl, opfs: results.opfs, persist: results.persist };
})();

document.getElementById('file').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if (file) window.c20.import = step('import', () => openBlob(file));
});
document.getElementById('engine').addEventListener('click', () => runEngine(5));
const n = Number(new URLSearchParams(location.search).get('engine'));
if (n > 0) window.c20.basics.then(() => runEngine(Math.min(n, 20)));
