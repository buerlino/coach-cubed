// SPDX-License-Identifier: AGPL-3.0-or-later
// The capture on a real phone camera (package c30): app/src/media/capture.mjs run as R1 and R2 run it,
// with the browser's parts wrapped so the page sees what the capture doesn't report: every frame's
// timestamp, size and rotation, each frame's encode time (encode() to its chunk), every chunk's type,
// size and time, and the decoder config the encoder gave. Driven over DevTools by
// tools/check-capture-phone.mjs (the debug APK's WebView and Brave). Debug builds only.
//
//   window.c30.record({ bufferS, seconds, quality, camera, snapshots: [20, 60], cutS: 10 })
//       open, start, `seconds` of recording, the status, snapshot(n) for each n (its time, size and
//       length, then opened and decoded end to end by the frame source), a cut of `cutS` seconds out of
//       the middle of the last one (read back the same way), stop, close. Phase times are Date.now()
//       (the phone's clock: the driver lines them up with its memory samples).
//   window.c30.permission()   navigator.permissions' camera state, or null
//
// Each returns a plain object; a failure is { error: { code, name, message } }, never thrown.
import { createCapture } from '../src/media/capture.mjs';
import { browserCaptureApi } from '../src/media/capture-browser.mjs';
import { openFrameSource } from '../src/media/frame-source.mjs';
import { cutVideo } from '../src/media/cut.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = v => (v == null ? v : Math.round(v * 10) / 10);
const r3 = v => (v == null ? v : Math.round(v * 1000) / 1000);

export function median(values) {
  const s = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function quantile(values, q) {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
}

/**
 * The frames' intervals from their timestamps (µs): the median, p10, p90, max, the jitter (the
 * standard deviation of the intervals) in ms, the rate (frames over their span) and the late frames
 * (an interval over 1.5 × the median: a frame the camera skipped or held).
 */
export function intervalStats(tsUs) {
  const d = tsUs.slice(1).map((t, i) => (t - tsUs[i]) / 1000);
  if (!d.length) return { frames: tsUs.length, intervals: 0 };
  const med = median(d), mean = d.reduce((a, b) => a + b, 0) / d.length;
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
  return {
    frames: tsUs.length, intervals: d.length,
    fps: r3((tsUs.length - 1) / ((tsUs.at(-1) - tsUs[0]) / 1e6)),
    medianMs: r3(med), p10Ms: r3(quantile(d, 0.1)), p90Ms: r3(quantile(d, 0.9)), maxMs: r3(Math.max(...d)),
    jitterMs: r3(sd), late: d.filter(x => x > 1.5 * med).length,
  };
}

/** The gaps between keyframes (µs in, ms out, to 0.1 ms), as check-capture.mjs's keyframeGapsMs. */
export const keyframeGapsMs = keysUs => keysUs.slice(1).map((k, i) => Math.round((k - keysUs[i]) / 100) / 10);

/** Counts of a list of strings: { value: count }. */
const tally = list => list.reduce((o, k) => ((o[k] = (o[k] || 0) + 1), o), {});

async function readBack(blob) {
  const t = performance.now();
  const src = await openFrameSource(blob);
  const openMs = Math.round(performance.now() - t);
  let frames = 0, prev = -Infinity, inOrder = true;
  const sizes = [];
  const t2 = performance.now();
  for await (const f of src.frames(0, src.info.duration)) {
    if (f.timestamp <= prev) inOrder = false;
    prev = f.timestamp;
    sizes.push(`${f.displayWidth}x${f.displayHeight}`);
    frames++;
    f.close();
  }
  const r = {
    openMs, decodeMs: Math.round(performance.now() - t2), frames, frameTimes: src.frameTimes.length, inOrder,
    sizes: tally(sizes), info: { ...src.info },
  };
  src.close();
  return r;
}

const errorOf = e => ({ code: e && e.code, name: e && e.name, message: String((e && e.message) || e) });
const heapMb = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);

/** The browser's parts with the frames, the encodes and the chunks recorded on the way through. */
function recordingApi(base, log) {
  return {
    ...base,
    readFrames: base.readFrames && (track => {
      const reader = base.readFrames(track);
      return {
        async read() {
          const r = await reader.read();
          if (!r.done) {
            const f = r.value;
            log.frames.push({ ts: f.timestamp, w: f.displayWidth, h: f.displayHeight, cw: f.codedWidth, ch: f.codedHeight, rot: f.rotation ?? 0, flip: !!f.flip, wall: performance.now() });
          }
          return r;
        },
        cancel: (...a) => reader.cancel(...a),
        releaseLock: () => reader.releaseLock(),
      };
    }),
    createEncoder: base.createEncoder && (init => {
      const pending = new Map();
      const enc = base.createEncoder({
        ...init,
        output: (chunk, meta) => {
          const t0 = pending.get(chunk.timestamp);
          pending.delete(chunk.timestamp);
          log.chunks.push({ ts: chunk.timestamp, type: chunk.type, bytes: chunk.byteLength, encodeMs: t0 === undefined ? null : performance.now() - t0 });
          if (meta && meta.decoderConfig) log.configs.push({ codec: meta.decoderConfig.codec, codedWidth: meta.decoderConfig.codedWidth, codedHeight: meta.decoderConfig.codedHeight, at: log.chunks.length - 1 });
          init.output(chunk, meta);
        },
      });
      return new Proxy(enc, {
        get(target, prop) {
          if (prop === 'encode') return (frame, opts) => { pending.set(frame.timestamp, performance.now()); log.encodes++; return target.encode(frame, opts); };
          if (prop === 'configure') return config => { log.configured.push({ codec: config.codec, width: config.width, height: config.height, bitrate: config.bitrate, framerate: config.framerate }); return target.configure(config); };
          const v = Reflect.get(target, prop, target);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    }),
  };
}

async function record({ bufferS = 60, seconds = 70, quality = '1080p30', camera = 'back', snapshots = [20, 60], cutS = 10, preview = true } = {}) {
  const out = { asked: { bufferS, seconds, quality, camera, snapshots, cutS }, marks: { page: Date.now() }, heap: { atLoadMb: heapMb() } };
  const log = { frames: [], chunks: [], configs: [], configured: [], encodes: 0 };
  let cap = null;
  try {
    out.screen = { orientation: screen.orientation && screen.orientation.type, w: innerWidth, h: innerHeight, dpr: devicePixelRatio };
    out.marks.open = Date.now();
    cap = createCapture({ camera, quality, bufferS }, { api: recordingApi(browserCaptureApi(), log) });
    let t = performance.now();
    await cap.open();
    out.openMs = Math.round(performance.now() - t);
    if (cap.status.state !== 'preview') { out.status = { state: cap.status.state, error: cap.status.error && errorOf(cap.status.error) }; return out; }
    const track = cap.stream.getVideoTracks()[0];
    out.track = { label: track.label, settings: track.getSettings(), capabilities: typeof track.getCapabilities === 'function' ? track.getCapabilities() : null };
    if (preview) { const v = document.getElementById('preview'); if (v) { v.srcObject = cap.stream; v.play().catch(() => {}); } }
    await sleep(1500);   // the camera's exposure settles, as R1's preview gives it time to
    out.marks.start = Date.now();
    t = performance.now();
    await cap.start();
    out.startMs = Math.round(performance.now() - t);
    const statuses = [];
    const end = performance.now() + seconds * 1000;
    while (performance.now() < end) {
      await sleep(Math.min(5000, end - performance.now()));
      const s = cap.status;
      statuses.push({ sinceS: r1(s.sinceS), fps: s.fps, heldS: r3(s.heldS), bytes: s.bytes, dropped: s.dropped });
    }
    out.marks.recorded = Date.now();
    const s = cap.status;
    out.status = { state: s.state, fps: s.fps, width: s.width, height: s.height, rotation: s.rotation, sinceS: r3(s.sinceS), heldS: r3(s.heldS), bytes: s.bytes, dropped: s.dropped, wakeLock: s.wakeLock, error: s.error && errorOf(s.error) };
    out.statuses = statuses;
    out.heap.recordingMb = heapMb();
    // the camera's frames: their rate and jitter over the whole recording, their sizes and rotations
    const ts = log.frames.map(f => f.ts);
    out.frames = { ...intervalStats(ts), sizes: tally(log.frames.map(f => `${f.w}x${f.h}`)), coded: tally(log.frames.map(f => `${f.cw}x${f.ch}`)), rotations: tally(log.frames.map(f => String(f.rot))), flipped: log.frames.filter(f => f.flip).length };
    // the encoder: what was asked, what it gave
    const keys = log.chunks.filter(c => c.type === 'key').map(c => c.ts);
    const gaps = keyframeGapsMs(keys);
    const enc = log.chunks.map(c => c.encodeMs).filter(Number.isFinite);
    const bytes = log.chunks.reduce((a, c) => a + c.bytes, 0);
    const spanS = log.chunks.length > 1 ? (log.chunks.at(-1).ts - log.chunks[0].ts) / 1e6 : 0;
    out.encoder = {
      configured: log.configured, configs: log.configs, codec: log.configs[0] ? log.configs[0].codec : null,
      encodes: log.encodes, chunks: log.chunks.length, keys: keys.length, framesRead: log.frames.length,
      keyframeGapsMs: { median: median(gaps), min: gaps.length ? Math.min(...gaps) : null, max: gaps.length ? Math.max(...gaps) : null, off: gaps.filter(g => Math.abs(g - 1000) > 1000 / 30 + 1).length },
      encodeMs: { median: r3(median(enc)), p90: r3(quantile(enc, 0.9)), max: r3(Math.max(...enc)) },
      allMbitPerS: spanS > 0 ? r3(bytes * 8 / spanS / 1e6) : null,
      keyBytesMedian: median(log.chunks.filter(c => c.type === 'key').map(c => c.bytes)), deltaBytesMedian: median(log.chunks.filter(c => c.type === 'delta').map(c => c.bytes)),
    };
    out.ring = { heldS: r3(s.heldS), bytes: s.bytes, mbitPerS: s.heldS > 0 ? r3(s.bytes * 8 / s.heldS / 1e6) : null, mb: r1(s.bytes / 1e6) };
    // the snapshots, while the capture records on, as R3 takes one
    out.snapshots = {};
    let last = null;
    for (const n of snapshots) {
      out.marks[`snapshot${n}`] = Date.now();
      t = performance.now();
      const snap = await cap.snapshot(n);
      const r = out.snapshots[n] = { ms: Math.round(performance.now() - t), bytes: snap && snap.blob.size, duration: snap && r3(snap.duration), start: snap && r3(snap.start) };
      out.marks[`snapshot${n}Read`] = Date.now();
      if (snap) {
        try { r.readBack = await readBack(snap.blob); } catch (e) { r.readBack = { error: errorOf(e) }; }
        last = snap;
      }
      out.marks[`snapshot${n}Done`] = Date.now();
      r.heapMb = heapMb();
    }
    if (last && cutS) {
      const mid = last.duration / 2, t0 = Math.max(0, mid - cutS / 2), t1 = Math.min(last.duration, t0 + cutS);
      out.marks.cut = Date.now();
      try {
        t = performance.now();
        const cut = await cutVideo(last.blob, { t0, t1 });
        out.cut = { t0: r3(t0), t1: r3(t1), ms: Math.round(performance.now() - t), bytes: cut.blob.size, start: r3(cut.start), duration: r3(cut.duration) };
        out.cut.readBack = await readBack(cut.blob);
      } catch (e) { out.cut = { error: errorOf(e) }; }
      out.marks.cutDone = Date.now();
    }
    out.marks.stop = Date.now();
    await cap.stop();
    out.afterStop = { state: cap.status.state, heldS: cap.status.heldS, wakeLock: cap.status.wakeLock };
  } catch (e) {
    out.error = errorOf(e);
    if (cap) out.statusAtError = { state: cap.status.state, error: cap.status.error && errorOf(cap.status.error) };
  } finally {
    if (cap) {
      const tracks = cap.stream ? cap.stream.getTracks() : [];
      cap.close();
      out.afterClose = { state: cap.status.state, tracks: tracks.map(x => x.readyState) };
    }
    const v = document.getElementById('preview');
    if (v) v.srcObject = null;
    out.marks.closed = Date.now();
  }
  return out;
}

async function permission() {
  try { return (await navigator.permissions.query({ name: 'camera' })).state; } catch { return null; }
}

export const c30 = { record, permission, ready: true };
if (typeof window !== 'undefined') {
  window.c30 = c30;
  const o = document.getElementById('out');
  if (o) o.textContent = 'window.c30 ready';
}
