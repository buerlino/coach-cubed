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
 * @property {() => void} close frees the decoder and the file
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
 * Checks an open source's shape: its info, its frame times and its four methods.
 * @param {unknown} src
 * @returns {string[]} the errors, empty when valid
 */
export function validateFrameSource(src) {
  if (!src || typeof src !== 'object') return ['source: must be an object'];
  const errors = validateFrameSourceInfo(src.info, 'info');
  errors.push(...validateFrameTimes(src.frameTimes));
  for (const m of ['frameAt', 'frames', 'thumbnails', 'close']) {
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
    close() {},
  };
}
