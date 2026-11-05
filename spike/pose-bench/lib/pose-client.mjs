// SPDX-License-Identifier: AGPL-3.0-or-later
// The one async interface the app's pose engine would have: a Worker behind
//   const engine = await PoseEngine.create({ model, ep, detector, detEvery });
//   const { keypoints, ms } = await engine.estimate(videoFrame, tMs);
// keypoints: COCO-17 × [y, x, conf] in frame pixels, or null. The frame is
// transferred to the worker, which closes it.
export class PoseEngine {
  static create(opts) {
    const worker = new Worker(new URL('../pose-worker.mjs', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      worker.onerror = e => reject(new Error('worker: ' + (e.message || e)));
      worker.onmessage = ({ data }) => {
        if (data.type === 'ready') resolve(new PoseEngine(worker, data.info));
        else if (data.type === 'error') { worker.terminate(); reject(new Error(data.error)); }
      };
      worker.postMessage({ type: 'init', opts });
    });
  }

  constructor(worker, info) {
    this.worker = worker; this.info = info; this.pending = new Map(); this.next = 0;
    worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error)); else p.resolve(data);
    };
  }

  estimate(frame, tMs) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'estimate', id, frame, tMs }, [frame]);
    });
  }

  close() { this.worker.terminate(); }
}
