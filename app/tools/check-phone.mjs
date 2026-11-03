// SPDX-License-Identifier: AGPL-3.0-or-later
// node app/tools/check-phone.mjs <command> --port P [--origin URL] [options]
//
// Milestone A on the phone (package c26): the app walked the way a person does,
// over the DevTools protocol of a page already open on the phone, in the debug
// APK (the WebView's webview_devtools_remote_<pid>) or in Brave
// (chrome_devtools_remote). It runs no adb itself: curie forwards the port
// (`adb -s <serial> forward tcp:P localabstract:…`) and drives the phone's own
// screens (the picker in Brave) by hand. Every tap is a touch through
// Input.dispatchTouchEvent, a real user gesture to the page.
//
//   walk --clip NAME --lift ID [--file PATH] [--tap-import] [--out FILE]
//       H → (a real tap on "Import a video" when --tap-import) → the file set on H's
//       input (--file: a path the shell can read, the APK's own files/) or picked by
//       hand (no --file: it waits for L1) → L1's tile → M: 1 on the first frame, ten
//       › steps, the filmstrip dragged to the end, 2, ↶, 2 again, 3 Analyse → Q1 to
//       the end → A1. Records: M1–M3's scroll and the boxes of [data-mark] and
//       .mark-text before and after 1, 2 and ↶; the steps' and the drag's frame times
//       (the stage canvas's draws); Analyse to Q1; the job's every progress event
//       (the app's own queue, subscribed); Q1's words; A1's scroll and cue cards; the
//       stored track, result and record; console errors and exceptions (the page and
//       its workers).
//   again --lift-id ID --clip NAME [--out FILE]
//       the stored lift queued again (the queue's enqueue, H's retry path) and run to
//       its end: the same job records, a new track; for medians without a new pick.
//   eval EXPR       an expression in the page, awaited, printed as JSON
//
// One JSON object per command, printed and appended (one line) to --out.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name, dflt) => { const i = argv.indexOf(name); return i > 0 ? argv[i + 1] : dflt; };
const PORT = Number(arg('--port', 9340));
const ORIGIN = arg('--origin', null);
const OUT = arg('--out', null) && resolve(arg('--out'));
const JOB_S = Number(arg('--job-s', 900));
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function median(values) {
  const s = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const r1 = v => (v == null ? v : Math.round(v * 10) / 10);

/**
 * A job's progress events (the queue's emits, as the page recorded them: {t, state, stage,
 * done, total, etaS}) read as s12 needs them: each stage's time, the longest wait between
 * two events and what it was, and the time left shown against the real time to done.
 * Only events of the running job count, from its first running stage to its end.
 */
export function jobTimes(events) {
  const run = events.filter(e => e.state !== 'queued');
  if (!run.length) return null;
  const end = run.find(e => e.state === 'done' || e.state === 'failed' || e.state === 'cancelled');
  const tEnd = end ? end.t : run[run.length - 1].t;
  const label = e => (e.state === 'done' || e.state === 'failed' || e.state === 'cancelled' ? e.state : `${e.stage} ${e.done}/${e.total}`);
  const what = (a, b) => {
    if (a.stage === 'reading' && a.done === 0 && b.stage === 'reading') return 'the cut read and opened';
    if (a.stage === 'reading' && b.stage === 'pose' && b.done === 0) return "the engine (its start, or the clip's reset)";
    if (a.stage === 'pose' && a.done === 0 && b.stage === 'pose' && b.done === 1) return 'the first frame';
    if (a.stage === 'pose' && b.stage === 'pose') return 'a frame';
    if (a.stage === 'pose' && b.stage === 'scoring') return 'the last frame and the stream end';
    if (a.stage === 'scoring' && b.stage === 'scoring') return 'scoring and saving';
    return 'the end';
  };
  let gap = { ms: 0 };
  for (let i = 1; i < run.length; i++) {
    const ms = run[i].t - run[i - 1].t;
    if (ms > gap.ms) gap = { ms, from: label(run[i - 1]), to: label(run[i]), what: what(run[i - 1], run[i]) };
  }
  const first = (stage, done) => run.find(e => e.stage === stage && (done == null || e.done === done));
  const at = { reading: first('reading', 0), pose: first('pose', 0), scoring: first('scoring', 0) };
  const frames = run.filter(e => e.stage === 'pose' && e.done > 0);
  const frameGaps = [];
  for (let i = 1; i < frames.length; i++) frameGaps.push(frames[i].t - frames[i - 1].t);
  const total = frames.length ? frames[frames.length - 1].total : 0;
  // the time left shown at each stage and at a tenth, half and nine tenths of the frames, against the real time to done
  const marks = [['reading 0', at.reading], ['reading 1', first('reading', 1)], ['pose 0', at.pose]];
  for (const q of [0.1, 0.5, 0.9]) marks.push([`pose ${Math.round(q * 100)} %`, frames.find(e => e.done >= Math.ceil(q * total))]);
  marks.push(['scoring 0', at.scoring]);
  return {
    state: end ? end.state : 'unfinished',
    totalMs: r1(tEnd - run[0].t),
    stagesMs: {
      reading: at.reading && at.pose ? r1(first('reading', 1) ? first('reading', 1).t - at.reading.t : null) : null,
      engine: first('reading', 1) && at.pose ? r1(at.pose.t - first('reading', 1).t) : null,
      pose: at.pose && at.scoring ? r1(at.scoring.t - at.pose.t) : null,
      scoring: at.scoring ? r1(tEnd - at.scoring.t) : null,
    },
    frames: total,
    firstFrameMs: frames.length && at.pose ? r1(frames[0].t - at.pose.t) : null,
    msPerFrame: r1(median(frameGaps)),
    msPerFrameP90: frameGaps.length ? r1([...frameGaps].sort((a, b) => a - b)[Math.floor(0.9 * frameGaps.length)]) : null,
    longestWait: { ms: r1(gap.ms), from: gap.from, to: gap.to, what: gap.what },
    timeLeft: marks.filter(([, e]) => e).map(([at_, e]) => ({ at: at_, etaS: e.etaS == null ? null : r1(e.etaS), realS: r1((tEnd - e.t) / 1000) })),
  };
}

/** Two sets of boxes ({name: {x, y, w, h}}) equal within tol px; the names that moved, with how. */
export function movedBoxes(before, after, tol = 0.5) {
  const out = [];
  for (const [k, a] of Object.entries(before)) {
    const b = after[k];
    if (!a || !b) { if (a !== b) out.push(`${k}: ${a ? 'gone' : 'appeared'}`); continue; }
    for (const p of ['x', 'y', 'w', 'h']) if (Math.abs(a[p] - b[p]) > tol) out.push(`${k}: ${p} ${a[p]} → ${b[p]}`);
  }
  return out;
}

// ---- the page ----
async function connect() {
  let page = null;
  for (let i = 0; i < 50 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find(t => t.type === 'page' && (!ORIGIN || t.url.startsWith(ORIGIN)));
    } catch { /* not up yet */ }
    if (!page) await sleep(200);
  }
  if (!page) throw new Error(`no page${ORIGIN ? ` at ${ORIGIN}` : ''} over DevTools on port ${PORT}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools socket')); });
  let id = 0;
  const pending = new Map();
  const errors = [];
  const send = (method, params = {}, sessionId) => new Promise(res => {
    pending.set(++id, res);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    const where = m.sessionId ? 'worker' : 'page';
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push({ where, kind: 'console', text: m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 400) });
    if (m.method === 'Runtime.exceptionThrown') errors.push({ where, kind: 'exception', text: (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 400) });
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push({ where, kind: 'log', text: `${m.params.entry.text} ${m.params.entry.url || ''}`.slice(0, 400) });
    if (m.method === 'Target.attachedToTarget') {
      for (const d of ['Runtime', 'Log']) send(`${d}.enable`, {}, m.params.sessionId);
      send('Runtime.runIfWaitingForDebugger', {}, m.params.sessionId);
    }
  };
  ws.onclose = () => { for (const res of pending.values()) res({ error: { message: 'DevTools closed' } }); pending.clear(); };
  for (const d of ['Runtime', 'Log']) await send(`${d}.enable`);
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const evaluate = async (expression, { timeout = 60000, objectId = false } = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: !objectId, timeout });
    if (r.error) throw new Error(r.error.message);
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return objectId ? r.result.result : r.result?.result?.value;
  };
  const waitFor = async (expression, what, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { const v = await evaluate(expression); if (v) return v; } catch { /* between documents */ }
      await sleep(100);
    }
    throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
  };
  // a touch at the element's centre: a real gesture for the page
  const tap = async (selector, text) => {
    const at = await evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'});
      if (!el || el.disabled) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!at) return false;
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
    await sleep(40);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return true;
  };
  return { send, evaluate, waitFor, tap, errors, close: () => ws.close(), url: page.url };
}

// In the page: the app's own queue (the same module main.mjs imports) and store, a recorder of one lift's job
const RECORDER = `(async () => {
  const { appQueue } = await import('./src/analysis/index.mjs');
  const q = appQueue();
  const rec = globalThis.__c26 = globalThis.__c26 || { events: [], q1: [], draws: [] };
  rec.events = []; rec.q1 = []; rec.liftId = null;
  if (!rec.off) {
    rec.off = q.subscribe(jobs => {
      const t = performance.now();
      const j = rec.liftId ? jobs.find(x => x.liftId === rec.liftId) : jobs.find(x => !['done', 'failed', 'cancelled'].includes(x.state));
      if (!j) return;
      rec.liftId = rec.liftId || j.liftId;
      const p = j.progress || {};
      const last = rec.events[rec.events.length - 1];
      const e = { t, state: j.state, stage: p.stage ?? null, done: p.done ?? null, total: p.total ?? null, etaS: p.etaS ?? null, error: j.error ?? null };
      if (!last || last.state !== e.state || last.stage !== e.stage || last.done !== e.done) rec.events.push(e);
    });
    new MutationObserver(() => {
      const el = document.querySelector('[data-screen="Q1"]');
      if (!el) return;
      const text = el.innerText.replace(/\\s+/g, ' ').trim();
      const last = rec.q1[rec.q1.length - 1];
      if (!last || last.text !== text) rec.q1.push({ t: performance.now(), text: text.slice(0, 300) });
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    // the stage canvas's draws on M (the frame shown under the playhead)
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...a) {
      const c = this.canvas;
      if (c && c.closest && c.closest('[data-screen="M"]') && c.getAttribute('aria-label') === 'The video at the playhead') rec.draws.push(performance.now());
      return draw.apply(this, a);
    };
  }
  return true;
})()`;

const LAYOUT = `(() => {
  const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; };
  const boxes = {};
  for (const b of document.querySelectorAll('[data-screen="M"] [data-mark]')) boxes['[data-mark="' + b.getAttribute('data-mark') + '"]'] = box(b);
  boxes['.mark-text'] = box(document.querySelector('[data-screen="M"] .mark-text'));
  return { scrollHeight: document.documentElement.scrollHeight, innerHeight, innerWidth, dpr: devicePixelRatio, step: document.querySelector('[data-screen="M"]')?.getAttribute('data-step') ?? null, boxes };
})()`;

const SCROLL = `({ scrollHeight: document.documentElement.scrollHeight, innerHeight, innerWidth, scrollY,
  moreBelow: !!document.querySelector('.more-below:not([hidden])'), listFade: !!document.querySelector('.list-fade:not([hidden])') })`;

async function readStored(c, liftId) {
  return c.evaluate(`(async () => {
    const { createStore } = await import('./src/store/index.mjs');
    const s = createStore();
    const lift = await s.getLift(${JSON.stringify(liftId)});
    let track = null, result = null;
    try { track = await s.readTrack(${JSON.stringify(liftId)}); } catch (e) { track = { error: String(e) }; }
    try { result = await s.readResult(${JSON.stringify(liftId)}); } catch (e) { result = { error: String(e) }; }
    return { lift, track, result };
  })()`, { timeout: 120000 });
}

async function waitJob(c, what) {
  return c.waitFor(`(() => {
    const e = globalThis.__c26.events;
    const last = e[e.length - 1];
    return last && ['done', 'failed', 'cancelled'].includes(last.state) ? last.state : false;
  })()`, what, JOB_S * 1000);
}

async function walk(c) {
  const out = { command: 'walk', clip: arg('--clip'), lift: arg('--lift'), url: c.url, at: new Date().toISOString() };
  const lift = arg('--lift');
  if (!lift) throw new Error('walk: --lift <id> is required');
  out.ua = await c.evaluate('navigator.userAgent');
  // the first run's intro, once
  if (await c.evaluate(`!!document.querySelector('[data-screen="Welcome"]')`)) {
    for (let i = 0; i < 40 && !await c.evaluate(`!!document.querySelector('[data-screen="H"]')`); i++) { await c.tap('.welcome__skip', 'Not now'); await sleep(250); }
  }
  await c.waitFor(`document.querySelector('[data-screen="H"]')`, 'H');
  await c.evaluate(RECORDER);
  out.home = await c.evaluate(SCROLL);
  if (argv.includes('--tap-import')) {
    const before = await c.evaluate('document.visibilityState');
    out.importTap = { tapped: await c.tap('[data-screen="H"] button', 'Import a video'), visibilityBefore: before };
    await sleep(2500);
    out.importTap.visibilityAfter = await c.evaluate('document.visibilityState').catch(e => String(e.message));
    return out;   // the picker is the phone's: curie looks at it and backs out
  }
  const file = arg('--file');
  let t = Date.now();
  if (file) {
    const input = await c.evaluate(`document.querySelector('[data-screen="H"] input[type="file"]')`, { objectId: true });
    const set = await c.send('DOM.setFileInputFiles', { files: [file], objectId: input.objectId });
    if (set.error) throw new Error(`setFileInputFiles: ${set.error.message}`);
    await c.waitFor(`document.querySelector('[data-screen="L1"]')`, 'L1 after the file', 30000);
  } else {
    await c.waitFor(`document.querySelector('[data-screen="L1"]')`, 'L1 after the pick by hand', 15 * 60000);
  }
  out.l1File = await c.evaluate(`document.querySelector('[data-screen="L1"]')?.innerText.replace(/\\s+/g, ' ').slice(0, 200)`);
  if (!await c.tap(`[data-screen="L1"] [data-lift=${JSON.stringify(lift)}]`)) throw new Error(`L1 has no tile for ${lift}`);
  t = Date.now();
  const mark = k => `[data-screen="M"] button[data-mark="${k}"]`;
  await c.waitFor(`document.querySelector('[data-screen="M"][data-step="start"] button[data-mark="start"]:not([disabled])')`, 'M with the video open', 120000);
  out.openMs = Date.now() - t;
  await sleep(800);   // the first frame and the strip's thumbnails settle
  const m = out.mark = { layouts: {}, moved: {} };
  const base = await c.evaluate(LAYOUT);
  m.layouts.M1 = base;
  const after = async (step, want) => {
    await c.waitFor(`document.querySelector('[data-screen="M"][data-step="${want}"]')`, `M at ${want} after ${step}`);
    await sleep(400);
    const l = await c.evaluate(LAYOUT);
    m.layouts[step] = l;
    m.moved[step] = movedBoxes(base.boxes, l.boxes);
  };
  if (!await c.tap(mark('start'))) throw new Error('M: no 1');
  await after('after 1', 'end');
  // ten › steps, a tap every 150 ms: each one's time from the tap to the stage's next draw
  const steps = [];
  for (let k = 0; k < 10; k++) {
    const n0 = await c.evaluate('globalThis.__c26.draws.length');
    const t0 = await c.evaluate('performance.now()');
    if (!await c.tap('[data-screen="M"] button[aria-label="One frame forward"]')) break;
    const drawn = await c.waitFor(`globalThis.__c26.draws.length > ${n0} && globalThis.__c26.draws[${n0}]`, 'the step drawn', 10000).catch(() => null);
    steps.push(drawn ? r1(drawn - t0) : null);
    await sleep(150);
  }
  m.stepMs = { n: steps.length, median: r1(median(steps)), max: r1(Math.max(...steps.filter(Number.isFinite))), each: steps, note: 'tap (touch sent over CDP) to the stage canvas\'s next drawImage' };
  // the filmstrip dragged to the end with a finger: 20 moves over ~1 s, then the frame under the playhead
  const strip = await c.evaluate(`(() => { const r = document.querySelector('.strip').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; })()`);
  const n0 = await c.evaluate('globalThis.__c26.draws.length');
  const tDrag = await c.evaluate('performance.now()');
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: strip.x + strip.w - 10, y: strip.y }] });
  for (let k = 1; k <= 20; k++) {
    await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: strip.x + strip.w - 10 - (strip.w - 20) * k / 20, y: strip.y }] });
    await sleep(50);
  }
  const tUp = await c.evaluate('performance.now()');
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  let seen = null, still = 0;
  for (let i = 0; i < 300 && still < 8; i++) {
    await sleep(100);
    const now = await c.evaluate(`document.querySelector('.strip')?.getAttribute('aria-valuenow') ?? null`);
    still = now !== null && now === seen ? still + 1 : 0;
    seen = now;
  }
  const draws = await c.evaluate(`globalThis.__c26.draws.slice(${n0})`);
  const during = draws.filter(d => d <= tUp), lastDraw = draws[draws.length - 1];
  m.drag = {
    playheadEndS: seen, dragMs: r1(tUp - tDrag), drawsDuring: during.length,
    drawsPerS: r1(during.length / ((tUp - tDrag) / 1000)),
    releaseToLastDrawMs: lastDraw != null && lastDraw > tUp ? r1(lastDraw - tUp) : null,
    note: 'touchStart, 20 touchMoves 50 ms apart, touchEnd; draws of the stage canvas',
  };
  await sleep(300);
  if (!await c.tap(mark('end'))) throw new Error('M: no 2');
  await after('after 2', 'ready');
  m.estimate = await c.evaluate(`document.querySelector('[data-screen="M"]')?.innerText.replace(/\\s+/g, ' ').slice(0, 300)`);
  if (!await c.tap(mark('undo'))) throw new Error('M: no ↶');
  await after('after ↶', 'end');
  if (!await c.tap(mark('end'))) throw new Error('M: no 2 after ↶');
  await after('after 2 again', 'ready');
  // 3 Analyse: the cut kept, then Q1
  const tA = await c.evaluate('performance.now()');
  if (!await c.tap(mark('analyse'))) throw new Error('M: no 3');
  await c.waitFor(`document.querySelector('[data-screen="Q1"]')`, 'Q1 after Analyse', 120000);
  out.analyseToQ1Ms = r1(await c.evaluate('performance.now()') - tA);
  out.jobEnd = await waitJob(c, 'the job to end');
  out.analyseToDoneMs = r1(await c.evaluate('performance.now()') - tA);
  await finishJob(c, out);
  if (out.jobEnd === 'done') {
    await c.tap('[data-screen="Q1"] button', 'Open the result');
    await c.waitFor(`document.querySelector('[data-screen="A1"] .cue-card')`, 'A1 with cue cards', 60000);
    await sleep(800);
    out.a1 = await c.evaluate(SCROLL);
    out.cards = await c.evaluate(`[...document.querySelectorAll('[data-screen="A1"] .cue-card')].map(c => ({ cue: c.getAttribute('data-cue'), cls: c.className, label: c.querySelector('.cue-card__head')?.getAttribute('aria-label') ?? null }))`);
  }
  return out;
}

async function finishJob(c, out) {
  const rec = await c.evaluate('({ events: globalThis.__c26.events, q1: globalThis.__c26.q1, liftId: globalThis.__c26.liftId })');
  out.liftId = rec.liftId;
  out.events = rec.events.length;
  out.job = jobTimes(rec.events);
  out.q1 = rec.q1.filter((x, i, a) => i === 0 || i === a.length - 1 || !/\d+ \/ \d+/.test(x.text) || i % 50 === 0).map(x => ({ t: r1(x.t - rec.events[0].t), text: x.text }));
  out.jobError = rec.events.at(-1)?.error ?? null;
  const stored = await readStored(c, rec.liftId);
  out.engine = stored.lift?.engine ?? null;
  out.range = stored.lift?.range ?? null;
  out.track = stored.track;
  out.result = stored.result;
  out.consoleErrors = c.errors;
}

async function again(c) {
  const id = arg('--lift-id');
  if (!id) throw new Error('again: --lift-id is required');
  const out = { command: 'again', clip: arg('--clip'), liftId: id, url: c.url, at: new Date().toISOString() };
  await c.waitFor(`document.querySelector('[data-screen]')`, 'the app drawn');
  await c.evaluate(RECORDER);
  await c.evaluate(`(globalThis.__c26.liftId = ${JSON.stringify(id)}, true)`);
  out.queued = await c.evaluate(`(async () => {
    const { appQueue } = await import('./src/analysis/index.mjs');
    const { createStore } = await import('./src/store/index.mjs');
    const lift = await createStore().getLift(${JSON.stringify(id)});
    if (!lift) throw new Error('no lift ${id}');
    const j = await appQueue().enqueue(lift);
    return { job: j.id, state: j.state };
  })()`);
  out.jobEnd = await waitJob(c, 'the job to end');
  await finishJob(c, out);
  return out;
}

const run = async () => {
  if (!['walk', 'again', 'eval'].includes(cmd)) { console.error('usage: check-phone.mjs walk|again|eval --port P [--origin URL] …'); process.exit(2); }
  const c = await connect();
  let out;
  try {
    if (cmd === 'eval') out = { command: 'eval', value: await c.evaluate(argv[argv.length - 1], { timeout: 600000 }), errors: c.errors };
    else out = cmd === 'walk' ? await walk(c) : await again(c);
  } catch (e) {
    out = { command: cmd, error: String((e && e.stack) || e), consoleErrors: c.errors };
  } finally { c.close(); }
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); appendFileSync(OUT, JSON.stringify(out) + '\n'); }
  // the whole record is in --out; printed: what to read at a glance
  const brief = cmd === 'eval' ? out : {
    command: out.command, clip: out.clip, liftId: out.liftId, error: out.error, jobEnd: out.jobEnd, jobError: out.jobError,
    job: out.job && { totalMs: out.job.totalMs, stagesMs: out.job.stagesMs, frames: out.job.frames, msPerFrame: out.job.msPerFrame, longestWait: out.job.longestWait },
    moved: out.mark && out.mark.moved, stepMs: out.mark && out.mark.stepMs.median, drag: out.mark && out.mark.drag,
    analyseToQ1Ms: out.analyseToQ1Ms, home: out.home, a1: out.a1, cards: out.cards && out.cards.length,
    track: out.track ? `${Object.keys(out.track.keypoints || {}).length} frames` : null, consoleErrors: out.consoleErrors, importTap: out.importTap,
  };
  console.log(JSON.stringify(brief));
  process.exit(out.error ? 1 : 0);
};
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) await run();
