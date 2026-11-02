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

module.exports = { createFakeWebCodecs };
