// node app/tools/build-tfjs.mjs [--out <dir>]
//
// Builds TensorFlow.js and pose-detection (MoveNet only) from the TypeScript
// at their tags, not from npm's built dist/ (docs/app-plan.md, "The build";
// docs/pose-spike.md, "F-Droid" and "Maintaining TF.js ourselves"):
//
// 1. Clones tensorflow/tfjs at `tfjs-v4.22.0` and tensorflow/tfjs-models at
//    `pose-detection-v2.1.3`, each checked against its pinned commit, into a
//    cache outside the repo: $XDG_CACHE_HOME/coach/, by default
//    ~/.cache/coach/ (the root `npm test` runs test files anywhere inside the
//    tree, gitignored folders too). A second run reuses the prepared clones.
// 2. Applies our patches (app/tools/patches/<repo>/*.patch, none at present)
//    and generates the converter's op lists from the JSON in the tag, as
//    tfjs's Bazel rule gen_op does (tfjs-converter/scripts/gen_op.ts).
// 3. Bundles with esbuild (pinned in app/package.json) through the tag's
//    root tsconfig.json, whose path map points every @tensorflow/* package
//    at its src/index.ts: one ES module per backend in app/vendor/tfjs/
//    (gitignored), each with tfjs-core, the converter, pose-detection cut
//    to MoveNet, and its backend; plus the licences.
//
// The bundles export { tf, converter, poseDetection }, as the spike's do
// (spike/pose-bench/build-tfjs.mjs) plus the converter:
//   tfjs-webgl.mjs, tfjs-webgpu.mjs  for the browser and the WebView;
//   tfjs-cpu.mjs                     for Node (s7 compares it with npm's).
import { build, version as esbuildVersion } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const REPO = resolve(APP, '..');

// The pinned sources. A tag can move; the commit can't: a clone whose HEAD
// isn't the commit is refused.
export const SOURCES = {
  tfjs: {
    url: 'https://github.com/tensorflow/tfjs.git',
    tag: 'tfjs-v4.22.0',
    commit: 'e5d5e9371ed1fd0a4df6d7cd0b947d2a820cefd7',
  },
  'tfjs-models': {
    url: 'https://github.com/tensorflow/tfjs-models.git',
    tag: 'pose-detection-v2.1.3',
    commit: 'f588523c083f4254050cd76c23ea18bd8fdef934',
  },
};

// The year gen_op.ts stamps into each op list's licence header is the build's
// own (new Date().getFullYear()). npm's tfjs-converter 4.22.0 carries 2023
// (dist/operations/op_list/arithmetic.js); fixed here so a rebuild is the same.
const OP_LIST_YEAR = 2023;

// The backends, one bundle each. The CPU bundle runs in Node (s7), where
// tfjs-core's Node platform calls require('util'), so it is built for Node
// with a require of its own; node-fetch stays external (Node 18+ has fetch,
// and tfjs-core uses the global one when it exists).
export const BUNDLES = {
  webgl: { backend: '@tensorflow/tfjs-backend-webgl', platform: 'browser' },
  webgpu: { backend: '@tensorflow/tfjs-backend-webgpu', platform: 'browser' },
  cpu: { backend: '@tensorflow/tfjs-backend-cpu', platform: 'node' },
};

// pose-detection cut to MoveNet: its index.ts imports every model (PoseNet,
// BlazePose on TF.js and on MediaPipe, whose @mediapipe/pose is a closed
// wasm). This entry, ours, takes MoveNet's loader and the public names the
// app uses from the tag's own files, unchanged.
const MOVENET_ENTRY = `
import {load} from './movenet/detector';
import {SINGLEPOSE_LIGHTNING, SINGLEPOSE_THUNDER, MULTIPOSE_LIGHTNING} from './movenet/constants';
import {SupportedModels} from './types';
export * from './types';
export {TrackerType} from './calculators/types';
export const movenet = {modelType: {SINGLEPOSE_LIGHTNING, SINGLEPOSE_THUNDER, MULTIPOSE_LIGHTNING}};
export async function createDetector(model, modelConfig) {
  if (model !== SupportedModels.MoveNet) throw new Error(model + ' is not in this build: MoveNet only');
  return load(modelConfig);
}
`;

// What the spike stubs (spike/pose-bench/build-tfjs.mjs). MoveNet's entry
// never reaches it; the stub keeps the closed runtime out if that changes.
const MEDIAPIPE_STUB = "export class Pose { constructor() { throw new Error('@mediapipe/pose is not bundled'); } }";

export function cacheDir(env = process.env) {
  const base = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(homedir(), '.cache');
  return join(base, 'coach');
}

export function isInside(dir, root) {
  const r = relative(resolve(root), resolve(dir));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

// The patches for one repo, in name order, and the files each one changes.
export function readPatches(patchDir) {
  if (!existsSync(patchDir)) return [];
  return readdirSync(patchDir).filter(f => f.endsWith('.patch')).sort().map(name => {
    const text = readFileSync(join(patchDir, name), 'utf8');
    const reason = (text.match(/^Reason: (.+)$/m) || [])[1] || '';
    const files = [...text.matchAll(/^\+\+\+ b\/(\S+)/gm)].map(m => m[1]);
    return { name, path: join(patchDir, name), text, reason, files };
  });
}

// The converter's op lists: each JSON in the tag becomes a .ts module, as
// gen_op.ts writes it (the JSON's double quotes made single).
export function opListTs(jsonText, year = OP_LIST_YEAR) {
  return `
/**
 * @license
 * Copyright ${year} Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {OpMapper} from '../types';

export const json: OpMapper[] = ${jsonText.replace(/"/g, '\'')};
`;
}

function generateOpLists(tfjsDir) {
  const from = join(tfjsDir, 'tfjs-converter/python/tensorflowjs/op_list');
  const to = join(tfjsDir, 'tfjs-converter/src/operations/op_list');
  mkdirSync(to, { recursive: true });
  const names = readdirSync(from).filter(f => f.endsWith('.json')).sort();
  for (const f of names) writeFileSync(join(to, f.replace(/\.json$/, '.ts')), opListTs(readFileSync(join(from, f), 'utf8')));
  return names.length;
}

// A clone, ready to bundle: the pinned commit, our patches applied, the
// generated sources written. The marker says what was done, so a second run
// reuses it and a change to the patches prepares it again.
function prepare(name, src, cache, log) {
  const dir = join(cache, src.tag);
  const patches = readPatches(join(HERE, 'patches', name));
  const want = JSON.stringify({
    commit: src.commit, patches: patches.map(p => [p.name, sha256(p.text)]),
    opLists: name === 'tfjs' ? OP_LIST_YEAR : null,
  });
  const marker = join(dir, '.coach-prepared');
  if (existsSync(dir)) {
    const head = git(['-C', dir, 'rev-parse', 'HEAD']);
    if (head !== src.commit) throw new Error(`${dir}: HEAD ${head}, expected ${src.commit} (${src.tag}); remove it and run again`);
    if (existsSync(marker) && readFileSync(marker, 'utf8') === want) {
      log(`${name}: reusing ${dir}`);
      return { dir, patches };
    }
    log(`${name}: preparing ${dir} again`);
    git(['-C', dir, 'checkout', '-q', '--', '.']);
    git(['-C', dir, 'clean', '-fdxq']);
  } else {
    const tmp = `${dir}.part`;
    rmSync(tmp, { recursive: true, force: true });
    log(`${name}: cloning ${src.url} at ${src.tag}`);
    git(['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', src.tag, src.url, tmp],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    const head = git(['-C', tmp, 'rev-parse', 'HEAD']);
    if (head !== src.commit) throw new Error(`${src.tag} is ${head}, expected the pinned ${src.commit}`);
    renameSync(tmp, dir);
  }
  for (const p of patches) {
    git(['-C', dir, 'apply', '--check', p.path]);
    git(['-C', dir, 'apply', p.path]);
    log(`${name}: applied ${p.name}`);
  }
  if (name === 'tfjs') log(`tfjs: ${generateOpLists(dir)} op lists generated`);
  writeFileSync(marker, want);
  return { dir, patches };
}

// The notice Apache-2.0 §4(b) asks for: each file we changed, and why.
export function patchNotice(patchSets) {
  const lines = [];
  for (const [repo, patches] of Object.entries(patchSets)) {
    for (const p of patches) for (const f of p.files) lines.push(` *   ${repo}/${f}: changed by coach (${p.name}${p.reason ? `: ${p.reason}` : ''})`);
  }
  return lines.length ? ` * Modified files (Apache-2.0 §4(b)):\n${lines.join('\n')}`
    : ' * Modified files (Apache-2.0 §4(b)): none; built from the tags unchanged.';
}

function banner(name, info, patchSets) {
  const s = SOURCES;
  return `/**
 * coach's TF.js bundle, ${name} backend: tfjs-core, tfjs-converter, tfjs-backend-${name} ${info.tfjsVersion}
 * and pose-detection ${info.poseDetectionVersion} (MoveNet only), built from source by app/tools/build-tfjs.mjs
 * with esbuild ${esbuildVersion}.
 * Sources: ${s.tfjs.url} at ${s.tfjs.tag} (${s.tfjs.commit}),
 *          ${s['tfjs-models'].url} at ${s['tfjs-models'].tag} (${s['tfjs-models'].commit}).
 * Licence: Apache-2.0 (LICENSE-tfjs.txt, LICENSE-tfjs-models.txt); bundled: long 4.0.0 (Apache-2.0,
 * LICENSE-long.txt), seedrandom 3.0.5 (MIT, LICENSE-seedrandom.txt).
 * The converter's op lists are generated from the tag's JSON (tfjs-converter/scripts/gen_op.ts's output).
${patchNotice(patchSets)}
 */`;
}

// seedrandom ships no LICENSE file: its MIT text heads seedrandom.js, and
// alea.js (bundled with it) carries its own.
function seedrandomLicence(dir) {
  const main = readFileSync(join(dir, 'seedrandom.js'), 'utf8').match(/^\/\*([\s\S]*?)\*\//)[1].trim();
  const alea = readFileSync(join(dir, 'lib/alea.js'), 'utf8').split('\n')
    .slice(0, 24).map(l => l.replace(/^\/\/ ?/, '')).join('\n').trim();
  return `seedrandom 3.0.5 (MIT), from seedrandom.js:\n\n${main}\n\n---\n\nlib/alea.js:\n\n${alea}\n`;
}

export async function buildTfjs({ out = join(APP, 'vendor/tfjs'), cache = cacheDir(), log = console.log } = {}) {
  if (isInside(cache, REPO)) throw new Error(`the cache ${cache} is inside the repo: set XDG_CACHE_HOME elsewhere`);
  mkdirSync(cache, { recursive: true });
  const tfjs = prepare('tfjs', SOURCES.tfjs, cache, log);
  const models = prepare('tfjs-models', SOURCES['tfjs-models'], cache, log);
  const patchSets = { tfjs: tfjs.patches, 'tfjs-models': models.patches };
  const pdSrc = join(models.dir, 'pose-detection/src');
  const info = {
    tfjsVersion: JSON.parse(readFileSync(join(tfjs.dir, 'tfjs-core/package.json'), 'utf8')).version,
    poseDetectionVersion: JSON.parse(readFileSync(join(models.dir, 'pose-detection/package.json'), 'utf8')).version,
  };
  const nodeModules = join(APP, 'node_modules');

  mkdirSync(out, { recursive: true });
  const result = { esbuild: esbuildVersion, sources: SOURCES, bundles: {}, patches: {} };
  for (const [repo, ps] of Object.entries(patchSets)) result.patches[repo] = ps.map(p => ({ name: p.name, reason: p.reason, files: p.files }));

  for (const [name, b] of Object.entries(BUNDLES)) {
    const outfile = join(out, `tfjs-${name}.mjs`);
    const node = b.platform === 'node';
    const t0 = performance.now();
    const res = await build({
      stdin: {
        contents: `export * as tf from '@tensorflow/tfjs-core';
export * as converter from '@tensorflow/tfjs-converter';
export * as poseDetection from 'coach:pose-detection-movenet';
import '${b.backend}';
`,
        resolveDir: tfjs.dir, sourcefile: `tfjs-${name}-entry.ts`, loader: 'ts',
      },
      // The tag's root tsconfig: its path map sends @tensorflow/<pkg> (and
      // <pkg>/dist/*) to the TypeScript; it applies to tfjs-models' files too.
      tsconfig: join(tfjs.dir, 'tsconfig.json'),
      // long and seedrandom, tfjs-core's and the CPU backend's two plain-JS
      // dependencies, at the versions tfjs-core's yarn.lock pins.
      nodePaths: [nodeModules],
      // The packages' "sideEffects" lists name dist/*.js and src/*.mjs, not
      // the .ts sources: honoured, they would drop the kernel registrations.
      ignoreAnnotations: true,
      bundle: true, format: 'esm', minify: true, target: 'es2020',
      platform: b.platform, mainFields: node ? ['module', 'main'] : undefined,
      external: node ? ['node-fetch'] : [],
      outfile, legalComments: 'eof', logLevel: 'warning', metafile: true,
      banner: { js: banner(name, info, patchSets) + (node
        ? "\nimport { createRequire as __coachCreateRequire } from 'node:module'; const require = __coachCreateRequire(import.meta.url);"
        : '') },
      plugins: [{
        name: 'coach-sources',
        setup(pb) {
          pb.onResolve({ filter: /^coach:pose-detection-movenet$/ }, () => ({ path: join(pdSrc, 'coach_movenet_entry.ts'), namespace: 'coach-entry' }));
          pb.onLoad({ filter: /.*/, namespace: 'coach-entry' }, () => ({ contents: MOVENET_ENTRY, loader: 'ts', resolveDir: pdSrc }));
          pb.onResolve({ filter: /^@mediapipe\/pose$/ }, () => ({ path: 'stub', namespace: 'mediapipe-stub' }));
          pb.onLoad({ filter: /.*/, namespace: 'mediapipe-stub' }, () => ({ contents: MEDIAPIPE_STUB, loader: 'js' }));
        },
      }],
    });
    const inputs = Object.keys(res.metafile.inputs);
    const bytes = statSync(outfile).size;
    result.bundles[`tfjs-${name}.mjs`] = {
      bytes, sha256: sha256(readFileSync(outfile)), ms: Math.round(performance.now() - t0), inputs: inputs.length,
      packages: [...new Set(inputs.map(i => (i.match(/(tfjs-[a-z-]+|pose-detection|long|seedrandom|mediapipe-stub)\//) || [])[1]).filter(Boolean))].sort(),
    };
    log(`tfjs-${name}.mjs  ${(bytes / 1e6).toFixed(2)} MB  (${inputs.length} sources, ${result.bundles[`tfjs-${name}.mjs`].ms} ms)`);
  }

  copyFileSync(join(tfjs.dir, 'LICENSE'), join(out, 'LICENSE-tfjs.txt'));
  copyFileSync(join(models.dir, 'LICENSE'), join(out, 'LICENSE-tfjs-models.txt'));
  copyFileSync(join(nodeModules, 'long/LICENSE'), join(out, 'LICENSE-long.txt'));
  writeFileSync(join(out, 'LICENSE-seedrandom.txt'), seedrandomLicence(join(nodeModules, 'seedrandom')));
  writeFileSync(join(out, 'build-info.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  await buildTfjs(i > 0 ? { out: resolve(process.argv[i + 1]) } : {});
}
