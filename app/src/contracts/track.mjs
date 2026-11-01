// The track: one lift's keypoints, frame by frame, in the fixture format
// (docs/fixture-data-contract.md, `<stem>.track.json`), so the app's tracks,
// the committed fixtures and the dev server's output read the same, and
// diagnostics.js scores any of them. A stored lift keeps one as its
// track.json (stored-lift.mjs); the analysis job writes it from the pose
// worker's results with trackFromFrames(). Plain module, no DOM.
import { at, checkInteger, checkNumber, isObject, isNumber } from './common.mjs';
import { validateKeypoints } from './keypoints.mjs';

/**
 * The person id the app's own tracks use. MoveNet SinglePose tracks one
 * person, so there is one id; the fixture format keys a frame by it and
 * diagnostics.js's computeResults() takes it as `personId`.
 */
export const APP_PERSON_ID = '0';

/** COCO-17's bone pairs, as every committed track's meta.skeleton has them. */
export const COCO17_SKELETON = Object.freeze([
  [15, 13], [13, 11], [16, 14], [14, 12], [11, 12], [5, 11], [6, 12], [5, 6], [5, 7], [6, 8],
  [7, 9], [8, 10], [1, 2], [0, 1], [0, 2], [1, 3], [2, 4], [0, 5], [0, 6],
].map(p => Object.freeze(p)));

/**
 * The fixture format. Frame keys are decimal strings; each frame holds the
 * kept person's Keypoints under its id, or nothing (`{}`) when nobody was
 * found. Older committed tracks carry more meta (`equipment`…): extra meta
 * fields are allowed, the ones below are checked.
 * @typedef {Object} Track
 * @property {Object<string, Object<string, import('./keypoints.mjs').Keypoints>>} keypoints
 * @property {TrackMeta} meta
 */

/**
 * @typedef {Object} TrackMeta
 * @property {number} fps the source's frame rate
 * @property {number} frame_count frames in the source
 * @property {number} frames_processed frames posed: frame_indices' length
 * @property {number} frame_stride 1: every frame
 * @property {number} width the frame's width in pixels, which x is in
 * @property {number} height the frame's height in pixels, which y is in
 * @property {number[]} frame_indices which frames were posed, in order
 * @property {number[]} [frame_times_ms] each posed frame's time (ms); the
 *   authority on timing when present (the app always writes it)
 * @property {Array<[number, number]>} [skeleton] COCO17_SKELETON
 * @property {{kept: string, kept_frames: number, dropped: Array}} tracks
 *   the kept person's id and how many frames hold it
 */

/**
 * One posed frame, as the job collects them from the pose worker.
 * @typedef {Object} TrackFrame
 * @property {number} index the frame's index in the source
 * @property {number} tMs its time in ms (the decoder's timestamp)
 * @property {import('./keypoints.mjs').Keypoints|null} keypoints
 */

/**
 * @param {unknown} track
 * @returns {string[]} the errors, empty when valid
 */
export function validateTrack(track) {
  const errors = [];
  if (!isObject(track)) return ['track: must be an object { keypoints, meta }'];
  for (const k of ['keypoints', 'meta']) if (!(k in track)) errors.push(`${k}: missing`);
  const meta = track.meta;
  let kept = null, indices = null;
  if (!isObject(meta)) {
    if (meta !== undefined) errors.push('meta: must be an object');
  } else {
    checkInteger(errors, 'meta.width', meta.width, 1);
    checkInteger(errors, 'meta.height', meta.height, 1);
    checkNumber(errors, 'meta.fps', meta.fps, { min: 0, above: true });
    checkInteger(errors, 'meta.frame_count', meta.frame_count, 0);
    checkInteger(errors, 'meta.frame_stride', meta.frame_stride, 1);
    checkInteger(errors, 'meta.frames_processed', meta.frames_processed, 0);
    if (!Array.isArray(meta.frame_indices) || !meta.frame_indices.every(i => Number.isInteger(i) && i >= 0)) {
      errors.push('meta.frame_indices: must be a list of frame indices');
    } else {
      indices = meta.frame_indices;
      if (indices.length !== meta.frames_processed) {
        // they disagree: name both
        errors.push(`meta.frames_processed: is ${meta.frames_processed}, but meta.frame_indices has ${indices.length}`);
        errors.push(`meta.frame_indices: has ${indices.length} frames, but meta.frames_processed is ${meta.frames_processed}`);
      }
      if (indices.some((v, i) => i > 0 && v <= indices[i - 1])) errors.push('meta.frame_indices: must be increasing');
    }
    if (meta.frame_times_ms !== undefined) {
      if (!Array.isArray(meta.frame_times_ms)) errors.push('meta.frame_times_ms: must be a list of times (ms)');
      else {
        if (indices && meta.frame_times_ms.length !== indices.length) {
          errors.push(`meta.frame_times_ms: has ${meta.frame_times_ms.length} times for ${indices.length} frames`);
        }
        meta.frame_times_ms.forEach((v, i) => {
          if (!isNumber(v)) errors.push(`${at('meta.frame_times_ms', i)}: must be a finite number`);
        });
      }
    }
    if (!isObject(meta.tracks)) errors.push('meta.tracks: must be an object with the kept person\'s id');
    else if (typeof meta.tracks.kept !== 'string' || !meta.tracks.kept) errors.push('meta.tracks.kept: must be the kept person\'s id (a string)');
    else kept = meta.tracks.kept;
  }
  const kp = track.keypoints;
  if (!isObject(kp)) {
    errors.push('keypoints: must be an object keyed by frame index');
    return errors;
  }
  const known = indices ? new Set(indices.map(String)) : null;
  for (const [key, frame] of Object.entries(kp)) {
    const p = at('keypoints', key);
    if (!/^(0|[1-9][0-9]*)$/.test(key)) { errors.push(`${p}: frame keys are frame indices as strings`); continue; }
    if (known && !known.has(key)) errors.push(`${p}: not in meta.frame_indices`);
    if (!isObject(frame)) { errors.push(`${p}: must be an object keyed by person id`); continue; }
    for (const [person, points] of Object.entries(frame)) {
      if (kept !== null && person !== kept) errors.push(`${at(p, person)}: only the kept person (${kept}) is stored`);
      if (points === null) errors.push(`${at(p, person)}: a frame with nobody holds no person, not null`);
      else errors.push(...validateKeypoints(points, at(p, person)));
    }
  }
  return errors;
}

/**
 * The track's posed frames in order, each with its time and the kept
 * person's keypoints (null where the frame holds nobody). Times come from
 * frame_times_ms, or index / fps without it.
 * @param {Track} track
 * @returns {TrackFrame[]}
 */
export function framesFromTrack(track) {
  const { meta } = track;
  const kept = meta.tracks.kept;
  return meta.frame_indices.map((index, i) => {
    const frame = track.keypoints[String(index)];
    const tMs = meta.frame_times_ms ? meta.frame_times_ms[i] : index / meta.fps * 1000;
    return { index, tMs, keypoints: frame && frame[kept] ? frame[kept] : null };
  });
}

/**
 * Builds a track from posed frames. `meta` gives everything but the frames:
 * what the frames say (frame_indices, frame_times_ms, frames_processed,
 * tracks.kept_frames) is written from them, the rest is kept as given.
 * trackFromFrames(framesFromTrack(t), t.meta) is t again.
 * @param {TrackFrame[]} frames in order
 * @param {TrackMeta} meta tracks.kept names the person
 * @returns {Track}
 */
export function trackFromFrames(frames, meta) {
  const person = meta.tracks.kept;
  const keypoints = {};
  for (const f of frames) keypoints[String(f.index)] = f.keypoints ? { [person]: f.keypoints } : {};
  return {
    keypoints,
    meta: {
      ...meta,
      frames_processed: frames.length,
      frame_indices: frames.map(f => f.index),
      frame_times_ms: frames.map(f => f.tMs),
      tracks: { ...meta.tracks, kept: person, kept_frames: frames.filter(f => f.keypoints).length },
    },
  };
}

/**
 * The meta of a track the app makes: every frame posed (stride 1), one person
 * (APP_PERSON_ID), the frame's size, which the keypoints are in.
 * @param {{fps: number, frameCount: number, width: number, height: number}} source
 * @returns {TrackMeta}
 */
export function appTrackMeta({ fps, frameCount, width, height }) {
  return {
    fps, frame_count: frameCount, frames_processed: 0, frame_stride: 1, width, height,
    frame_indices: [], frame_times_ms: [], skeleton: COCO17_SKELETON.map(p => [...p]),
    tracks: { kept: APP_PERSON_ID, kept_frames: 0, dropped: [] },
  };
}
