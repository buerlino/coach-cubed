// SPDX-License-Identifier: AGPL-3.0-or-later
// node check-heatmap.mjs [PYTHON] [EASY_VITPOSE_DIR]
// Compares lib/heatmap.mjs with easy_ViTPose's own decoding (the reference
// tracks' VitInference.postprocess) on synthetic heatmaps: Gaussian blobs at
// sub-pixel positions plus noise, near the edges too. Needs the dev server's
// Python (numpy, cv2) and the easy_ViTPose submodule checked out.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeHeatmaps } from './lib/heatmap.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const python = process.argv[2] || resolve(REPO, '.venv/bin/python');
const vendor = process.argv[3] || resolve(REPO, 'vendor/easy_ViTPose');

const K = 17, H = 64, W = 48;
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const cases = [];
for (let c = 0; c < 4; c++) {
  const hm = new Float32Array(K * H * W);
  for (let k = 0; k < K; k++) {
    const edge = (k + c) % 5 === 0;
    const cx = edge ? (k % 2 ? 0.3 : W - 1.2) : 2 + rand() * (W - 4);
    const cy = edge ? 1 + rand() * (H - 2) : 2 + rand() * (H - 4);
    const peak = 0.2 + 0.8 * rand();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      hm[k * H * W + y * W + x] = peak * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / 8) + 0.01 * (rand() - 0.5);
    }
  }
  cases.push({ hm: Array.from(hm), cropW: 300 + 37 * c, cropH: 400 + 49 * c });
}

const py = `
import json, sys
import numpy as np
sys.path.insert(0, sys.argv[1])
from easy_ViTPose.inference import VitInference
cases = json.load(sys.stdin)
out = []
for c in cases:
    hm = np.array(c['hm'], dtype=np.float32).reshape(1, ${K}, ${H}, ${W})
    out.append(VitInference.postprocess(hm, c['cropW'], c['cropH'])[0].tolist())
print(json.dumps(out))
`;
const ref = JSON.parse(execFileSync(python, ['-c', py, vendor], { input: JSON.stringify(cases), maxBuffer: 1 << 26 }));

let worst = 0;
cases.forEach((c, i) => {
  const got = decodeHeatmaps(Float32Array.from(c.hm), K, H, W, c.cropW, c.cropH);
  got.forEach((p, k) => {
    for (let j = 0; j < 3; j++) worst = Math.max(worst, Math.abs(p[j] - ref[i][k][j]));
  });
});
console.log(`largest difference over ${cases.length * K} keypoints: ${worst.toExponential(2)} px (or score)`);
process.exit(worst < 1e-3 ? 0 : 1);
