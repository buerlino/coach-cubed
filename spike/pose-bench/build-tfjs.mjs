// node build-tfjs.mjs: bundles TensorFlow.js and @tensorflow-models/pose-detection
// into one ES module per backend, bundles/tfjs-<backend>.mjs (gitignored), so
// the worker can import them by a relative URL (module workers have no
// import maps, and the npm packages import each other by bare name).
// Each bundle: tfjs-core, tfjs-converter, pose-detection and its backend.
// pose-detection imports tfjs-backend-webgpu itself (a WebGPU crop path), so
// every bundle carries that one too. Its MediaPipe runtime (@mediapipe/pose,
// a closed wasm) is replaced by a stub that throws: only runtime 'tfjs' is used.
import { build } from 'esbuild';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'bundles');
mkdirSync(OUT, { recursive: true });

const BACKENDS = {
  webgl: "import '@tensorflow/tfjs-backend-webgl';",
  webgpu: "import '@tensorflow/tfjs-backend-webgpu';",
  wasm: "export { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';",
};
const STUB = "export class Pose { constructor() { throw new Error('@mediapipe/pose is not bundled'); } }";

for (const [name, line] of Object.entries(BACKENDS)) {
  const outfile = join(OUT, `tfjs-${name}.mjs`);
  await build({
    stdin: {
      contents: `export * as tf from '@tensorflow/tfjs-core';
export * as poseDetection from '@tensorflow-models/pose-detection';
${line}`,
      resolveDir: HERE, sourcefile: `tfjs-${name}-entry.mjs`,
    },
    bundle: true, format: 'esm', minify: true, platform: 'browser', target: 'es2020',
    outfile, legalComments: 'eof', logLevel: 'warning',
    plugins: [{ name: 'stub-mediapipe-pose', setup(b) {
      b.onResolve({ filter: /^@mediapipe\/pose$/ }, () => ({ path: 'stub', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB, loader: 'js' }));
    } }],
  });
  console.log(`bundles/tfjs-${name}.mjs  ${(statSync(outfile).size / 1e6).toFixed(2)} MB`);
}
