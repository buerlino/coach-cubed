// node app/tools/check-apk.mjs --serial <serial> [--engine N] [--apk PATH] [--port P] [--keep]
//
// The debug APK on a phone (package c20): installs app/out/coach-debug.apk
// (build-apk.sh), starts it, checks the app shell opened, then drives the
// check page (app/debug/, debug builds only) over the WebView's DevTools:
//   1. the basics: the WebView, WebGL, OPFS (a folder of its own, removed
//      after) and persist();
//   2. file import: the page's <input type="file"> clicked with a user gesture
//      opens Android's picker (the resumed activity is recorded, then Back);
//      the test clip, copied into the app's own files/ with run-as, is set on
//      the input (DOM.setFileInputFiles) and opened by the frame source;
//   3. the pose engine, N runs (5) on the test clip: create, every frame,
//      reset, frames 0 and 1 again.
// Prints one JSON object; uninstalls the app after (unless --keep) and removes
// its forward and the pushed file. Touches nothing but coach's own app.
// The phone's lock and stay-awake are the caller's (docs/pipeline.md, "The phone").
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = 'org.coach.placeholder';   // the placeholder app ID (capacitor.config.json)
const CLIP = resolve(APP, '../tests/app/clips/testsrc2-h264-30fps.mp4');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const SERIAL = arg('--serial', process.env.ANDROID_SERIAL);
const ENGINE_RUNS = Number(arg('--engine', 5));
const APK = resolve(arg('--apk', resolve(APP, 'out/coach-debug.apk')));
const PORT = Number(arg('--port', 9335));
const KEEP = process.argv.includes('--keep');
if (!SERIAL) { console.error('check-apk: --serial <serial> (or ANDROID_SERIAL) is required'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const adb = (...a) => execFileSync('adb', ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 120000 }).replace(/\r/g, '').trim();
const sh = cmd => adb('shell', cmd);
const resumed = () => (sh('dumpsys activity activities').match(/(?:mResumedActivity|topResumedActivity)[^\n]*?\{[^}]*?\s(\S+\/\S+)/) || [])[1] || null;

async function cdp(port) {
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find(t => t.type === 'page');
    } catch { /* not up yet */ }
    if (!page) await sleep(200);
  }
  if (!page) throw new Error('no page target over DevTools');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression, opts = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...opts });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 800));
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

const out = { serial: SERIAL, package: PKG };
let forwarded = false;
const pushed = '/data/local/tmp/coach-c20-clip.mp4';
try {
  out.device = {
    model: sh('getprop ro.product.model'), android: sh('getprop ro.build.version.release'),
    build: sh('getprop ro.build.display.id'),
    webview: (sh('dumpsys webviewupdate').match(/Current WebView package \(name, version\): \(([^)]*)\)/) || [])[1] || null,
  };
  let t = Date.now();
  adb('install', '-r', APK);
  out.installMs = Date.now() - t;
  sh(`am force-stop ${PKG}`);
  sh(`am start -n ${PKG}/.MainActivity`);
  let pid = '';
  for (let i = 0; i < 50 && !pid; i++) { await sleep(200); try { pid = sh(`pidof ${PKG}`); } catch { pid = ''; } }
  if (!pid) throw new Error('the app did not start');
  adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
  forwarded = true;
  let c = await cdp(PORT);
  // The app shell: index.html loaded and the shell drew into #app.
  for (let i = 0; i < 50; i++) {
    if (await c.evaluate("document.readyState === 'complete' && !!document.querySelector('#app')?.children.length")) break;
    await sleep(200);
  }
  out.shell = await c.evaluate(`({ href: location.href, title: document.title,
    drawn: document.querySelector('#app')?.children.length || 0, text: (document.body.innerText || '').slice(0, 200) })`);
  out.shell.resumed = resumed();

  // The check page, in the same WebView (same origin, so OPFS is the app's).
  const origin = new URL(out.shell.href).origin;
  await c.send('Page.navigate', { url: `${origin}/debug/check.html` });
  await sleep(1000);
  c.close();
  c = await cdp(PORT);
  for (let i = 0; i < 100; i++) {
    if (await c.evaluate("typeof window.c20 === 'object' && !!window.c20.basics")) break;
    await sleep(200);
  }
  out.basics = await c.evaluate('window.c20.basics', { timeout: 60000 });

  // File import: the picker, then the input set to the clip in the app's own files/.
  const before = resumed();
  await c.evaluate("document.getElementById('file').click(), true", { userGesture: true, awaitPromise: false });
  await sleep(2500);
  const picker = resumed();
  sh('input keyevent KEYCODE_BACK');
  await sleep(1500);
  out.picker = { before, opened: picker, after: resumed() };
  adb('push', CLIP, pushed);
  try { sh(`run-as ${PKG} cp ${pushed} files/coach-c20-clip.mp4`); } finally { sh(`rm -f ${pushed}`); }
  const doc = await c.send('DOM.getDocument', {});
  const node = await c.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#file' });
  const set = await c.send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [`/data/user/0/${PKG}/files/coach-c20-clip.mp4`] });
  out.import = set.error ? { error: set.error.message }
    : await c.evaluate("(async () => { for (let i = 0; i < 100 && !window.c20.import; i++) await new Promise(r => setTimeout(r, 100)); return window.c20.import || { error: 'no change event' }; })()", { timeout: 60000 });

  if (ENGINE_RUNS > 0) {
    out.engine = await c.evaluate(`window.c20.runEngine(${ENGINE_RUNS})`, { timeout: 900000 });
  }
  c.close();
} catch (e) {
  out.error = String((e && e.stack) || e);
} finally {
  if (forwarded) try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* gone */ }
  if (!KEEP) try { adb('uninstall', PKG); out.uninstalled = true; } catch (e) { out.uninstalled = String(e.message || e); }
}
console.log(JSON.stringify(out, null, 2));
process.exit(out.error ? 1 : 0);
