// SPDX-License-Identifier: AGPL-3.0-or-later
// MoveNet SinglePose Thunder on TF.js, through pose-detection, in the worker.
// Copied from pose-bench's engines.mjs (the TF.js path) and trimmed: one model,
// no ONNX, no model choice. Runs where there is a WebGL context for the
// bundle: a worker's OffscreenCanvas.
//
// - The bundle (app/vendor/tfjs/, built by tools/build-tfjs.mjs) and the
//   weights (app/models/, fetched by tools/fetch-models.sh) are read by URLs
//   relative to this file, so the same code runs from app/ and from dist/.
// - MoveNet crops each frame from the last pose (pose-detection's own state in
//   the detector); the engine has no other state. reset() clears it
//   (detector.reset()), so a new clip's first frame starts from no previous
//   pose, with the model and its compiled shaders kept. Its keypoint smoothing
//   is off: src/track/ smooths, and the raw track should be the model's.
// - A blank frame is run once at init, so the first real frames don't pay for
//   compiling the model's shaders.
import { toCoco17 } from './coco17.mjs';

// WebGPU and the one-thread WASM backend come later (docs/app-plan.md).
const BUNDLES = Object.freeze({
  webgl: new URL('../../vendor/tfjs/tfjs-webgl.mjs', import.meta.url).href,
});
const MODEL_URL = new URL('../../models/movenet-thunder-4/model.json', import.meta.url).href;

// The warm-up frame's side. The model's own input is 256 × 256; the real
// frames' sizes are not known at init, so the shaders that depend on the
// frame's size (the crop's) may still compile on the first real frame.
const WARMUP_SIDE = 256;

const ESTIMATION = Object.freeze({ maxPoses: 1, flipHorizontal: false });

/**
 * @param {string} backend 'webgl'
 * @returns {Promise<{info: {model: string, backend: string, runtime: string},
 *   estimate: (frame: VideoFrame, tMs: number) => Promise<Array<[number, number, number]>|null>,
 *   reset: () => void}>}
 */
export async function loadMoveNet(backend) {
  const bundle = BUNDLES[backend];
  if (!bundle) throw new Error(`TF.js backend ${backend} is not in this app yet (webgl is)`);
  const { tf, poseDetection } = await import(bundle);
  if (!(await tf.setBackend(backend))) throw new Error(`TF.js backend ${backend} unavailable`);
  await tf.ready();
  if (tf.getBackend() !== backend) throw new Error(`TF.js backend ${backend} unavailable (running on ${tf.getBackend()})`);

  const detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
    modelType: poseDetection.movenet.modelType.SINGLEPOSE_THUNDER,
    enableSmoothing: false,
    modelUrl: MODEL_URL,
  });

  // Every image goes through an ImageBitmap: tf.browser.fromPixels takes
  // that, not a VideoFrame.
  async function poseOf(source, tMs) {
    const bitmap = await createImageBitmap(source);
    try {
      const poses = await detector.estimatePoses(bitmap, ESTIMATION, tMs);
      return poses[0] ? toCoco17(poses[0].keypoints) : null;
    } finally {
      bitmap.close();
    }
  }

  // A canvas with no context has no bitmap to give: draw the blank (black) frame.
  const blank = new OffscreenCanvas(WARMUP_SIDE, WARMUP_SIDE);
  const ctx = blank.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, WARMUP_SIDE, WARMUP_SIDE);
  await poseOf(blank, 0);
  detector.reset();   // the blank frame's crop must not be the first real frame's

  return {
    info: { model: 'movenet-thunder', backend: tf.getBackend(), runtime: `tfjs ${tf.version_core}` },
    estimate: poseOf,
    reset: () => detector.reset(),
  };
}
