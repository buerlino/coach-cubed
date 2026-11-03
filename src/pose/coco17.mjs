// SPDX-License-Identifier: AGPL-3.0-or-later
// MediaPipe BlazePose-33 → COCO-17, the keypoint layout diagnostics.js reads.
// Entry k is the BlazePose landmark index for COCO-17 keypoint k (nose, eyes,
// ears, shoulders, elbows, wrists, hips, knees, ankles; left before right).
// This is the one copy: every 33→17 conversion imports it.
export const COCO17_FROM_MP33=[0,2,5,7,8,11,12,13,14,15,16,23,24,25,26,27,28];

// Normalised BlazePose landmarks ({x,y,visibility} in 0–1) → 17 × [y, x, conf]
// in pixels, the track format's order (y first). Visibility stands in for the
// detector confidence the diagnostics gate on.
export function toCoco17(landmarks,width,height){
  return COCO17_FROM_MP33.map(k=>{const p=landmarks[k];return [p.y*height,p.x*width,p.visibility??0];});
}
