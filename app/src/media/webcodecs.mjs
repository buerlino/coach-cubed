// The browser's side of the frame source: WebCodecs' decoder and chunk, the
// canvas turn that makes a frame upright, and a thumbnail as an ImageBitmap.
// Everything the frame source needs from the browser comes through the object
// this returns (`webcodecs`), so Node tests hand it a fake instead.
import { MediaError } from './media-error.mjs';

/**
 * @param {typeof globalThis} [g]
 * @returns {{
 *   isConfigSupported: (config: object) => Promise<{supported: boolean}>,
 *   createChunk: (init: object) => EncodedVideoChunk,
 *   createDecoder: (init: {output: Function, error: Function}) => VideoDecoder,
 *   rotate: (frame: VideoFrame, rotation: 90|180|270) => VideoFrame,
 *   toBitmap: (frame: VideoFrame, size: {width: number, height: number}) => Promise<ImageBitmap>,
 * }}
 */
export function browserWebCodecs(g = globalThis) {
  if (typeof g.VideoDecoder !== 'function' || typeof g.EncodedVideoChunk !== 'function') {
    throw new MediaError('no-webcodecs', "This browser can't decode video: it has no WebCodecs (VideoDecoder).");
  }
  // one canvas, redrawn for each frame: a VideoFrame made from a canvas is a copy of its pixels
  let canvas = null, ctx = null;
  return {
    isConfigSupported: config => g.VideoDecoder.isConfigSupported(config),
    createChunk: init => new g.EncodedVideoChunk(init),
    createDecoder: init => new g.VideoDecoder(init),

    // The file's rotation applied to the pixels, once: a clockwise turn by 90, 180
    // or 270°, so the VideoFrame handed on is upright with rotation 0 and every
    // consumer (the pose worker, a canvas, a <canvas> in the player) reads upright
    // pixels without knowing about the file's metadata.
    rotate(frame, rotation) {
      const w = frame.displayWidth, h = frame.displayHeight;
      const swap = rotation === 90 || rotation === 270;
      const cw = swap ? h : w, ch = swap ? w : h;
      if (typeof g.OffscreenCanvas !== 'function') throw new MediaError('decode-failed', "This browser can't turn a video upright (no OffscreenCanvas).");
      if (!canvas || canvas.width !== cw || canvas.height !== ch) {
        canvas = new g.OffscreenCanvas(cw, ch);
        ctx = canvas.getContext('2d');
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.translate(cw / 2, ch / 2);
      ctx.rotate(rotation * Math.PI / 180);   // canvas angles run clockwise (y points down)
      ctx.drawImage(frame, -w / 2, -h / 2);
      return new g.VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined });
    },

    toBitmap(frame, { width, height }) {
      return g.createImageBitmap(frame, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' });
    },
  };
}
