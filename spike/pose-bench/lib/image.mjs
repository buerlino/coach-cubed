// Pixels for a model's input: draws a region of a frame (VideoFrame or
// ImageBitmap) into a canvas the size of the model's input and reads it back
// as normalised planar RGB. drawImage resamples bilinearly, like the
// reference's cv2.resize(INTER_LINEAR).
export class Sampler {
  constructor(width, height) {
    this.width = width; this.height = height;
    this.canvas = new OffscreenCanvas(width, height);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingQuality = 'low';   // bilinear
  }

  // Source rect [sx, sy, sw, sh] onto destination rect [dx, dy, dw, dh];
  // the rest of the input stays `fill` (black, like np.pad's zeros).
  draw(src, s, d, fill = '#000') {
    const { ctx, width, height } = this;
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(src, s[0], s[1], s[2], s[3], d[0], d[1], d[2], d[3]);
    return ctx.getImageData(0, 0, width, height).data;
  }
}

// RGBA bytes → Float32 CHW, (v * scale − mean) / std per channel; `bgr`
// swaps the channel order for models trained on OpenCV's BGR.
export function toCHW(rgba, width, height, { mean, std, scale = 1, bgr = false }) {
  const n = width * height, out = new Float32Array(3 * n);
  const order = bgr ? [2, 1, 0] : [0, 1, 2];
  for (let c = 0; c < 3; c++) {
    const src = order[c], m = mean[c], s = std[c], o = c * n;
    for (let i = 0; i < n; i++) out[o + i] = (rgba[4 * i + src] * scale - m) / s;
  }
  return out;
}
