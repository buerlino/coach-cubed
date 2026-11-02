// The overlay for one instant: the skeleton and, over it, each cue's drawing, on the
// pose at the playhead's time (the old page's drawOverlay, minus its readouts and panels).
// One call paints what the frame shown at t needs; the player calls it for the frame
// the video or the stepper shows. Plain module, no DOM.
import { poseAtTime } from './interpolate.mjs';
import { bonesOf, drawSkeleton } from './skeleton.mjs';
import { drawCues } from './cues.mjs';

/**
 * @typedef {Object} OverlayScene
 * @property {{keypoints: Object, frames: number[], times: number[]}} track trackSamples() of the smoothed keypoints
 * @property {Object} meta the track's meta (width, height, skeleton)
 * @property {Object} Diagnostics diagnostics.js's object
 * @property {import('../contracts/cue-view.mjs').ResultView} view
 * @property {Object} computed scoreLift()'s computeResults() output
 */

/**
 * Clears the canvas and paints the overlay at time t. `skeleton` and `cues` are
 * A3's view options (settings.view); `style` is skeleton.mjs's overlayStyle().
 * @param {CanvasRenderingContext2D} ctx in the track's frame pixels (meta.width × meta.height)
 * @param {OverlayScene} scene
 * @param {number} t seconds, the frame shown
 * @param {{skeleton: boolean, cues: boolean, style: object}} opts
 * @returns {{pose: object|null, cues: string[]}} what was drawn
 */
export function paintOverlay(ctx, scene, t, { skeleton, cues, style }) {
  const c = ctx.canvas;
  ctx.clearRect(0, 0, c.width, c.height);
  const pose = skeleton ? poseAtTime(scene.track, t, { smooth: true }) : null;
  if (skeleton) drawSkeleton(ctx, pose, bonesOf(scene.meta), style);
  const drawn = cues ? drawCues(ctx, scene.Diagnostics, scene.view, scene.computed, t) : [];
  return { pose, cues: drawn };
}

/**
 * A2's frame: the skeleton and, over it, one cue's drawing at time t (the cue's own marks and phase label
 * only; the other cues stay off). Clears the canvas first, like paintOverlay.
 * @param {CanvasRenderingContext2D} ctx in the track's frame pixels
 * @param {OverlayScene} scene
 * @param {number} t seconds, the frame shown
 * @param {{cue: string, skeleton?: boolean, style: object}} opts
 * @returns {{pose: object|null, cues: string[]}}
 */
export function paintCue(ctx, scene, t, { cue, skeleton = true, style }) {
  const c = ctx.canvas;
  ctx.clearRect(0, 0, c.width, c.height);
  const pose = skeleton ? poseAtTime(scene.track, t, { smooth: true }) : null;
  if (skeleton) drawSkeleton(ctx, pose, bonesOf(scene.meta), style);
  return { pose, cues: drawCues(ctx, scene.Diagnostics, scene.view, scene.computed, t, { ids: [cue] }) };
}
