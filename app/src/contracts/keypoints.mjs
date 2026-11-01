// The one keypoint format (docs/rules-core.md, principle 4): every pose model
// hands diagnostics.js COCO-17 [y, x, conf], in the frame's pixels, y pointing
// down; null when the model found nobody. Plain module, no DOM.
import { at, isNumber } from './common.mjs';

/** The joint order, as docs/fixture-data-contract.md gives it. */
export const COCO17 = Object.freeze([
  'nose', 'l_eye', 'r_eye', 'l_ear', 'r_ear', 'l_shoulder', 'r_shoulder',
  'l_elbow', 'r_elbow', 'l_wrist', 'r_wrist', 'l_hip', 'r_hip',
  'l_knee', 'r_knee', 'l_ankle', 'r_ankle',
]);

/**
 * One person's pose in one frame: 17 rows in COCO17's order, each
 * [y, x, conf]. y and x are the frame's pixels (not normalised), y pointing
 * down. A point may sit outside the frame: pose-detection 2.1.3 scales
 * MoveNet's normalised output by the image size without clamping
 * (movenet/detector.js), and ViTPose's crops can extend past an edge, so a
 * joint cut off by the frame is still a number. conf is the model's score,
 * 0 or more; it isn't capped at 1, since ViTPose's heatmap peaks go above it
 * (1.036 in global/example/lateral-raise-cable-1).
 * @typedef {Array<[number, number, number]>} Keypoints
 */

/**
 * @param {unknown} kp Keypoints, or null for "nobody in this frame".
 * @param {string} [path] the field's name in the errors
 * @returns {string[]} the errors, empty when valid
 */
export function validateKeypoints(kp, path = 'keypoints') {
  if (kp === null) return [];
  const errors = [];
  if (!Array.isArray(kp)) return [`${path}: must be 17 points [y, x, conf] or null`];
  if (kp.length !== COCO17.length) errors.push(`${path}: must have 17 points (COCO-17), has ${kp.length}`);
  kp.forEach((row, i) => {
    const p = at(path, i);
    if (!Array.isArray(row) || row.length !== 3) {
      errors.push(`${p}: must be [y, x, conf]`);
      return;
    }
    if (!isNumber(row[0])) errors.push(`${at(p, 0)}: y must be a finite number (pixels)`);
    if (!isNumber(row[1])) errors.push(`${at(p, 1)}: x must be a finite number (pixels)`);
    if (!isNumber(row[2]) || row[2] < 0) errors.push(`${at(p, 2)}: conf must be a finite number, 0 or more`);
  });
  return errors;
}

/**
 * An example: frame 0 of the committed track
 * tests/fixtures/global/example/lateral-raise-cable-1 (1080 × 1920),
 * its kept person, as ViTPose wrote it.
 * @type {Keypoints}
 */
export const KEYPOINTS_EXAMPLE = [
  [425.4705810546875, 588.7766723632812, 0.9791776537895203],
  [400.14703369140625, 597.0908203125, 0.9858118891716003],
  [401.7843017578125, 559.9976196289062, 0.9634394645690918],
  [406.3476867675781, 592.8729248046875, 0.6449061036109924],
  [405.58038330078125, 482.9411926269531, 0.9939411282539368],
  [547.115966796875, 643.5098876953125, 0.9292397499084473],
  [569.21826171875, 397.6668395996094, 0.8627942204475403],
  [740.3377685546875, 688.884033203125, 0.9464377760887146],
  [799.6593627929688, 372.4619140625, 0.9560491442680359],
  [912.7132568359375, 728.5947875976562, 0.9163668751716614],
  [995.5405883789062, 468.4159240722656, 0.9310523271560669],
  [945.6094360351562, 662.1105346679688, 0.8448410034179688],
  [960.0963134765625, 507.44482421875, 0.8414421677589417],
  [1249.530029296875, 626.8499145507812, 0.8905645608901978],
  [1266.5914306640625, 486.6988830566406, 0.8993047475814819],
  [1491.0887451171875, 589.4090576171875, 0.8675802946090698],
  [1544.969482421875, 443.8101501464844, 0.8994755744934082],
];
