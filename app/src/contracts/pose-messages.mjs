// SPDX-License-Identifier: AGPL-3.0-or-later
// Contract 1, the pose worker's messages: what the engine's client
// (app/src/pose/, s10) and its worker say to each other. pose-bench's
// (spike/pose-bench/pose-worker.mjs and lib/pose-client.mjs), trimmed to
// MoveNet: no model choice, no detector or its options, no box. Plain
// module, no DOM: the worker imports it.
//
//   client → worker   init     { backend }            → ready { info } | error { error }
//   client → worker   estimate { id, frame, tMs }      → result { id, keypoints, ms } | result { id, error }
//   client → worker   reset    { id }                  → cleared { id } | cleared { id, error }
//
// The frame is a VideoFrame, transferred (postMessage(msg, [frame])); the
// worker closes it. One message at a time: the client sends the next estimate
// or reset after the last answer. A reset (s35) clears MoveNet's crop between
// clips, so the next estimate starts from no previous pose; the worker keeps
// its model (no weights or warm-up again).
import { checkFields, checkFrame, checkInteger, checkNumber, checkString } from './common.mjs';
import { KEYPOINTS_EXAMPLE, validateKeypoints } from './keypoints.mjs';

/** TF.js backends: WebGL by default; WebGPU and one-thread WASM come later; CPU for Node's tests (s7). */
export const BACKENDS = Object.freeze(['webgl', 'webgpu', 'wasm', 'cpu']);

/** The messages the client sends. */
export const TO_WORKER = Object.freeze(['init', 'estimate', 'reset']);
/** The messages the worker sends. */
export const FROM_WORKER = Object.freeze(['ready', 'error', 'result', 'cleared']);

/**
 * Start the engine on a backend: load the model, warm it up.
 * @typedef {Object} InitMessage
 * @property {'init'} type
 * @property {'webgl'|'webgpu'|'wasm'|'cpu'} backend
 */

/**
 * The engine is ready. `model`, `backend` and `runtime` are what a stored
 * lift records as its `engine`.
 * @typedef {Object} ReadyMessage
 * @property {'ready'} type
 * @property {{model: string, backend: string, runtime: string, initMs: number}} info
 *   model: e.g. 'movenet-thunder'; backend: the one TF.js runs on (BACKENDS);
 *   runtime: the runtime and its version, e.g. 'tfjs 4.22.0'; initMs: the
 *   time init took, warm-up included
 */

/**
 * init failed: the backend is missing, the weights didn't load. The worker
 * is useless after it.
 * @typedef {Object} ErrorMessage
 * @property {'error'} type
 * @property {string} error what went wrong, in the engine's words
 */

/**
 * Pose one frame.
 * @typedef {Object} EstimateMessage
 * @property {'estimate'} type
 * @property {number} id the client's number for it (an integer, 0 or more), echoed in the result
 * @property {VideoFrame} frame upright (see frame-source.mjs), transferred; the worker closes it
 * @property {number} tMs the frame's time in ms, for MoveNet's crop tracking across frames
 */

/**
 * The pose of one frame: keypoints COCO-17 [y, x, conf] in the frame's
 * pixels, or null when nobody was found; ms is the whole estimate's time,
 * which the job's time left is measured from. A failed estimate carries
 * `error` instead of `keypoints` and `ms`.
 * @typedef {Object} ResultMessage
 * @property {'result'} type
 * @property {number} id
 * @property {import('./keypoints.mjs').Keypoints|null} [keypoints]
 * @property {number} [ms]
 * @property {string} [error]
 */

/**
 * Between clips: forget the last pose (pose-detection's detector.reset(), which
 * clears MoveNet's crop), keep the model. The worker answers it after any
 * estimate sent before it, and the next estimate starts from no previous pose.
 * @typedef {Object} ResetMessage
 * @property {'reset'} type
 * @property {number} id the client's number for it (an integer, 0 or more; the
 *   same count as the estimates'), echoed in the answer
 */

/**
 * The reset is done: the crop is cleared. A reset that failed (no engine, the
 * detector threw) carries `error`, in the engine's words; the worker goes on,
 * as after a failed estimate.
 * @typedef {Object} ClearedMessage
 * @property {'cleared'} type
 * @property {number} id the reset's id
 * @property {string} [error]
 */

/** @typedef {InitMessage|EstimateMessage|ResetMessage} ToWorkerMessage */
/** @typedef {ReadyMessage|ErrorMessage|ResultMessage|ClearedMessage} FromWorkerMessage */

/**
 * Any of the seven messages, told apart by `type`.
 * @param {unknown} msg
 * @returns {string[]} the errors, empty when valid
 */
export function validatePoseMessage(msg) {
  const errors = [];
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return ['message: must be an object with a type'];
  switch (msg.type) {
    case 'init':
      checkFields(errors, '', msg, ['type', 'backend']);
      if (!BACKENDS.includes(msg.backend)) errors.push(`backend: must be one of ${BACKENDS.join(', ')}`);
      break;
    case 'ready':
      checkFields(errors, '', msg, ['type', 'info']);
      if (msg.info !== undefined && checkFields(errors, 'info', msg.info, ['model', 'backend', 'runtime', 'initMs'])) {
        checkString(errors, 'info.model', msg.info.model);
        if (msg.info.backend !== undefined && !BACKENDS.includes(msg.info.backend)) {
          errors.push(`info.backend: must be one of ${BACKENDS.join(', ')}`);
        }
        if (msg.info.runtime !== undefined) checkString(errors, 'info.runtime', msg.info.runtime);
        checkNumber(errors, 'info.initMs', msg.info.initMs, { min: 0 });
      }
      break;
    case 'error':
      checkFields(errors, '', msg, ['type', 'error']);
      checkString(errors, 'error', msg.error);
      break;
    case 'estimate':
      checkFields(errors, '', msg, ['type', 'id', 'frame', 'tMs']);
      checkInteger(errors, 'id', msg.id, 0);
      if (msg.frame !== undefined) checkFrame(errors, 'frame', msg.frame);
      checkNumber(errors, 'tMs', msg.tMs, { min: 0 });
      break;
    case 'result':
      checkInteger(errors, 'id', msg.id, 0);
      if ('error' in msg) {
        if ('keypoints' in msg || 'ms' in msg) errors.push('error: a result carries keypoints and ms, or an error, never both');
        checkFields(errors, '', msg, ['type', 'id', 'error']);
        checkString(errors, 'error', msg.error);
      } else {
        checkFields(errors, '', msg, ['type', 'id', 'keypoints', 'ms']);
        if ('keypoints' in msg) errors.push(...validateKeypoints(msg.keypoints, 'keypoints'));
        if ('ms' in msg) checkNumber(errors, 'ms', msg.ms, { min: 0 });
      }
      break;
    case 'reset':
      checkFields(errors, '', msg, ['type', 'id']);
      checkInteger(errors, 'id', msg.id, 0);
      break;
    case 'cleared':
      checkFields(errors, '', msg, ['type', 'id'], ['error']);
      checkInteger(errors, 'id', msg.id, 0);
      if ('error' in msg) checkString(errors, 'error', msg.error);
      break;
    default:
      return [`type: must be one of ${[...TO_WORKER, ...FROM_WORKER].join(', ')}`];
  }
  return errors;
}

/** A stand-in VideoFrame for the example: what checkFrame looks at. */
function exampleFrame() {
  const frame = {
    displayWidth: 1080, displayHeight: 1920, timestamp: 0,
    close() { frame.displayWidth = 0; frame.displayHeight = 0; },
  };
  return frame;
}

/**
 * One of each. Sample values: initMs is made up; ms is the per-frame cost
 * ui-design.md quotes (about 2.9 s per second of 30 fps video: ~97 ms);
 * the keypoints are KEYPOINTS_EXAMPLE, frame 0 of a committed track.
 * @type {Array<ToWorkerMessage|FromWorkerMessage>}
 */
export const POSE_MESSAGE_EXAMPLES = [
  { type: 'init', backend: 'webgl' },
  { type: 'ready', info: { model: 'movenet-thunder', backend: 'webgl', runtime: 'tfjs 4.22.0', initMs: 1500 } },
  { type: 'error', error: 'TF.js backend webgl unavailable' },
  { type: 'estimate', id: 0, frame: exampleFrame(), tMs: 0 },
  { type: 'result', id: 0, keypoints: KEYPOINTS_EXAMPLE, ms: 97 },
  { type: 'reset', id: 1 },
  { type: 'cleared', id: 1 },
];
