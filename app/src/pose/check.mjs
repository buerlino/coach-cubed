// SPDX-License-Identifier: AGPL-3.0-or-later
// What the pose engine lets through (contract 1, app/src/contracts/): keypoints
// that are COCO-17 [y, x, conf] and in the frame's pixels. Both sides use it:
// the worker before it posts a result, the client before it believes one.
// Plain module, no DOM.
import { validateKeypoints } from '../contracts/keypoints.mjs';

// Below this a frame is too small for "0..1" to tell normalised from pixels.
const MIN_SIDE = 16;

/**
 * The errors in one frame's keypoints, empty when they are fit for the track.
 * Beyond contract 1's shape: a pose whose every coordinate lies in 0..1 on a
 * frame of hundreds of pixels is normalised (the model's own output, never
 * scaled), not pixels; diagnostics.js would score it as a pose a pixel wide.
 * @param {unknown} keypoints
 * @param {number} width the frame's upright width in pixels
 * @param {number} height
 * @returns {string[]}
 */
export function checkResultKeypoints(keypoints, width, height) {
  const errors = validateKeypoints(keypoints, 'keypoints');
  if (errors.length || keypoints === null) return errors;
  if (width >= MIN_SIDE && height >= MIN_SIDE) {
    let max = 0;
    for (const [y, x] of keypoints) max = Math.max(max, Math.abs(y), Math.abs(x));
    if (max > 0 && max <= 1) {
      errors.push(`keypoints: every coordinate is within 0..1, so they look normalised; pixels of a ${width}×${height} frame are expected`);
    }
  }
  return errors;
}
