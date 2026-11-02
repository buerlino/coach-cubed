// The analysis (package s12): the job (job.mjs), the queue (queue.mjs) and the
// cost shown while marking (estimate.mjs). appQueue() is the app's one queue,
// made on first use with the browser's parts: it outlives screen changes, so
// Q1, H and M1–M3 all subscribe to the same one.
import { createQueue } from './queue.mjs';
import { createStore } from '../store/index.mjs';
import { openFrameSource } from '../media/frame-source.mjs';
import { keepVideo } from '../media/cut.mjs';
import { PoseEngine } from '../pose/pose-client.mjs';

export { createQueue, StallError } from './queue.mjs';
export { runJob, median, framesInRange, JobCancelled, EngineError } from './job.mjs';
export { DEFAULT_RATE, estimateCost, rateOf } from './estimate.mjs';

let theQueue = null;

/**
 * The app's queue: the store in OPFS, s9's frame source, s32's keepVideo, s10's
 * engine on WebGL, diagnostics.js from window.Diagnostics. It loads the kept
 * queue (a job cut off by the app's close runs again) and follows the page's
 * visibility (a frozen WebView is never a stall).
 * @param {Object} [overrides] createQueue's deps to replace
 */
export function appQueue(overrides = {}) {
  if (theQueue) return theQueue;
  theQueue = createQueue({
    store: createStore(),
    createEngine: () => PoseEngine.create({ backend: 'webgl' }),
    openFrameSource: blob => openFrameSource(blob),
    keepVideo,
    ...overrides,
  });
  const doc = globalThis.document;
  if (doc && typeof doc.addEventListener === 'function') {
    const follow = () => theQueue.setVisible(doc.visibilityState !== 'hidden');
    doc.addEventListener('visibilitychange', follow);
    follow();
  }
  theQueue.load().catch(() => { /* no store here: analyse() reports it */ });
  return theQueue;
}
