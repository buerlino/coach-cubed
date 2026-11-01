// Demux an MP4/MOV with mp4box.js and decode it with WebCodecs, in
// presentation order, without a <video> element (the old prototype's seeking
// cost 0.2–0.5 s per frame on the Fairphone).
import { createFile, DataStream, Endianness, MP4BoxBuffer } from '../node_modules/mp4box/dist/mp4box.all.mjs';

// The decoder's codec description (avcC/hvcC/vpcC/av1C box body).
function description(file, trackId) {
  const trak = file.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8);   // drop the box header
    }
  }
  return undefined;
}

// buffer: the whole file. Resolves to { config, chunks, info } where chunks
// are EncodedVideoChunks in decode order, timestamps in µs from the first
// presented frame.
export function demuxMp4(buffer) {
  return new Promise((resolve, reject) => {
    const file = createFile();
    let track = null;
    const samples = [];
    file.onError = e => reject(new Error('mp4box: ' + e));
    file.onReady = info => {
      track = info.videoTracks[0];
      if (!track) { reject(new Error('no video track')); return; }
      file.setExtractionOptions(track.id, null, { nbSamples: Infinity });
      file.start();
    };
    file.onSamples = (id, user, batch) => { for (const s of batch) samples.push(s); };
    const ab = MP4BoxBuffer.fromArrayBuffer(buffer, 0);
    file.appendBuffer(ab, true);
    file.flush();
    if (!track) { reject(new Error('not an MP4 the demuxer understands')); return; }

    // Presentation time 0 is the earliest composition time, as ffmpeg (and so
    // the reference's OpenCV decode) would show it after the edit list.
    const t0 = Math.min(...samples.map(s => s.cts));
    const us = v => Math.round(1e6 * v / track.timescale);
    // A fragmented MP4 (what MediaRecorder writes) has an almost empty moov,
    // so its track duration says ~0 s: the samples' own span is the truth.
    const span = (Math.max(...samples.map(s => s.cts + s.duration)) - t0) / track.timescale;
    const durationS = Math.max(track.duration / track.timescale, span);
    const chunks = samples.map(s => new EncodedVideoChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: us(s.cts - t0),
      duration: us(s.duration),
      data: s.data,
    }));
    const config = {
      codec: track.codec.startsWith('vp08') ? 'vp8' : track.codec,
      codedWidth: track.video.width,
      codedHeight: track.video.height,
      description: description(file, track.id),
    };
    resolve({ config, chunks, info: { codec: track.codec, width: track.video.width, height: track.video.height,
      frames: samples.length, durationS, fps: samples.length / durationS } });
  });
}

// Decodes every chunk and calls onFrame(frame, index) in presentation order;
// onFrame owns the frame and must close() it. Backpressure: at most
// `maxQueued` decoded frames wait for onFrame at a time, so decoding stays a
// few frames ahead of a slow consumer instead of filling memory.
export async function decodeAll({ config, chunks }, onFrame, { maxQueued = 4, hardware = 'no-preference' } = {}) {
  const support = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: hardware });
  if (!support.supported) throw new Error('decoder does not support ' + config.codec);
  const ready = [];
  let wake = null, error = null, index = 0;
  const decoder = new VideoDecoder({
    output: f => { ready.push(f); if (wake) { wake(); wake = null; } },
    error: e => { error = e; if (wake) { wake(); wake = null; } },
  });
  decoder.configure({ ...config, hardwareAcceleration: hardware });
  // Woken by a frame, an error, or the decoder taking a chunk: a decoder may
  // hold a dozen frames for reordering before it outputs one, so waiting for
  // output alone could wait forever on a decoder that wants more input.
  decoder.addEventListener('dequeue', () => { if (wake) { wake(); wake = null; } });
  const waitFrame = () => new Promise(r => { wake = r; });

  let fed = 0;
  const drain = async () => {
    while (ready.length) await onFrame(ready.shift(), index++);
  };
  while (fed < chunks.length) {
    // Keep the decoder fed, but don't let decoded frames pile up.
    while (fed < chunks.length && decoder.decodeQueueSize < 8 && ready.length < maxQueued) decoder.decode(chunks[fed++]);
    if (error) throw error;
    if (ready.length) await drain(); else await waitFrame();
  }
  // Keep draining while the flush runs: a hardware decoder (Android's
  // MediaCodec) outputs its last frames only once earlier ones are closed and
  // their buffers return to its pool, so awaiting the flush first deadlocks.
  let flushed = false;
  const flush = decoder.flush().then(() => { flushed = true; if (wake) { wake(); wake = null; } });
  while (!flushed || ready.length) {
    if (error) throw error;
    if (ready.length) await drain(); else await waitFrame();
  }
  await flush;
  if (error) throw error;
  decoder.close();
  return index;
}
