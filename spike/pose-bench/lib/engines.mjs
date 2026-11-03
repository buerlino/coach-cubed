// SPDX-License-Identifier: AGPL-3.0-or-later
// The pose engines the spike compares, each behind the same call:
// estimate(frame, tMs) → { keypoints: 17 × [y, x, conf] in frame pixels
// (COCO-17, y down) or null, ms: { stage: milliseconds } }.
// Loaded inside the worker (pose-worker.mjs); every URL is relative to this file.
import { Sampler, toCHW } from './image.mjs';
import { decodeHeatmaps } from './heatmap.mjs';
import { createDetector } from './detector.mjs';
import { blazeposeOnnx } from './blazepose-onnx.mjs';
import { COCO17_FROM_MP33, toCoco17 } from '../../../src/pose/coco17.mjs';

const ORT_DIST = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url).href;
const MODELS = new URL('../models/', import.meta.url).href;
const IMAGENET = { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], scale: 1 / 255 };

// What a model costs to fetch, for the first-load numbers.
async function fetchModel(name) {
  const t0 = performance.now();
  const res = await fetch(MODELS + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return { buf, bytes: buf.byteLength, ms: performance.now() - t0 };
}

// ONNX Runtime Web: the WebGPU build for 'webgpu', the plain WebAssembly
// build for 'wasm' (the fallback a phone without WebGPU would download).
async function loadOrt(ep, threads) {
  const ort = await import(ORT_DIST + (ep === 'webgpu' ? 'ort.webgpu.min.mjs' : 'ort.wasm.min.mjs'));
  ort.env.wasm.wasmPaths = ORT_DIST;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? (threads || Math.min(4, navigator.hardwareConcurrency || 1)) : 1;
  return ort;
}

async function session(ort, name, ep) {
  const file = await fetchModel(name);
  const t0 = performance.now();
  const s = await ort.InferenceSession.create(file.buf, {
    executionProviders: [ep], graphOptimizationLevel: 'all',
  });
  return { s, load: { model: name, bytes: file.bytes, fetchMs: file.ms, createMs: performance.now() - t0 } };
}

// --- top-down: a person box, then the pose model on that crop -------------

// Follows one person: the largest box first, then whichever box overlaps the
// previous one most. Between detector runs (detEvery > 1) the box comes from
// the last pose's confident keypoints.
class PersonTracker {
  constructor() { this.box = null; }
  static iou(a, b) {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const inter = ix * iy, area = r => (r[2] - r[0]) * (r[3] - r[1]);
    return inter / (area(a) + area(b) - inter || 1);
  }
  pick(dets) {
    if (!dets.length) return this.box;
    const area = d => (d[2] - d[0]) * (d[3] - d[1]);
    let best = null;
    if (this.box) {
      let o = 0.1;
      for (const d of dets) { const v = PersonTracker.iou(d, this.box); if (v > o) { o = v; best = d; } }
    }
    if (!best) best = dets.reduce((a, b) => (area(b) > area(a) ? b : a));
    return (this.box = best.slice(0, 4));
  }
  fromKeypoints(kp, W, H) {
    const ok = kp.filter(p => p[2] >= 0.3);
    if (ok.length < 4) return this.box;
    const ys = ok.map(p => p[0]), xs = ok.map(p => p[1]);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const mx = 0.15 * (x1 - x0), my = 0.15 * (y1 - y0);
    return (this.box = [Math.max(0, x0 - mx), Math.max(0, y0 - my), Math.min(W, x1 + mx), Math.min(H, y1 + my)]);
  }
}

// easy_ViTPose's crop (VitInference.inference): the box rounded, grown by
// 10 px, clipped to the frame, then zero-padded to 3:4 around its centre.
export function vitposeCrop(box, W, H) {
  const x0 = Math.min(W, Math.max(0, Math.round(box[0]) - 10)), x1 = Math.min(W, Math.max(0, Math.round(box[2]) + 10));
  const y0 = Math.min(H, Math.max(0, Math.round(box[1]) - 10)), y1 = Math.min(H, Math.max(0, Math.round(box[3]) + 10));
  const w = x1 - x0, h = y1 - y0;
  let left = 0, top = 0, pw = w, ph = h;
  if (w / h < 3 / 4) { pw = Math.trunc(3 / 4 * h); left = Math.floor((pw - w) / 2); }
  else { ph = Math.trunc(w / (3 / 4)); top = Math.floor((ph - h) / 2); }
  return { x0, y0, w, h, left, top, pw, ph };
}

// ViTPose (easy_ViTPose's ONNX export): 256×192 RGB, ImageNet-normalised,
// 17 heatmaps of 64×48 decoded as the reference decodes them.
async function vitposeHead(ort, name, ep) {
  const { s, load } = await session(ort, name, ep);
  const sampler = new Sampler(192, 256);
  return {
    load,
    async run(frame, box, W, H) {
      const c = vitposeCrop(box, W, H);
      if (c.w < 2 || c.h < 2) return null;
      const t0 = performance.now();
      const sx = 192 / c.pw, sy = 256 / c.ph;
      const rgba = sampler.draw(frame, [c.x0, c.y0, c.w, c.h], [c.left * sx, c.top * sy, c.w * sx, c.h * sy]);
      const input = new ort.Tensor('float32', toCHW(rgba, 192, 256, IMAGENET), [1, 3, 256, 192]);
      const t1 = performance.now();
      const out = (await s.run({ [s.inputNames[0]]: input }))[s.outputNames[0]];
      const t2 = performance.now();
      const hm = await out.getData();
      const [, K, h, w] = out.dims;
      const kp = decodeHeatmaps(hm, K, h, w, c.pw, c.ph).map(([y, x, v]) => [y + c.y0 - c.top, x + c.x0 - c.left, v]);
      out.dispose?.();
      return { kp, ms: { pre: t1 - t0, pose: t2 - t1, post: performance.now() - t2 } };
    },
  };
}

// RTMPose (OpenMMLab's ONNX, as rtmlib runs it): the box's centre and size
// × 1.25, widened to 3:4, warped to 256×192 (out-of-frame is black); RGB
// normalised as the model's pipeline.json says (to_rgb: true; rtmlib itself
// feeds BGR). SimCC decode: argmax of each axis / 2, score = mean of the two
// maxima (rtmlib's get_simcc_maximum; MMPose takes the smaller one).
async function rtmposeHead(ort, name, ep) {
  const { s, load } = await session(ort, name, ep);
  const sampler = new Sampler(192, 256);
  const NORM = { mean: [123.675, 116.28, 103.53], std: [58.395, 57.12, 57.375] };
  return {
    load,
    async run(frame, box) {
      const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
      let sw = (box[2] - box[0]) * 1.25, sh = (box[3] - box[1]) * 1.25;
      if (sw > sh * 0.75) sh = sw / 0.75; else sw = sh * 0.75;
      if (!(sw > 1)) return null;
      const t0 = performance.now();
      const rgba = sampler.draw(frame, [cx - sw / 2, cy - sh / 2, sw, sh], [0, 0, 192, 256]);
      const input = new ort.Tensor('float32', toCHW(rgba, 192, 256, NORM), [1, 3, 256, 192]);
      const t1 = performance.now();
      const res = await s.run({ [s.inputNames[0]]: input });
      const t2 = performance.now();
      const ox = res.simcc_x, oy = res.simcc_y;
      const X = await ox.getData(), Y = await oy.getData();
      const K = ox.dims[1], nx = ox.dims[2], ny = oy.dims[2];
      const kp = [];
      for (let k = 0; k < K; k++) {
        let bx = 0, mx = -Infinity, by = 0, my = -Infinity;
        for (let i = 0; i < nx; i++) if (X[k * nx + i] > mx) { mx = X[k * nx + i]; bx = i; }
        for (let i = 0; i < ny; i++) if (Y[k * ny + i] > my) { my = Y[k * ny + i]; by = i; }
        const v = 0.5 * (mx + my);
        if (!(v > 0)) { kp.push([cy, cx, 0]); continue; }
        kp.push([by / 2 / 256 * sh + cy - sh / 2, bx / 2 / 192 * sw + cx - sw / 2, v]);
      }
      ox.dispose?.(); oy.dispose?.();
      return { kp, ms: { pre: t1 - t0, pose: t2 - t1, post: performance.now() - t2 } };
    },
  };
}

async function topDown(opts) {
  const ort = await loadOrt(opts.ep, opts.threads);
  const det = await createDetector(ort, opts.detector, opts.ep, { session, Sampler, toCHW });
  const head = await (opts.head === 'rtmpose' ? rtmposeHead : vitposeHead)(ort, opts.weights, opts.ep);
  const tracker = new PersonTracker();
  const every = Math.max(1, opts.detEvery || 1);
  let n = 0, last = null;
  return {
    info: { load: [det.load, head.load], ort: ort.env.versions?.web, threads: ort.env.wasm.numThreads },
    async estimate(frame) {
      const W = frame.displayWidth, H = frame.displayHeight, ms = {};
      let box;
      if (n++ % every === 0 || !last) {
        const t0 = performance.now();
        const dets = await det.detect(frame, W, H);
        ms.det = performance.now() - t0;
        box = tracker.pick(dets);
      } else {
        box = tracker.fromKeypoints(last, W, H);
      }
      if (!box) { last = null; return { keypoints: null, ms }; }
      const r = await head.run(frame, box, W, H);
      if (!r) { last = null; return { keypoints: null, ms }; }
      last = r.kp;
      return { keypoints: r.kp, box, ms: { ...ms, ...r.ms } };
    },
  };
}

// --- MediaPipe Pose Landmarker (Tasks): its own detector and tracking -----

async function mediapipe(opts) {
  const t0 = performance.now();
  const vision = await import('../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs');
  const fileset = await vision.FilesetResolver.forVisionTasks(
    new URL('../node_modules/@mediapipe/tasks-vision/wasm', import.meta.url).href, true);
  const file = await fetchModel(opts.weights);
  const t1 = performance.now();
  const landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: new Uint8Array(file.buf), delegate: opts.ep === 'webgpu' ? 'GPU' : 'CPU' },
    runningMode: 'VIDEO', numPoses: 1,
    canvas: opts.ep === 'webgpu' ? new OffscreenCanvas(1, 1) : undefined,
  });
  return {
    info: { load: [{ model: opts.weights, bytes: file.bytes, fetchMs: file.ms, createMs: performance.now() - t1,
      runtimeMs: t1 - t0 - file.ms }], delegate: opts.ep === 'webgpu' ? 'GPU' : 'CPU' },
    async estimate(frame, tMs) {
      const s = performance.now();
      const res = landmarker.detectForVideo(frame, tMs);
      const ms = { pose: performance.now() - s };
      const lm = res.landmarks && res.landmarks[0];
      if (!lm) return { keypoints: null, ms };
      return { keypoints: toCoco17(lm, frame.displayWidth, frame.displayHeight), ms };
    },
  };
}

// --- TensorFlow.js: @tensorflow-models/pose-detection, runtime 'tfjs' -----
// MoveNet's own crop across frames (the last pose's keypoints, low-passed)
// and BlazePose's detector plus landmark ROI tracking, as that package runs
// them. Its keypoint smoothing is off: coach smooths in src/track/, and the
// raw track should be the model's. ep: 'tfjs-webgl' | 'tfjs-webgpu' |
// 'tfjs-wasm' (one thread: the app's WebView can't be isolated).
const TFJS_WASM = new URL('../node_modules/@tensorflow/tfjs-backend-wasm/dist/', import.meta.url).href;

async function tfjs(opts) {
  const backend = opts.ep.replace(/^tfjs-/, '');
  const t0 = performance.now();
  const { tf, poseDetection, setWasmPaths } = await import(new URL(`../bundles/tfjs-${backend}.mjs`, import.meta.url).href);
  if (backend === 'wasm') {
    setWasmPaths(TFJS_WASM);
    tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
  }
  if (!(await tf.setBackend(backend))) throw new Error(`TF.js backend ${backend} unavailable`);
  await tf.ready();
  const t1 = performance.now();
  // Every model file through one counting fetch, for the download column.
  const load = [];
  const handler = dir => {
    const l = { model: dir, bytes: 0, fetchMs: 0 };
    load.push(l);
    return tf.io.http(MODELS + dir + '/model.json', { fetchFunc: async (url, init) => {
      const s = performance.now();
      const res = await fetch(url, init);
      const buf = await res.arrayBuffer();
      l.bytes += buf.byteLength; l.fetchMs += performance.now() - s;
      return new Response(buf, { status: res.status, headers: res.headers });
    } });
  };
  const M = poseDetection.SupportedModels;
  const detector = opts.family === 'movenet'
    ? await poseDetection.createDetector(M.MoveNet, { modelType: opts.modelType, enableSmoothing: false,
      modelUrl: handler(opts.weights) })
    : await poseDetection.createDetector(M.BlazePose, { runtime: 'tfjs', modelType: 'full', enableSmoothing: false,
      enableSegmentation: false, detectorModelUrl: handler(opts.weights[0]), landmarkModelUrl: handler(opts.weights[1]) });
  load[0].createMs = performance.now() - t1;
  load[0].runtimeMs = t1 - t0;
  return {
    info: { load, tfjs: tf.version_core, backend: tf.getBackend(),
      wasmThreads: backend === 'wasm' ? tf.env().getBool('WASM_HAS_MULTITHREAD_SUPPORT') : undefined },
    async estimate(frame, tMs) {
      const s = performance.now();
      // tf.browser.fromPixels takes an ImageBitmap, not a VideoFrame.
      const bmp = await createImageBitmap(frame);
      const s1 = performance.now();
      const poses = await detector.estimatePoses(bmp, { maxPoses: 1, flipHorizontal: false }, tMs);
      bmp.close();
      const ms = { pre: s1 - s, pose: performance.now() - s1 };
      const kp = poses[0]?.keypoints;
      if (!kp) return { keypoints: null, ms };
      const pts = opts.family === 'movenet' ? kp : COCO17_FROM_MP33.map(k => kp[k]);
      return { keypoints: pts.map(p => [p.y, p.x, p.score ?? 0]), ms };
    },
  };
}

// --- BlazePose's Tasks models converted to ONNX, on ONNX Runtime ---------
// (lib/blazepose-onnx.mjs: the detector and ROI tracking in plain JS.)
async function blazeposeOrt(opts) {
  const ort = await loadOrt(opts.ep, opts.threads);
  const bp = await blazeposeOnnx(ort, session, Sampler, opts.weights, opts.ep);
  return {
    info: { load: bp.load, ort: ort.env.versions?.web, threads: ort.env.wasm.numThreads },
    async estimate(frame) {
      const W = frame.displayWidth, H = frame.displayHeight;
      const r = await bp.estimate(frame);
      const lm = r.landmarks33;
      return { keypoints: lm ? COCO17_FROM_MP33.map(k => [lm[k][1] * H, lm[k][0] * W, lm[k][2]]) : null, ms: r.ms };
    },
  };
}

// The candidates, by the name the page offers. weights: file in models/.
export const CANDIDATES = {
  'blazepose-onnx-full': { kind: 'blazepose-onnx', weights: ['pose_detector_full.onnx', 'pose_landmarks_full.onnx'] },
  'movenet-thunder': { kind: 'tfjs', family: 'movenet', modelType: 'SinglePose.Thunder', weights: 'movenet-thunder-4' },
  'movenet-lightning': { kind: 'tfjs', family: 'movenet', modelType: 'SinglePose.Lightning', weights: 'movenet-lightning-4' },
  'blazepose-tfjs-full': { kind: 'tfjs', family: 'blazepose', weights: ['blazepose-detector-1', 'blazepose-landmark-full-2'] },
  'vitpose-s': { kind: 'topdown', head: 'vitpose', weights: 'vitpose-s-coco.onnx' },
  'vitpose-b': { kind: 'topdown', head: 'vitpose', weights: 'vitpose-b-coco.onnx' },
  'rtmpose-s': { kind: 'topdown', head: 'rtmpose', weights: 'rtmpose-s.onnx' },
  'rtmpose-m': { kind: 'topdown', head: 'rtmpose', weights: 'rtmpose-m.onnx' },
  'mediapipe-lite': { kind: 'mediapipe', weights: 'pose_landmarker_lite.task' },
  'mediapipe-full': { kind: 'mediapipe', weights: 'pose_landmarker_full.task' },
  'mediapipe-heavy': { kind: 'mediapipe', weights: 'pose_landmarker_heavy.task' },
};

export async function createEngine(opts) {
  const c = CANDIDATES[opts.model];
  if (!c) throw new Error('unknown model ' + opts.model);
  const o = { ...opts, weights: c.weights, head: c.head, family: c.family, modelType: c.modelType };
  const make = { mediapipe, tfjs, 'blazepose-onnx': blazeposeOrt, topdown: topDown }[c.kind];
  return make(o);
}
