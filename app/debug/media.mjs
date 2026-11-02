// The check page's media measurements (package c34): s9's frame source and
// s32's cut on clips the driver (tools/check-media-apk.mjs) copies into the
// app's own files/ and sets on #media, over the WebView's DevTools. Debug build
// only (assemble.mjs --debug), like the rest of debug/.
//
//   window.c34.ready                    a promise of the clips' names, once #media has them
//   window.c34.open(name)               openFrameSource: its time, info and frameTimes' spacing, or the error
//   window.c34.decodeRate(name, {t0, t1, consumerMs})   frames(t0, t1), each closed after consumerMs
//   window.c34.frameAtRandom(name, {n, seed})           frameAt at n seeded random times
//   window.c34.step(name, {n, seed})    frameAt on n+1 consecutive frames from a seeded start (M1–M3's step)
//   window.c34.rotateCost(name, {t0, t1, rotation})     the canvas turn on each decoded frame, timed alone
//   window.c34.cut(name, {t0, t1, keep})                cutVideo, the store's write (saveLift), the cut read back,
//                                                       opened and decoded end to end, then the lift deleted
//
// Each returns a plain object (JSON); a failure is `{error: {code, message}}`,
// never thrown. Times are performance.now() wall times in ms. Every call also
// samples performance.memory (the JS heap) every 100 ms: `jsHeapPeakMb`.
import { openFrameSource } from '../src/media/frame-source.mjs';
import { cutVideo, keepVideo } from '../src/media/cut.mjs';
import { browserWebCodecs } from '../src/media/webcodecs.mjs';
import { createStore } from '../src/store/index.mjs';

const now = () => performance.now();
const r1 = v => (v == null ? v : Math.round(v * 10) / 10);
const r3 = v => (v == null ? v : Math.round(v * 1000) / 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MB = 1 << 20;

export function median(values) {
  const s = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const quantile = (values, q) => {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
const stats = ms => ({ n: ms.length, median: r1(median(ms)), p90: r1(quantile(ms, 0.9)), max: r1(Math.max(...ms)), min: r1(Math.min(...ms)) });

// a seeded PRNG (mulberry32), so a run's random times can be drawn again
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// the spacing of frame times (seconds in, ms out)
export function spacing(times) {
  const d = [];
  for (let i = 1; i < times.length; i++) d.push((times[i] - times[i - 1]) * 1000);
  const distinct = new Set(d.map(v => Math.round(v * 10) / 10));
  return { frames: times.length, ms: stats(d), distinctSpacings: distinct.size, first: d.slice(0, 8).map(r3) };
}

const files = new Map();
let resolveReady;
const ready = new Promise(r => { resolveReady = r; });

const heap = () => (performance.memory ? performance.memory.usedJSHeapSize : null);
// runs fn with the JS heap sampled every 100 ms; adds jsHeapPeakMb and jsHeapStartMb
async function measured(fn) {
  const start = heap();
  let peak = start;
  const timer = setInterval(() => { const h = heap(); if (h != null && h > peak) peak = h; }, 100);
  try {
    const out = await fn();
    const h = heap();
    if (h != null && h > peak) peak = h;
    return { ...out, jsHeapStartMb: start == null ? null : r1(start / MB), jsHeapPeakMb: peak == null ? null : r1(peak / MB) };
  } catch (e) {
    return { error: { code: e && e.code, message: String((e && (e.stack || e.message)) || e).slice(0, 800) } };
  } finally { clearInterval(timer); }
}
const file = name => {
  const f = files.get(name);
  if (!f) throw new Error(`no clip ${name} (have: ${[...files.keys()].join(', ')})`);
  return f;
};

async function withSource(name, fn) {
  const src = await openFrameSource(file(name));
  try { return await fn(src); } finally { src.close(); }
}

export const c34 = {
  ready,
  names: () => [...files.keys()],

  open: name => measured(async () => {
    const f = file(name);
    const t = now();
    let src;
    try { src = await openFrameSource(f); } catch (e) {
      return { bytes: f.size, openMs: r1(now() - t), error: { code: e.code, message: e.message, codec: e.codec ?? null } };
    }
    const openMs = now() - t;
    try {
      return { bytes: f.size, openMs: r1(openMs), info: src.info, spacing: spacing(src.frameTimes) };
    } finally { src.close(); }
  }),

  // frames(t0, t1): every frame closed after consumerMs (0: at once). waitMs is how long
  // the consumer waited for each next frame: with backpressure working, the decoder is
  // ahead and the wait is near 0 even though the whole run takes consumerMs a frame.
  decodeRate: (name, { t0 = 0, t1 = 60, consumerMs = 0 } = {}) => measured(() => withSource(name, async src => {
    const waits = [];
    let n = 0, firstTs = null, lastTs = null, inOrder = true;
    const t = now();
    let w = now();
    for await (const f of src.frames(t0, t1)) {
      waits.push(now() - w);
      if (lastTs != null && f.timestamp <= lastTs) inOrder = false;
      if (firstTs == null) firstTs = f.timestamp;
      lastTs = f.timestamp;
      n++;
      if (consumerMs > 0) await sleep(consumerMs);
      f.close();
      w = now();
    }
    const ms = now() - t;
    const expected = src.frameTimes.filter(x => x >= t0 - 1e-6 && x <= t1 + 1e-6).length;
    return {
      t0, t1, consumerMs, frames: n, expected, inOrder, ms: Math.round(ms), fps: r1(n / (ms / 1000)),
      firstWaitMs: r1(waits[0]), waitMs: stats(waits.slice(1)), info: src.info,
    };
  })),

  frameAtRandom: (name, { n = 20, seed = 1 } = {}) => measured(() => withSource(name, async src => {
    const rnd = prng(seed), d = src.info.duration;
    const times = Array.from({ length: n }, () => rnd() * d);
    const ms = [], got = [];
    for (const t of times) {
      const s = now();
      const f = await src.frameAt(t);
      ms.push(now() - s);
      got.push(f.timestamp / 1e6);
      f.close();
    }
    return { n, seed, ms: stats(ms), each: ms.map(r1), times: times.map(r3), got: got.map(r3) };
  })),

  // M1–M3's +1 frame step: frameAt on the next frame's time, n times from a random start
  step: (name, { n = 30, seed = 1 } = {}) => measured(() => withSource(name, async src => {
    const ft = src.frameTimes;
    const start = Math.floor(prng(seed)() * (ft.length - n - 1));
    const first = await src.frameAt(ft[start]);
    first.close();
    const ms = [];
    let consecutive = true;
    for (let k = 1; k <= n; k++) {
      const s = now();
      const f = await src.frameAt(ft[start + k]);
      ms.push(now() - s);
      if (Math.abs(f.timestamp / 1e6 - ft[start + k]) > 1e-4) consecutive = false;
      f.close();
    }
    return { n, seed, startFrame: start, startS: r3(ft[start]), consecutive, ms: stats(ms), each: ms.map(r1) };
  })),

  // The canvas turn alone (webcodecs.rotate, what the frame source does for a rotated
  // file) on each decoded frame of a file with no rotation: the call, then the turned
  // frame's pixels read back by a 1x1 drawImage so the GPU work is waited for.
  rotateCost: (name, { t0 = 0, t1 = 10, rotation = 90 } = {}) => measured(() => withSource(name, async src => {
    const wc = browserWebCodecs();
    const probe = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    const call = [], total = [];
    for await (const f of src.frames(t0, t1)) {
      const s = now();
      const turned = wc.rotate(f, rotation);
      call.push(now() - s);
      probe.drawImage(turned, 0, 0, 1, 1);
      probe.getImageData(0, 0, 1, 1);
      total.push(now() - s);
      turned.close();
      f.close();
    }
    const sum = a => a.reduce((x, y) => x + y, 0);
    return { t0, t1, rotation, fps: src.info.fps, frames: call.length, callMs: stats(call), withReadbackMs: stats(total), callTotalMs: Math.round(sum(call)) };
  })),

  // cutVideo of [t0, t1], then the cut saved as a lift (saveLift: what keepVideo does
  // after the cut), read back, opened and decoded end to end; the lift is deleted after.
  // keep: true runs keepVideo itself (cut and save in one call) instead.
  cut: (name, { t0 = 0, t1 = 60, keep = false } = {}) => measured(async () => {
    const f = file(name);
    const store = createStore();
    let t = now(), cut, lift, cutMs = null, saveMs = null, keepMs = null;
    if (keep) {
      const kept = await keepVideo(store, 'snatch', f, { t0, t1 });
      keepMs = now() - t;
      lift = kept.lift;
      cut = { range: kept.range, start: kept.start, duration: kept.duration, blob: null };
    } else {
      cut = await cutVideo(f, { t0, t1 });
      cutMs = now() - t;
      t = now();
      lift = await store.saveLift({ lift: 'snatch', video: cut.blob, range: cut.range });
      saveMs = now() - t;
    }
    const heapAfterCutMb = heap() == null ? null : r1(heap() / MB);
    try {
      t = now();
      const back = await store.readVideo(lift.id);
      const readMs = now() - t;
      t = now();
      const src = await openFrameSource(back);
      const openMs = now() - t;
      let n = 0, inOrder = true, last = -1;
      t = now();
      try {
        for await (const fr of src.frames(0, src.info.duration)) {
          if (fr.timestamp <= last) inOrder = false;
          last = fr.timestamp;
          n++;
          fr.close();
        }
      } finally { src.close(); }
      const decodeMs = now() - t;
      return {
        t0, t1, keep, sourceBytes: f.size, cutBytes: back.size, start: cut.start, duration: r3(cut.duration), range: cut.range,
        cutMs: r1(cutMs), saveMs: r1(saveMs), keepMs: r1(keepMs), heapAfterCutMb,
        readBack: { readMs: r1(readMs), openMs: r1(openMs), info: src.info, frames: n, expected: src.frameTimes.length, inOrder, decodeMs: Math.round(decodeMs), fps: r1(n / (decodeMs / 1000)) },
      };
    } finally {
      await store.deleteLift(lift.id);
    }
  }),
};

// In a page only: Node's tests import the helpers above.
const input = typeof document === 'undefined' ? null : document.getElementById('media');
if (typeof window !== 'undefined') window.c34 = c34;
if (input) {
  input.addEventListener('change', () => {
    for (const f of input.files || []) files.set(f.name.replace(/\.[^.]*$/, ''), f);
    if (files.size) resolveReady([...files.keys()]);
  });
}
