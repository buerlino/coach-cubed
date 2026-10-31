// The pose engine's worker: one model, one frame at a time. Messages:
//   init     { opts }            → ready { info } | error
//   estimate { id, frame, tMs }  → result { id, keypoints, box?, ms }
// The frame (a VideoFrame) is transferred in and closed here.
import { createEngine } from './lib/engines.mjs';

let engine = null;
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      const t0 = performance.now();
      engine = await createEngine(data.opts);
      self.postMessage({ type: 'ready', info: { ...engine.info, initMs: performance.now() - t0,
        isolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer !== 'undefined', gpu: !!self.navigator.gpu } });
    } catch (e) {
      self.postMessage({ type: 'error', error: String(e && e.stack || e) });
    }
  } else if (data.type === 'estimate') {
    const t0 = performance.now();
    try {
      const r = await engine.estimate(data.frame, data.tMs);
      self.postMessage({ type: 'result', id: data.id, ...r, ms: { ...r.ms, total: performance.now() - t0 } });
    } catch (e) {
      self.postMessage({ type: 'result', id: data.id, error: String(e && e.stack || e) });
    } finally {
      data.frame.close();
    }
  }
};
