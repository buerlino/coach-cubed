// Assembles the app into one folder, app/dist/ by default: what the PWA host
// and Capacitor get, and what serve.mjs serves.
//
//   node app/tools/assemble.mjs [--debug] [--test] [--out DIR] [--app DIR] [--src DIR]
//
// - app/ without tools/, android/, dist/, debug/, out/ (the APK), capacitor.config.json and
//   node_modules/ (any node_modules);
// - with --debug only (the debug APK, tools/build-apk.sh): app/debug/, the
//   check page (c20), and the test clip it poses, tests/app/clips/
//   testsrc2-h264-30fps.mp4, into debug/clips/. The shipped dist/ is
//   assembled without it, so it never holds the check page;
// - with --test only (the page test, c21: app/tools/page-test.mjs, which assembles into a temporary
//   folder): app/page-test/, the replay engine and the boot that puts it in the queue, as page-test/;
//   two committed fixture tracks (TEST_TRACKS) beside them, listed in page-test/tracks.json; and
//   index.html loading page-test/boot.mjs before main.mjs. The test build needs neither
//   vendor/tfjs/ nor models/. The shipped dist/ is assembled without it: no replay engine, no track;
// - src/diagnostics.js and src/track/ from the repo's src/ (the old page
//   serves them, so they stay there), into src/ of the output: the same
//   relative imports work in the repo and here (app/README.md);
// - THIRD_PARTY.md's section "In the new app (`app/`)" only (from its heading to the
//   next `## `), as licences/THIRD_PARTY.md: S1's credits offer that list (d24);
//   the old page's, the dev server's, the spike's and the other sections don't
//   ship in the app, so they stay out. The licence texts the credits name sit next to
//   their components in app/ (vendor/, licences/) and are copied with it;
//   checkLicences() says which one is missing (the CLI runs it after assembling);
// - app/vendor/tfjs/ and app/models/ when present (gitignored, made by s6);
//   absent, it says so and goes on;
// - files.json for the service worker (c19): every file copied, sorted, and a
//   version hash over their names and contents. Not itself in the list.
//   sw.js is hashed as it is in app/, then stamped with that version in dist/
//   (`const BUILT_VERSION = null;`): its bytes then change with every version,
//   which is what makes a browser look for an update, and it knows which
//   cache is its own.
//
// Node only, no dependencies. --app and --src exist for the tests.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKIP_TOP = new Set(['tools', 'android', 'dist', 'debug', 'page-test', 'out', 'node_modules', 'capacitor.config.json']);
// What --debug adds: the check page's clip, from the repo's tests/ (relative to src/'s parent).
export const DEBUG_CLIPS = ['testsrc2-h264-30fps.mp4'];
// What --test adds: the committed tracks the replay engine answers with (tests/fixtures/global/, from src/'s
// parent), each with the lift it is scored as; the page test's clips are matched to them (tests/app/clips/).
export const TEST_TRACKS = [
  { id: 'example/lateral-raise-cable-1', lift: 'lateral-raise', file: 'lateral-raise-cable-1.track.json' },
  { id: 'example/athlete-a-trim', lift: 'snatch', file: 'athlete-a-trim.track.json' },
];
const TEST_BOOT = '<script type="module" src="./page-test/boot.mjs"></script>\n';
const MAIN_TAG = '<script type="module" src="./src/main.mjs"></script>';
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
    if (a === '--test') { opts.test = true; continue; }
    if (!['--out', '--app', '--src'].includes(a) || i + 1 >= argv.length) throw new Error(`usage: assemble.mjs [--debug] [--test] [--out DIR] [--app DIR] [--src DIR] (got ${a})`);
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

// sw.js with the version put in at its stamp point; no stamp point is an error.
export function stampWorker(text, version) {
  const stamp = 'const BUILT_VERSION = null;';
  if (!text.includes(stamp)) throw new Error(`sw.js has no stamp point (${stamp})`);
  return text.replace(stamp, () => `const BUILT_VERSION = ${JSON.stringify(version)};`);
}

const NEW_APP_HEADING = '## In the new app (`app/`)';

/** THIRD_PARTY.md's section for the new app: its heading to the next `## ` (or the end). */
export function newAppSection(text) {
  const start = text.indexOf(`\n${NEW_APP_HEADING}\n`);
  if (start < 0) throw new Error(`THIRD_PARTY.md has no section "${NEW_APP_HEADING}"`);
  const from = start + 1;
  const next = text.indexOf('\n## ', from + NEW_APP_HEADING.length);
  return `${text.slice(from, next < 0 ? text.length : next).trimEnd()}\n`;
}

function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

export function assemble({ out, app, src, debug = false, test = false, log = console.log }) {
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
  const thirdParty = join(src, '..', 'THIRD_PARTY.md');
  if (existsSync(thirdParty)) {
    mkdirSync(join(out, 'licences'), { recursive: true });
    writeFileSync(join(out, 'licences', 'THIRD_PARTY.md'), newAppSection(readFileSync(thirdParty, 'utf8')));
    copied.add('licences/THIRD_PARTY.md');
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
  if (test) {
    if (!existsSync(join(app, 'page-test'))) throw new Error(`--test: ${join(app, 'page-test')} not found`);
    for (const f of listFiles(join(app, 'page-test'))) {
      copy(join(app, 'page-test', f), join(out, 'page-test', f));
      copied.add(`page-test/${f}`);
    }
    for (const t of TEST_TRACKS) {
      copy(join(src, '..', 'tests', 'fixtures', 'global', 'example', t.file), join(out, 'page-test', t.file));
      copied.add(`page-test/${t.file}`);
    }
    writeFileSync(join(out, 'page-test', 'tracks.json'), `${JSON.stringify(TEST_TRACKS, null, 2)}\n`);
    copied.add('page-test/tracks.json');
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    if (!html.includes(MAIN_TAG)) throw new Error(`--test: index.html has no ${MAIN_TAG}`);
    writeFileSync(join(out, 'index.html'), html.replace(MAIN_TAG, () => TEST_BOOT + MAIN_TAG));
  }
  for (const [dir, what] of OPTIONAL) {
    if (![...copied].some((f) => f.startsWith(`${dir}/`))) log(`${dir}/ absent, skipped: ${what}`);
  }

  const files = [...copied].sort();
  const hash = createHash('sha256');
  for (const f of files) { hash.update(f); hash.update('\0'); hash.update(readFileSync(join(out, f))); hash.update('\0'); }
  const version = hash.digest('hex').slice(0, 16);
  if (copied.has('sw.js')) writeFileSync(join(out, 'sw.js'), stampWorker(readFileSync(join(out, 'sw.js'), 'utf8'), version));
  writeFileSync(join(out, 'files.json'), `${JSON.stringify({ version, files }, null, 2)}\n`);
  log(`assembled ${files.length} files into ${out}, version ${version}${debug ? ' (debug: with the check page)' : ''}${test ? ' (test: with the replay engine)' : ''}`);
  return { version, files };
}

/**
 * The licence texts S1's credits name (app/src/credits.mjs) that are not in `out`. A text the
 * TF.js build copies (`built`) is only expected when that build is in `out`.
 * @returns {Promise<string[]>}
 */
export async function checkLicences(out, app) {
  const file = join(resolve(app), 'src', 'credits.mjs');
  if (!existsSync(file)) return [];
  const { CREDITS } = await import(pathToFileURL(file).href);
  const built = existsSync(join(out, 'vendor', 'tfjs'));
  return CREDITS.filter((c) => (!c.built || built) && !existsSync(join(out, c.text))).map((c) => c.text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const app = o.app ?? resolve(HERE, '..');
    const out = o.out ?? join(app, 'dist');
    assemble({ out, app, src: o.src ?? resolve(app, '..', 'src'), debug: !!o.debug, test: !!o.test });
    const missing = await checkLicences(out, app);
    if (missing.length) throw new Error(`licence texts the credits name are missing from ${out}: ${missing.join(', ')}`);
    if (!existsSync(join(out, 'vendor', 'tfjs'))) console.log("TF.js's licence texts absent with the bundle: they are copied when it is built");
  } catch (e) {
    console.error(`assemble: ${e.message}`);
    process.exit(1);
  }
}
