// SPDX-License-Identifier: AGPL-3.0-or-later
// Person detectors for the top-down models: detect(frame, W, H) →
// [[x0, y0, x1, y1, score], ...] in frame pixels, people only, best first.
//
// 'yolox-nano' / 'yolox-tiny': Megvii's COCO-trained YOLOX ONNX (Apache-2.0),
// pre- and post-processed as its demo/ONNXRuntime/onnx_inference.py does:
// letterboxed into the top-left corner on grey 114, raw 0–255 BGR, then the
// grid decode, person score = objectness × class, NMS at IoU 0.45. People
// scoring over 0.35 count, the reference pipeline's YOLO cut.
// 'frame': no detector, the whole frame is the box (single-person clips only).

const SCORE_MIN = 0.35, NMS_IOU = 0.45;

function nms(boxes) {
  boxes.sort((a, b) => b[4] - a[4]);
  const keep = [];
  const iou = (a, b) => {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const inter = ix * iy;
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
  };
  for (const b of boxes) if (keep.every(k => iou(k, b) <= NMS_IOU)) keep.push(b);
  return keep;
}

async function yolox(ort, file, ep, { session, Sampler, toCHW }) {
  const { s, load } = await session(ort, file, ep);
  const size = s.inputMetadata?.[0]?.shape?.[2] || 416;
  const sampler = new Sampler(size, size);
  const strides = [8, 16, 32];
  return {
    load: { ...load, input: size },
    async detect(frame, W, H) {
      const r = Math.min(size / H, size / W);
      const rgba = sampler.draw(frame, [0, 0, W, H], [0, 0, Math.trunc(W * r), Math.trunc(H * r)], 'rgb(114,114,114)');
      const input = new ort.Tensor('float32', toCHW(rgba, size, size, { mean: [0, 0, 0], std: [1, 1, 1], bgr: true }), [1, 3, size, size]);
      const out = (await s.run({ [s.inputNames[0]]: input }))[s.outputNames[0]];
      const d = await out.getData();
      const C = out.dims[2];
      const boxes = [];
      let a = 0;
      for (const st of strides) {
        const g = size / st;
        for (let gy = 0; gy < g; gy++) for (let gx = 0; gx < g; gx++, a++) {
          const o = a * C, score = d[o + 4] * d[o + 5];   // objectness × person
          if (score <= SCORE_MIN) continue;
          const cx = (d[o] + gx) * st, cy = (d[o + 1] + gy) * st;
          const w = Math.exp(d[o + 2]) * st, h = Math.exp(d[o + 3]) * st;
          boxes.push([(cx - w / 2) / r, (cy - h / 2) / r, (cx + w / 2) / r, (cy + h / 2) / r, score]);
        }
      }
      out.dispose?.();
      return nms(boxes).map(b => [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(W, b[2]), Math.min(H, b[3]), b[4]]);
    },
  };
}

export async function createDetector(ort, kind, ep, helpers) {
  if (kind === 'frame') {
    return { load: { model: 'frame', bytes: 0, fetchMs: 0, createMs: 0 },
      async detect(frame, W, H) { return [[0, 0, W, H, 1]]; } };
  }
  if (kind === 'yolox-nano') return yolox(ort, 'yolox_nano.onnx', ep, helpers);
  if (kind === 'yolox-tiny') return yolox(ort, 'yolox_tiny.onnx', ep, helpers);
  throw new Error('unknown detector ' + kind);
}
