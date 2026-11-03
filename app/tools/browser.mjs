// The tools' browser (package c47): find a headless Brave or Chromium, launch it, and end it with the test.
//
//   import { findBrowser, launchBrowser } from './browser.mjs';
//   const b = await launchBrowser(profileDir, ['--enable-unsafe-swiftshader', 'about:blank']);
//   b.child; b.port; await b.close();
//
// Why this exists: /usr/bin/brave-browser (and Fedora's chromium) is a bash wrapper whose last line is
// `"$HERE/brave" "$@" || true`, without `exec`. A tool that spawns it and calls child.kill() signals only the
// wrapper: bash exits, the real browser and its GPU process live on, children of systemd, ~0.5 GB each. So close()
// ends the whole tree: the wrapper's descendants (found with `pgrep -P`, recursively, which works on Linux and
// macOS), then anything still carrying the profile's path in its command line; SIGTERM, up to 5 s of waiting, then
// SIGKILL. It is idempotent.
//
// The browser is NOT spawned `detached`: it stays in the tool's session and process group, so the pipeline's own
// kill of a check's session still reaches it. While a browser is open the helper also closes it on the process's
// SIGTERM, SIGINT and SIGHUP (then exits with the signal's code, 128 + n; `timeout` sends SIGTERM) and on `exit`
// (synchronously, SIGKILL).
//
// The temp folder (c52): Chromium makes `org.chromium.Chromium.*` folders in $TMPDIR, from two causes. Its singleton
// folder for the profile (SingletonCookie, SingletonSocket) is removed on a clean exit and left when the browser is
// killed, which close() does. Brave's component updater's `BraveComponentUpdater_*` scratch folders (new-tab wallpapers
// and extensions, most of the 363 MB) come from every headless launch, killed or not. On 2026-11-02 /tmp held 1,431
// such folders, 1,269 of them made in two hours of tests. So every browser gets a $TMPDIR of its own, `<profile>/t`
// (short: a socket path is limited to about 108 bytes), and close() and killNow() remove it; nothing outside the
// browser's own folders is touched. Checked: the singleton folder lands in that $TMPDIR. Not reproduced here: the
// updater folders never appeared in this session's runs, so they are only expected to follow $TMPDIR. The component
// updater is switched off as well (`--disable-component-update`, `--disable-background-networking`): a tool's browser
// has no business downloading Brave's wallpapers and extensions.
// A SIGKILL to node cannot be caught: the browser is then left behind (it is cleaned up by nothing but the
// pipeline's session kill, when there is one).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** The fake camera for the page test and the layout check (d28): 30 fps, and the permission granted without asking. */
export const FAKE_CAMERA = Object.freeze(['--use-fake-device-for-media-stream=fps=30', '--use-fake-ui-for-media-stream']);

export const BROWSERS = ['brave-browser', 'brave', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --browser PATH, then $COACH_BROWSER, then the first of BROWSERS on PATH. null when none exists.
export function findBrowser(argv = process.argv, env = process.env) {
  const i = argv.indexOf('--browser');
  const given = (i > 0 && i + 1 < argv.length ? argv[i + 1] : null) ?? env.COACH_BROWSER;
  if (given) return existsSync(given) ? given : null;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    for (const name of BROWSERS) if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

// pids below `pid` (children, grandchildren, ...), by pgrep -P
function descendants(pid) {
  const out = [];
  const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  for (const l of (r.stdout ?? '').split('\n')) {
    const c = Number(l.trim());
    if (c > 0) out.push(c, ...descendants(c));
  }
  return out;
}

// pids whose command line holds the profile's path: the helpers that were orphaned before we looked
function withProfile(profile) {
  const r = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
  const out = [];
  for (const l of (r.stdout ?? '').split('\n')) {
    const m = l.trim().match(/^(\d+)\s+(.*)$/);
    if (m && Number(m[1]) !== process.pid && m[2].includes(`--user-data-dir=${profile}`)) out.push(Number(m[1]));
  }
  return out;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const signal = (pids, sig) => { for (const p of pids) { try { process.kill(p, sig); } catch { /* gone */ } } };

// every pid of the browser's tree: the wrapper, its descendants and what carries the profile
function tree(child, profile) {
  const set = new Set([...(child.pid ? [child.pid, ...descendants(child.pid)] : []), ...withProfile(profile)]);
  return [...set];
}

const open = new Set();
let handlersOn = false;
const SIGNALS = { SIGTERM: 15, SIGINT: 2, SIGHUP: 1 };
function onSignal(name) {
  Promise.allSettled([...open].map(b => b.close())).then(() => process.exit(128 + SIGNALS[name]));
}
const handlers = Object.fromEntries(Object.keys(SIGNALS).map(n => [n, () => onSignal(n)]));
function onExit() { for (const b of open) b.killNow(); }
function guard(b) {
  open.add(b);
  if (handlersOn) return;
  handlersOn = true;
  for (const [n, h] of Object.entries(handlers)) process.on(n, h);
  process.on('exit', onExit);
}
function unguard(b) {
  open.delete(b);
  if (open.size || !handlersOn) return;
  handlersOn = false;
  for (const [n, h] of Object.entries(handlers)) process.off(n, h);
  process.off('exit', onExit);
}

// launchBrowser(profile, args, { browser }): headless Brave/Chromium on `profile` with a DevTools port of its own.
// Resolves { child, port, close() } once the browser has printed "DevTools listening"; rejects (and closes) otherwise.
export async function launchBrowser(profile, args = [], { browser = findBrowser(), timeoutMs = 30000 } = {}) {
  if (!browser) throw new Error(`no Brave or Chromium found (looked for ${BROWSERS.join(', ')} on PATH; --browser PATH or COACH_BROWSER)`);
  const tmp = join(profile, 't');
  mkdirSync(tmp, { recursive: true });
  const removeTmp = () => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  let child;
  try {
    child = spawn(browser, [`--user-data-dir=${profile}`, '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', '--disable-component-update', '--disable-background-networking', ...args],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMPDIR: tmp } });
  } catch (e) { removeTmp(); throw e; }
  let closing = null;
  const b = {
    child, port: null,
    killNow() { signal(tree(child, profile), 'SIGKILL'); removeTmp(); },
    close() {
      closing ??= (async () => {
        const pids = tree(child, profile);
        signal(pids, 'SIGTERM');
        const end = Date.now() + 5000;
        while (Date.now() < end && pids.some(alive)) await sleep(100);
        const left = [...new Set([...pids, ...withProfile(profile)])].filter(alive);
        signal(left, 'SIGKILL');
        for (let i = 0; i < 20 && left.some(alive); i++) await sleep(50);
        removeTmp();
        unguard(b);
      })();
      return closing;
    },
  };
  guard(b);
  try {
    b.port = await new Promise((res, rej) => {
      let err = '';
      const timer = setTimeout(() => rej(new Error('no DevTools port from the browser: ' + err.slice(-500))), timeoutMs);
      child.stderr.on('data', d => {
        err = (err + d).slice(-4000);
        const m = err.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (m) { clearTimeout(timer); res(m[1]); }
      });
      child.on('exit', code => { clearTimeout(timer); rej(new Error(`the browser exited (${code}): ${err.slice(-500)}`)); });
      child.on('error', e => { clearTimeout(timer); rej(e); });
    });
  } catch (e) {
    await b.close();
    throw e;
  }
  child.removeAllListeners('exit');   // the wrapper may exit before the browser; close() looks at the tree, not at it
  return b;
}
