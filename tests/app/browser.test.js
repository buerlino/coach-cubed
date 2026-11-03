'use strict';
// c47: a test's browser ends with the test. /usr/bin/brave-browser is a bash wrapper whose last line is
// `"$HERE/brave" "$@" || true` (no exec): killing the spawned wrapper orphans the real browser. app/tools/browser.mjs
// launches the browser and closes its whole tree; the tools use it and never spawn a browser themselves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOLS = path.join(ROOT, 'app', 'tools');
const HELPER = path.join(TOOLS, 'browser.mjs');
const FIVE = ['page-test.mjs', 'check-tfjs.mjs', 'check-offline.mjs', 'check-pose.mjs', 'check-media.mjs', 'layout-check.mjs', 'check-capture.mjs'];   // d25 added the sixth, c27 the seventh
const sleep = ms => new Promise(r => setTimeout(r, ms));

const load = () => import(pathToFileURL(HELPER).href);   // fails (red) while the helper does not exist
const procsWith = needle => spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).stdout.split('\n')
  .filter(l => l.includes(needle) && !/\bps -eo\b/.test(l));
async function noneWithin(needle, ms) {
  const end = Date.now() + ms;
  let left = procsWith(needle);
  while (left.length && Date.now() < end) { await sleep(200); left = procsWith(needle); }
  return left;
}

test('the tools (the five of c47, the d25 layout check and the c27 capture check) launch and close the browser through browser.mjs, none spawns one itself', () => {
  assert.ok(fs.existsSync(HELPER), 'app/tools/browser.mjs exists');
  for (const f of FIVE) {
    const text = fs.readFileSync(path.join(TOOLS, f), 'utf8');
    assert.ok(!/\bspawn\(/.test(text), `${f} calls spawn(`);
    assert.ok(!/\bbrowser\.kill\(/.test(text), `${f} kills a browser itself`);
    assert.match(text, /from '\.\/browser\.mjs'/, `${f} imports the helper`);
    assert.match(text, /launchBrowser\(/, `${f} launches through launchBrowser`);
    assert.ok(!/function findBrowser/.test(text), `${f} has its own findBrowser`);
  }
});

async function found(t) {
  assert.ok(fs.existsSync(HELPER), 'app/tools/browser.mjs exists');
  const { findBrowser } = await load();
  const b = findBrowser();
  if (!b) t.skip('no Brave or Chromium found on PATH (COACH_BROWSER / --browser give one): nothing to launch');
  return b;
}

test('live: close() leaves no process with the profile in its command line within 5 s', async t => {
  const b = await found(t);
  if (!b) return;
  const { launchBrowser } = await load();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-browser-test-'));
  try {
    const br = await launchBrowser(profile, ['--headless=new', 'about:blank']);
    assert.ok(Number(br.port) > 0, 'a DevTools port');
    assert.ok(procsWith(profile).length > 1, 'the browser and its children run');
    await br.close();
    await br.close();   // idempotent
    assert.deepEqual(await noneWithin(profile, 5000), []);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('live: a node script SIGTERMed (what timeout sends) takes its browser with it', async t => {
  const b = await found(t);
  if (!b) return;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-browser-test-'));
  const script = path.join(profile, 'child.mjs');
  fs.writeFileSync(script, `import { launchBrowser } from ${JSON.stringify(pathToFileURL(HELPER).href)};
await launchBrowser(${JSON.stringify(profile + '/p')}, ['--headless=new', 'about:blank']);
console.log('ready');
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('the child never got its browser')), 40000);
      child.stdout.on('data', d => { if (String(d).includes('ready')) { clearTimeout(timer); res(); } });
      child.on('exit', () => rej(new Error('the child exited early')));
    });
    assert.ok(procsWith(profile + '/p').length > 1, 'the browser runs');
    const exited = new Promise(r => child.on('exit', r));
    child.kill('SIGTERM');
    await exited;
    assert.deepEqual(await noneWithin(profile + '/p', 5000), []);
  } finally {
    child.kill('SIGKILL');
    for (const l of procsWith(profile + '/p')) { try { process.kill(Number(l.trim().split(/\s+/)[0]), 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// c52: the browser's singleton folder (org.chromium.Chromium.*, SingletonCookie and SingletonSocket) and Brave's component
// updater folders (org.chromium.Chromium.BraveComponentUpdater_*) land in the temp folder. A stand-in browser makes them
// the way Brave does (in its $TMPDIR, plus the DevTools line), so the test is quick, needs no Brave, and counts only what
// its own browser made: os.tmpdir() is a private folder of the test's (TMPDIR), nothing else on the machine writes there.
const FAKE = `#!/bin/bash
mkdir -p "$TMPDIR/org.chromium.Chromium.fAkE01" "$TMPDIR/org.chromium.Chromium.BraveComponentUpdater_chrome_url_fetcher_.fAkE02"
: > "$TMPDIR/org.chromium.Chromium.fAkE01/SingletonCookie"
: > "$TMPDIR/org.chromium.Chromium.fAkE01/SingletonSocket"
echo "DevTools listening on ws://127.0.0.1:9/devtools/browser/fake" >&2
sleep 300 &
wait
`;

async function withFake(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-c52-'));
  const priv = path.join(root, 'tmp');   // os.tmpdir() for the duration of the test
  fs.mkdirSync(priv);
  const fake = path.join(root, 'fake-brave');
  fs.writeFileSync(fake, FAKE, { mode: 0o755 });
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = priv;
  try {
    assert.equal(os.tmpdir(), priv);
    const { launchBrowser } = await load();
    await fn({ launchBrowser, fake, priv, root, profile: path.join(priv, 'profile') });
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    for (const l of procsWith(root)) { try { process.kill(Number(l.trim().split(/\s+/)[0]), 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
const chromiumEntries = dir => fs.readdirSync(dir).filter(n => n.startsWith('org.chromium.Chromium'));

test('c52: close() leaves no org.chromium.Chromium.* entry in the temp folder (singleton and component updater folders)', async () => {
  await withFake(async ({ launchBrowser, fake, priv, profile }) => {
    const br = await launchBrowser(profile, ['--headless=new', 'about:blank'], { browser: fake });
    await br.close();
    assert.deepEqual(chromiumEntries(priv), []);
    assert.deepEqual(chromiumEntries(priv).filter(n => n.includes('BraveComponentUpdater')), []);
  });
});

test('c52: a browser killed before close() (killNow, the exit handler) leaves no org.chromium.Chromium.* entry', async () => {
  await withFake(async ({ launchBrowser, fake, priv, profile }) => {
    const br = await launchBrowser(profile, ['--headless=new', 'about:blank'], { browser: fake });
    br.killNow();
    // the exit handler calls killNow() alone, never close(): it must have removed the folder by itself
    assert.ok(!fs.existsSync(path.join(profile, 't')), 'killNow() removed the browser\'s own temp folder');
    assert.deepEqual(chromiumEntries(priv), []);
    await br.close();   // cleanup only
  });
});

test('c52: a browser whose processes were killed from outside, then close(), leaves no org.chromium.Chromium.* entry', async () => {
  await withFake(async ({ launchBrowser, fake, priv, profile }) => {
    const br = await launchBrowser(profile, ['--headless=new', 'about:blank'], { browser: fake });
    br.child.kill('SIGKILL');
    for (const l of procsWith(profile)) { try { process.kill(Number(l.trim().split(/\s+/)[0]), 'SIGKILL'); } catch { /* gone */ } }
    await br.close();
    assert.deepEqual(chromiumEntries(priv), []);
  });
});

test('c52: the browser gets its own TMPDIR inside the profile\'s folder, and the component updater is off', async () => {
  await withFake(async ({ launchBrowser, fake, priv, profile }) => {
    let seen = null;
    const spy = path.join(path.dirname(fake), 'spy-brave');
    fs.writeFileSync(spy, `#!/bin/bash\nprintf '%s\\n' "$TMPDIR" > "${path.dirname(fake)}/tmpdir.txt"\nprintf '%s\\n' "$@" > "${path.dirname(fake)}/argv.txt"\necho "DevTools listening on ws://127.0.0.1:9/devtools/browser/fake" >&2\nsleep 300 &\nwait\n`, { mode: 0o755 });
    const br = await launchBrowser(profile, ['--headless=new', 'about:blank'], { browser: spy });
    try {
      seen = fs.readFileSync(path.join(path.dirname(fake), 'tmpdir.txt'), 'utf8').trim();
      const argv = fs.readFileSync(path.join(path.dirname(fake), 'argv.txt'), 'utf8').split('\n');
      assert.ok(seen.startsWith(profile + path.sep), `TMPDIR ${seen} is inside the profile ${profile}`);
      assert.ok(argv.includes('--disable-component-update'), 'the component updater is off');
      assert.ok(argv.includes('--disable-background-networking'), 'background networking is off');
      assert.ok(argv.includes('about:blank'), 'the caller\'s own arguments are kept');
    } finally { await br.close(); }
    assert.ok(!fs.existsSync(seen), 'its temp folder is gone after close()');
    assert.equal(chromiumEntries(priv).length, 0);
  });
});

test('live c52: a real launch and close adds no org.chromium.Chromium.* entry to the temp folder', async t => {
  const b = await found(t);
  if (!b) return;
  const { launchBrowser } = await load();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-c52-live-'));
  const priv = path.join(root, 'tmp');
  fs.mkdirSync(priv);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = priv;
  try {
    const br = await launchBrowser(path.join(priv, 'profile'), ['--headless=new', 'about:blank']);
    await br.close();
    assert.deepEqual(chromiumEntries(priv), []);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
