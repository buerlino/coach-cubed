// SPDX-License-Identifier: AGPL-3.0-or-later
// The check page's compatibility probe (package c65): what a browser or WebView
// gives the app of the features newer than Chrome 101, for c60 on the Samsung
// S8+ (Chrome 101 as its browser and its WebView). Debug build only, like the
// rest of debug/: check.mjs runs it at load as window.c20.compat, and
// tools/check-apk.mjs prints it. One function over the globals, so a Node test
// runs it on fakes (tests/app/chrome101.test.js). It opens no camera and
// touches nothing but a folder of its own in OPFS, which it removes.
//
// The Chrome versions in the comments are from memory and MDN, not measured:
// the probe is how c60 checks them.
import { CODECS, encoderConfig, parseQuality } from '../src/media/capture.mjs';

const words = e => String((e && (e.name ? `${e.name}: ${e.message}` : e.message)) || e);
// a part that throws is reported as its error, never thrown
const tryIt = async fn => { try { return await fn(); } catch (e) { return { error: words(e) }; } };
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer in ${ms} ms`)), ms))]);

// The decoder's `dequeue` event (Chrome 106): decode.mjs re-checks decodeQueueSize where it is missing.
function dequeue(g) {
  if (typeof g.VideoDecoder !== 'function') return { videoDecoder: false, ondequeue: null };
  return { videoDecoder: true, ondequeue: 'ondequeue' in g.VideoDecoder.prototype };
}

// OPFS (getDirectory: Chrome 86, on Android later; createWritable; move: newer still): the store's calls, in a folder
// of its own (removed after), as check.mjs's opfs() does. The store has no fallback without getDirectory or createWritable.
export const OPFS_FOLDER = 'c65-compat';
async function opfs(g) {
  const storage = g.navigator && g.navigator.storage;
  const out = { getDirectory: !!storage && typeof storage.getDirectory === 'function', createWritable: null, move: null, moveOverExisting: null, readBack: null };
  if (!out.getDirectory) return out;
  const root = await storage.getDirectory();
  const dir = await root.getDirectoryHandle(OPFS_FOLDER, { create: true });
  try {
    const fh = await dir.getFileHandle('a.txt', { create: true });
    out.createWritable = typeof fh.createWritable === 'function';
    if (!out.createWritable) return out;
    const write = async (h, text) => { const w = await h.createWritable(); await w.write(text); await w.close(); };
    await write(fh, 'probe');
    out.move = typeof fh.move === 'function';
    if (out.move) {
      // what the store's writeAtomic does: a temporary file moved over the real name, which exists
      await write(await dir.getFileHandle('b.txt', { create: true }), 'old');
      try { await fh.move('b.txt'); out.moveOverExisting = true; } catch (e) { out.moveOverExisting = { error: words(e) }; }
      out.readBack = await (await (await dir.getFileHandle('b.txt')).getFile()).text();
    } else {
      out.readBack = await (await fh.getFile()).text();
    }
    return out;
  } finally {
    await root.removeEntry(OPFS_FOLDER, { recursive: true });
  }
}

// dvh (Chrome 108) and tokens.css's @supports fallback: which --screen-h applies, and what it measures
function height(g) {
  const doc = g.document;
  const out = { dvh: typeof g.CSS === 'object' && typeof g.CSS.supports === 'function' ? g.CSS.supports('height', '100dvh') : null };
  if (!doc || !doc.documentElement) return out;
  out.screenH = g.getComputedStyle(doc.documentElement).getPropertyValue('--screen-h').trim() || null;
  const probe = doc.createElement('div');
  probe.style.cssText = 'position: absolute; visibility: hidden; height: var(--screen-h);';
  doc.body.appendChild(probe);
  try { out.screenHPx = probe.getBoundingClientRect().height; } finally { probe.remove(); }
  out.innerHeight = g.innerHeight;
  return out;
}

// H.264 at 1080p: the decoder on a phone camera's High profile and on the capture's own three
async function decoder(g) {
  if (typeof g.VideoDecoder !== 'function') return { videoDecoder: false };
  const out = {};
  for (const codec of ['avc1.640028', ...CODECS]) {
    out[codec] = await tryIt(async () => !!(await g.VideoDecoder.isConfigSupported({ codec, codedWidth: 1920, codedHeight: 1080 })).supported);
  }
  return out;
}

// The capture's encoder configs, from capture.mjs's own builder (what start() asks), at the default quality both ways
// up; then the first codec without hardwareAcceleration and without latencyMode, so a refusal names the key it is for.
async function encoder(g) {
  if (typeof g.VideoEncoder !== 'function') return { videoEncoder: false };
  const { width, height: h, fps } = parseQuality('1080p30');
  const ask = async config => tryIt(async () => !!(await g.VideoEncoder.isConfigSupported(config)).supported);
  const out = {};
  for (const [w, hh] of [[width, h], [h, width]]) for (const c of CODECS) out[`${c} ${w}x${hh}`] = await ask(encoderConfig(c, w, hh, fps));
  const { hardwareAcceleration, ...noAccel } = encoderConfig(CODECS[0], width, h, fps);
  const { latencyMode, ...noLatency } = encoderConfig(CODECS[0], width, h, fps);
  out.withoutHardwareAcceleration = await ask(noAccel);
  out.withoutLatencyMode = await ask(noLatency);
  return out;
}

// WebGL2 in an OffscreenCanvas in a worker (the pose engine's): a worker of its own, from a Blob
const WORKER = `try { const gl = new OffscreenCanvas(1, 1).getContext('webgl2'); postMessage({ offscreenCanvas: true, webgl2: !!gl,
  renderer: gl ? gl.getParameter(gl.RENDERER) : null }); } catch (e) { postMessage({ offscreenCanvas: typeof OffscreenCanvas === 'function', error: String(e) }); }`;
async function workerWebgl2(g) {
  if (typeof g.Worker !== 'function') return { worker: false };
  const url = g.URL.createObjectURL(new g.Blob([WORKER], { type: 'text/javascript' }));
  const w = new g.Worker(url);
  try {
    return await withTimeout(new Promise((res, rej) => { w.onmessage = e => res(e.data); w.onerror = e => rej(new Error(e.message || 'worker error')); }), 10000, 'the worker');
  } finally { w.terminate(); g.URL.revokeObjectURL(url); }
}

/**
 * @param {typeof globalThis} [g] the page's globals (a fake in Node)
 * @returns {Promise<object>} plain JSON: each part's answer, or `{error}` where it threw
 */
export async function compat(g = globalThis) {
  const nav = g.navigator || {};
  return {
    userAgent: nav.userAgent ?? null,
    decoderDequeue: dequeue(g),                                                   // Chrome 106
    opfs: await tryIt(() => opfs(g)),
    height: await tryIt(() => height(g)),                                          // dvh: Chrome 108
    videoDecoder1080p: await tryIt(() => decoder(g)),
    videoEncoder: await tryIt(() => encoder(g)),
    mediaStreamTrackProcessor: typeof g.MediaStreamTrackProcessor === 'function',  // Chrome 94
    wakeLock: !!nav.wakeLock && typeof nav.wakeLock.request === 'function',        // Chrome 84
    requestVideoFrameCallback: typeof g.HTMLVideoElement === 'function' && 'requestVideoFrameCallback' in g.HTMLVideoElement.prototype,   // Chrome 83
    workerWebgl2: await tryIt(() => workerWebgl2(g)),
  };
}
