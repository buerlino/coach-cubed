// The skeleton overlay (package d16, plan step 5.5), ported from the old page and pinned to it
// by tests/app/draw.test.js: the pose at a playhead time, the bones and the confidence gate,
// each cue's drawing, the lift window's marks.
export { CONF_THRESHOLD, cubicAt, monoTangent, poseAtTime, slotForTime, trackSamples } from './interpolate.mjs';
export { bonesOf, drawSkeleton, overlayStyle, skeletonShapes } from './skeleton.mjs';
export { drawCues } from './cues.mjs';
export { timelineMarks } from './marks.mjs';
export { paintOverlay } from './overlay.mjs';
