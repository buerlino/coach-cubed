// Keeping the lift's video (package s32, D6): the marked range cut to MP4 at
// Analyse and stored with the lift, so the job reads its source from the store
// (a queued job survives a restart) and A1 plays it.
//
//   const cut = await cutVideo(blob, { t0, t1 });   // seconds in the source's timeline
//   cut.blob       the MP4
//   cut.range      { t0, t1 } in the cut's own timeline (0 is the cut's first frame)
//   cut.start      the source time of the cut's first frame: the keyframe at or before t0
//   cut.duration   the cut's length in seconds
//   const kept = await keepVideo(store, lift, blob, { t0, t1 });   // c8's saveLift
//   kept.lift      the StoredLift (contract 3), kept.range its range in the cut's timeline
//
// A stream copy: mediabunny reads the packets of the range and writes them again,
// byte for byte, into a new MP4 with the same codec configuration and the file's
// rotation. Nothing is decoded and nothing is encoded, so it is fast, loses no
// quality, and an HEVC file the WebView can't decode can still be kept. The packets
// are the ones the frame source would decode for the same range (the sample table's
// `plan`): from the key packet before the earliest-stored frame of the range (or, in an open
// group, the one before that, so the keyframe is at or before t0) to the
// latest-stored one (B-frames are stored after a picture shown later). Times in the
// cut are the source's minus the keyframe's, so the cut starts at 0 and the frame
// source (s9) opens it like any file.
import {
  ALL_FORMATS, BlobSource, BufferTarget, EncodedPacketSink, EncodedVideoPacketSource, Input, Mp4OutputFormat, Output,
} from '../../vendor/mediabunny/mediabunny.mjs';
import { MediaError, asMediaError } from './media-error.mjs';
import { buildSampleTable } from './sample-table.mjs';

const isTime = t => typeof t === 'number' && Number.isFinite(t);

/**
 * @param {Blob} blob the picked File (or any MP4/MOV/WebM the demuxer reads)
 * @param {{t0: number, t1: number}} range seconds in the source's timeline (0 is its first frame); the
 *   frames starting in [t0, t1] are covered, a range past either end is held to the video's span
 * @returns {Promise<{blob: Blob, range: {t0: number, t1: number}, start: number, duration: number}>}
 * @throws {MediaError} `range` (not a range, or no frame in it), `unreadable`, `no-video`
 */
export async function cutVideo(blob, range) {
  if (!(blob instanceof Blob)) throw new TypeError('cutVideo needs a Blob or File');
  if (!range || !isTime(range.t0) || !isTime(range.t1)) throw new MediaError('range', 'cutVideo needs a range of two times in seconds, t0 and t1.');
  if (range.t1 < range.t0) throw new MediaError('range', `The range ends (${range.t1} s) before it starts (${range.t0} s).`);

  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new MediaError('no-video', 'This file has no video track, so there is nothing to keep.');
    const config = await track.getDecoderConfig();
    const rotation = await track.getRotation();
    const sink = new EncodedPacketSink(track);

    const listed = [];
    for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
      listed.push({ type: p.type, timestamp: p.timestamp, duration: p.duration });
    }
    const table = buildSampleTable(listed);

    const r = table.indexRange(range.t0, range.t1);
    if (!r) throw new MediaError('range', `No frame of this ${table.duration.toFixed(2)} s video starts between ${range.t0} s and ${range.t1} s.`);
    let { startDec, endDec } = table.plan(r.first, r.last);
    // In an open group the pictures shown just before a keyframe are stored after it, so the
    // key packet before the earliest-stored frame of the range can be shown after the range
    // starts. Then the cut starts on the keyframe before that one, which is at or before t0
    // and from which those leading pictures can be decoded.
    const firstShown = table.times[r.first];
    while (startDec > 0 && table.times[table.presOf(startDec)] > firstShown + 1e-6) startDec = table.keyBefore(startDec - 1);
    const keyRaw = table.rawTimestamp(startDec);
    const start = table.times[table.presOf(startDec)];

    const first = await sink.getKeyPacket(keyRaw);
    if (!first || Math.abs(first.timestamp - keyRaw) > 1e-6) {
      throw new MediaError('unreadable', "The video file's index doesn't match its contents.");
    }

    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat(), target });
    const source = new EncodedVideoPacketSource(track.codec);
    output.addVideoTrack(source, { rotation });
    await output.start();

    let d = startDec, written = 0, end = 0, done = false;
    for await (const p of sink.packets(first)) {
      const i = table.presOf(d);
      // a picture shown before the keyframe (an open group) can't be decoded from it: left out
      if (p.timestamp >= keyRaw - 1e-9) {
        const duration = p.duration > 0 ? p.duration : table.durationUs(i) / 1e6;
        const shifted = p.clone({ timestamp: p.timestamp - keyRaw, duration });
        await source.add(shifted, written === 0 && config ? { decoderConfig: config } : undefined);
        end = Math.max(end, shifted.timestamp + duration);
        written++;
      }
      if (d++ === endDec) { done = true; break; }
    }
    if (!done) throw new MediaError('unreadable', 'The video file ends before the end of the range.');
    await output.finalize();

    return {
      blob: new Blob([target.buffer], { type: 'video/mp4' }),
      // the marked range in the cut's timeline, held to the video's span
      range: { t0: Math.max(0, Math.max(0, range.t0) - start), t1: Math.min(range.t1, table.duration) - start },
      start,
      duration: end,
    };
  } catch (e) {
    throw e instanceof MediaError || e instanceof TypeError ? e : asMediaError(e, 'unreadable', "This file isn't a video the app can cut");
  } finally {
    try { input.dispose(); } catch { /* already closed */ }
  }
}

/**
 * Cuts the marked range and stores it as a new lift (c8's saveLift): the cut in
 * the lift's folder, the record with the cut's path and the range in the cut's
 * timeline. A full disk comes through as the store's `storage-full` StoreError
 * (d23 shows it); a video that can't be cut as a MediaError.
 * @param {{saveLift: Function}} store from createStore()
 * @param {import('../contracts/lifts.mjs').LiftId} lift
 * @param {Blob} source the picked File
 * @param {{t0: number, t1: number}} range the marked range, seconds in the source
 * @returns {Promise<{lift: import('../contracts/stored-lift.mjs').StoredLift, range: {t0: number, t1: number}, start: number, duration: number}>}
 */
export async function keepVideo(store, lift, source, range) {
  const cut = await cutVideo(source, range);
  const stored = await store.saveLift({ lift, video: cut.blob, range: cut.range });
  return { lift: stored, range: cut.range, start: cut.start, duration: cut.duration };
}
