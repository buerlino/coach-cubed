// The capture's rolling buffer (package c27, D2): the encoded chunks of the last
// `bufferS` seconds, in memory, as whole groups of pictures (a keyframe and the
// chunks after it). No decoder and no encoder here: a snapshot is a stream copy of
// the chunks into an MP4 (mp4-writer.mjs), and a follower reads the chunks as they are.
//
// Times are µs on the recording's clock (0 at its first frame). A chunk belongs to a
// segment: one decoder config and one rotation. A snapshot never spans two segments.
import { codecOf, createMp4Writer, packetOf } from './mp4-writer.mjs';

// Compacted when this many dropped chunks sit before the head.
const COMPACT_AT = 1024;
const SLACK_US = 1;

/**
 * @typedef {Object} RingChunk
 * @property {'key'|'delta'} type
 * @property {number} ts µs on the recording's clock
 * @property {number} dur µs, 0 when the encoder gave none
 * @property {Uint8Array} data
 * @property {{decoderConfig: object, rotation: number, key: string}} seg
 */

/**
 * @param {{bufferS: number}} o
 */
export function createRing({ bufferS }) {
  if (!(bufferS > 0)) throw new TypeError('the ring needs bufferS, a number of seconds above 0');
  const bufferUs = bufferS * 1e6;
  /** @type {RingChunk[]} */
  let chunks = [];
  let head = 0;          // the oldest chunk still held
  let firstSeq = 0;      // its sequence number (chunks are numbered from 0 as they come)
  let keys = [];         // indexes into `chunks` of the key chunks held, oldest first
  let keyHead = 0;
  let bytes = 0;
  let closed = false;
  const waiters = new Set();
  const wakeAll = () => { for (const w of [...waiters]) w(); };

  const size = () => chunks.length - head;
  const at = seq => chunks[head + seq - firstSeq];
  const lastSeq = () => firstSeq + size() - 1;

  function dropTo(index) {   // drop every chunk before chunks[index]
    for (let i = head; i < index; i++) bytes -= chunks[i].data.byteLength;
    firstSeq += index - head;
    head = index;
    if (head >= COMPACT_AT && head * 2 >= chunks.length) {
      chunks = chunks.slice(head);
      keys = keys.slice(keyHead).map(k => k - head);
      keyHead = 0;
      head = 0;
    }
  }

  /** The index of the last key chunk at or before `ts` within the segment `seg` (or the segment's first key). */
  function keyAtOrBefore(ts, seg) {
    let found = -1;
    for (let k = keys.length - 1; k >= keyHead; k--) {
      const c = chunks[keys[k]];
      if (seg && c.seg !== seg) break;
      found = keys[k];
      if (c.ts <= ts + SLACK_US) break;
    }
    return found;
  }

  const ring = {
    get heldS() { return size() ? (chunks[chunks.length - 1].ts - chunks[head].ts) / 1e6 : 0; },
    get bytes() { return bytes; },
    get size() { return size(); },
    get newest() { return size() ? chunks[chunks.length - 1] : null; },

    /** Adds a chunk; then drops whole groups from the front while the next group still starts bufferS or more behind the newest chunk. */
    push(chunk) {
      if (closed) return;
      if (!size() && chunk.type !== 'key') return;   // a group starts with its keyframe
      chunks.push(chunk);
      bytes += chunk.data.byteLength;
      if (chunk.type === 'key') keys.push(chunks.length - 1);
      while (keys.length - keyHead > 1 && chunk.ts - chunks[keys[keyHead + 1]].ts >= bufferUs) {
        keyHead++;
        dropTo(keys[keyHead]);
      }
      wakeAll();
    },

    /**
     * The last `seconds` as an MP4: from the keyframe at or before the newest chunk's time minus
     * `seconds` (the segment's first keyframe if the ring is shorter), to the newest chunk; times from 0.
     * @returns {Promise<{blob: Blob, duration: number, start: number}|null>} null when nothing is held
     */
    async snapshot(seconds) {
      if (!(typeof seconds === 'number' && seconds > 0)) throw new TypeError('snapshot(seconds) needs a number of seconds above 0');
      const newest = ring.newest;
      if (!newest) return null;
      const from = keyAtOrBefore(newest.ts - seconds * 1e6, newest.seg);
      const list = chunks.slice(from);   // a copy: the ring goes on while the MP4 is written
      const base = list[0].ts;
      const intervals = list.map((c, i) => (i + 1 < list.length ? list[i + 1].ts - c.ts : 0));
      const lastDur = list.at(-1).dur > 0 ? list.at(-1).dur : (list.length > 1 ? intervals[list.length - 2] : 0);
      intervals[list.length - 1] = lastDur;
      const { decoderConfig, rotation } = newest.seg;
      const writer = await createMp4Writer({ codec: codecOf(decoderConfig.codec), rotation });
      for (const [i, c] of list.entries()) {
        await writer.add(packetOf(c.data, c.type, (c.ts - base) / 1e6, Math.max(0, intervals[i]) / 1e6), decoderConfig);
      }
      return { blob: await writer.finish(), duration: (newest.ts + lastDur - base) / 1e6, start: base / 1e6 };
    },

    /**
     * The chunks from the keyframe at or before `t` (seconds), then each new one as it comes.
     * A follower the ring has overtaken goes on from the oldest keyframe held. Ends at close(),
     * or when the caller stops reading (its return()).
     * @param {number} t seconds on the recording's clock
     * @returns {AsyncGenerator<{type: string, timestamp: number, duration: number, data: Uint8Array, decoderConfig?: object}>}
     *   timestamp and duration in µs; decoderConfig on the first chunk and again at each change of segment or gap
     */
    async *follow(t) {
      if (closed) return;
      let next = null, lastSeg = null, wake = null;
      const waiter = () => { const w = wake; wake = null; if (w) w(); };
      waiters.add(waiter);
      try {
        for (;;) {
          if (closed) return;
          if (next === null && size()) {
            const i = keyAtOrBefore(Number.isFinite(t) ? t * 1e6 : -Infinity, null);
            next = firstSeq + (i < 0 ? 0 : i - head);
          }
          if (next !== null && next < firstSeq) { next = firstSeq; lastSeg = null; }   // overtaken: the oldest group held
          if (next !== null && next <= lastSeq()) {
            const c = at(next++);
            const out = { type: c.type, timestamp: c.ts, duration: c.dur, data: c.data };
            if (c.seg !== lastSeg) out.decoderConfig = c.seg.decoderConfig;
            lastSeg = c.seg;
            yield out;
            continue;
          }
          await new Promise(res => { wake = res; });
        }
      } finally {
        waiters.delete(waiter);
      }
    },

    /** Drops every chunk and ends every follower. */
    close() {
      closed = true;
      chunks = []; keys = []; head = 0; keyHead = 0; bytes = 0;
      wakeAll();
    },
  };
  return ring;
}
