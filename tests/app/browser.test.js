'use strict';
// c47: a test's browser ends with the test. /usr/bin/brave-browser is a bash wrapper whose last line is
// `"$HERE/brave" "$@" || true` (no exec): killing the spawned wrapper orphans the real browser. app/tools/browser.mjs
// launches the browser and closes its whole tree; the five tools use it and never spawn a browser themselves.
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
const FIVE = ['page-test.mjs', 'check-tfjs.mjs', 'check-offline.mjs', 'check-pose.mjs', 'check-media.mjs'];
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

test('the five tools launch and close the browser through browser.mjs, none spawns one itself', () => {
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
