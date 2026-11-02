// The pose engine as the app sees it: one async interface over a worker.
//
//   const engine = await PoseEngine.create({ backend: 'webgl' });   // loads, warms up
//   const { keypoints, ms } = await engine.estimate(videoFrame, tMs);
//   await engine.reset();    // between clips: no crop carries over
//   engine.close();
//
// keypoints: COCO-17 × [y, x, conf] in the frame's pixels, or null when nobody
// was found. The frame is transferred to the worker, which closes it; a frame
// that never reaches the worker is closed here, so the caller never closes a
// frame it has passed in. Messages are contract 1's (app/src/contracts/
// pose-messages.mjs): what the client sends and what it believes both pass
// its validator. Copied from pose-bench's pose-client.mjs and trimmed.
//
// One frame at a time (the contract): estimate() calls made together wait in
// order and each is sent after the last result, since MoveNet's crop follows
// the previous pose. Results are matched by id; a reply that isn't for the
// call in flight is ignored.
import { BACKENDS, validatePoseMessage } from '../contracts/pose-messages.mjs';
import { checkResultKeypoints } from './check.mjs';

const defaultWorker = () => new Worker(new URL('./pose-worker.mjs', import.meta.url), { type: 'module' });

function closeFrame(frame) {
  try { frame && frame.close && frame.close(); } catch { /* not a frame, or closed */ }
}

export class PoseEngine {
  /**
   * @param {Object} [o]
   * @param {'webgl'|'webgpu'|'wasm'|'cpu'} [o.backend] webgl; the others come later
   * @param {() => Worker} [o.createWorker] tests give a fake
   * @returns {Promise<PoseEngine>} when the worker is ready; rejects with the worker's words
   */
  static async create({ backend = 'webgl', createWorker = defaultWorker } = {}) {
    if (!BACKENDS.includes(backend)) throw new Error(`backend: must be one of ${BACKENDS.join(', ')}`);
    const engine = new PoseEngine(backend, createWorker);
    const { worker, info } = await engine.#start();
    engine.#attach(worker, info);
    return engine;
  }

  #backend; #createWorker;
  #worker = null;
  #dead = null;        // the Error every call gets once the engine can't go on
  #next = 0;
  #queue = [];         // estimates and resets waiting, in order
  #current = null;     // the estimate in flight
  #busy = false;       // a reset is running, or an estimate is in flight

  /** What the worker said at ready: model, backend, runtime, initMs (a stored lift's `engine`). */
  info = null;

  constructor(backend, createWorker) {
    this.#backend = backend;
    this.#createWorker = createWorker;
  }

  // Starts a worker and waits for its ready.
  #start() {
    return new Promise((resolve, reject) => {
      const worker = this.#createWorker();
      const fail = error => { try { worker.terminate(); } catch { /* gone */ } reject(error); };
      worker.onerror = e => fail(new Error('worker: ' + ((e && e.message) || e)));
      worker.onmessage = ({ data }) => {
        if (!data || (data.type !== 'ready' && data.type !== 'error')) return;
        const errors = validatePoseMessage(data);
        if (errors.length) return fail(new Error('worker: ' + errors.join('; ')));
        if (data.type === 'error') return fail(new Error(data.error));
        resolve({ worker, info: data.info });
      };
      try {
        worker.postMessage({ type: 'init', backend: this.#backend });
      } catch (e) { fail(e); }
    });
  }

  #attach(worker, info) {
    this.#worker = worker;
    this.info = info;
    worker.onmessage = ({ data }) => this.#onMessage(worker, data);
    worker.onerror = e => {
      if (this.#worker === worker) this.#die(new Error('worker: ' + ((e && e.message) || e)));
    };
  }

  #onMessage(worker, data) {
    const cur = this.#current;
    if (worker !== this.#worker || !cur || !data || data.type !== 'result' || data.id !== cur.id) return;
    const errors = validatePoseMessage(data);
    let outcome;
    if (errors.length) outcome = { error: new Error('worker: ' + errors.join('; ')) };
    else if ('error' in data) outcome = { error: new Error(data.error) };
    else {
      const bad = checkResultKeypoints(data.keypoints, cur.width, cur.height);
      outcome = bad.length ? { error: new Error('worker: ' + bad.join('; ')) } : { value: { keypoints: data.keypoints, ms: data.ms } };
    }
    this.#current = null;
    this.#busy = false;
    if (outcome.error) cur.reject(outcome.error); else cur.resolve(outcome.value);
    this.#pump();
  }

  /**
   * Pose one frame. Takes the frame: it is transferred, and closed by the worker.
   * @param {VideoFrame} frame upright (contract 5)
   * @param {number} tMs the frame's time in ms
   * @returns {Promise<{keypoints: Array<[number, number, number]>|null, ms: number}>}
   *   rejects when this frame failed (the engine goes on) or the engine is closed or dead
   */
  estimate(frame, tMs) {
    if (this.#dead) { closeFrame(frame); return Promise.reject(this.#dead); }
    const id = this.#next++;
    const msg = { type: 'estimate', id, frame, tMs };
    const errors = validatePoseMessage(msg);
    if (errors.length) { closeFrame(frame); return Promise.reject(new Error('estimate: ' + errors.join('; '))); }
    return new Promise((resolve, reject) => {
      this.#queue.push({ kind: 'estimate', id, msg, width: frame.displayWidth, height: frame.displayHeight, resolve, reject });
      this.#pump();
    });
  }

  /**
   * Between clips: the next frame is a first frame, whatever came before.
   * MoveNet's crop follows the last pose and contract 1 has no message to
   * clear it, so this ends the worker and starts a fresh one (weights and
   * warm-up again). Waits for the estimate in flight; calls made meanwhile
   * go to the new worker.
   * @returns {Promise<void>}
   */
  reset() {
    if (this.#dead) return Promise.reject(this.#dead);
    return new Promise((resolve, reject) => {
      this.#queue.push({ kind: 'reset', resolve, reject });
      this.#pump();
    });
  }

  close() {
    this.#die(new Error('pose engine closed'));
  }

  #pump() {
    if (this.#busy || this.#dead) return;
    const item = this.#queue.shift();
    if (!item) return;
    this.#busy = true;
    if (item.kind === 'reset') return this.#restart(item);
    const worker = this.#worker;
    try {
      worker.postMessage(item.msg, [item.msg.frame]);
    } catch (e) {
      // The transfer didn't happen: the frame is still ours.
      closeFrame(item.msg.frame);
      this.#busy = false;
      item.reject(e);
      return this.#pump();
    }
    this.#current = item;
  }

  async #restart(item) {
    const old = this.#worker;
    this.#worker = null;
    try { old.terminate(); } catch { /* gone */ }
    try {
      const { worker, info } = await this.#start();
      if (this.#dead) { worker.terminate(); item.reject(this.#dead); return; }
      this.#attach(worker, info);
      this.#busy = false;
      item.resolve();
      this.#pump();
    } catch (e) {
      item.reject(e);
      this.#die(e);
    }
  }

  // The engine can't go on: reject what is waiting or in flight, end the worker.
  #die(error) {
    if (this.#dead) return;
    this.#dead = error;
    const worker = this.#worker;
    this.#worker = null;
    try { worker && worker.terminate(); } catch { /* gone */ }
    const cur = this.#current;
    this.#current = null;
    if (cur) cur.reject(error);   // its frame went to the worker, which is gone with it
    const waiting = this.#queue;
    this.#queue = [];
    for (const item of waiting) {
      if (item.kind === 'estimate') closeFrame(item.msg.frame);
      item.reject(error);
    }
  }
}
