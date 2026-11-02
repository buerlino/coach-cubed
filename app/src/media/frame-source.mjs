// The frame source (package s9), contract 5 (app/src/contracts/frame-source.mjs):
// a video opened from a Blob, read with mediabunny (the one demuxer in the app,
// vendored in app/vendor/mediabunny/) and decoded with WebCodecs. No <video>
// element: seeking one cost more than the pose model on the Fairphone.
//
//   const src = await openFrameSource(file);
//   src.info                      duration, fps, upright width and height, rotation, codec
//   await src.frameAt(t)          the frame shown at t seconds, a VideoFrame to close()
//   for await (f of src.frames(t0, t1)) …   a range in order, each frame to close()
//   await src.thumbnails([t…], {height})    ImageBitmaps for the filmstrip
//   src.close()
//   src.frameTimes                every frame's start time, presentation order (the steps of M1–M3)
//
// How: the demuxer lists every packet once, without reading the data (the
// sample table, sample-table.mjs). A request for frames is turned into the
// packets a decoder needs, from the keyframe before the first frame wanted to
// the last-stored frame wanted (B-frames are stored out of order), those are read
// and fed to a fresh decoder, and the frames not wanted are closed on the way.
// One decoder per call: calls may overlap, and close() ends them all.
//
// Frames come out upright: a file with a 90° rotation is turned once, here, so
// info.width × info.height and every frame's pixels are what the lifter sees, and
// keypoints posed on a frame are in those pixels.
//
// Every failure is a MediaError (media-error.mjs) and none is a hang: a video the
// decoder can't decode (HEVC on a WebView without it) fails at open, with the codec
// named, because open checks the decoder supports the file and decodes its first
// frame. Mirroring in the file (a flip) is not applied.
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from '../../vendor/mediabunny/mediabunny.mjs';
import { decodeFrames } from './decode.mjs';
import { MediaError, asMediaError } from './media-error.mjs';
import { buildSampleTable } from './sample-table.mjs';
import { browserWebCodecs } from './webcodecs.mjs';

export { MediaError, MEDIA_ERROR_CODES } from './media-error.mjs';

const isTime = t => typeof t === 'number' && Number.isFinite(t);

/**
 * @param {Blob} blob the picked File, or the stored cut read back
 * @param {Object} [options]
 * @param {Object} [options.webcodecs] the browser's WebCodecs calls (see webcodecs.mjs); tests pass a fake
 * @param {number} [options.stallMs] a decoder that makes no progress for this long is given up on (15 s)
 * @returns {Promise<import('../contracts/frame-source.mjs').FrameSource>} contract 5's source, frameTimes included
 */
export async function openFrameSource(blob, options = {}) {
  if (!(blob instanceof Blob)) throw new TypeError('openFrameSource needs a Blob or File');
  const webcodecs = options.webcodecs || browserWebCodecs();
  const stallMs = options.stallMs ?? 15000;
  const controller = new AbortController();
  let closed = false;
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const free = () => { try { input.dispose(); } catch { /* not open */ } };

  let track, sink, config, table, rotation, codec;
  try {
    track = await input.getPrimaryVideoTrack();
    if (!track) throw new MediaError('no-video', "This file has no video track, so there is nothing to mark or analyse.");
    codec = (await track.getCodecParameterString()) || track.codec || 'unknown';
    config = await track.getDecoderConfig();
    const supported = config
      ? await Promise.resolve(webcodecs.isConfigSupported(config)).then(r => !!(r && r.supported), () => false)
      : false;
    if (!supported) {
      throw new MediaError('unsupported-codec',
        `This video's format (${track.codec ? `${track.codec}, ` : ''}${codec}) can't be decoded on this device. `
        + 'Film it again with the phone camera set to H.264, or convert it.', { codec });
    }
    rotation = await track.getRotation();

    sink = new EncodedPacketSink(track);
    const packets = [];
    for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
      packets.push({ type: p.type, timestamp: p.timestamp, duration: p.duration });
    }
    table = buildSampleTable(packets);
  } catch (e) {
    free();
    throw e instanceof MediaError ? e : asMediaError(e, 'unreadable', "This file isn't a video the app can read");
  }

  const guard = () => { if (closed) throw new MediaError('closed', 'The video was closed.'); };

  // the packets startDec..endDec, in storage order, as chunks for the decoder
  async function* chunks(startDec, endDec) {
    const first = await sink.getKeyPacket(table.rawTimestamp(startDec));
    if (!first || Math.abs(first.timestamp - table.rawTimestamp(startDec)) > 1e-6) {
      throw new MediaError('unreadable', "The video file's index doesn't match its contents.");
    }
    let d = startDec;
    for await (const p of sink.packets(first)) {
      const i = table.presOf(d);
      yield { type: p.type, timestamp: table.timestampUs(i), duration: table.durationUs(i), data: p.data };
      if (d++ === endDec) return;
    }
    throw new MediaError('unreadable', 'The video file ends before its last frame.');
  }

  // decoded frames (as the decoder made them, not yet turned) of the packets
  // startDec..endDec whose timestamps `wants` accepts
  const decode = (startDec, endDec, wants) => decodeFrames({
    webcodecs, config, chunks: chunks(startDec, endDec), wants, signal: controller.signal, stallMs,
  });

  // the file's rotation applied to a frame; the original is closed
  async function upright(frame) {
    if (rotation === 0) return frame;
    try { return await webcodecs.rotate(frame, rotation); } finally { frame.close(); }
  }

  async function decodeAt(i, turn) {
    const { startDec, endDec } = table.plan(i, i);
    const target = table.timestampUs(i);
    for await (const f of decode(startDec, endDec, ts => ts === target)) return turn ? upright(f) : f;
    throw new MediaError('decode-failed', `The video decoder gave no frame at ${(table.times[i]).toFixed(3)} s.`);
  }

  // The first frame is decoded now: it shows the decoder really works on this
  // file (isConfigSupported can say yes and the decode still fail) and gives the
  // true frame size, which the container's header can get wrong.
  let probe;
  try { probe = await decodeAt(0, false); } catch (e) { free(); throw e; }
  const decodedW = probe.displayWidth, decodedH = probe.displayHeight;
  probe.close();
  const swap = rotation === 90 || rotation === 270;
  /** @type {import('../contracts/frame-source.mjs').FrameSourceInfo} */
  const info = {
    duration: table.duration, fps: table.fps,
    width: swap ? decodedH : decodedW, height: swap ? decodedW : decodedH,
    rotation, codec,
  };

  return {
    info,
    frameTimes: Object.freeze(table.times.slice()),

    async frameAt(t) {
      guard();
      if (!isTime(t)) throw new MediaError('range', `frameAt needs a time in seconds, not ${t}.`);
      return decodeAt(table.indexAt(t), true);
    },

    async *frames(t0, t1) {
      guard();
      if (!isTime(t0) || !isTime(t1)) throw new MediaError('range', `frames needs two times in seconds, not ${t0} and ${t1}.`);
      const r = table.indexRange(t0, t1);
      if (!r) return;
      const { startDec, endDec } = table.plan(r.first, r.last);
      const lo = table.timestampUs(r.first), hi = table.timestampUs(r.last);
      for await (const f of decode(startDec, endDec, ts => ts >= lo && ts <= hi)) {
        const ts = f.timestamp;
        yield await upright(f);
        if (ts >= hi) return;   // the last one wanted: no need to wait for the decoder's flush
      }
    },

    async thumbnails(times, { height } = {}) {
      guard();
      if (!Array.isArray(times) || !times.every(isTime)) throw new MediaError('range', 'thumbnails needs a list of times in seconds.');
      if (!isTime(height) || height < 1) throw new MediaError('range', `thumbnails needs a height in pixels, not ${height}.`);
      if (!times.length) return [];
      const width = Math.max(1, Math.round(height * info.width / info.height));
      // the slots each frame fills; frames are grouped by the keyframe they decode from
      const slots = new Map();
      times.forEach((t, k) => {
        const i = table.indexAt(t);
        if (!slots.has(i)) slots.set(i, []);
        slots.get(i).push(k);
      });
      const groups = new Map();
      for (const i of slots.keys()) {
        const { startDec, endDec } = table.plan(i, i);
        const g = groups.get(startDec) || { startDec, endDec, byTs: new Map() };
        g.endDec = Math.max(g.endDec, endDec);
        g.byTs.set(table.timestampUs(i), slots.get(i));
        groups.set(startDec, g);
      }
      const out = new Array(times.length).fill(null);
      try {
        for (const g of groups.values()) {
          let left = g.byTs.size;
          for await (const f of decode(g.startDec, g.endDec, ts => g.byTs.has(ts))) {
            const frame = await upright(f);
            try {
              for (const k of g.byTs.get(frame.timestamp)) out[k] = await webcodecs.toBitmap(frame, { width, height });
            } finally { frame.close(); }
            if (--left === 0) break;
          }
          if (left) throw new MediaError('decode-failed', 'The video decoder gave no frame for a thumbnail.');
        }
      } catch (e) {
        for (const b of out) if (b) b.close();
        throw e;
      }
      return out;
    },

    close() {
      if (closed) return;
      closed = true;
      controller.abort();
      free();
    },
  };
}
