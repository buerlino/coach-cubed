// SPDX-License-Identifier: AGPL-3.0-or-later
// The decode loop: chunks in, decoded frames out, in presentation order, over
// WebCodecs' VideoDecoder (or whatever stands in for it, see `webcodecs` in
// frame-source.mjs). An async generator, so the consumer's pace is the
// backpressure: the decoder is fed only while few decoded frames wait for the
// consumer, and a frame the consumer doesn't take is never decoded.
//
// It never hangs: a decoder error ends the stream with a MediaError, a decoder
// that stops answering ends it after `stallMs` with no progress, and an aborted
// signal ends it at once. Whatever the end, the decoder is closed and every
// frame still held is closed.
import { MediaError, asMediaError } from './media-error.mjs';

const closeQuietly = x => { try { x.close(); } catch { /* already closed */ } };

/**
 * @param {Object} o
 * @param {Object} o.webcodecs createDecoder, createChunk
 * @param {Object} o.config the decoder's configuration (codec string, description, coded size)
 * @param {AsyncIterable<{type: string, timestamp: number, duration: number, data: Uint8Array}>} o.chunks decode order, µs
 * @param {(timestampUs: number) => boolean} o.wants frames not wanted are closed here
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.stallMs] no progress for this long is an error
 * @param {number} [o.maxQueued] decoded frames waiting for the consumer, at most
 * @param {number} [o.maxQueueSize] chunks waiting for the decoder, at most
 * @returns {AsyncGenerator<VideoFrame>} the consumer closes each frame
 */
export async function* decodeFrames({ webcodecs, config, chunks, wants, signal, stallMs = 15000, maxQueued = 4, maxQueueSize = 8 }) {
  const ready = [];
  let error = null, flushed = false, closed = false, wake = null, decoder = null, iterator = null;
  const poke = () => { const w = wake; wake = null; if (w) w(); };
  const fail = e => { if (!error && !closed) error = asMediaError(e, 'decode-failed', 'The video decoder failed'); poke(); };
  const onAbort = () => { if (!error) error = new MediaError('closed', 'The video was closed.'); poke(); };

  // no progress (an output, a chunk taken, the flush done) for stallMs is a stall
  const waitForProgress = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      wake = null;
      reject(new MediaError('decode-stalled', `The video decoder did not answer for ${Math.round(stallMs / 1000 * 10) / 10} s, so the video was given up on.`));
    }, stallMs);
    wake = () => { clearTimeout(timer); resolve(); };
  });

  try {
    if (signal) {
      if (signal.aborted) throw new MediaError('closed', 'The video was closed.');
      signal.addEventListener('abort', onAbort);
    }
    try {
      decoder = webcodecs.createDecoder({
        output: frame => { if (closed || !wants(frame.timestamp)) closeQuietly(frame); else ready.push(frame); poke(); },
        error: fail,
      });
      if (decoder.addEventListener) decoder.addEventListener('dequeue', poke);
      decoder.configure(config);
    } catch (e) {
      throw asMediaError(e, 'decode-failed', "The video decoder couldn't be started");
    }
    iterator = chunks[Symbol.asyncIterator]();

    let feeding = true;
    for (;;) {
      if (error) throw error;
      while (feeding && decoder.decodeQueueSize < maxQueueSize && ready.length < maxQueued) {
        let next;
        try { next = await iterator.next(); } catch (e) {
          // a close() that disposed the file under this read already said why
          if (error) throw error;
          throw asMediaError(e, 'unreadable', "The video file couldn't be read");
        }
        if (error) throw error;
        if (next.done) {
          feeding = false;
          decoder.flush().then(
            () => { flushed = true; poke(); },
            e => { if (!closed) fail(e); else poke(); },
          );
          break;
        }
        try { decoder.decode(webcodecs.createChunk(next.value)); } catch (e) { throw asMediaError(e, 'decode-failed', 'The video decoder refused a chunk'); }
      }
      if (ready.length) { yield ready.shift(); continue; }
      if (flushed) break;
      await waitForProgress();
    }
    if (error) throw error;
  } finally {
    closed = true;
    wake = null;
    if (signal) signal.removeEventListener('abort', onAbort);
    if (decoder) closeQuietly(decoder);
    for (const f of ready.splice(0)) closeQuietly(f);
    if (iterator && iterator.return) iterator.return().catch(() => {});
  }
}
