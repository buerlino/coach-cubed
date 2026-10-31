// node run-cdp.mjs DEVTOOLS_PORT PLAN.json OUT.json [URL_PART] [COOLDOWN_S]
// Drives the bench page over the DevTools protocol (the page must be open,
// in Brave on the phone through `adb forward`, or in a local browser): for
// each entry of the plan, reloads the page (a cold start every time) and
// awaits window.bench.run(entry). Appends each summary to OUT.json as it
// goes, so a crash keeps what finished; tracks go to results/ via the page.
// Plan entry: { clip, model, ep, fps, detector?, detEvery?, tag? }.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [port, planFile, outFile, match = 'pose-bench', cooldown = '0'] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const out = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : [];

async function connect() {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find(p => p.type === 'page' && p.url.includes(match));
  if (!page) throw new Error('no page matching ' + match + ': ' + pages.map(p => p.url).join(', '));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 1;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') console.error('page exception:', m.params.exceptionDetails.text,
      m.params.exceptionDetails.exception?.description?.slice(0, 300));
  };
  const send = (method, params = {}) => new Promise(res => {
    const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { ws, send };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const { ws, send } = await connect();
await send('Runtime.enable');
await send('Page.enable');

for (const [n, entry] of plan.entries()) {
  if (n && +cooldown) await sleep(+cooldown * 1000);   // let the phone cool between runs
  const label = `${entry.clip} ${entry.model} ${entry.ep} fps=${entry.fps}${entry.tag ? ' ' + entry.tag : ''}`;
  await send('Page.reload', { ignoreCache: true });
  // Wait for the page's module to publish window.bench.
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    await sleep(500);
    const r = await send('Runtime.evaluate', { expression: '!!window.bench', returnByValue: true });
    ready = r.result?.result?.value === true;
  }
  if (!ready) { console.error(label, ': page not ready'); out.push({ entry, error: 'page not ready' }); continue; }
  const t0 = Date.now();
  const r = await send('Runtime.evaluate', {
    expression: `window.bench.run(${JSON.stringify(entry)})`, awaitPromise: true, returnByValue: true, timeout: 1800000,
  });
  const err = r.result?.exceptionDetails;
  const value = r.result?.result?.value;
  if (err || !value) {
    const msg = err ? (err.exception?.description || err.text) : JSON.stringify(r).slice(0, 500);
    console.error(label, ': ERROR', msg.slice(0, 600));
    out.push({ entry, error: msg });
  } else {
    const tm = value.timings, pf = value.perFrame;
    console.error(`${label}: ${(tm.clipTotalMs / 1000).toFixed(1)} s for ${value.frames.processed} frames, ` +
      `engine ${pf.total ? pf.total.mean.toFixed(0) : '-'} ms/frame (pose ${pf.pose ? pf.pose.mean.toFixed(0) : '-'}` +
      `, det ${pf.det ? pf.det.mean.toFixed(0) : '-'}), load ${(tm.engineLoadMs / 1000).toFixed(1)} s, wall ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    out.push({ entry, ...value });
  }
  writeFileSync(outFile, JSON.stringify(out, null, 1));
}
ws.close();
