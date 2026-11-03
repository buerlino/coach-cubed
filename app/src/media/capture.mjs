// Capture and the rolling buffer (package c27, milestone B; D2: a 60 s buffer, a 20 s
// replay, several lifts per session). The camera's frames are encoded to H.264 as they
// come, with a keyframe a second, into a ring that holds the last `bufferS` seconds;
// R3's replay is a snapshot of it as an MP4, R3b's delayed view follows it.
//
//   const cap = createCapture({ camera: 'back', quality: '1080p30', bufferS: 60 });   // the settings' fields
//   await cap.open();                    // R1: the camera for the preview; cap.stream; nothing recorded
//   await cap.start();                   // R1's Start: frames -> H.264 -> the ring; the wake lock
//   const off = cap.subscribe(s => …);   // now and at each change (cap.status is the latest)
//   const snap = await cap.snapshot(20); // { blob, duration, start }: the last 20 s as an MP4
//   for await (const c of cap.follow(t)) …   // the chunks from the keyframe at or before t, then live
//   await cap.resume(); await cap.stop(); cap.close();
//
// The browser's parts (camera, frames, encoder, wake lock, visibility) come through
// `api` (capture-browser.mjs), so the tests hand it a fake. Spike: spike/capture-check/.
import { browserCaptureApi } from './capture-browser.mjs';
import { CaptureError, asCaptureError, cameraError } from './capture-error.mjs';
import { createRing } from './ring.mjs';

export { CaptureError, CAPTURE_ERROR_CODES } from './capture-error.mjs';

/** A keyframe at the first frame this long or more after the last one; the 1 ms is the camera timestamps' rounding. */
export const KEYFRAME_US = 1e6 - 1000;
/** Frames are dropped (and counted) while more than this many wait in the encoder's queue (the spike's 4). */
export const MAX_ENCODE_QUEUE = 4;
/** The frame rate is the median frame interval over this much of the latest frames. */
export const RATE_WINDOW_US = 2e6;
/**
 * The bitrate at 1080p30; other sizes and rates scale with their pixels per second. 10 Mbit/s is
 * what c34's phone-like clips have (the frame source's and the cut's phone numbers were measured
 * on them), between them and the spike's 12; 60 s of it is 75 MB in the ring.
 */
export const BITRATE_1080P30 = 10e6;
const MIN_BITRATE = 250e3;
/**
 * H.264 profiles in the order tried: Baseline first, the spike's and the one it checked on the
 * phone; it has no B-frames, so the encoder's output order is the frames' order, which the
 * ring's groups and its followers rely on. Level 4.2 covers 1080p60.
 */
export const CODECS = Object.freeze(['avc1.42002A', 'avc1.4D002A', 'avc1.64002A']);

/** '1080p30' → { width: 1920, height: 1080, fps: 30 } (16:9); anything else is 1080p30. */
export function parseQuality(q) {
  const m = /^(\d+)p(\d+)$/.exec(String(q));
  const height = m ? Number(m[1]) : 1080, fps = m ? Number(m[2]) : 30;
  return { width: Math.round(height * 16 / 9 / 2) * 2, height, fps };
}

export function bitrateFor(width, height, fps) {
  return Math.max(MIN_BITRATE, Math.round(BITRATE_1080P30 * (width * height * fps) / (1920 * 1080 * 30)));
}

/** The frame rate from the frames' own timestamps: the median interval over the last RATE_WINDOW_US. */
function createRateMeter() {
  let ts = [];
  return {
    add(t) {
      ts.push(t);
      let i = 0;
      while (i < ts.length - 1 && t - ts[i] > RATE_WINDOW_US) i++;
      if (i) ts = ts.slice(i);
      if (ts.length < 2) return null;
      const d = ts.slice(1).map((x, k) => x - ts[k]).sort((a, b) => a - b);
      const mid = d.length >> 1;
      const median = d.length % 2 ? d[mid] : (d[mid - 1] + d[mid]) / 2;
      return median > 0 ? Math.round(1e6 / median * 100) / 100 : null;
    },
  };
}

const configKey = c => {
  const d = c.description ? Array.from(new Uint8Array(c.description.buffer ?? c.description, c.description.byteOffset ?? 0, c.description.byteLength)) : [];
  return `${c.codec}|${c.codedWidth}x${c.codedHeight}|${d.map(b => b.toString(16).padStart(2, '0')).join('')}`;
};
const copyConfig = c => {
  const out = { ...c };
  if (c.description) out.description = new Uint8Array(c.description.buffer ?? c.description, c.description.byteOffset ?? 0, c.description.byteLength).slice();
  return out;
};
const quietly = f => { try { const r = f(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch { /* already done */ } };

/**
 * @param {{camera?: 'back'|'front', quality?: string, bufferS?: number}} settings the settings' fields (store/settings.mjs)
 * @param {{api?: ReturnType<typeof browserCaptureApi>, now?: () => number}} [options] the browser's parts, a clock in ms
 */
export function createCapture(settings = {}, { api = browserCaptureApi(), now = () => performance.now() } = {}) {
  const quality = parseQuality(settings.quality ?? '1080p30');
  const bufferS = settings.bufferS ?? 60;
  const facingMode = settings.camera === 'front' ? 'user' : 'environment';

  let state = 'closed', error = null, stream = null, track = null, offTrack = null;
  let ring = null, session = null, startedAt = null, codec = null;
  let fps = null, width = null, height = null, rotation = 0, dropped = 0;
  // the recording's clock across camera sessions: the last frame's time (µs) and when it came (ms)
  let lastFrameUs = null, lastFrameWall = null;
  let wake = 'off', sentinel = null, wakePending = null, offVisibility = null;
  const listeners = new Set();

  const status = () => ({
    state, fps, width, height, rotation,
    sinceS: startedAt === null ? 0 : (now() - startedAt) / 1000,
    heldS: ring ? ring.heldS : 0, bytes: ring ? ring.bytes : 0, dropped, wakeLock: wake, error,
  });
  const emit = () => { const s = status(); for (const fn of [...listeners]) fn(s); };
  const set = (patch) => { if ('state' in patch) state = patch.state; if ('error' in patch) error = patch.error; emit(); };
  // Every move to `failed` lets the wake lock and the visibility handler go (a failed capture
  // records nothing, so it must not keep the screen on); the ring stays, for snapshot().
  const toFailed = (e) => { releaseWake(); set({ state: 'failed', error: e }); };
  const fail = (e) => { toFailed(e); throw e; };

  // ---- the camera ----
  const constraints = () => ({
    audio: false,
    video: { facingMode: { ideal: facingMode }, width: { ideal: quality.width }, height: { ideal: quality.height }, frameRate: { ideal: quality.fps } },
  });
  async function openCamera() {
    if (!api.getUserMedia) throw new CaptureError('insecure', "The camera can't be used here: the page has no navigator.mediaDevices (it needs https or localhost).");
    let s;
    try { s = await api.getUserMedia(constraints()); } catch (e) { throw cameraError(e); }
    const t = s.getVideoTracks()[0];
    if (!t) { for (const x of s.getTracks()) quietly(() => x.stop()); throw new CaptureError('no-camera', 'The camera gave no video track.'); }
    return { s, t };
  }
  function adoptCamera({ s, t }) {
    stream = s; track = t;
    const settingsNow = typeof t.getSettings === 'function' ? t.getSettings() : {};
    if (settingsNow.width) width = settingsNow.width;
    if (settingsNow.height) height = settingsNow.height;
    const onLost = () => { if (track === t) interrupt(); };
    t.addEventListener('ended', onLost);
    t.addEventListener('mute', onLost);
    offTrack = () => { t.removeEventListener('ended', onLost); t.removeEventListener('mute', onLost); };
  }
  function releaseCamera() {
    if (offTrack) offTrack();
    offTrack = null;
    if (stream) for (const t of stream.getTracks()) quietly(() => t.stop());
    stream = null; track = null;
  }

  // ---- the wake lock ----
  async function requestWake() {
    if (wake === 'held' || wakePending) return wakePending;
    if (!api.requestWakeLock) { wake = 'refused'; emit(); return null; }
    wakePending = (async () => {
      try {
        const s = await api.requestWakeLock();
        if (!ring || state === 'failed') { quietly(() => s.release()); return; }   // stopped or failed meanwhile
        sentinel = s;
        wake = 'held';
        if (typeof s.addEventListener === 'function') {
          s.addEventListener('release', () => { if (sentinel === s) { sentinel = null; wake = 'off'; emit(); } });
        }
      } catch {
        if (ring && state !== 'failed') wake = 'refused';   // stopped or failed meanwhile: it stays off
      } finally {
        wakePending = null;
        emit();
      }
    })();
    return wakePending;
  }
  function releaseWake() {
    const s = sentinel;
    sentinel = null;
    wake = 'off';
    if (s) quietly(() => s.release());
    if (offVisibility) offVisibility();
    offVisibility = null;
  }

  // ---- a recording session: one camera track, one encoder ----
  function startSession() {
    const t = typeof track.clone === 'function' ? track.clone() : track;
    const s = {
      track: t, reader: api.readFrames(t), encoder: null, configured: null, rotations: [], seg: null,
      offsetUs: null, lastKeyUs: null, forceKey: true, meter: createRateMeter(), ended: false, discard: false,
    };
    s.encoder = api.createEncoder({
      output: (chunk, meta) => onChunk(s, chunk, meta),
      error: e => onEncoderError(s, e),
    });
    session = s;
    readLoop(s);
    return s;
  }

  async function readLoop(s) {
    for (;;) {
      let r;
      try { r = await s.reader.read(); } catch { break; }
      if (r.done) break;
      const f = r.value;
      if (s.ended) { quietly(() => f.close()); break; }
      try { onFrame(s, f); } finally { quietly(() => f.close()); }
    }
    // the frames stopped without stop() or an interruption: the camera is gone
    if (!s.ended && session === s && state === 'recording') interrupt();
  }

  function onFrame(s, f) {
    const wall = now();
    if (s.offsetUs === null) {
      // the first frame of a session: 0 for the first one, else on after the last frame by the wall time between
      const at = lastFrameUs === null ? 0 : lastFrameUs + Math.max(1e6 / quality.fps, Math.round((wall - lastFrameWall) * 1000));
      s.offsetUs = Math.round(at) - f.timestamp;
    }
    const ts = f.timestamp + s.offsetUs;
    lastFrameUs = ts; lastFrameWall = wall;
    const rate = s.meter.add(ts);
    if (rate !== null) fps = rate;
    const w = f.displayWidth, h = f.displayHeight, rot = f.rotation ?? 0;
    if (!s.configured || s.configured.w !== w || s.configured.h !== h || s.configured.rot !== rot) {
      try {
        s.encoder.configure({
          codec, width: w, height: h, framerate: quality.fps, bitrate: bitrateFor(w, h, quality.fps),
          hardwareAcceleration: 'no-preference', latencyMode: 'realtime', avc: { format: 'avc' },
        });
      } catch (e) { onEncoderError(s, e); return; }
      s.configured = { w, h, rot };
      s.rotations.push(rot);
      s.forceKey = true;
      width = w; height = h; rotation = rot;
    }
    if (s.encoder.encodeQueueSize > MAX_ENCODE_QUEUE) { dropped++; emit(); return; }
    const key = s.forceKey || s.lastKeyUs === null || ts - s.lastKeyUs >= KEYFRAME_US;
    if (key) { s.lastKeyUs = ts; s.forceKey = false; }
    try { s.encoder.encode(f, { keyFrame: key }); } catch (e) { onEncoderError(s, e); }
  }

  function onChunk(s, chunk, meta) {
    if (s.discard || !ring) return;
    if (meta && meta.decoderConfig) {
      const decoderConfig = copyConfig(meta.decoderConfig);
      const rot = s.rotations.length ? s.rotations.shift() : rotation;
      const key = `${configKey(decoderConfig)}|${rot}`;
      const last = ring.newest;
      s.seg = last && last.seg.key === key ? last.seg : { decoderConfig, rotation: rot, key };
    }
    if (!s.seg) return;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    ring.push({ type: chunk.type, ts: chunk.timestamp + s.offsetUs, dur: chunk.duration > 0 ? chunk.duration : 0, data, seg: s.seg });
    emit();
  }

  function onEncoderError(s, e) {
    if (s.ended || s.discard || session !== s) return;
    endSession(s, { flush: false });
    toFailed(asCaptureError(e, 'encoder-failed', 'The video encoder failed while recording'));
  }

  /** Ends a session: the reader, the track's clone and the encoder; with flush, what the encoder holds reaches the ring first. */
  async function endSession(s, { flush }) {
    if (s.ended) return;
    s.ended = true;
    if (!flush) s.discard = true;
    if (session === s) session = null;
    quietly(() => s.reader.cancel());
    if (s.track !== track) quietly(() => s.track.stop());
    if (flush && s.configured) { try { await s.encoder.flush(); } catch { /* closed by an error */ } }
    quietly(() => s.encoder.close());
  }

  function interrupt() {
    if (state !== 'recording' && state !== 'preview') return;
    if (session) endSession(session, { flush: true });
    set({ state: 'interrupted' });
  }

  /** Everything held let go: the session, the ring, the wake lock, the camera. */
  function teardown() {
    if (session) endSession(session, { flush: false });
    if (ring) ring.close();
    ring = null; startedAt = null;
    releaseWake();
    releaseCamera();
  }

  const cap = {
    /** The latest state: { state, fps, width, height, rotation, sinceS, heldS, bytes, dropped, wakeLock, error }. */
    get status() { return status(); },
    /** The camera's MediaStream while it is open (R1's preview), else null. */
    get stream() { return stream; },

    subscribe(fn) {
      listeners.add(fn);
      fn(status());
      return () => listeners.delete(fn);
    },

    /** R1: the camera for the preview. Nothing is recorded. After a failure it starts afresh. */
    async open() {
      if (state === 'preview' || state === 'recording' || state === 'interrupted') return;
      teardown();
      error = null;
      try { adoptCamera(await openCamera()); } catch (e) { releaseCamera(); fail(e); }
      set({ state: 'preview', error: null });
    },

    /** R1's Start: frames to H.264, a keyframe a second, into the ring; the wake lock. */
    async start() {
      if (state === 'recording') return;
      if (state !== 'preview') throw new Error(`start() needs the preview (open() first); the capture is ${state}`);
      if (!api.createEncoder || !api.isEncoderConfigSupported) fail(new CaptureError('no-encoder', "This browser can't record video: it has no WebCodecs encoder (VideoEncoder)."));
      if (!api.readFrames) fail(new CaptureError('no-encoder', "This browser can't record video: it can't read the camera's frames (no MediaStreamTrackProcessor)."));
      const w = width || quality.width, h = height || quality.height;
      codec = null;
      for (const c of CODECS) {
        const config = { codec: c, width: w, height: h, framerate: quality.fps, bitrate: bitrateFor(w, h, quality.fps), hardwareAcceleration: 'no-preference', latencyMode: 'realtime', avc: { format: 'avc' } };
        let ok = false;
        try { ok = !!(await api.isEncoderConfigSupported(config)).supported; } catch { ok = false; }
        if (ok) { codec = c; break; }
      }
      if (!codec) fail(new CaptureError('no-encoder', `This browser's video encoder supports none of the H.264 configs the app records (${CODECS.join(', ')} at ${w}×${h}).`));
      if (state !== 'preview') return;   // closed while asking
      ring = createRing({ bufferS });
      dropped = 0; fps = null; lastFrameUs = null; lastFrameWall = null;
      startedAt = now();
      try { startSession(); } catch (e) { ring.close(); ring = null; startedAt = null; fail(asCaptureError(e, 'encoder-failed', "The video encoder couldn't be started")); }
      offVisibility = api.onVisibilityChange(() => { if (ring && api.isVisible() && wake !== 'held') requestWake(); });
      set({ state: 'recording', error: null });
      await requestWake();
    },

    /** After an interruption: the camera again, recording on into the same ring from a new keyframe. */
    async resume() {
      if (state !== 'interrupted') return;
      if (offTrack) offTrack();
      offTrack = null;
      if (stream) for (const t of stream.getTracks()) quietly(() => t.stop());
      stream = null; track = null;
      try { adoptCamera(await openCamera()); } catch (e) { releaseCamera(); fail(e); }
      if (ring) {
        try { startSession(); } catch (e) { fail(asCaptureError(e, 'encoder-failed', "The video encoder couldn't be started")); }
        set({ state: 'recording', error: null });
        if (wake !== 'held') await requestWake();
      } else set({ state: 'preview', error: null });
    },

    /** The last `seconds` of the ring as an MP4, or null when nothing is held. */
    snapshot(seconds) { return ring ? ring.snapshot(seconds) : Promise.resolve(null); },

    /** The ring's chunks from the keyframe at or before `t` (seconds on the recording's clock, 0 at its first frame), then live. */
    follow(t) {
      if (ring) return ring.follow(t);
      return (async function* nothing() { /* nothing recorded */ })();
    },

    /** Stops the encoder, drops the ring and the wake lock; the camera stays open for the preview. */
    async stop() {
      if (!ring && !session) return;
      if (session) await endSession(session, { flush: false });
      if (ring) ring.close();
      ring = null; startedAt = null; dropped = 0;
      releaseWake();
      const live = track && track.readyState === 'live' && !track.muted;
      set({ state: live ? 'preview' : (stream ? 'interrupted' : 'closed'), error: null });
    },

    /** Releases the camera: every track stopped. */
    close() {
      teardown();
      set({ state: 'closed', error: null });
    },
  };
  return cap;
}
