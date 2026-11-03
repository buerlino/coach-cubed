'use strict';
// A fake of the WebCodecs calls the frame source makes (app/src/media/), for
// tests/app/frame-source.test.js: Node has no VideoDecoder. It is shaped like
// the `webcodecs` option of openFrameSource():
//   isConfigSupported(config), createChunk(init), createDecoder({output, error}),
//   rotate(frame, rotation), toBitmap(frame, {width, height}).
//
// The decoder follows the real one where the frame source depends on it:
//  - it needs a key chunk first after configure(), else the error callback runs;
//  - a decoder with B-frames holds `reorder` chunks back and outputs the frames
//    in presentation (timestamp) order; a key chunk flushes what it holds (a
//    closed GOP), flush() outputs the rest;
//  - output comes later, never inside decode() (setImmediate);
//  - decodeQueueSize counts chunks not yet taken, and 'dequeue' fires when one is;
//  - a frame is { timestamp, duration, displayWidth, displayHeight, close() }, the
//    size from configure()'s codedWidth/codedHeight; closing twice is harmless;
//  - a bitmap records the frame it was drawn from (`source`: its size, its turn).
// `log` records what the frame source did, for the assertions: the decoders made,
// the chunks each was fed (in order), every frame and bitmap made and whether it
// was closed, the rotations and the configs checked.

function createFakeWebCodecs({
  supported = true,        // boolean, or (config) => boolean
  reorder = 3,             // chunks the decoder holds back (B-frames)
  silent = false,          // a decoder that takes chunks and never outputs
  failOnChunk = null,      // call error() when this many chunks have been fed (1 = the first)
  failConfigure = false,   // configure() reports the error through error()
  hangFlush = false,       // flush() never settles (a decoder that is stuck)
} = {}) {
  const log = { checked: [], decoders: [], frames: [], bitmaps: [], rotations: [], chunks: [] };

  const makeFrame = (timestamp, duration, w, h, extra = {}) => {
    const f = {
      timestamp, duration, displayWidth: w, displayHeight: h, closed: false, ...extra,
      close() { f.closed = true; },
    };
    log.frames.push(f);
    return f;
  };

  class FakeDecoder {
    constructor(init) {
      this.init = init;
      this.state = 'unconfigured';
      this.config = null;
      this.fed = [];            // the chunks this decoder was given, in order
      this.held = [];
      this.pending = 0;
      this.listeners = [];
      this.outputs = 0;
      log.decoders.push(this);
    }
    get decodeQueueSize() { return this.pending; }
    addEventListener(type, fn) { if (type === 'dequeue') this.listeners.push(fn); }
    configure(config) {
      if (this.state === 'closed') throw new DOMException('closed', 'InvalidStateError');
      this.config = config;
      this.state = 'configured';
      this.needKey = true;
      if (failConfigure) setImmediate(() => this._fail(new Error('configure failed')));
    }
    _fail(e) { if (this.state !== 'closed') { this.state = 'closed'; this.init.error(e); } }
    _emit(chunk) {
      if (this.state === 'closed') return;
      this.outputs++;
      this.init.output(makeFrame(chunk.timestamp, chunk.duration, this.config.codedWidth, this.config.codedHeight, { chunk }));
    }
    _emitHeld(count) {
      this.held.sort((a, b) => a.timestamp - b.timestamp);
      for (const c of this.held.splice(0, count)) this._emit(c);
    }
    decode(chunk) {
      if (this.state !== 'configured') throw new DOMException('not configured', 'InvalidStateError');
      this.fed.push(chunk);
      log.chunks.push(chunk);
      this.pending++;
      setImmediate(() => {
        if (this.state === 'closed') return;
        this.pending--;
        for (const fn of this.listeners) fn();
        if (this.needKey && chunk.type !== 'key') return this._fail(new Error('A key frame is required after configure()'));
        this.needKey = false;
        if (failOnChunk && this.fed.length === failOnChunk) return this._fail(new Error('decode failed'));
        if (silent) return;
        if (chunk.type === 'key') this._emitHeld(this.held.length);
        this.held.push(chunk);
        if (this.held.length > reorder) this._emitHeld(1);
      });
    }
    flush() {
      if (hangFlush) return new Promise(() => {});
      return new Promise((resolve, reject) => setImmediate(() => {
        if (this.state === 'closed') return reject(new DOMException('closed', 'AbortError'));
        if (!silent) this._emitHeld(this.held.length);
        resolve();
      }));
    }
    close() { this.state = 'closed'; }
  }

  return {
    log,
    async isConfigSupported(config) {
      log.checked.push(config);
      const ok = typeof supported === 'function' ? supported(config) : supported;
      return { supported: !!ok, config };
    },
    createChunk(init) { return { ...init }; },
    createDecoder(init) { return new FakeDecoder(init); },
    // what the real one does with a canvas: the pixels turned, so a 90° or 270° turn swaps the sides
    rotate(frame, rotation) {
      log.rotations.push({ rotation, from: frame.timestamp });
      const swap = rotation === 90 || rotation === 270;
      return makeFrame(frame.timestamp, frame.duration,
        swap ? frame.displayHeight : frame.displayWidth, swap ? frame.displayWidth : frame.displayHeight, { rotated: rotation });
    },
    toBitmap(frame, { width, height }) {
      // source: the frame it was drawn from, so a test sees it was upright (and turned, when it was)
      const b = {
        width, height, timestamp: frame.timestamp, closed: false, close() { b.closed = true; },
        source: { width: frame.displayWidth, height: frame.displayHeight, rotated: frame.rotated ?? 0 },
      };
      log.bitmaps.push(b);
      return b;
    },
  };
}

// ---- the capture's browser (c27): a fake camera, encoder and wake lock ----------------
//
// Shaped like browserCaptureApi() in app/src/media/capture-browser.mjs, the `api` option of
// createCapture(). The camera is driven by the test, frame by frame, on its own clock:
//   const fake = await createFakeCapture({ fps: 20, askedFps: 30 });
//   createCapture(settings, { api: fake.api, now: fake.now });
//   await fake.deliver(40);          // 2 s of frames, each taken by the capture before the next
//   fake.camera.setFps(15); fake.camera.end(); fake.camera.mute(); fake.setVisible(false);
// Frames carry timestamps (µs) at the camera's real rate, whatever getSettings() says (askedFps).
// The encoder outputs, for each frame it is given, a packet of a real clip of that size from
// tests/app/clips/ (read with mediabunny, with the clip's decoder config): a key packet when a
// keyframe is asked for (or first after configure()), else the clip's next delta packet. So what
// the capture writes is a real MP4 that openFrameSource (with the fake decoder above) and cutVideo
// read. The decoder config comes with the first output after each configure(), as WebCodecs does.

const CAPTURE_CLIPS = { '96x54': 'testsrc2-h264-30fps.mp4', '108x192': 'testsrc2-snatch-30fps-107f.mp4' };

/** A clip's packets and decoder config, read with the app's vendored mediabunny. */
async function loadClipPackets(file) {
  const path = require('node:path');
  const fs = require('node:fs');
  const { pathToFileURL } = require('node:url');
  const mb = await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'app', 'vendor', 'mediabunny', 'mediabunny.mjs')).href);
  const input = new mb.Input({ source: new mb.BufferSource(fs.readFileSync(path.join(__dirname, 'clips', file))), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    const c = await track.getDecoderConfig();
    const keys = [], deltas = [];
    for await (const p of new mb.EncodedPacketSink(track).packets()) (p.type === 'key' ? keys : deltas).push(new Uint8Array(p.data));
    return {
      file, keys, deltas,
      config: { codec: c.codec, codedWidth: c.codedWidth, codedHeight: c.codedHeight, description: new Uint8Array(c.description) },
    };
  } finally { input.dispose(); }
}

async function createFakeCapture({
  fps = 30,                  // the camera's real rate
  askedFps = 30,             // what its track's getSettings() says
  sizes = ['96x54'],         // the frame size of each getUserMedia() in turn (the last one repeats)
  rotation = 0,              // VideoFrame.rotation, where the browser sets it
  getUserMediaError = null,  // { name, message }: getUserMedia rejects with it
  mediaDevices = true,       // false: no navigator.mediaDevices (an insecure context)
  encoder = true,            // false: no VideoEncoder at all
  trackProcessor = true,     // false: no MediaStreamTrackProcessor
  supported = true,          // boolean, or (config) => boolean: VideoEncoder.isConfigSupported
  holdOutputs = false,       // the encoder takes frames and outputs nothing until release()
  wakeLock = 'grant',        // 'grant', 'refuse' (NotAllowedError), or 'none' (no navigator.wakeLock)
} = {}) {
  const clips = {};
  for (const [size, file] of Object.entries(CAPTURE_CLIPS)) clips[size] = await loadClipPackets(file);
  const log = { getUserMedia: [], encoders: [], configs: [], encoded: [], outputs: [], checked: [], frames: [], wakeLocks: [], flushes: [] };
  let clockMs = 1000, opened = 0, visible = true;
  const visibilityListeners = new Set();
  const tick = () => new Promise(r => setImmediate(r));

  function makeCamera(size) {
    const [width, height] = size.split('x').map(Number);
    const cam = {
      width, height, fps, rotation, live: true, clockBaseMs: clockMs + 500,   // opening the camera takes 0.5 s on the fake's clock
      muted: false, nextUs: 0, readers: new Set(), tracks: [],
      setFps(f) { cam.fps = f; },
      end() { cam.live = false; for (const t of cam.tracks) { t.readyState = 'ended'; t._fire('ended'); } for (const r of cam.readers) r._end(); },
      mute() { cam.muted = true; for (const t of cam.tracks) { t.muted = true; t._fire('mute'); } },
    };
    cam.track = makeTrack(cam);
    return cam;
  }
  function makeTrack(cam) {
    const listeners = {};
    const t = {
      kind: 'video', readyState: 'live', muted: false, camera: cam,
      getSettings: () => ({ width: cam.width, height: cam.height, frameRate: askedFps, deviceId: 'fake_device_0' }),
      addEventListener(type, fn) { (listeners[type] ||= new Set()).add(fn); },
      removeEventListener(type, fn) { listeners[type]?.delete(fn); },
      _fire(type) { for (const fn of [...(listeners[type] || [])]) fn({ type }); },
      stop() { t.readyState = 'ended'; },
      clone() { return makeTrack(cam); },
    };
    cam.tracks.push(t);
    return t;
  }

  const api = {
    getUserMedia: !mediaDevices ? null : async constraints => {
      log.getUserMedia.push(constraints);
      if (getUserMediaError) {
        const e = new Error(getUserMediaError.message);
        e.name = getUserMediaError.name;
        throw e;
      }
      const cam = makeCamera(sizes[Math.min(opened++, sizes.length - 1)]);
      fake.cameras.push(cam);
      fake.camera = cam;
      return { id: `stream-${opened}`, getTracks: () => [cam.track], getVideoTracks: () => [cam.track] };
    },
    readFrames: !trackProcessor ? null : track => {
      const cam = track.camera, queue = [];
      let wake = null, ended = !cam.live || track.readyState !== 'live';
      const r = {
        _push(f) { queue.push(f); const w = wake; wake = null; if (w) w(); },
        _end() { ended = true; const w = wake; wake = null; if (w) w(); },
        taken: () => queue.length === 0,
        async read() {
          for (;;) {
            if (queue.length) return { value: queue.shift(), done: false };
            if (ended || track.readyState !== 'live') return { value: undefined, done: true };
            await new Promise(res => { wake = res; });
          }
        },
        async cancel() { r._end(); cam.readers.delete(r); for (const f of queue.splice(0)) f.close(); },
      };
      cam.readers.add(r);
      return r;
    },
    isEncoderConfigSupported: !encoder ? null : async config => {
      log.checked.push(config);
      return { supported: !!(typeof supported === 'function' ? supported(config) : supported), config };
    },
    createEncoder: !encoder ? null : init => new FakeEncoder(init),
    requestWakeLock: wakeLock === 'none' ? null : async () => {
      if (wakeLock === 'refuse') { const e = new Error('Wake Lock permission request denied'); e.name = 'NotAllowedError'; throw e; }
      const listeners = new Set();
      const s = {
        released: false, releasedBy: null,
        addEventListener(type, fn) { if (type === 'release') listeners.add(fn); },
        removeEventListener(type, fn) { listeners.delete(fn); },
        async release() { if (s.released) return; s.released = true; s.releasedBy = 'page'; for (const fn of listeners) fn({ type: 'release' }); },
        _drop() { if (s.released) return; s.released = true; s.releasedBy = 'browser'; for (const fn of listeners) fn({ type: 'release' }); },
      };
      log.wakeLocks.push(s);
      return s;
    },
    isVisible: () => visible,
    onVisibilityChange(fn) { visibilityListeners.add(fn); return () => visibilityListeners.delete(fn); },
  };

  class FakeEncoder {
    constructor(init) {
      this.init = init; this.state = 'unconfigured'; this.pending = []; this.listeners = []; this.closedBy = null;
      log.encoders.push(this);
    }
    get encodeQueueSize() { return this.pending.length; }
    addEventListener(type, fn) { if (type === 'dequeue') this.listeners.push(fn); }
    removeEventListener(type, fn) { this.listeners = this.listeners.filter(x => x !== fn); }
    configure(config) {
      if (this.state === 'closed') throw new DOMException('closed', 'InvalidStateError');
      const clip = clips[`${config.width}x${config.height}`];
      if (!clip) throw new Error(`the fake encoder has no clip of ${config.width}x${config.height}`);
      this.config = config; this.clip = clip; this.state = 'configured'; this.newConfig = true; this.keyAt = -1; this.deltaAt = -1;
      log.configs.push(config);
    }
    encode(frame, options = {}) {
      if (this.state !== 'configured') throw new DOMException('not configured', 'InvalidStateError');
      if (frame.closed) throw new TypeError('the frame is closed');
      const key = !!options.keyFrame || this.newConfig;
      const e = { timestamp: frame.timestamp, duration: frame.duration, keyFrame: !!options.keyFrame, key, encoder: log.encoders.indexOf(this) };
      log.encoded.push(e);
      this.pending.push(e);
      if (!holdOutputs) setImmediate(() => this._out(1));
    }
    _out(n) {
      for (const e of this.pending.splice(0, n)) {
        if (this.state === 'closed') return;
        const clip = this.clip;
        let data;
        if (e.key) { this.keyAt = (this.keyAt + 1) % clip.keys.length; data = clip.keys[this.keyAt]; } else { this.deltaAt = (this.deltaAt + 1) % clip.deltas.length; data = clip.deltas[this.deltaAt]; }
        const chunk = {
          type: e.key ? 'key' : 'delta', timestamp: e.timestamp, duration: e.duration ?? null, byteLength: data.byteLength,
          copyTo(dst) { dst.set(data); },
        };
        const meta = this.newConfig ? { decoderConfig: { ...clip.config, description: clip.config.description.slice() } } : undefined;
        this.newConfig = false;
        log.outputs.push({ chunk, meta });
        for (const fn of this.listeners) fn();
        this.init.output(chunk, meta);
      }
    }
    release() { this._out(this.pending.length); }
    async flush() {
      log.flushes.push(log.encoders.indexOf(this));
      if (this.state !== 'configured') throw new DOMException('not configured', 'InvalidStateError');
      await tick();
      this._out(this.pending.length);
    }
    fail(message = 'Encoding error.') {
      this.state = 'closed';
      const e = new Error(message); e.name = 'EncodingError';
      this.init.error(e);
    }
    close() { this.state = 'closed'; this.pending.length = 0; }
  }

  const fake = {
    api, log, clips, cameras: [], camera: null,
    now: () => clockMs,
    setVisible(v) { visible = v; for (const fn of [...visibilityListeners]) fn(); },
    /** n frames from the latest camera, each one taken by the capture's reader before the next is made; the clock follows the frames. */
    async deliver(n) {
      const cam = fake.camera;
      for (let i = 0; i < n; i++) {
        if (!cam.live) break;
        const ts = Math.round(cam.nextUs);
        cam.nextUs += 1e6 / cam.fps;
        clockMs = cam.clockBaseMs + ts / 1000;
        const f = {
          timestamp: ts, duration: null, displayWidth: cam.width, displayHeight: cam.height, codedWidth: cam.width, codedHeight: cam.height,
          rotation: cam.rotation, closed: false, close() { f.closed = true; },
        };
        log.frames.push(f);
        for (const r of cam.readers) r._push(f);
        for (let k = 0; k < 20 && [...cam.readers].some(r => !r.taken()); k++) await tick();
        await tick(); await tick();
      }
      for (let k = 0; k < 5; k++) await tick();
    },
    settle: async () => { for (let k = 0; k < 10; k++) await tick(); },
    get encoder() { return log.encoders.at(-1); },
    get wakeLock() { return log.wakeLocks.at(-1); },
  };
  return fake;
}

module.exports = { createFakeWebCodecs, createFakeCapture, loadClipPackets, CAPTURE_CLIPS };
