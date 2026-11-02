// The worker's message handler, apart from the worker: contract 1's messages in,
// contract 1's messages out, the engine behind `load`. pose-worker.mjs wires it
// to `self`; the tests drive it with a fake engine. Plain module, no DOM.
//
// Messages are handled one after the other, whatever the order they arrive in:
// MoveNet's crop follows the last pose, so two estimates must never overlap.
// The frame of an estimate is closed here, once, whatever happens to it.
import { validatePoseMessage } from '../contracts/pose-messages.mjs';
import { checkResultKeypoints } from './check.mjs';

const words = e => String((e && e.message) || e);

/**
 * @param {Object} o
 * @param {(backend: string) => Promise<{info: {model: string, backend: string, runtime: string},
 *   estimate: (frame: VideoFrame, tMs: number) => Promise<Array|null>}>} o.load
 *   starts the engine (loads, warms up); rejects with the reason it can't
 * @param {(msg: object) => void} o.post
 * @param {() => number} [o.now] ms, for initMs and ms
 * @returns {(data: unknown) => Promise<void>} never rejects
 */
export function createWorkerHandler({ load, post, now = () => performance.now() }) {
  let engine = null;
  let initError = 'the engine was not initialised: send init first';
  let chain = Promise.resolve();

  async function init(msg) {
    const t0 = now();
    try {
      engine = await load(msg.backend);
      const ready = { type: 'ready', info: { ...engine.info, initMs: now() - t0 } };
      const errors = validatePoseMessage(ready);
      if (errors.length) throw new Error(`the engine's info breaks contract 1: ${errors.join('; ')}`);
      post(ready);
    } catch (e) {
      engine = null;
      initError = `init failed: ${words(e)}`;
      post({ type: 'error', error: words(e) });
    }
  }

  async function estimate(msg) {
    const { frame } = msg;
    try {
      if (!engine) throw new Error(initError);
      const width = frame.displayWidth, height = frame.displayHeight;
      const t0 = now();
      const keypoints = await engine.estimate(frame, msg.tMs);
      const ms = now() - t0;
      const errors = checkResultKeypoints(keypoints, width, height);
      if (errors.length) throw new Error(errors.join('; '));
      post({ type: 'result', id: msg.id, keypoints, ms });
    } catch (e) {
      post({ type: 'result', id: msg.id, error: words(e) });
    } finally {
      frame.close();
    }
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'init') {
      const errors = validatePoseMessage(msg);
      if (errors.length) post({ type: 'error', error: errors.join('; ') });
      else await init(msg);
    } else if (msg.type === 'estimate') {
      // A message we can't answer by id has no result to carry the error: its frame is closed, nothing is posted.
      const errors = validatePoseMessage(msg);
      if (errors.length) { try { msg.frame && msg.frame.close(); } catch { /* not a frame */ } return; }
      await estimate(msg);
    }
  }

  return data => {
    const run = chain.then(() => handle(data));
    chain = run.catch(() => {});
    return run.catch(() => {});
  };
}
