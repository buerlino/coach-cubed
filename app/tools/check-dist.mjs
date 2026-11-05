// SPDX-License-Identifier: AGPL-3.0-or-later
// Checks an assembled folder before it is published (package c67):
//
//   node app/tools/check-dist.mjs [--release] DIR
//
// - files.json lists every file of DIR but itself, and only those (the service worker fails
//   its whole install on one listed file that is missing, and ignores one that is not listed);
// - no debug/ and no page-test/ (the check page and the replay engine are not for the public),
//   no video (.mp4), no file or folder whose name starts with a dot (actions/upload-pages-artifact
//   leaves those out of the Pages artifact);
// - sw.js carries files.json's version (BUILT_VERSION);
// - with --release also the three things a published build is not one without: the pose model
//   (models/movenet-thunder-4/model.json), the TF.js bundle (vendor/tfjs/tfjs-webgl.mjs) and
//   CNAME (assemble.mjs --cname). assemble.mjs only logs "absent, skipped" for the first two.
//
// One line per problem on stderr and exit 1; else one line with the file count and the total
// bytes. Node only, no dependencies.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_FILES = [
  'models/movenet-thunder-4/model.json',
  'vendor/tfjs/tfjs-webgl.mjs',
  'CNAME',
];

// Every file under dir, dot files included (the point of the check), as '/'-separated paths.
function listAll(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * @param {string} dir an assembled folder
 * @param {{release?: boolean}} [opts]
 * @returns {{problems: string[], files: number, bytes: number}}
 */
export function checkDist(dir, { release = false } = {}) {
  dir = resolve(dir);
  const problems = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { problems: [`${dir} is not a folder`], files: 0, bytes: 0 };
  const files = listAll(dir);
  const bytes = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);

  for (const f of files) {
    if (f.startsWith('debug/')) problems.push(`${f}: debug/ is the debug APK's check page, not for a release`);
    else if (f.startsWith('page-test/')) problems.push(`${f}: page-test/ is the test build's replay engine, not for a release`);
    if (/\.mp4$/i.test(f)) problems.push(`${f}: a video`);
    if (f.split('/').some((s) => s.startsWith('.'))) problems.push(`${f}: a name starting with a dot (the Pages artifact leaves it out)`);
  }

  let list = null;
  if (!files.includes('files.json')) problems.push('files.json: missing');
  else {
    try { list = JSON.parse(readFileSync(join(dir, 'files.json'), 'utf8')); } catch { problems.push('files.json: not JSON'); }
  }
  if (list && (typeof list.version !== 'string' || !Array.isArray(list.files))) {
    problems.push('files.json: no version and list of files');
    list = null;
  }
  if (list) {
    const listed = new Set(list.files);
    for (const f of list.files) if (!files.includes(f)) problems.push(`${f}: listed in files.json but not in the folder`);
    for (const f of files) if (f !== 'files.json' && !listed.has(f)) problems.push(`${f}: in the folder but not listed in files.json`);
    if (listed.has('files.json')) problems.push('files.json: lists itself');
    if (!files.includes('sw.js')) problems.push('sw.js: missing');
    else {
      const m = readFileSync(join(dir, 'sw.js'), 'utf8').match(/const BUILT_VERSION = (null|"[^"\n]*");/);
      if (!m) problems.push('sw.js: no BUILT_VERSION stamp');
      else if (m[1] !== JSON.stringify(list.version)) problems.push(`sw.js: BUILT_VERSION is ${m[1]} but files.json is version ${list.version}`);
    }
  }

  if (release) for (const f of RELEASE_FILES) if (!files.includes(f)) problems.push(`${f}: missing (a release needs it)`);
  return { problems, files: files.length, bytes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const release = args.includes('--release');
  const rest = args.filter((a) => a !== '--release');
  if (rest.length !== 1 || rest[0].startsWith('--')) {
    console.error('usage: check-dist.mjs [--release] DIR');
    process.exit(2);
  }
  const { problems, files, bytes } = checkDist(rest[0], { release });
  if (problems.length) {
    for (const p of problems) console.error(`check-dist: ${p}`);
    process.exit(1);
  }
  console.log(`check-dist: ${rest[0]}: ${files} files, ${bytes} bytes${release ? ' (release)' : ''}: ok`);
}
