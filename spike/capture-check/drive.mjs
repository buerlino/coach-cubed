// node drive.mjs DEVTOOLS_PORT URL_PART 'EXPRESSION' [OUT.json] [--grant ORIGIN] [--nowait]
// Evaluates one expression in the page whose URL contains URL_PART, over the
// DevTools protocol (Brave or a WebView through `adb forward`), awaits it and
// writes the value to OUT.json (or prints it). --grant first gives ORIGIN the
// camera through the browser-level target (Browser.grantPermissions), so no
// prompt has to be tapped on the phone. --nowait starts it and returns (the
// heat run posts its own progress).
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : null; };
const grant = flag('--grant');
const nowait = args.includes('--nowait') && args.splice(args.indexOf('--nowait'), 1);
const [port, match, expression, outFile] = args;

function open(url) {
  const ws = new WebSocket(url);
  let id = 1;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  return new Promise((res, rej) => { ws.onopen = () => res({ ws, send }); ws.onerror = rej; });
}

if (grant) {
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const b = await open(v.webSocketDebuggerUrl);
  const r = await b.send('Browser.grantPermissions', { origin: grant, permissions: ['videoCapture'] });
  console.error('grantPermissions', grant, JSON.stringify(r.error || r.result));
  b.ws.close();
}
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find(p => p.type === 'page' && p.url.includes(match));
if (!page) throw new Error('no page matching ' + match + ': ' + pages.map(p => p.url).join(', '));
const { ws, send } = await open(page.webSocketDebuggerUrl);
if (expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: !nowait, returnByValue: true, timeout: 3600000 });
  const err = r.result?.exceptionDetails;
  const value = err ? { error: err.exception?.description || err.text } : r.result?.result?.value;
  const text = JSON.stringify(value, null, 1);
  if (outFile) writeFileSync(outFile, text); else console.log(text);
}
ws.close();
