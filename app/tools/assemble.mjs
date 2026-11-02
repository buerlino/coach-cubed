// Assembles the app into one folder, app/dist/ by default: what the PWA host
// and Capacitor get, and what serve.mjs serves.
//
//   node app/tools/assemble.mjs [--debug] [--out DIR] [--app DIR] [--src DIR]
//
// - app/ without tools/, android/, dist/, debug/, capacitor.config.json and
//   node_modules/ (any node_modules);
// - with --debug only (the debug APK, tools/build-apk.sh): app/debug/, the
//   check page (c20), and the test clip it poses, tests/app/clips/
//   testsrc2-h264-30fps.mp4, into debug/clips/. The shipped dist/ is
//   assembled without it, so it never holds the check page;
// - src/diagnostics.js and src/track/ from the repo's src/ (the old page
//   serves them, so they stay there), into src/ of the output: the same
//   relative imports work in the repo and here (app/README.md);
// - app/vendor/tfjs/ and app/models/ when present (gitignored, made by s6);
//   absent, it says so and goes on;
// - files.json for the service worker (c19): every file copied, sorted, and a
//   version hash over their names and contents. Not itself in the list.
//
// Node only, no dependencies. --app and --src exist for the tests.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKIP_TOP = new Set(['tools', 'android', 'dist', 'debug', 'node_modules', 'capacitor.config.json']);
// What --debug adds: the check page's clip, from the repo's tests/ (relative to src/'s parent).
export const DEBUG_CLIPS = ['testsrc2-h264-30fps.mp4'];
const OPTIONAL = [
  ['vendor/tfjs', 'the TF.js bundle (s6 builds it)'],
  ['models', "MoveNet's weights (s6 fetches them)"],
];

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === 'node_modules' || e.name === '.DS_Store') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--debug') { opts.debug = true; continue; }
    if (!['--out', '--app', '--src'].includes(a) || i + 1 >= argv.length) throw new Error(`usage: assemble.mjs [--debug] [--out DIR] [--app DIR] [--src DIR] (got ${a})`);
    opts[a.slice(2)] = argv[++i];
  }
  return opts;
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Empties `out` for a fresh run, only if it is empty, missing, or an earlier output of this tool.
function prepareOut(out, app, src) {
  if (isInside(app, out) || isInside(src, out)) throw new Error(`refusing: ${out} contains the app or src folder`);
  if (isInside(out, app) && out !== resolve(app, 'dist')) throw new Error(`refusing: ${out} is inside the app folder (use app/dist)`);
  if (!existsSync(out)) { mkdirSync(out, { recursive: true }); return; }
  const entries = readdirSync(out);
  if (entries.length === 0) return;
  if (!entries.includes('files.json')) throw new Error(`refusing to empty ${out}: it has no files.json, so it is not an earlier assemble output`);
  for (const name of entries) rmSync(join(out, name), { recursive: true, force: true });
}

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

export function assemble({ out, app, src, debug = false, log = console.log }) {
  out = resolve(out); app = resolve(app); src = resolve(src);
  for (const [dir, what] of [[app, 'app'], [src, 'src']]) if (!existsSync(dir)) throw new Error(`${what} folder not found: ${dir}`);
  prepareOut(out, app, src);

  const copied = new Set();
  for (const f of listFiles(app)) {
    if (SKIP_TOP.has(f.split('/')[0])) continue;
    copy(join(app, f), join(out, f));
    copied.add(f);
  }
  // src/track/ and diagnostics.js land in src/ of the output, over the stubs
  // app/src/track/ keeps for the repo.
  copy(join(src, 'diagnostics.js'), join(out, 'src', 'diagnostics.js'));
  copied.add('src/diagnostics.js');
  for (const f of listFiles(join(src, 'track'))) {
    copy(join(src, 'track', f), join(out, 'src', 'track', f));
    copied.add(`src/track/${f}`);
  }
  if (debug) {
    if (!existsSync(join(app, 'debug'))) throw new Error(`--debug: ${join(app, 'debug')} not found`);
    for (const f of listFiles(join(app, 'debug'))) {
      copy(join(app, 'debug', f), join(out, 'debug', f));
      copied.add(`debug/${f}`);
    }
    for (const c of DEBUG_CLIPS) {
      copy(join(src, '..', 'tests', 'app', 'clips', c), join(out, 'debug', 'clips', c));
      copied.add(`debug/clips/${c}`);
    }
  }
  for (const [dir, what] of OPTIONAL) {
    if (![...copied].some((f) => f.startsWith(`${dir}/`))) log(`${dir}/ absent, skipped: ${what}`);
  }

  const files = [...copied].sort();
  const hash = createHash('sha256');
  for (const f of files) { hash.update(f); hash.update('\0'); hash.update(readFileSync(join(out, f))); hash.update('\0'); }
  const version = hash.digest('hex').slice(0, 16);
  writeFileSync(join(out, 'files.json'), `${JSON.stringify({ version, files }, null, 2)}\n`);
  log(`assembled ${files.length} files into ${out}, version ${version}${debug ? ' (debug: with the check page)' : ''}`);
  return { version, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const app = o.app ?? resolve(HERE, '..');
    assemble({ out: o.out ?? join(app, 'dist'), app, src: o.src ?? resolve(app, '..', 'src'), debug: !!o.debug });
  } catch (e) {
    console.error(`assemble: ${e.message}`);
    process.exit(1);
  }
}
