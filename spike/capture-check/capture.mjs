// SPDX-License-Identifier: AGPL-3.0-or-later
// Step 3.4's capture checks for the gym recording session (milestone B),
// each one async and returning plain JSON for the CDP driver (drive.mjs):
//
//   camera    getUserMedia from the back camera: the frame rate and size
//             actually delivered, and the frame-time jitter
//   recorder  MediaRecorder: the supported types, and whether the clip it
//             writes decodes with pose-bench's lib/decode.mjs (mp4box) or
//             needs a WebM demuxer (mediabunny)
//   rolling   restarted segments: does each decode on its own, and the gap
//             between them; and why one recorder's timeslice chunks don't
//   encoder   WebCodecs VideoEncoder, a keyframe every second, muxed to MP4
//             or WebM by mediabunny, and a cut at a later keyframe
//   heat      record segments back to back and run the pose engine on each
//             while the next one records, for minutes
//
// Nothing recorded leaves the phone: clips live in memory and are dropped;
// only timings and counts are posted to results/.
import { demuxMp4, decodeAll } from '../pose-bench/lib/decode.mjs';
import { PoseEngine } from '../pose-bench/lib/pose-client.mjs';
import { ALL_FORMATS, BufferSource, BufferTarget, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource,
  Input, Mp4OutputFormat, Output, WebMOutputFormat } from './node_modules/mediabunny/dist/bundles/mediabunny.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stat = v => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b), mean = v.reduce((a, b) => a + b, 0) / v.length;
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: v.length, mean: +mean.toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2),
    min: +s[0].toFixed(2), max: +s[s.length - 1].toFixed(2),
    std: +Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length).toFixed(2) };
};

export async function post(name, body) {
  await fetch('results/' + name, { method: 'POST', body: JSON.stringify(body) });
}

// --- the camera -------------------------------------------------------------

// label: a camera by (part of) its label, e.g. 'camera 0,' (the device ids
// change per origin). exposureTime (100 µs units, as the Image Capture spec
// has it): manual exposure, so a dim room doesn't stretch every frame and
// lower the frame rate.
export async function openCamera({ width = 1920, height = 1080, fps = 60, exactFps = false, deviceId, label,
  exposureTime } = {}) {
  if (label) {
    const d = (await navigator.mediaDevices.enumerateDevices()).find(x => x.kind === 'videoinput' && x.label.includes(label));
    if (!d) throw new Error('no camera ' + label);
    deviceId = d.deviceId;
  }
  const video = { width: { ideal: width }, height: { ideal: height },
    frameRate: exactFps ? { exact: fps } : { ideal: fps } };
  if (deviceId) video.deviceId = { exact: deviceId }; else video.facingMode = { exact: 'environment' };
  const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  const track = stream.getVideoTracks()[0];
  if (exposureTime) await track.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime }] });
  return { stream, track, settings: track.getSettings(), capabilities: track.getCapabilities?.() };
}

// Every camera's label, facing, and the sizes and frame rates it offers.
export async function cameras() {
  const out = [];
  for (const d of (await navigator.mediaDevices.enumerateDevices()).filter(x => x.kind === 'videoinput')) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: d.deviceId } } });
      const t = s.getVideoTracks()[0], c = t.getCapabilities();
      out.push({ label: d.label, facing: c.facingMode, width: c.width, height: c.height, frameRate: c.frameRate,
        exposureTime: c.exposureTime, zoom: c.zoom });
      stopStream(s);
    } catch (e) { out.push({ label: d.label, error: `${e.name}: ${e.message}` }); }
  }
  return out;
}

export function stopStream(stream) { for (const t of stream.getTracks()) t.stop(); }

// Frame times as the camera stamps them: MediaStreamTrackProcessor's
// VideoFrame timestamps (Chromium exposes it on Window), so the display's
// refresh rate doesn't cap what is counted.
async function frameTimes(track, seconds) {
  const clone = track.clone();   // stopped below, or it keeps the camera open
  const proc = new MediaStreamTrackProcessor({ track: clone });
  const reader = proc.readable.getReader();
  const ts = [], arrive = [];
  let size = null;
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    const { value: f, done } = await reader.read();
    if (done) break;
    ts.push(f.timestamp / 1000); arrive.push(performance.now());
    size ||= `${f.displayWidth}x${f.displayHeight} ${f.format}`;
    f.close();
  }
  reader.cancel(); clone.stop();
  const d = ts.slice(1).map((t, i) => t - ts[i]), a = arrive.slice(1).map((t, i) => t - arrive[i]);
  const span = (ts.at(-1) - ts[0]) / 1000;
  const p50 = stat(d)?.p50 || 0;
  return { frames: ts.length, frameSize: size, fps: +((ts.length - 1) / span).toFixed(2),
    intervalMs: stat(d), arrivalMs: stat(a),
    late: d.filter(x => x > 1.5 * p50).length,   // a frame interval over 1.5× the median: a dropped frame
  };
}

export async function camera(opts = {}) {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput')
    .map(d => ({ id: d.deviceId.slice(0, 8), label: d.label }));
  let cam;
  try { cam = await openCamera(opts); } catch (e) { return { opts, devices, error: `${e.name}: ${e.message}` }; }
  try {
    await sleep(1000);   // let auto-exposure settle; the first frames come slow
    return { opts, devices, settings: cam.settings, capabilities: cam.capabilities,
      delivered: await frameTimes(cam.track, opts.seconds || 5) };
  } finally { stopStream(cam.stream); }
}

// --- reading a recorded clip back -------------------------------------------

// mediabunny's demuxer, for anything it reads (WebM, MP4, fragmented MP4),
// into the { config, chunks, info } that lib/decode.mjs's decodeAll takes.
export async function demuxAny(buf) {
  const input = new Input({ source: new BufferSource(buf), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('no video track');
  const config = await track.getDecoderConfig();
  const chunks = [];
  for await (const p of new EncodedPacketSink(track).packets()) chunks.push(p.toEncodedVideoChunk());
  const durationS = await track.computeDuration();
  return { config, chunks, info: { container: (await input.getFormat()).name, codec: config.codec,
    width: track.displayWidth, height: track.displayHeight, frames: chunks.length, durationS,
    keyframes: chunks.filter(c => c.type === 'key').length } };
}

async function decodeCount(media, hardware) {
  const ts = [];
  const t0 = performance.now();
  const n = await decodeAll(media, f => { ts.push(f.timestamp / 1000); f.close(); }, hardware ? { hardware } : undefined);
  const d = ts.slice(1).map((t, i) => t - ts[i]);
  return { decoded: n, ms: Math.round(performance.now() - t0),
    spanS: +((ts.at(-1) - ts[0]) / 1000).toFixed(3), intervalMs: stat(d) };
}

// Tries pose-bench's mp4box path first (what decode.mjs reads today), then
// mediabunny's; records what each did.
export async function readBack(buf) {
  const out = { bytes: buf.byteLength };
  try {
    const m = await demuxMp4(buf);
    out.mp4box = { info: m.info, ...(await decodeCount(m)) };
  } catch (e) { out.mp4box = { error: String(e.message || e).slice(0, 200) }; }
  try {
    const m = await demuxAny(buf);
    out.mediabunny = { info: m.info, ...(await decodeCount(m)) };
  } catch (e) { out.mediabunny = { error: String(e.message || e).slice(0, 200) }; }
  return out;
}

// --- MediaRecorder ----------------------------------------------------------

export const TYPES = ['video/mp4', 'video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.42E01F', 'video/mp4;codecs=avc1.64002A',
  'video/mp4;codecs=hvc1', 'video/mp4;codecs=av01', 'video/mp4;codecs=vp9',
  'video/webm', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm;codecs=av1', 'video/webm;codecs=h264',
  'video/x-matroska;codecs=avc1'];

function record(stream, { mimeType, bitrate, seconds, timeslice }) {
  return new Promise((resolve, reject) => {
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
    const parts = [];
    let started = 0;
    rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
    rec.onerror = e => reject(e.error || new Error('recorder error'));
    rec.onstart = () => { started = performance.now(); };
    rec.onstop = () => resolve({ parts, type: rec.mimeType, wallS: (performance.now() - started) / 1000 });
    rec.start(timeslice);
    setTimeout(() => rec.state !== 'inactive' && rec.stop(), seconds * 1000);
  });
}

export async function recorder({ seconds = 5, mimeType, bitrate = 12e6, ...cam } = {}) {
  const supported = TYPES.filter(t => MediaRecorder.isTypeSupported(t));
  const types = mimeType ? [mimeType] : [...new Set(supported.map(t => t.split(';')[0] === 'video/mp4' ? 'video/mp4'
    : t))].filter(t => ['video/mp4', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm;codecs=h264',
    'video/webm;codecs=av1'].includes(t));
  const { stream, settings } = await openCamera({ fps: 60, ...cam });
  const runs = [];
  try {
    await sleep(1000);
    for (const t of types) {
      try {
        const r = await record(stream, { mimeType: t, bitrate, seconds });
        const blob = new Blob(r.parts, { type: r.type });
        runs.push({ asked: t, got: r.type, wallS: +r.wallS.toFixed(2), ...(await readBack(await blob.arrayBuffer())) });
      } catch (e) { runs.push({ asked: t, error: String(e.message || e) }); }
    }
  } finally { stopStream(stream); }
  return { supported, settings, runs };
}

// Restarted recorders, overlapped so no frame falls between two: the next
// one starts before the last one stops. Then one recorder with a timeslice,
// to show its later chunks can't be read alone.
export async function rolling({ segments = 3, seconds = 10, mimeType, bitrate = 12e6, ...cam } = {}) {
  mimeType ||= MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm;codecs=vp8';
  const { stream, settings } = await openCamera({ fps: 60, ...cam });
  const out = { mimeType, settings, segments: [] };
  try {
    await sleep(1000);
    const pending = [];
    const startOne = () => {
      const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
      const parts = [];
      const seg = { startedAt: performance.now(), rec, done: new Promise(r => { rec.onstop = r; }) };
      rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
      rec.start();
      seg.parts = parts;
      return seg;
    };
    let cur = startOne();
    for (let k = 0; k < segments; k++) {
      await sleep(seconds * 1000);
      const next = k + 1 < segments ? startOne() : null;
      cur.rec.stop(); cur.stoppedAt = performance.now();
      pending.push(cur);
      cur = next;
    }
    for (const [k, seg] of pending.entries()) {
      await seg.done;
      const buf = await new Blob(seg.parts, { type: mimeType }).arrayBuffer();
      out.segments.push({ k, wallS: +((seg.stoppedAt - seg.startedAt) / 1000).toFixed(2),
        overlapMs: k ? Math.round(pending[k - 1].stoppedAt - seg.startedAt) : null, ...(await readBack(buf)) });
    }
    // One recorder, timeslice 2 s: the first chunk alone, the second alone, both.
    const r = await record(stream, { mimeType, bitrate, seconds: 6.5, timeslice: 2000 });
    const as = async parts => {
      const rb = await readBack(await new Blob(parts, { type: mimeType }).arrayBuffer());
      return { mp4box: rb.mp4box.error ? 'error: ' + rb.mp4box.error : rb.mp4box.decoded + ' frames',
        mediabunny: rb.mediabunny.error ? 'error: ' + rb.mediabunny.error : rb.mediabunny.decoded + ' frames' };
    };
    out.timeslice = { chunks: r.parts.length, first: await as(r.parts.slice(0, 1)), second: await as(r.parts.slice(1, 2)),
      firstTwo: await as(r.parts.slice(0, 2)) };
  } finally { stopStream(stream); }
  return out;
}

// --- WebCodecs encoder into a muxer ------------------------------------------

export const ENCODERS = ['avc1.42002A', 'avc1.4D002A', 'avc1.64002A', 'hvc1.1.6.L123.B0', 'vp8', 'vp09.00.41.08',
  'av01.0.09M.08'];

export async function encoderSupport({ width = 1920, height = 1080, fps = 60 } = {}) {
  const out = [];
  for (const codec of ENCODERS) for (const hw of ['prefer-hardware', 'prefer-software']) {
    const cfg = { codec, width, height, framerate: fps, bitrate: 12e6, hardwareAcceleration: hw };
    try { out.push({ codec, hw, supported: (await VideoEncoder.isConfigSupported(cfg)).supported }); }
    catch (e) { out.push({ codec, hw, error: String(e.message || e) }); }
  }
  return out;
}

// container: 'mp4' | 'webm'. Every frame the camera delivers goes to the
// encoder unless its queue is backed up (then it is dropped and counted).
export async function encoder({ seconds = 6, codec = 'avc1.42002A', container = 'mp4', keyEverySec = 1,
  hardware = 'prefer-hardware', bitrate = 12e6, ...cam } = {}) {
  const { stream, track, settings } = await openCamera({ fps: 60, ...cam });
  const fps = Math.round(settings.frameRate || 30);
  const res = { codec, container, hardware, settings };
  try {
    await sleep(1000);
    const packets = [];   // { chunk, meta }, kept for the cut below
    let error = null;
    const enc = new VideoEncoder({ output: (chunk, meta) => packets.push({ chunk, meta }), error: e => { error = e; } });
    enc.configure({ codec, width: settings.width, height: settings.height, framerate: fps, bitrate,
      hardwareAcceleration: hardware, latencyMode: 'realtime', ...(codec.startsWith('avc1') ? { avc: { format: 'avc' } } : {}) });
    const clone = track.clone();
    const reader = new MediaStreamTrackProcessor({ track: clone }).readable.getReader();
    let n = 0, dropped = 0, t0 = null;
    const encMs = [];
    const end = performance.now() + seconds * 1000;
    while (performance.now() < end && !error) {
      const { value: f, done } = await reader.read();
      if (done) break;
      t0 ??= f.timestamp;
      if (enc.encodeQueueSize > 4) { dropped++; f.close(); continue; }
      const s = performance.now();
      enc.encode(f, { keyFrame: n % (fps * keyEverySec) === 0 });
      encMs.push(performance.now() - s);
      n++; f.close();
    }
    reader.cancel(); clone.stop();
    if (error) throw error;   // the encoder closes itself on an error
    await enc.flush(); enc.close();
    if (error) throw error;
    res.frames = n; res.dropped = dropped; res.packets = packets.length;
    res.keyframes = packets.filter(p => p.chunk.type === 'key').length;
    // Only the first output carries the decoder config; a cut needs it too.
    const decoderConfig = packets.find(p => p.meta?.decoderConfig)?.meta.decoderConfig;
    const mux = async list => {
      const output = new Output({ format: container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' })
        : new WebMOutputFormat(), target: new BufferTarget() });
      const src = new EncodedVideoPacketSource(codec.startsWith('avc1') ? 'avc' : codec.startsWith('hvc1') ? 'hevc'
        : codec.startsWith('vp09') ? 'vp9' : codec.startsWith('av01') ? 'av1' : 'vp8');
      output.addVideoTrack(src, { frameRate: fps });
      await output.start();
      const base = list[0].chunk.timestamp;
      for (const [i, p] of list.entries()) {
        const pk = EncodedPacket.fromEncodedChunk(p.chunk).clone({ timestamp: (p.chunk.timestamp - base) / 1e6 });
        await src.add(pk, i === 0 ? { ...p.meta, decoderConfig } : p.meta);
      }
      await output.finalize();
      return output.target.buffer;
    };
    res.whole = await readBack(await mux(packets));
    // The rolling buffer's cut: everything from the third keyframe on, as a
    // clip of its own.
    const keys = packets.map((p, i) => (p.chunk.type === 'key' ? i : -1)).filter(i => i >= 0);
    if (keys.length > 2) res.cutFromThirdKey = await readBack(await mux(packets.slice(keys[2])));
  } catch (e) { res.error = String(e.stack || e).slice(0, 400); }
  finally { stopStream(stream); }
  return res;
}

// --- heat: record and process at the same time --------------------------------

// Samples a decoded clip on a 1/fps grid as bench.mjs does, through the
// engine; returns per-frame timings. t0Ms shifts the timestamps the engine
// sees: MediaPipe's video mode needs them to keep rising across segments.
async function poseClip(engine, media, fps, t0Ms = 0) {
  const step = fps === 'full' ? 0 : 1 / fps;
  const srcFps = media.info.frames / (media.info.durationS || 1);
  const half = 0.5 / srcFps;
  let next = 0, processed = 0, persons = 0, decodeWait = 0, last = performance.now();
  const ms = [];
  const decoded = await decodeAll(media, async f => {
    decodeWait += performance.now() - last;
    const ts = f.timestamp / 1e6;
    if (step && ts < next - half) { f.close(); last = performance.now(); return; }
    if (step) while (next <= ts + half) next += step;
    const r = await engine.estimate(f, t0Ms + ts * 1000);
    ms.push(r.ms.total); processed++; if (r.keypoints) persons++;
    last = performance.now();
  });
  return { decoded, processed, persons, decodeWaitMs: Math.round(decodeWait), engineMs: stat(ms) };
}

let heatState = null;

// Records segS-second segments back to back (overlapped restarts, as in
// rolling()) and runs the engine on each finished one while the next records.
// poseClip: a clip URL whose frames the engine runs on instead of the
// segment's (the segment is still demuxed and decoded): a camera facing an
// empty room only exercises MediaPipe's person detector, never its landmark
// model, so the load would be lower than with a lifter in frame.
// Posts its log to results/<name> after every segment, so the driver can
// start it and walk away. A backlog over maxBacklog segments drops the oldest.
export async function heat({ minutes = 30, segS = 10, model = 'mediapipe-full', ep = 'webgpu', fps = 'full', threads,
  mimeType, bitrate = 12e6, name = 'heat.json', maxBacklog = 3, poseClip: clipUrl, ...cam } = {}) {
  mimeType ||= MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm;codecs=vp8';
  const engine = await PoseEngine.create({ model, ep, threads, detector: 'yolox-nano', detEvery: 1 });
  const fixture = clipUrl ? await demuxMp4(await (await fetch(clipUrl)).arrayBuffer()) : null;
  const { stream, settings } = await openCamera({ fps: 60, ...cam });
  const log = { opts: { minutes, segS, model, ep, fps, threads, mimeType, bitrate, poseClip: clipUrl }, settings, engine: engine.info,
    startedAt: Date.now(), segments: [], dropped: 0, stopped: null };
  heatState = { stop: false };
  const queue = [];
  let recording = true, t0Ms = 0;
  const recLoop = (async () => {
    const until = performance.now() + minutes * 60000;
    let k = 0, cur = null;
    const startOne = () => {
      const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
      const parts = [];
      const seg = { k: k++, recStart: Date.now(), parts, done: new Promise(r => { rec.onstop = r; }), rec };
      rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
      rec.start();
      return seg;
    };
    cur = startOne();
    while (performance.now() < until && !heatState.stop) {
      await sleep(segS * 1000);
      const next = performance.now() < until && !heatState.stop ? startOne() : null;
      cur.rec.stop(); cur.recEnd = Date.now();
      await cur.done;
      queue.push(cur);
      while (queue.length > maxBacklog) { queue.shift(); log.dropped++; }
      if (!next) break;
      cur = next;
    }
    recording = false;
  })();
  try {
    while (recording || queue.length) {
      if (!queue.length) { await sleep(200); continue; }
      const seg = queue.shift();
      const procStart = Date.now();
      const entry = { k: seg.k, recStart: seg.recStart, recEnd: seg.recEnd, procStart, backlog: queue.length };
      try {
        const buf = await new Blob(seg.parts, { type: mimeType }).arrayBuffer();
        seg.parts.length = 0;
        entry.bytes = buf.byteLength;
        const media = mimeType.startsWith('video/mp4') ? await demuxMp4(buf).catch(() => demuxAny(buf)) : await demuxAny(buf);
        if (fixture) entry.segmentDecode = await decodeCount(media);
        const src = fixture || media;
        Object.assign(entry, await poseClip(engine, src, fps, t0Ms));
        t0Ms += (src.info.durationS + 1) * 1000;
      } catch (e) { entry.error = String(e.message || e).slice(0, 300); }
      entry.procEnd = Date.now();
      entry.procS = (entry.procEnd - procStart) / 1000;
      log.segments.push(entry);
      await post(name, log).catch(() => {});
    }
    await recLoop;
  } finally {
    stopStream(stream); engine.close();
    log.endedAt = Date.now(); log.stopped = heatState.stop ? 'asked' : 'time';
    await post(name, log).catch(() => {});
  }
  return { segments: log.segments.length, dropped: log.dropped };
}

export function stopHeat() { if (heatState) heatState.stop = true; }
