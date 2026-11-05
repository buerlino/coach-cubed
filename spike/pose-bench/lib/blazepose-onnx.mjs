// SPDX-License-Identifier: AGPL-3.0-or-later
// BlazePose (MediaPipe Pose Landmarker full's own two .tflite models,
// converted to ONNX by convert-blazepose.py) on ONNX Runtime Web, with the
// detector and the landmark ROI tracking written here in plain JS. Ported
// from @tensorflow-models/pose-detection's blazepose_tfjs (Apache-2.0),
// which ports MediaPipe's pose graph; constants are theirs.
//
//   detector: 224×224 letterboxed, RGB in [-1, 1] → 2254 anchors × (box,
//             4 keypoints) + a score each; the best one ≥ 0.5 (maxPoses 1).
//   ROI:      centred on keypoint 0 (hips), 2 × the distance to keypoint 1,
//             rotated so 0→1 points up, ×1.25, square.
//   landmark: that ROI warped to 256×256, RGB in [0, 1] → 39 × (x, y, z,
//             visibility, presence) in input pixels, a pose flag, and 64×64
//             heatmaps that refine x, y (kernel 7, sigmoid as MediaPipe's
//             RefineLandmarksFromHeatmapCalculator). The next frame's ROI
//             comes from auxiliary landmarks 33, 34; the detector runs again
//             only when the pose flag drops under 0.5.
// No landmark smoothing (src/track/ smooths).

const sigmoid = v => 1 / (1 + Math.exp(-v));
const normRad = a => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));

// MediaPipe's SSD anchors for the pose detector: strides 8, 16, 32×3, two
// anchors per cell (interpolated scale), fixed size → only the centres matter.
function anchors() {
  const strides = [8, 16, 32, 32, 32], out = [];
  for (let l = 0; l < strides.length;) {
    let n = 0, last = l;
    while (last < strides.length && strides[last] === strides[l]) { n += 2; last++; }
    const fm = Math.ceil(224 / strides[l]);
    for (let y = 0; y < fm; y++) for (let x = 0; x < fm; x++) for (let a = 0; a < n; a++) out.push([(x + 0.5) / fm, (y + 0.5) / fm]);
    l = last;
  }
  return out;   // 2254 × [xCenter, yCenter]
}

// Rect from two keypoints in normalised image coords (MediaPipe's
// AlignmentPointsRectsCalculator, then RectTransformation ×1.25 square-long).
function alignRect(p0, p1, W, H) {
  const x0 = p0[0] * W, y0 = p0[1] * H, x1 = p1[0] * W, y1 = p1[1] * H;
  const size = 2 * Math.hypot(x1 - x0, y1 - y0) * 1.25;
  return { cx: p0[0], cy: p0[1], w: size / W, h: size / H, rot: normRad(Math.PI / 2 - Math.atan2(-(y1 - y0), x1 - x0)) };
}

export async function blazeposeOnnx(ort, session, Sampler, names, ep) {
  const det = await session(ort, names[0], ep);
  const lmk = await session(ort, names[1], ep);
  const A = anchors();
  const canvas = new OffscreenCanvas(256, 256);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let roi = null;

  // RGBA → NHWC RGB floats (the converted models keep TF Lite's layout).
  const toNHWC = (img, n, lo, hi) => {
    const out = new Float32Array(n * n * 3), k = (hi - lo) / 255;
    for (let i = 0, j = 0; i < n * n; i++, j += 4) {
      out[3 * i] = img[j] * k + lo; out[3 * i + 1] = img[j + 1] * k + lo; out[3 * i + 2] = img[j + 2] * k + lo;
    }
    return out;
  };

  async function detect(frame, W, H) {
    const s = 224 / Math.max(W, H), dw = W * s, dh = H * s;
    canvas.width = canvas.height = 224;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 224, 224);
    ctx.drawImage(frame, (224 - dw) / 2, (224 - dh) / 2, dw, dh);
    const input = new ort.Tensor('float32', toNHWC(ctx.getImageData(0, 0, 224, 224).data, 224, -1, 1), [1, 224, 224, 3]);
    const res = await det.s.run({ [det.s.inputNames[0]]: input });
    // Outputs by shape: [1, 2254, 12] boxes, [1, 2254, 1] scores.
    const outs = Object.values(res);
    const boxT = outs.find(t => t.dims.at(-1) === 12), scoreT = outs.find(t => t.dims.at(-1) === 1);
    const box = await boxT.getData(), score = await scoreT.getData();
    let best = -1, bs = 0.5;
    for (let i = 0; i < A.length; i++) {
      const v = sigmoid(Math.max(-100, Math.min(100, score[i])));
      if (v >= bs) { bs = v; best = i; }
    }
    if (best < 0) return null;
    // Keypoints 0 and 1 of the best box, in the letterboxed square, then
    // without the letterbox (normalised to the frame).
    const padX = (224 - dw) / 2 / 224, padY = (224 - dh) / 2 / 224;
    const kp = k => {
      const x = box[best * 12 + 4 + 2 * k] / 224 + A[best][0], y = box[best * 12 + 5 + 2 * k] / 224 + A[best][1];
      return [(x - padX) / (1 - 2 * padX), (y - padY) / (1 - 2 * padY)];
    };
    return alignRect(kp(0), kp(1), W, H);
  }

  async function landmarks(frame, r, W, H) {
    // The rotated ROI → 256×256: output = S·R(−rot)·(p − c) + 128.
    const size = r.w * W, k = 256 / size, c = Math.cos(r.rot), sn = Math.sin(r.rot);
    const cx = r.cx * W, cy = r.cy * H;
    canvas.width = canvas.height = 256;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 256, 256);
    const a = k * c, b = -k * sn, cc = k * sn, d = k * c;
    ctx.setTransform(a, b, cc, d, 128 - (a * cx + cc * cy), 128 - (b * cx + d * cy));
    ctx.drawImage(frame, 0, 0);
    const input = new ort.Tensor('float32', toNHWC(ctx.getImageData(0, 0, 256, 256).data, 256, 0, 1), [1, 256, 256, 3]);
    const res = await lmk.s.run({ [lmk.s.inputNames[0]]: input });
    const outs = Object.values(res);
    const ld = await outs.find(t => t.dims.length === 2 && t.dims[1] === 195).getData();
    const flag = (await outs.find(t => t.dims.length === 2 && t.dims[1] === 1).getData())[0];
    if (flag < 0.5) return null;
    const hmT = outs.find(t => t.dims.length === 4 && t.dims[3] === 39);
    const hm = hmT ? await hmT.getData() : null;
    const pts = [];
    for (let i = 0; i < 39; i++) {
      let x = ld[5 * i] / 256, y = ld[5 * i + 1] / 256;
      if (hm) {   // RefineLandmarksFromHeatmap: kernel 7 around the point, min confidence 0.5
        const cc0 = Math.trunc(x * 64), cr0 = Math.trunc(y * 64);
        if (cc0 >= 0 && cc0 < 64 && cr0 >= 0 && cr0 < 64) {
          let sum = 0, wc = 0, wr = 0, mx = 0;
          for (let row = Math.max(0, cr0 - 3); row < Math.min(64, cr0 + 4); row++) {
            for (let col = Math.max(0, cc0 - 3); col < Math.min(64, cc0 + 4); col++) {
              const v = sigmoid(hm[(row * 64 + col) * 39 + i]);
              sum += v; mx = Math.max(mx, v); wc += col * v; wr += row * v;
            }
          }
          if (mx >= 0.5 && sum > 0) { x = wc / 64 / sum; y = wr / 64 / sum; }
        }
      }
      // Back to normalised frame coords (MediaPipe's LandmarkProjection).
      const dx = x - 0.5, dy = y - 0.5;
      pts.push([(c * dx - sn * dy) * r.w + r.cx, (sn * dx + c * dy) * r.h + r.cy, sigmoid(ld[5 * i + 3])]);
    }
    return pts;
  }

  return {
    load: [det.load, lmk.load],
    async estimate(frame) {
      const W = frame.displayWidth, H = frame.displayHeight, ms = {};
      if (!roi) {
        const t0 = performance.now();
        roi = await detect(frame, W, H);
        ms.det = performance.now() - t0;
        if (!roi) return { keypoints: null, ms };
      }
      const t1 = performance.now();
      const pts = await landmarks(frame, roi, W, H);
      ms.pose = performance.now() - t1;
      if (!pts) { roi = null; return { keypoints: null, ms }; }
      roi = alignRect(pts[33], pts[34], W, H);
      return { landmarks33: pts.slice(0, 33), ms };
    },
  };
}
