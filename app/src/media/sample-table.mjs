// The sample table: what a video's packets say about its frames, without
// decoding any. Built from the demuxer's packets in decode (storage) order, each
// { type: 'key'|'delta', timestamp, duration } in seconds. Answers the frame
// source's questions: the frame times in presentation order (from 0, the earliest
// frame), the frame shown at a time, a range's frames, and the keyframe search:
// which packets a decoder has to be given to produce a set of frames.
//
// B-frames make decode order differ from presentation order: a picture can be
// stored after one that is shown later. So "frame i" always means the i-th in
// presentation order, "packet d" the d-th in storage order, and the table maps
// between them. Plain module, no DOM.
import { MediaError } from './media-error.mjs';

// a time given as a float is one ulp short of the frame it names more often than
// not (3 / 30 * 30); a microsecond is below any frame spacing and WebCodecs' unit
const SLACK = 1e-6;

/**
 * @param {{type: string, timestamp: number, duration: number}[]} packets decode order
 */
export function buildSampleTable(packets) {
  const n = packets.length;
  if (!n) throw new MediaError('unreadable', 'The video has no frames.');
  if (packets[0].type !== 'key') throw new MediaError('unreadable', "The video doesn't start with a key frame, so it can't be decoded from the start.");

  let origin = Infinity;
  for (const p of packets) if (p.timestamp < origin) origin = p.timestamp;

  const order = Array.from({ length: n }, (_, d) => d).sort((a, b) => packets[a].timestamp - packets[b].timestamp || a - b);
  const decOfPres = Int32Array.from(order);
  const presOfDec = new Int32Array(n);
  order.forEach((d, i) => { presOfDec[d] = i; });

  const times = new Array(n);
  for (let i = 0; i < n; i++) times[i] = packets[decOfPres[i]].timestamp - origin;
  // a frame's length: its own duration, else the gap to the next (the last: to the one before)
  const lengths = new Array(n);
  for (let i = 0; i < n; i++) {
    const own = packets[decOfPres[i]].duration;
    lengths[i] = own > 0 ? own : (i + 1 < n ? times[i + 1] - times[i] : (i > 0 ? times[i] - times[i - 1] : 0));
  }
  let end = 0;
  for (let i = 0; i < n; i++) end = Math.max(end, times[i] + lengths[i]);
  if (!(end > 0)) throw new MediaError('unreadable', 'The video has no length.');

  // lastKey[d]: the storage index of the last key packet at or before d
  const lastKey = new Int32Array(n);
  for (let d = 0, k = 0; d < n; d++) { if (packets[d].type === 'key') k = d; lastKey[d] = k; }

  // the last presentation index with times[i] <= t
  const lastAtOrBefore = t => {
    let lo = 0, hi = n - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  };
  const us = t => Math.round(t * 1e6);

  return {
    count: n,
    /** frame start times in seconds, presentation order, the earliest at 0 */
    times,
    /** the span of the frames in seconds */
    duration: end,
    /** frames over duration: the average rate */
    fps: n / end,
    /** the packet's timestamp in the container, to find it again in the demuxer */
    rawTimestamp: d => packets[d].timestamp,
    /** a frame's timestamp in µs from 0, what the decoder's chunk and frame carry */
    timestampUs: i => us(times[i]),
    durationUs: i => us(lengths[i]),
    /** packet d's presentation index and frame i's packet */
    presOf: d => presOfDec[d],
    decOf: i => decOfPres[i],
    keyBefore: d => lastKey[d],
    /** the frame shown at t: the last starting at or before t, the first or last when t is outside */
    indexAt(t) {
      const i = lastAtOrBefore(t + SLACK);
      return i < 0 ? 0 : i;
    },
    /** the frames starting in [t0, t1], both ends in: {first, last}, or null when none */
    indexRange(t0, t1) {
      const last = lastAtOrBefore(t1 + SLACK);
      let lo = 0, hi = n;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] >= t0 - SLACK) hi = mid; else lo = mid + 1; }
      return last < lo || lo >= n ? null : { first: lo, last };
    },
    /**
     * The packets a decoder needs to give frames first..last: from the key packet
     * before the earliest-stored of them to the latest-stored of them.
     */
    plan(first, last) {
      let lo = Infinity, hi = -Infinity;
      for (let i = first; i <= last; i++) { const d = decOfPres[i]; if (d < lo) lo = d; if (d > hi) hi = d; }
      return { startDec: lastKey[lo], endDec: hi };
    },
  };
}
