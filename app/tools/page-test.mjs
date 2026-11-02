// node app/tools/page-test.mjs [--browser PATH] [--break KIND] [--real CLIP]     (npm --prefix app run test:page)
//
// The page test (package c21, plan step 5.6): the app offline in a real page, walked the way a person
// walks it, for a lateral raise and a snatch.
//   1. assembles the TEST build into a temporary folder (assemble.mjs --test): the replay engine
//      (app/page-test/) answers the k-th decoded frame with the k-th frame of a committed fixture track,
//      through contract 1's messages, and the job takes the fixture's width, height and fps. It needs
//      neither app/vendor/tfjs/ nor app/models/. The shipped dist/ never has any of it;
//   2. serves it on 127.0.0.1:$COACH_PORT (any free port without it), opens headless Brave or Chromium
//      over the DevTools protocol, loads the app, waits for the service worker's full cache, then takes
//      the network away (emulation, and the server shut down) and reloads;
//   3. per lift: H → Import (the lift, a clip of tests/app/clips/, decoded for real) → M (set start,
//      drag to the end, set end, Analyse) → Q1 (waits for the job) → A1; reads the cue cards and
//      compares each with the view model of s11's adapter (scoreLift) computed in Node from the same
//      fixture track: per cue its id, status class, verdict line, value and the card's label (with the
//      status word). Not empty, not different.
// It fails on a console error, a failed request (any HTTP error or network failure, in the page or a
// worker), an unhandled rejection or exception, a job that does not finish in its time (60 s,
// $COACH_PAGE_TEST_JOB_S), cards that differ from the adapter's, or an empty cue list.
// No browser found: fails with one clear line, unless COACH_PAGE_TEST_SKIP=1 (then it says it skipped, exit 0).
//
// --break KIND   a deliberate fault, to see the test fail (exit 1): console (a console.error), http (a
//                request that 404s, made online), rejection (an unhandled rejection), stall (the replay
//                engine has no tracks, so the job fails), hang (the replay engine never answers: the job
//                does not finish in its time, 5 s here), cards (a fixture track altered in the test build, so the
//                cards differ from the adapter's).
// --real CLIP    off by default: the real engine (MoveNet on TF.js; its WebGL backend, which headless Brave runs in software, on the CPU: the app has no other) on one example clip,
//                CLIP being lateral-raise-cable-1 or athlete-a-trim, read from the phase-0 worktree's
//                tests/fixtures/local/example/ (found with `git worktree list`; read in place, never copied;
//                its app/vendor/tfjs/ and app/models/ are used when this folder has none). Online, not
//                offline; the cards are shown next to the adapter's and may differ (a different pose
//                model); it fails on an error, on a job that does not finish ($COACH_PAGE_TEST_JOB_S,
//                540 s here) or on an empty cue list. Run it through
//                `pipeline/devlock.sh slice page-real node app/tools/page-test.mjs --real <clip>`.
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assemble, TEST_TRACKS } from './assemble.mjs';
import { createApp } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const ROOT = resolve(APP, '..');
const CLIPS = join(ROOT, 'tests', 'app', 'clips');
const BROWSERS = ['brave-browser', 'brave', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
const LIFTS = [
  { lift: 'lateral-raise', clip: 'testsrc2-lateral-raise-25fps-75f.mp4', track: TEST_TRACKS[0] },
  { lift: 'snatch', clip: 'testsrc2-snatch-30fps-107f.mp4', track: TEST_TRACKS[1] },
];

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt; };
const say = s => process.stdout.write(`${s}\n`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- the browser ----
function findBrowser() {
  const given = arg('--browser') ?? process.env.COACH_BROWSER;
  if (given) return existsSync(given) ? given : null;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of BROWSERS) if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

const breakKind = arg('--break');
if (breakKind && !['console', 'http', 'rejection', 'stall', 'hang', 'cards'].includes(breakKind)) { console.error(`page-test: --break wants console, http, rejection, stall, hang or cards (got ${breakKind})`); process.exit(2); }
const browserPath = findBrowser();
if (!browserPath) {
  if (process.env.COACH_PAGE_TEST_SKIP === '1') { say('page-test: SKIPPED: no Brave or Chromium found (COACH_PAGE_TEST_SKIP=1)'); process.exit(0); }
  console.error(`page-test: FAILED: no Brave or Chromium found (looked for ${BROWSERS.join(', ')} on PATH; give one with --browser PATH, or set COACH_PAGE_TEST_SKIP=1 to skip)`);
  process.exit(1);
}

const realClip = arg('--real');
const JOB_S = Number(process.env.COACH_PAGE_TEST_JOB_S) || (breakKind === 'hang' ? 5 : realClip ? 540 : 60);

// ---- the phase-0 worktree, for --real ----
function phase0() {
  const text = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  for (const block of text.split('\n\n')) {
    if (/^branch refs\/heads\/phase-0$/m.test(block)) return block.match(/^worktree (.+)$/m)[1];
  }
  throw new Error('no worktree on the branch phase-0 (git worktree list)');
}

// ---- what the cards must say: s11's adapter on the fixture track, in Node ----
async function expectedCards(track) {
  const require = createRequire(import.meta.url);
  const { loadDiagnostics } = require(join(ROOT, 'tests', 'loadDiagnostics.js'));
  const Diagnostics = loadDiagnostics();
  const { scoreLift } = await import(pathToFileURL(join(APP, 'src', 'scoring', 'score.mjs')).href);
  const { cardsOf } = await import(pathToFileURL(join(APP, 'src', 'ui', 'result-model.mjs')).href);
  const fixture = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'global', 'example', track.file), 'utf8'));
  const { view } = scoreLift(fixture, track.lift, { Diagnostics });
  return cardsOf(view).map(c => ({
    id: c.id, cls: c.cls, line: c.line ?? '', value: c.value,
    label: `${c.title}: ${c.word}${c.line ? `, ${c.line}` : ''}${c.scored ? `, ${c.value}` : ''}`,   // A1's card head aria-label
  }));
}

// ---- the page's cards, as the screen draws them ----
const READ_CARDS = `[...document.querySelectorAll('[data-screen="A1"] .cue-card')].map(c => {
  const line = c.querySelector('.cue-card__line');
  const text = line.lastElementChild ? line.lastElementChild.textContent : '';
  return {
    id: c.dataset.cue,
    cls: ((line.className.match(/status--([a-z-]+)/) || [])[1]) || null,
    line: text.replace(/^ · /, ''),
    value: c.querySelector('.cue-card__value').textContent,
    label: c.querySelector('.cue-card__head').getAttribute('aria-label'),
  };
})`;

const dist = mkdtempSync(join(tmpdir(), 'coach-page-dist-'));
const profile = mkdtempSync(join(tmpdir(), 'coach-page-profile-'));
const result = { ok: false, mode: realClip ? `real engine on ${realClip}` : 'replay engine', break: breakKind ?? undefined, lifts: [] };
const problems = [];   // everything that fails the run, in words
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
let browser = null, server = null;

const realLog = console.log;
console.log = () => {};   // serve.mjs logs every request; this script says what it has to through say()

try {
  // 1. the test build
  const built = assemble({ out: dist, app: APP, src: join(ROOT, 'src'), test: true, log: () => {} });
  if (breakKind === 'stall') writeFileSync(join(dist, 'page-test', 'tracks.json'), '[]\n');   // the manifest is changed after files.json's hash was made: the first load does not mind
  if (breakKind === 'hang') {
    const f = join(dist, 'page-test', 'replay.mjs');
    const text = readFileSync(f, 'utf8');
    if (!text.includes('async estimate() {')) throw new Error('--break hang: replay.mjs changed, update the break');
    writeFileSync(f, text.replace('async estimate() {', 'estimate() { return new Promise(() => {}); },\n    async unused() {'));
  }
  if (breakKind === 'cards') {
    const f = join(dist, 'page-test', TEST_TRACKS[0].file);
    const track = JSON.parse(readFileSync(f, 'utf8'));
    for (const frame of Object.values(track.keypoints)) for (const pts of Object.values(frame)) for (const j of [9, 10]) pts[j][0] += 60;   // the wrists 60 px lower
    writeFileSync(f, JSON.stringify(track));
  }
  let vendored = false;
  if (realClip) {
    const clipDir = join(phase0(), 'tests', 'fixtures', 'local', 'example');
    if (!existsSync(join(clipDir, `${realClip}.mp4`))) throw new Error(`--real: ${join(clipDir, `${realClip}.mp4`)} not found`);
    for (const [rel, what] of [['vendor/tfjs', 'the TF.js bundle'], ['models', "MoveNet's weights"]]) {
      if (existsSync(join(dist, rel))) continue;
      const from = join(phase0(), 'app', rel);
      if (!existsSync(from)) throw new Error(`--real needs ${what}: neither ${join(APP, rel)} nor ${from} exists (node app/tools/build-tfjs.mjs, app/tools/fetch-models.sh)`);
      cpSync(from, join(dist, rel), { recursive: true });   // into the temporary folder only
      vendored = true;
    }
  }
  const expected = new Set([...built.files, 'files.json']);

  // 2. serve, launch
  const hits = [];
  server = createApp(dist);
  server.on('request', (req, res) => { res.on('finish', () => hits.push({ url: req.url, status: res.statusCode })); });
  await new Promise(r => server.listen(Number(process.env.COACH_PORT) || 0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  browser = spawn(browserPath, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--window-size=390,844', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise((res, rej) => {
    let err = '';
    const timer = setTimeout(() => rej(new Error('no DevTools port from the browser: ' + err.slice(-500))), 30000);
    browser.stderr.on('data', d => {
      err += d;
      const m = err.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(timer); res(m[1]); }
    });
    browser.on('exit', code => rej(new Error(`the browser exited (${code}): ${err.slice(-500)}`)));
  });
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools socket')); });

  let id = 0;
  const pending = new Map();
  const events = [];   // { method, params, sessionId }
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (!m.method) return;
    events.push(m);
    if (m.method === 'Target.attachedToTarget') {   // workers and the service worker: the same eyes on them
      for (const d of ['Runtime', 'Log', 'Network']) send(`${d}.enable`, {}, m.params.sessionId);
      send('Runtime.runIfWaitingForDebugger', {}, m.params.sessionId);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const evaluate = async (expression, { timeout = 30000, objectId = false } = {}) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: !objectId, timeout });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return objectId ? r.result.result : r.result?.result?.value;
  };
  async function waitFor(expression, what, ms = 20000) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      try { last = await evaluate(expression); if (last) return last; } catch { /* the page is between documents */ }
      await sleep(100);
    }
    throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
  }
  const click = (selector, text) => evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'});
    if (!el || el.disabled) return false;
    el.click();
    return true;
  })()`);

  for (const d of ['Page', 'Network', 'Runtime', 'Log']) await send(`${d}.enable`);
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

  // 3. online first load: the worker and its whole cache (offline mode only)
  let preReload = new Set();
  await send('Page.navigate', { url: `${origin}/${realClip ? '?real' : ''}` });
  await waitFor(`document.querySelector('[data-screen="H"]')`, 'H on the first load');
  if (breakKind === 'http') await evaluate(`fetch('./no-such-file.txt').then(() => 0, () => 0)`);   // online: the server says 404
  if (!realClip) {
    await waitFor(`(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg || !reg.active) return false;
      const c = await caches.open('coach-${built.version}').catch(() => null);
      return c ? (await c.keys()).length === ${expected.size} : false;
    })()`, "the service worker's full cache", 30000);
    result.firstLoad = { cached: expected.size, at: stamp() };

    // 4. offline: the emulation, and the server gone
    for (const e of events) if (e.method === 'Network.requestWillBeSent') preReload.add(e.params.requestId);
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    server.close(); server.closeAllConnections();
    result.hitsBeforeOffline = hits.length;
    await send('Page.reload', { ignoreCache: false });
    await waitFor(`document.querySelector('[data-screen="H"]') && !!navigator.serviceWorker.controller`, 'H after the offline reload');
    result.offlineReload = { at: stamp() };
  }
  // errors count from the first load on: no event is cleared

  // the breaks that need the page
  if (breakKind === 'console') await evaluate(`console.error('page-test --break console')`);
  if (breakKind === 'rejection') await evaluate(`void Promise.reject(new Error('page-test --break rejection'))`);

  // 5. the lifts
  const todo = realClip
    ? [{ ...(LIFTS.find(l => l.track.id === `example/${realClip}`) ?? (() => { throw new Error(`--real wants lateral-raise-cable-1 or athlete-a-trim (got ${realClip})`); })()), file: join(phase0(), 'tests', 'fixtures', 'local', 'example', `${realClip}.mp4`) }]
    : LIFTS.map(l => ({ ...l, file: join(CLIPS, l.clip) }));
  for (const l of todo) {
    const one = { lift: l.lift, clip: l.file.replace(ROOT, '.') };
    result.lifts.push(one);
    const want = await expectedCards(l.track);
    l.meta = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'global', 'example', l.track.file), 'utf8')).meta;
    const frames = l.meta.frame_count;
    let at = Date.now();
    const lap = () => { const d = Date.now() - at; at = Date.now(); return d; };

    // H → Import
    await waitFor(`document.querySelector('[data-screen="H"]')`, 'H');
    if (!await click('button', 'Import a video')) throw new Error('H has no "Import a video" button');
    await waitFor(`document.querySelector('[data-screen="Import"]')`, 'the import screen');
    await evaluate(`document.querySelector('input[name="lift"][value=${JSON.stringify(l.lift)}]').click()`);
    const input = await evaluate(`document.querySelector('input[type="file"]')`, { objectId: true });
    await send('DOM.setFileInputFiles', { files: [l.file], objectId: input.objectId });

    // M: set start at the first frame, drag the filmstrip to the end, set end, Analyse
    await waitFor(`document.querySelector('[data-screen="M"][data-step="start"] .mark-main--set:not([disabled])')`, 'M with the video open (the clip decoded)');
    one.importMs = lap();
    if (!await click('.mark-main--set')) throw new Error('M: Set start was not there');
    await waitFor(`document.querySelector('[data-screen="M"][data-step="end"]')`, 'M asking for the end');
    const strip = await evaluate(`(() => { const r = document.querySelector('.strip').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; })()`);
    const mouse = (type, x) => send('Input.dispatchMouseEvent', { type, x, y: strip.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' });
    await mouse('mousePressed', strip.x + strip.w - 10);
    for (let k = 1; k <= 10; k++) await mouse('mouseMoved', strip.x + strip.w - 10 - (strip.w - 20) * k / 10);   // the whole strip leftwards: far past the end, which clamps
    await mouse('mouseReleased', strip.x + 10);
    // the drag clamps at the last frame: the playhead stops there (the clip's own last frame; the example clips may have
    // one frame more than their fixture's track)
    let seen = null, still = 0;
    for (let i = 0; i < 200 && still < 8; i++) {
      await sleep(100);
      const now = await evaluate(`document.querySelector('.strip')?.getAttribute('aria-valuenow') ?? null`);
      still = now !== null && now === seen && Number(now) > 0 ? still + 1 : 0;
      seen = now;
    }
    if (still < 8) throw new Error('timed out waiting for the playhead at the last frame');
    const lastAt = ((l.meta.frame_count - 1) / l.meta.fps).toFixed(1);   // the strip's aria-valuenow, to a tenth
    if (!realClip && seen !== lastAt) throw new Error(`the playhead stopped at ${seen} s, not at the last frame (${lastAt} s)`);
    await sleep(300);   // the frame under the playhead settles
    if (!await click('.mark-main--set')) throw new Error('M: Set end was not there');
    await waitFor(`document.querySelector('[data-screen="M"][data-step="ready"] .mark-main.button--primary:not([disabled])')`, 'M ready to analyse');
    one.markMs = lap();
    if (!await click('.mark-main.button--primary')) throw new Error('M: Analyse was not there');

    // Q1: the job, to its end
    await waitFor(`document.querySelector('[data-screen="Q1"]')`, 'Q1 after Analyse', 30000);
    one.keepMs = lap();
    let done;
    try {
      done = await waitFor(`(() => {
        const q = document.querySelector('[data-screen="Q1"]');
        if (!q) return false;
        if ([...q.querySelectorAll('button')].some(b => b.textContent.includes('Open the result'))) return 'done';
        return q.innerText.includes("Couldn't analyse") ? 'failed' : false;
      })()`, `the job to finish (${JOB_S} s)`, JOB_S * 1000);
      if (done === 'failed') throw new Error('the job failed');
    } catch (e) {
      const said = await evaluate(`document.querySelector('[data-screen="Q1"]')?.innerText ?? ''`).catch(() => '');
      problems.push(`${l.lift}: the job did not finish (${e.message}); Q1 says: ${said.replace(/\s+/g, ' ').slice(0, 300)}`);
      one.ok = false;
      break;
    }
    one.jobMs = lap();
    await click('button', 'Open the result');
    await waitFor(`document.querySelector('[data-screen="A1"] .cue-card')`, 'the result screen with cue cards');

    // A1: the cards
    const got = await evaluate(READ_CARDS);
    one.cards = got.map(c => `${c.id}: ${c.cls} · ${c.line} · ${c.value}`);
    one.frames = frames;
    if (!got.length) problems.push(`${l.lift}: the cue list is empty`);
    else if (!realClip) {
      const diffs = [];
      if (got.length !== want.length) diffs.push(`${got.length} cards, the adapter has ${want.length}`);
      for (const w of want) {
        const g = got.find(c => c.id === w.id);
        if (!g) { diffs.push(`${w.id}: no card`); continue; }
        for (const f of ['cls', 'line', 'value', 'label']) if (g[f] !== w[f]) diffs.push(`${w.id}.${f}: the card says ${JSON.stringify(g[f])}, the adapter ${JSON.stringify(w[f])}`);
      }
      if (got.map(c => c.id).join() !== want.map(c => c.id).join() && !diffs.length) diffs.push('the cards are in another order than the adapter\'s cues');
      if (diffs.length) problems.push(`${l.lift}: cards differ from the adapter's: ${diffs.join('; ')}`);
      one.ok = diffs.length === 0;
    } else {
      one.adapterOnTheFixture = want.map(w => `${w.id}: ${w.cls} · ${w.line} · ${w.value}`);
      one.ok = true;
    }
    if (!one.ok && one.ok !== false) one.ok = got.length > 0;
    // d46: A2's "Play the rep at ½×" opens A1 again on that cue at ½×
    const scoredCue = got.find(c => !/Can.t score/i.test(c.label ?? '') && c.id);
    if (scoredCue) {
      const card = `[data-screen="A1"] .cue-card[data-cue="${scoredCue.id}"]`;
      const open = await evaluate(`!!document.querySelector(${JSON.stringify(card + ' .cue-card__more')})`);
      if (!open) await evaluate(`document.querySelector(${JSON.stringify(card + ' .cue-card__head')}).click()`);
      // s45: the open card's rule line names the unit's noun and the watch band, and A2's "How it's scored" starts
      // with the sentence on what the verdict reads, both from diagnostics.js's rule(id) in the page
      const api = await evaluate(`window.Diagnostics.rule(${JSON.stringify(scoredCue.id)})`);
      const a1Rule = await evaluate(`document.querySelector(${JSON.stringify(card + ' .cue-card__rule')})?.textContent ?? null`);
      if (!await click(`${card} .cue-card__more`)) throw new Error('A1: no "Plot and details" on a scored cue');
      await waitFor(`document.querySelector('[data-screen="A2"]')`, 'A2 after "Plot and details"');
      await waitFor(`document.querySelector('[data-screen="A2"] .detail-play')`, 'A2\'s button, once the cue is loaded');
      const a2Rule = await evaluate(`document.querySelector('[data-screen="A2"] .detail-rule__sentence')?.textContent ?? null`);
      one.rule = { cue: scoredCue.id, a1: a1Rule, a2: a2Rule };
      if (!api || !a1Rule || !a1Rule.includes(api.noun) || !/, watch /.test(a1Rule)) { problems.push(`${l.lift}: A1's rule line for ${scoredCue.id} lacks rule(id)'s noun or the watch band: ${JSON.stringify(a1Rule)}`); one.ok = false; }
      if (!api || !a2Rule || !a2Rule.startsWith(api.basis)) { problems.push(`${l.lift}: A2's "How it's scored" for ${scoredCue.id} does not start with rule(id)'s sentence: ${JSON.stringify(a2Rule)}`); one.ok = false; }
      if (!await click('[data-screen="A2"] .detail-play', 'Play the rep at ½×')) throw new Error('A2: no "Play the rep at ½×" button');
      await waitFor(`document.querySelector('[data-screen="A1"] .result-speed')`, 'A1 after "Play the rep at ½×"');
      const back = await evaluate(`({ speed: document.querySelector('.result-speed').textContent, open: !!document.querySelector(${JSON.stringify(card + ' .cue-card__body')}), problem: document.querySelector('.result-problem')?.textContent ?? null })`);
      one.playHalf = back;
      if (back.speed !== '½×' || !back.open || back.problem) { problems.push(`${l.lift}: "Play the rep at ½×" opened A1 with ${JSON.stringify(back)}`); one.ok = false; }
    }
    // d22: A3 opens over A1 with the mockup's controls, a switch changes at once, a smoothing change scores again,
    // and Re-mark opens M on the stored cut with the old marks (M3)
    await waitFor(`document.querySelector('[data-screen="A1"] .result-header__more:not([disabled])')`, 'A1\'s View options button');
    if (!await click('[data-screen="A1"] .result-header__more')) throw new Error('A1: no View options button');
    await waitFor(`document.querySelector('.vo-sheet')`, 'A3 after "View options"');
    const sheet = await evaluate(`(() => {
      const q = s => [...document.querySelectorAll(s)];
      return { title: document.querySelector('.vo-title')?.textContent, switches: q('.vo-switch').map(e => e.querySelector('.vo-switch__name').textContent + ':' + e.getAttribute('aria-checked')),
        speeds: q('.vo-segment').map(e => e.textContent), slider: document.querySelector('.vo-slider')?.value, lifter: /Lifter/.test(document.querySelector('.vo-sheet').textContent) };
    })()`);
    one.sheet = sheet;
    const wantSwitches = ['Skeleton:true', 'Cue drawings:true', 'Unsure joints:false', 'Loop the lift only:true'];
    if (sheet.title !== 'View options' || JSON.stringify(sheet.switches) !== JSON.stringify(wantSwitches) || JSON.stringify(sheet.speeds) !== JSON.stringify(['¼×', '½×', '1×']) || sheet.lifter) {
      problems.push(`${l.lift}: A3 opened with ${JSON.stringify(sheet)}`); one.ok = false;
    }
    await click('.vo-switch', 'Skeleton');
    await waitFor(`document.querySelector('.vo-switch[aria-checked="false"]')`, 'the Skeleton switch off');
    await click('.vo-switch', 'Skeleton');
    await evaluate(`(() => { const i = document.querySelector('.vo-slider'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '0'); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('.vo-sigma__value')?.textContent === '0 ms' && !document.querySelector('.vo-slider').disabled`, 'the smoothing scored again');
    // the choice is kept in the settings and the next lift is analysed with it: back to the standard 50 ms
    await evaluate(`(() => { const i = document.querySelector('.vo-slider'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '50'); i.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('.vo-sigma__value')?.textContent === '50 ms' && !document.querySelector('.vo-slider').disabled`, 'the standard smoothing back');
    const sigma = await evaluate(`document.querySelector('.vo-error')?.textContent ?? null`);
    if (sigma) { problems.push(`${l.lift}: A3's smoothing change said ${sigma}`); one.ok = false; }
    if (!await click('.vo-action', 'Re-mark this lift')) throw new Error('A3: no Re-mark button');
    await waitFor(`document.querySelector('[data-screen="M"][data-step="ready"]')`, 'M3 after "Re-mark this lift"');
    one.remark = 'M3 with the old marks';
    // M's Close goes home
    if (!await click('[data-screen="M"] button[aria-label="Close"]')) throw new Error('M: no Close button');
    await waitFor(`document.querySelector('[data-screen="H"]')`, 'H after closing M');
  }

  // 6. what went wrong anywhere: console, exceptions, rejections, failed requests (page, workers, service worker)
  await sleep(500);
  const sent = new Map();
  for (const e of events) if (e.method === 'Network.requestWillBeSent') sent.set(`${e.sessionId ?? ''}/${e.params.requestId}`, e.params.request.url);
  for (const e of events) {
    const p = e.params;
    if (e.method === 'Runtime.exceptionThrown') problems.push(`exception: ${(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).split('\n')[0]} (${p.exceptionDetails.url ?? ''}:${p.exceptionDetails.lineNumber ?? ''})`);
    else if (e.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'assert')) problems.push(`console.${p.type}: ${p.args.map(a => a.value ?? a.description).join(' ').slice(0, 300)}`);
    else if (e.method === 'Log.entryAdded' && p.entry.level === 'error') problems.push(`log error: ${p.entry.text} ${p.entry.url ?? ''}`.slice(0, 300));
    else if (e.method === 'Network.loadingFailed' && !(p.canceled && preReload.has(p.requestId))) problems.push(`request failed: ${sent.get(`${e.sessionId ?? ''}/${p.requestId}`) ?? p.requestId}: ${p.errorText}`);
    else if (e.method === 'Network.responseReceived' && p.response.status >= 400) problems.push(`HTTP ${p.response.status}: ${p.response.url}`);
  }
  for (const h of hits) if (h.status >= 400) problems.push(`server answered ${h.status} to ${h.url}`);
  if (!realClip && hits.length > result.hitsBeforeOffline) problems.push(`${hits.length - result.hitsBeforeOffline} request(s) reached the server after it was taken away`);
  result.browser = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser;
  result.files = built.files.length;
  result.vendoredFromPhase0 = vendored || undefined;
  ws.close();
} catch (e) {
  problems.push(`the run stopped: ${e.message}`);
} finally {
  if (browser) {
    // wait for the browser to be gone: it writes to its profile until it exits, and rmSync then hits ENOTEMPTY
    const gone = browser.exitCode !== null || browser.signalCode !== null ? Promise.resolve() : new Promise(r => browser.once('exit', r));
    browser.kill();
    await Promise.race([gone, sleep(5000)]);
  }
  if (server) server.close();
  await sleep(300);
  // retries: a helper process of the browser may still hold a file for a moment
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  console.log = realLog;
}

result.problems = [...new Set(problems)];
result.seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
result.ok = result.problems.length === 0 && result.lifts.length > 0 && result.lifts.every(l => l.ok);
say(JSON.stringify(result, null, 2));
say(result.ok ? `page-test: PASSED in ${result.seconds} s` : `page-test: FAILED: ${result.problems[0] ?? 'a lift did not complete'}`);
process.exit(result.ok ? 0 : 1);
