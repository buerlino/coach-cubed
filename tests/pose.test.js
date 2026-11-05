// SPDX-License-Identifier: AGPL-3.0-or-later
// In-browser pose (src/pose/): the BlazePose-33 → COCO-17 mapping that every
// on-device track goes through before diagnostics.js scores it.
const test = require('node:test'), assert = require('node:assert/strict');
const coco17 = import('../src/pose/coco17.mjs');

// BlazePose landmark index → name, for the 17 points COCO-17 keeps.
const BLAZEPOSE = {0: 'nose', 2: 'left_eye', 5: 'right_eye', 7: 'left_ear', 8: 'right_ear',
  11: 'left_shoulder', 12: 'right_shoulder', 13: 'left_elbow', 14: 'right_elbow',
  15: 'left_wrist', 16: 'right_wrist', 23: 'left_hip', 24: 'right_hip',
  25: 'left_knee', 26: 'right_knee', 27: 'left_ankle', 28: 'right_ankle'};
const COCO17 = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
  'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'];

test('pose: every COCO-17 keypoint maps to the BlazePose landmark of the same name', async () => {
  const {COCO17_FROM_MP33} = await coco17;
  assert.deepEqual(COCO17_FROM_MP33.map(k => BLAZEPOSE[k]), COCO17);
});

test('pose: toCoco17 gives 17 × [y, x, conf] in pixels, y first', async () => {
  const {toCoco17} = await coco17;
  const landmarks = Array.from({length: 33}, (_, i) => ({x: i / 100, y: i / 50, visibility: i / 33}));
  delete landmarks[0].visibility;
  const points = toCoco17(landmarks, 1000, 500);
  assert.equal(points.length, 17);
  assert.deepEqual(points[0], [0, 0, 0], 'missing visibility reads as confidence 0');
  assert.deepEqual(points[5], [11 / 50 * 500, 11 / 100 * 1000, 11 / 33], 'left shoulder is BlazePose 11');
  assert.deepEqual(points[16], [28 / 50 * 500, 28 / 100 * 1000, 28 / 33], 'right ankle is BlazePose 28');
});
