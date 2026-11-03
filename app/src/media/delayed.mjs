// SPDX-License-Identifier: AGPL-3.0-or-later
// R3b's delayed frames (package d29b, milestone B; D2: the delayed view as a setting beside the replay): the
// capture's chunks, followed from `delayS` behind its newest frame (capture.mjs's `follow` and `liveUs`), decoded
// with the decode loop (decode.mjs), and handed to the screen once each frame's time has come: its capture time
// plus the delay. Plain module: no DOM, no decoder of its own (`webcodecs` is webcodecs.mjs's, or a test's fake).
//
//   const frames = createDelayedFrames({ source: capture, webcodecs, delayS: 10 });
//   const e = frames.take();     // each screen refresh: the newest frame that is due, or null; the caller closes e.frame
//   frames.setDelay(5);          // starts again at the new delay
//   frames.close();              // every frame held and the decoder closed; the recording goes on
//
// - A frame is handed out once the recording's clock (`liveUs`) has reached its time plus the delay, so the delay on
//   screen stays within a frame interval of the setting while the decoder keeps up. Frames due together: the newest
//   is handed out, the older ones are closed (a screen that refreshes slower than the camera).
// - Few frames wait: the decode loop holds at most `maxHeld` decoded frames and feeds the decoder a few chunks
//   ahead; the rest of the delay stays as chunks in the ring, never as decoded frames.
// - A decoder that falls behind (its newest frame more than `maxLagUs` behind where the view should be: a slow
//   decoder, a hidden page) skips to the next keyframe at or after that point instead of drifting: the chunks in
//   between are not decoded, the frames already decoded are closed.
// - A new decoder config in the ring (the camera came back at another size) configures a new decoder; each frame
//   carries its segment's rotation for the screen to turn it.
import { decodeFrames } from './decode.mjs';

/** The newest decoded frame may be this far behind where the view should be before it skips to the next keyframe. */
export const MAX_LAG_US = 300000;
/** Decoded frames held for the screen, and in the decode loop, at most (each). */
export const MAX_HELD = 2;
/** Chunks fed to the decoder ahead of its output, at most. */
const MAX_FED = 3;

const closeQuietly = x => { try { x.close(); } catch { /* already closed */ } };
const plain = c => ({ type: c.type, timestamp: c.timestamp, duration: c.duration, data: c.data });

/**
 * @param {Object} o
 * @param {{follow: (t: number) => AsyncIterable<object>, liveUs: () => number|null}} o.source the capture
 *   (capture.mjs): `follow(t)` its chunks from the keyframe at or before t seconds, `liveUs()` its clock now
 * @param {Object} o.webcodecs createDecoder, createChunk (webcodecs.mjs's browserWebCodecs, or a fake)
 * @param {number} o.delayS seconds behind the capture
 * @param {number} [o.maxLagUs]
 * @param {number} [o.maxHeld]
 */
export function createDelayedFrames({ source, webcodecs, delayS, maxLagUs = MAX_LAG_US, maxHeld = MAX_HELD }) {
  if (!(delayS > 0)) throw new TypeError('the delayed view needs delayS, a number of seconds above 0');
  let delay = delayS;
  let run = null;
  let closed = false;
  let error = null;
  const stats = { shown: 0, dropped: 0, skips: 0, runs: 0 };

  const delayUs = () => Math.round(delay * 1e6);
  const wake = r => { const w = r.wake; r.wake = null; if (w) w(); };

  function stop(r) {
    if (!r || r.stopped) return;
    r.stopped = true;
    r.resolveStopped();
    r.abort.abort();
    for (const e of r.held.splice(0)) closeQuietly(e.frame);
    wake(r);
  }

  /** A run: one follower from the target on, through as many decoders as the ring has segments. */
  function start() {
    const live = source.liveUs();
    const target = live === null || live === undefined ? -Infinity : live - delayUs();
    // floorUs: frames before it are not wanted. It moves with the chunks up to the start point, so the first frame
    // kept is the one at or before it (due now); after a skip it is the skip's point.
    const r = {
      held: [], startUs: target, floorUs: -Infinity, newestUs: null, skipToUs: null, shown: false,
      stopped: false, wake: null, abort: new AbortController(), resolveStopped: null,
    };
    r.whenStopped = new Promise(res => { r.resolveStopped = res; });
    run = r;
    stats.runs++;
    pump(r, target).catch(e => {
      if (!r.stopped && run === r) error = e;
    }).finally(() => {
      for (const e of r.held.splice(0)) closeQuietly(e.frame);
    });
  }

  async function pump(r, target) {
    const followed = source.follow(Number.isFinite(target) ? target / 1e6 : -Infinity);
    const it = followed[Symbol.asyncIterator]();
    const next = async () => {
      const res = await Promise.race([it.next(), r.whenStopped]);
      return res && !res.done && !r.stopped ? res.value : null;
    };
    try {
      let first = await next();
      while (first && !r.stopped) {
        if (!first.decoderConfig) throw new Error('The recording gave a chunk without its decoder config.');
        const rotation = first.rotation ?? 0;
        let carry = null;
        // one segment's chunks; the chunk that starts the next one is carried over to the next decoder
        const segment = async function* chunksOf(c) {
          while (c) {
            if (r.skipToUs !== null && c.type === 'key' && c.timestamp >= r.skipToUs) r.skipToUs = null;
            if (r.skipToUs === null) {
              if (c.timestamp <= r.startUs) r.floorUs = c.timestamp;
              yield plain(c);
            }
            c = await next();
            if (c && c.decoderConfig) { carry = c; return; }
          }
        };
        const frames = decodeFrames({
          webcodecs,
          config: { ...first.decoderConfig, optimizeForLatency: true },
          chunks: segment(first),
          wants: ts => !r.stopped && ts >= r.floorUs,
          signal: r.abort.signal,
          maxQueued: maxHeld,
          maxQueueSize: MAX_FED,
        });
        try {
          for await (const f of frames) {
            if (r.stopped || f.timestamp < r.floorUs) { closeQuietly(f); stats.dropped++; continue; }
            // a frame that is due already makes every older one useless: they are closed now, not held
            const live = source.liveUs();
            if (live !== null && live !== undefined && f.timestamp <= live - delayUs()) {
              while (r.held.length && r.held[0].timestamp < f.timestamp) { closeQuietly(r.held.shift().frame); stats.dropped++; }
            }
            r.held.push({ frame: f, timestamp: f.timestamp, rotation });
            r.newestUs = f.timestamp;
            while (!r.stopped && r.held.length >= maxHeld) await new Promise(res => { r.wake = res; });
            if (r.stopped) break;
          }
        } catch (e) {
          if (!r.stopped) throw e;   // a stop aborts the decode loop: that is no error
        }
        first = r.stopped ? null : carry;
      }
    } finally {
      Promise.resolve(it.return ? it.return() : null).catch(() => {});
    }
  }

  start();

  return {
    /** The delay now, in seconds. */
    get delayS() { return delay; },
    /** The decoder's or the recording's error that ended the view, else null. */
    get error() { return error; },
    /** Counts: frames handed out, frames decoded and never handed out, skips to a keyframe, runs started. */
    get stats() { return { ...stats }; },

    /**
     * The newest frame whose capture time plus the delay has come, or null. Older due frames are closed. The caller
     * draws `frame` and closes it.
     * @returns {{frame: VideoFrame, timestamp: number, rotation: number, behindS: number}|null}
     */
    take() {
      const r = run;
      if (closed || !r) return null;
      const live = source.liveUs();
      if (live === null || live === undefined) return null;
      const target = live - delayUs();
      // (only once this run has shown a frame: before that the decoder is still coming up from the keyframe)
      if (r.shown && r.newestUs !== null && r.skipToUs === null && target - r.newestUs > maxLagUs) {
        // fallen behind: what is decoded is stale; the decoder goes on from the next keyframe
        for (const e of r.held.splice(0)) { closeQuietly(e.frame); stats.dropped++; }
        r.floorUs = target;
        r.startUs = -Infinity;
        r.skipToUs = target;
        r.newestUs = null;
        r.shown = false;
        stats.skips++;
        wake(r);
        return null;
      }
      let out = null;
      while (r.held.length && r.held[0].timestamp <= target) {
        const e = r.held.shift();
        if (out) { closeQuietly(out.frame); stats.dropped++; }
        out = e;
      }
      if (!out) return null;
      r.shown = true;
      wake(r);
      stats.shown++;
      return { frame: out.frame, timestamp: out.timestamp, rotation: out.rotation, behindS: (live - out.timestamp) / 1e6 };
    },

    /** A new delay: the view starts again that far behind the capture. */
    setDelay(s) {
      if (!(s > 0)) throw new TypeError('setDelay(s) needs a number of seconds above 0');
      if (closed || s === delay) return;
      delay = s;
      error = null;
      stop(run);
      start();
    },

    /** Every frame held and the decoder closed; the follower let go. The capture records on. */
    close() {
      if (closed) return;
      closed = true;
      stop(run);
      run = null;
    },
  };
}
