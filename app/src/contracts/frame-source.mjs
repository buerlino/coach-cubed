// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract 5, a frame source: one video opened for reading (app/src/media/,
// s9: mediabunny demuxes, WebCodecs decodes). M1–M3 step through it and draw
// the filmstrip, A1 plays it, the job reads a range of it into the pose
// worker. Opened from a Blob: the File from the picker at import, or the
// stored cut read back from the store. Plain module, no DOM.
//
// Frames come out upright: the source applies the file's rotation, so a
// frame is width × height as `info` gives them, and the keypoints posed on
// it are in those pixels, y pointing down, as a track's meta.width and
// meta.height say. Times are seconds in the video's own timeline (0 is its
// first frame); a VideoFrame's timestamp is in microseconds, as WebCodecs has it.
// `frameTimes` lists every frame's start in that timeline, in presentation
// order (s35): M1–M3's one-frame steps and the job's frame count use them,
// never times made up from the frame rate.
import { at, checkFields, checkInteger, checkNumber, isNumber, isObject } from './common.mjs';

/** The rotations a video file can carry, in degrees clockwise. */
export const ROTATIONS = Object.freeze([0, 90, 180, 270]);

/**
 * What opening a video tells.
 * @typedef {Object} FrameSourceInfo
 * @property {number} duration seconds
 * @property {number} fps the average frame rate (frames over duration); a
 *   variable rate has its own timestamps, which are the authority
 * @property {number} width the upright frame's width in pixels, after rotation
 * @property {number} height the upright frame's height in pixels, after rotation
 * @property {0|90|180|270} rotation what the file asked for, already applied to the frames
 * @property {string} [codec] the codec string, e.g. 'avc1.64001f', for the "can't be read" message
 */

/**
 * An open video. Every frame it hands out is the caller's to close().
 * @typedef {Object} FrameSource
 * @property {FrameSourceInfo} info
 * @property {readonly number[]} frameTimes every frame's start time in seconds,
 *   in presentation order, from the first frame (frameTimes[0] is 0): finite and
 *   increasing. A variable rate's times are the file's own. frameAt(frameTimes[i])
 *   is frame i, so a one-frame step is the next entry.
 * @property {(t: number) => Promise<VideoFrame>} frameAt the frame shown at t
 *   seconds: the last one starting at or before t (decoded from the keyframe before it)
 * @property {(t0: number, t1: number) => AsyncIterable<VideoFrame>} frames
 *   every frame starting in [t0, t1], in order: a range as a stream, for the job
 * @property {(times: number[], opts: {height: number}) => Promise<ImageBitmap[]>} thumbnails
 *   one picture per time, `height` pixels high, for the filmstrip
 * @property {(t: number, opts: StepperOptions) => Promise<Stepper>} stepper
 *   M1–M3's one-frame steps (s38): a cache of the frames around a playhead,
 *   opened at the frame shown at t once that frame is held
 * @property {() => void} close frees the decoder and the file, and closes every stepper
 */

/**
 * The stepper's default budget (s38): at most this many frames and bytes held.
 * A frame is width × height × 4 bytes at the size the caller asks for, so the
 * frame count is the smaller of maxFrames and maxBytes over the frame's bytes.
 * 90 frames is three 1 s keyframe groups at 30 fps; 128 MiB is 34 frames of
 * 744 × 1320 (M1–M3's 248 × 440 px video at a pixel ratio of 3).
 */
export const STEPPER_BUDGET = Object.freeze({ maxFrames: 90, maxBytes: 128 * 1024 * 1024 });

/**
 * @typedef {Object} StepperOptions
 * @property {number} [width] the frames' width in pixels; with no height, the height keeps the upright aspect
 * @property {number} [height] the frames' height in pixels; with no width, the width keeps the upright aspect
 * @property {number} [maxFrames] frames held at most (STEPPER_BUDGET.maxFrames)
 * @property {number} [maxBytes] bytes held at most, at 4 a pixel (STEPPER_BUDGET.maxBytes)
 */

/**
 * Where a step landed.
 * @typedef {Object} StepperFrame
 * @property {number} index the frame's place in frameTimes
 * @property {number} time frameTimes[index], seconds
 * @property {ImageBitmap} frame upright, at the stepper's width × height. The
 *   stepper's, not the caller's: draw it, never close it; it stays valid until
 *   the next step or seek settles, or close()
 * @property {boolean} cached the frame was held when the step was asked (no wait for a decode)
 */

/**
 * The frames around a playhead, decoded once and kept, so a step is a lookup.
 * A refill runs in the background ahead of the steps, more frames on the side
 * the steps go; a step to a frame not held yet waits for it. A decoder error or
 * stall in the refill is the source's MediaError on the next step.
 * @typedef {Object} Stepper
 * @property {number} index the playhead's frame (frameTimes' index)
 * @property {number} time its time, seconds
 * @property {ImageBitmap} frame its picture (as StepperFrame.frame)
 * @property {number} width the frames' width in pixels
 * @property {number} height the frames' height in pixels
 * @property {{maxFrames: number, maxBytes: number, frameBytes: number, frames: number}} budget
 *   what was asked, a frame's bytes, and the frames that makes
 * @property {number} held frames held now
 * @property {number} bytes their bytes
 * @property {(delta?: number) => Promise<StepperFrame>} step `delta` frames on
 *   (an integer, 1 by default; negative steps back), held at the first and last frame
 * @property {(t: number) => Promise<StepperFrame>} seek to the frame shown at t seconds
 * @property {() => Promise<void>} settled resolves when the refill has nothing left to do
 * @property {() => void} close closes every frame held and stops the refill
 */

/**
 * @param {unknown} info
 * @returns {string[]} the errors, empty when valid
 */
export function validateFrameSourceInfo(info, path = '') {
  const p = k => path ? `${path}.${k}` : k;
  if (!isObject(info)) return [`${path || 'info'}: must be an object`];
  const errors = [];
  checkFields(errors, path, info, ['duration', 'fps', 'width', 'height', 'rotation'], ['codec']);
  checkNumber(errors, p('duration'), info.duration, { min: 0, above: true });
  checkNumber(errors, p('fps'), info.fps, { min: 0, above: true });
  checkInteger(errors, p('width'), info.width, 1);
  checkInteger(errors, p('height'), info.height, 1);
  if (!ROTATIONS.includes(info.rotation)) errors.push(`${p('rotation')}: must be one of ${ROTATIONS.join(', ')}`);
  if ('codec' in info && (typeof info.codec !== 'string' || !info.codec)) errors.push(`${p('codec')}: must be a non-empty string`);
  return errors;
}

/**
 * Checks a source's frame times: a non-empty array of finite seconds, the first
 * 0, each later than the one before. The first broken entry is named.
 * @param {unknown} times
 * @param {string} [path]
 * @returns {string[]} the errors, empty when valid
 */
export function validateFrameTimes(times, path = 'frameTimes') {
  if (!Array.isArray(times)) return [`${path}: must be an array of seconds (every frame's start, presentation order)`];
  if (!times.length) return [`${path}: must not be empty: an open video has a first frame`];
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (!isNumber(t)) return [`${at(path, i)}: must be a finite number (seconds)`];
    if (i === 0 && t !== 0) return [`${at(path, 0)}: must be 0: times are from the first frame`];
    if (i > 0 && !(t > times[i - 1])) return [`${at(path, i)}: must be later than ${at(path, i - 1)} (presentation order)`];
  }
  return [];
}

/**
 * Checks an open source's shape: its info, its frame times and its five methods.
 * @param {unknown} src
 * @returns {string[]} the errors, empty when valid
 */
export function validateFrameSource(src) {
  if (!src || typeof src !== 'object') return ['source: must be an object'];
  const errors = validateFrameSourceInfo(src.info, 'info');
  errors.push(...validateFrameTimes(src.frameTimes));
  for (const m of ['frameAt', 'frames', 'thumbnails', 'stepper', 'close']) {
    if (typeof src[m] !== 'function') errors.push(`${m}: must be a method`);
  }
  return errors;
}

/**
 * The example's video: the committed lateral raise's size and rate
 * (global/example/lateral-raise-cable-1: 1080 × 1920 at 25 fps, 75 frames);
 * the codec string is a sample.
 * @type {FrameSourceInfo}
 */
export const FRAME_SOURCE_INFO_EXAMPLE = { duration: 3, fps: 25, width: 1080, height: 1920, rotation: 0, codec: 'avc1.64001f' };

/**
 * A stand-in source with no video behind it: frames are plain objects shaped
 * like VideoFrames (displayWidth, displayHeight, timestamp in µs, close()),
 * thumbnails like ImageBitmaps. For tests of whatever reads a frame source.
 * @param {FrameSourceInfo} [info]
 * @returns {FrameSource}
 */
export function exampleFrameSource(info = FRAME_SOURCE_INFO_EXAMPLE) {
  const n = Math.round(info.duration * info.fps);
  const frame = i => {
    const f = {
      timestamp: Math.round(i / info.fps * 1e6), duration: Math.round(1e6 / info.fps),
      displayWidth: info.width, displayHeight: info.height,
      close() { f.displayWidth = 0; f.displayHeight = 0; },
    };
    return f;
  };
  // the index of the last frame starting at or before t (1 µs of slack for float times)
  const indexAt = t => Math.min(n - 1, Math.max(0, Math.floor(t * info.fps + 1e-6)));
  return {
    info: { ...info },
    frameTimes: Object.freeze(Array.from({ length: n }, (_, i) => i / info.fps)),
    async frameAt(t) { return frame(indexAt(t)); },
    async *frames(t0, t1) {
      for (let i = Math.ceil(t0 * info.fps - 1e-6); i < n && i / info.fps <= t1 + 1e-9; i++) if (i >= 0) yield frame(i);
    },
    async thumbnails(times, { height }) {
      const width = Math.round(height * info.width / info.height);
      return times.map(() => { const b = { width, height, close() { b.width = 0; b.height = 0; } }; return b; });
    },
    // every frame "held" at once (no refill), each made when first shown
    async stepper(t, { width: w, height: h, maxFrames = STEPPER_BUDGET.maxFrames, maxBytes = STEPPER_BUDGET.maxBytes } = {}) {
      const height = h ?? Math.round(w * info.height / info.width), width = w ?? Math.round(h * info.width / info.height);
      const held = new Map();
      const bitmap = i => {
        if (!held.has(i)) { const b = { width, height, close() { b.width = 0; b.height = 0; } }; held.set(i, b); }
        return held.get(i);
      };
      let index = indexAt(t), closed = false;
      const frames = Math.min(maxFrames, Math.floor(maxBytes / (width * height * 4)));
      const at = async i => {
        if (closed) throw new Error('The video was closed.');
        index = Math.min(n - 1, Math.max(0, i));
        for (const k of [...held.keys()]) if (k !== index && held.size >= frames) { held.get(k).close(); held.delete(k); }
        return { index, time: index / info.fps, frame: bitmap(index), cached: true };
      };
      await at(index);
      return {
        get index() { return index; },
        get time() { return index / info.fps; },
        get frame() { return held.get(index); },
        width, height,
        budget: { maxFrames, maxBytes, frameBytes: width * height * 4, frames },
        get held() { return held.size; },
        get bytes() { return held.size * width * height * 4; },
        step: (delta = 1) => at(index + delta),
        seek: s => at(indexAt(s)),
        async settled() {},
        close() { closed = true; for (const b of held.values()) b.close(); held.clear(); },
      };
    },
    close() {},
  };
}
