// SPDX-License-Identifier: AGPL-3.0-or-later
// pose-detection's MoveNet keypoints -> COCO-17 [y, x, conf] (principle 4).
// Plain module, no DOM.

/** The names pose-detection gives MoveNet's 17 points, in COCO-17's order. */
export const MOVENET_NAMES = Object.freeze([
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear', 'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
]);

/**
 * @param {Array<{x: number, y: number, score?: number, name?: string}>} points
 *   one pose's keypoints, x and y in the image's pixels (the detector scales them)
 * @returns {Array<[number, number, number]>}
 * @throws {Error} when there aren't 17, or a name isn't the one COCO-17 has at that place
 */
export function toCoco17(points) {
  if (!Array.isArray(points) || points.length !== MOVENET_NAMES.length) {
    throw new Error(`MoveNet gave ${Array.isArray(points) ? points.length : 'no'} keypoints, not 17`);
  }
  return points.map((p, i) => {
    if (p.name !== undefined && p.name !== MOVENET_NAMES[i]) {
      throw new Error(`keypoint ${i} is "${p.name}", COCO-17 has "${MOVENET_NAMES[i]}" there`);
    }
    return [p.y, p.x, p.score ?? 0];
  });
}
