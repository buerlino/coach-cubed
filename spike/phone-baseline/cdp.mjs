// SPDX-License-Identifier: AGPL-3.0-or-later
// cdp.mjs PORT URL_SUBSTRING EXPRESSION_FILE OUT_FILE
// Evaluates the expression (an async IIFE) in the first page whose URL
// contains URL_SUBSTRING, awaits it, and writes the returned value as JSON.
import { readFileSync, writeFileSync } from 'node:fs';

const [port, match, exprFile, outFile] = process.argv.slice(2);
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = pages.find(p => p.type === 'page' && p.url.includes(match)) || pages.find(p => p.url.includes(match));
if (!page) { console.error('no page matching', match, pages.map(p => p.url)); process.exit(2); }
console.error('page:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1;
const pending = new Map();
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method === 'Runtime.consoleAPICalled') console.error('console:', msg.params.args.map(a => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise(res => {
  const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});

await send('Runtime.enable');
const reply = await send('Runtime.evaluate', {
  expression: readFileSync(exprFile, 'utf8'), awaitPromise: true, returnByValue: true, timeout: 900000,
});
ws.close();
if (reply.result?.exceptionDetails) {
  console.error('exception:', JSON.stringify(reply.result.exceptionDetails).slice(0, 2000)); process.exit(1);
}
writeFileSync(outFile, JSON.stringify(reply.result?.result?.value ?? reply, null, 1));
console.error('wrote', outFile);
