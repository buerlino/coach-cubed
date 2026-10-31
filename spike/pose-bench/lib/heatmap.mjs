// Heatmaps → keypoints, as easy_ViTPose decodes them for the reference
// tracks: keypoints_from_heatmaps(unbiased=True, use_udp=True), i.e. the
// argmax refined by one Newton step on the log of the heatmap blurred with an
// 11×11 Gaussian (post_dark_udp), then mapped onto the crop with UDP's
// (size − 1) spacing (transform_preds). Ported from
// vendor/easy_ViTPose/easy_ViTPose/vit_utils/top_down_eval.py and
// post_processing/post_transforms.py; check-heatmap.py compares the two.

const KERNEL = 11;
// cv2.getGaussianKernel(11, 0): sigma = 0.3 * ((11 - 1) / 2 - 1) + 0.8 = 2.
const SIGMA = 0.3 * ((KERNEL - 1) * 0.5 - 1) + 0.8;
const G = (() => {
  const g = [];
  for (let i = 0; i < KERNEL; i++) g.push(Math.exp(-((i - 5) ** 2) / (2 * SIGMA * SIGMA)));
  const s = g.reduce((a, b) => a + b, 0);
  return g.map(v => v / s);
})();
const EPS32 = 1.1920928955078125e-7;   // np.finfo(np.float32).eps

// OpenCV's default border, BORDER_REFLECT_101: -1 → 1, n → n - 2.
function reflect101(i, n) {
  if (n === 1) return 0;
  while (i < 0 || i >= n) i = i < 0 ? -i : 2 * n - 2 - i;
  return i;
}

// log(clip(blur(hm), 0.001, 50)) at one point of one heatmap.
function blurredLog(hm, off, W, H, x, y) {
  let acc = 0;
  for (let j = 0; j < KERNEL; j++) {
    const row = off + reflect101(y + j - 5, H) * W;
    let r = 0;
    for (let i = 0; i < KERNEL; i++) r += G[i] * hm[row + reflect101(x + i - 5, W)];
    acc += G[j] * r;
  }
  return Math.log(Math.min(50, Math.max(0.001, acc)));
}

// hm: Float32Array of K × H × W (one person). cropW, cropH: the size of the
// image the heatmaps cover, in pixels. Returns K × [y, x, score] in that
// image's pixels, as VitInference.postprocess does.
export function decodeHeatmaps(hm, K, H, W, cropW, cropH) {
  const out = [];
  for (let k = 0; k < K; k++) {
    const off = k * H * W;
    let best = 0, max = -Infinity;
    for (let i = 0; i < H * W; i++) if (hm[off + i] > max) { max = hm[off + i]; best = i; }
    let px = best % W, py = (best - px) / W;
    if (!(max > 0)) { px = -1; py = -1; }

    // The Newton step: the padded map is edge-extended, so a neighbour
    // outside the grid reads the nearest edge value.
    const at = (dx, dy) => blurredLog(hm, off, W, H,
      Math.min(W - 1, Math.max(0, px + dx)), Math.min(H - 1, Math.max(0, py + dy)));
    const i_ = at(0, 0), ix1 = at(1, 0), iy1 = at(0, 1), ix1y1 = at(1, 1),
      ix1_y1_ = at(-1, -1), ix1_ = at(-1, 0), iy1_ = at(0, -1);
    const dx = 0.5 * (ix1 - ix1_), dy = 0.5 * (iy1 - iy1_);
    const dxx = ix1 - 2 * i_ + ix1_ + EPS32, dyy = iy1 - 2 * i_ + iy1_ + EPS32;
    const dxy = 0.5 * (ix1y1 - ix1 - iy1 + i_ + i_ - ix1_ - iy1_ + ix1_y1_);
    const det = dxx * dyy - dxy * dxy;
    let x = px, y = py;
    if (det !== 0) {
      x -= (dyy * dx - dxy * dy) / det;
      y -= (-dxy * dx + dxx * dy) / det;
    }

    // transform_preds(use_udp=True) with center = size // 2, scale = size.
    const tx = x * (cropW / (W - 1)) + Math.floor(cropW / 2) - cropW * 0.5;
    const ty = y * (cropH / (H - 1)) + Math.floor(cropH / 2) - cropH * 0.5;
    out.push([ty, tx, max]);
  }
  return out;
}
