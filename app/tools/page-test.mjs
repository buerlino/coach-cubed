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
//   3. per lift with a fixture (app/tools/lift-fixtures.mjs; a lift of the registry without one is listed in
//      the output, `untested`, and in a line after it): H → the picker (a clip of tests/app/clips/) → L1 (the lift's tile) → M (decoded for real) (1 Start,
//      a refused 2, drag to the end, 2 End, ↶, 2 again, Analyse; d54's shift check after each press: every control of M where it
//      was in M1, to 0.5 px, shift-check.mjs) → Q1 (waits for the job) → A1; reads the cue cards and
//      compares each with the view model of s11's adapter (scoreLift) computed in Node from the same
//      fixture track: per cue its id, status class, verdict line, value and the card's label (with the
//      status word). Not empty, not different;
//   3b. (d28) the session walk: H → the gym card → R1 (the camera's preview, a lift tapped) → Start → R2 (the clock moves, the
//      real rate reads 30 fps ± 1) → (d29) wait 4 s, Replay → R3 (the position moves, ½× switches, a pause holds the countdown)
//      → Keep and mark → M (1, a drag, 2, 3 Analyse) → R2 with the queue line showing the lift → Q1 through it, the recorded
//      lift's job cancelled (the replay engine has no track for a recording), Back to the session → R2 → End session → H, and
//      every camera track has ended (checked in the page). The output names each step. The browser has a fake camera at 30 fps
//      (browser.mjs's FAKE_CAMERA).
// It fails on a console error, a failed request (any HTTP error or network failure, in the page or a
// worker), an unhandled rejection or exception, a job that does not finish in its time (60 s,
// $COACH_PAGE_TEST_JOB_S), cards that differ from the adapter's, or an empty cue list.
// No browser found: fails with one clear line, unless COACH_PAGE_TEST_SKIP=1 (then it says it skipped, exit 0).
//
// --break KIND   a deliberate fault, to see the test fail (exit 1): console (a console.error), http (a
//                request that 404s, made online), rejection (an unhandled rejection), stall (the replay
//                engine has no tracks, so the job fails), hang (the replay engine never answers: the job
//                does not finish in its time, 5 s here), cards (a fixture track altered in the test build, so the
//                cards differ from the adapter's), shift (a row of M grows once the start is set, so the controls
//                move: the shift check names each control and the step).
// --real CLIP    off by default: the real engine (MoveNet on TF.js; its WebGL backend, which headless Brave runs in software, on the CPU: the app has no other) on one example clip,
//                CLIP being lateral-raise-cable-1 or athlete-a-trim, read from the phase-0 worktree's
//                tests/fixtures/local/example/ (found with `git worktree list`; read in place, never copied;
//                its app/vendor/tfjs/ and app/models/ are used when this folder has none). Online, not
//                offline; the cards are shown next to the adapter's and may differ (a different pose
//                model); it fails on an error, on a job that does not finish ($COACH_PAGE_TEST_JOB_S,
//                540 s here) or on an empty cue list. Run it through
//                `pipeline/devlock.sh slice page-real node app/tools/page-test.mjs --real <clip>`.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assemble, TEST_TRACKS } from './assemble.mjs';
import { fixtureCoverage } from './lift-fixtures.mjs';
import { createApp } from './serve.mjs';
import { BROWSERS, FAKE_CAMERA, findBrowser, launchBrowser } from './browser.mjs';
import { MARK_CONTROLS, SHIFT_BREAK, compareBoxes, readBoxes } from './shift-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const ROOT = resolve(APP, '..');
const CLIPS = join(ROOT, 'tests', 'app', 'clips');
// One walk per lift in the registry with a fixture (lift-fixtures.mjs); a lift with none is listed, not skipped quietly.
const COVERAGE = fixtureCoverage();
const LIFTS = COVERAGE.walked.map(f => ({ lift: f.lift, clip: f.clip, track: TEST_TRACKS.find(t => t.id === f.track.id) }));

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt; };
const say = s => process.stdout.write(`${s}\n`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- the browser: found and launched by browser.mjs, which also ends its whole process tree ----
const breakKind = arg('--break');
if (breakKind && !['console', 'http', 'rejection', 'stall', 'hang', 'cards', 'shift'].includes(breakKind)) { console.error(`page-test: --break wants console, http, rejection, stall, hang, cards or shift (got ${breakKind})`); process.exit(2); }
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
const result = { ok: false, mode: realClip ? `real engine on ${realClip}` : 'replay engine', break: breakKind ?? undefined, lifts: [], untested: realClip ? undefined : COVERAGE.untested };
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

  browser = await launchBrowser(profile, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    ...FAKE_CAMERA, '--window-size=390,844', 'about:blank'], { browser: browserPath });
  const port = browser.port;
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
  // d23: the first run shows the intro once; leaving it by "Not now" keeps that it was shown, so the reloads go straight to H
  await waitFor(`document.querySelector('[data-screen="Welcome"]')`, 'the intro on the first run');
  // the tap is repeated until H shows: on a loaded machine the first tap can land before the button's handler is attached
  for (let tries = 0; tries < 40 && !await evaluate(`!!document.querySelector('[data-screen="H"]')`); tries++) {
    await click('.welcome__skip', 'Not now');
    await sleep(250);
  }
  await waitFor(`document.querySelector('[data-screen="H"]')`, 'H after the intro');
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

    // H → the picker (H's file input is set, as the phone's picker would) → L1 → the lift's tile
    await waitFor(`document.querySelector('[data-screen="H"]')`, 'H');
    if (!await evaluate(`[...document.querySelectorAll('[data-screen="H"] button')].some(b => b.textContent.includes('Import a video'))`)) throw new Error('H has no "Import a video" button');
    const input = await evaluate(`document.querySelector('[data-screen="H"] input[type="file"]')`, { objectId: true });
    await send('DOM.setFileInputFiles', { files: [l.file], objectId: input.objectId });
    await waitFor(`document.querySelector('[data-screen="L1"]')`, 'L1 after the picker');
    if (!await click(`[data-screen="L1"] [data-lift=${JSON.stringify(l.lift)}]`)) throw new Error(`L1 has no tile for ${l.lift}`);

    // M: 1 at the first frame, a refused 2 there, the filmstrip dragged to the end, 2, ↶, 2 again, Analyse; after each
    // press every control of M is where it was in M1 before any mark (d54's shift check, shift-check.mjs)
    const markButton = kind => `button[data-mark="${kind}"]`;   // in [data-screen="M"]
    await waitFor(`document.querySelector('[data-screen="M"][data-step="start"] ${markButton('start')}:not([disabled])')`, 'M with the video open (the clip decoded)');
    one.importMs = lap();
    if (breakKind === 'shift') await evaluate(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(SHIFT_BREAK)}; document.head.appendChild(s); })()`);
    const boxes = () => evaluate(`(${readBoxes.toString()})(${JSON.stringify(MARK_CONTROLS)})`);
    const base = await boxes();
    one.shift = [];
    const shift = async step => {
      const moved = compareBoxes(base, await boxes(), step);
      one.shift.push(step);
      for (const p of moved) problems.push(`${l.lift}: ${p}`);
      if (moved.length) one.ok = false;
    };
    if (!await click('[data-screen="M"] ' + markButton('start'))) throw new Error('M: 1 Start was not there');
    await waitFor(`document.querySelector('[data-screen="M"][data-step="end"] ${markButton('end')}:not([disabled])')`, 'M asking for the end');
    await shift('after 1');
    if (!await click('[data-screen="M"] ' + markButton('end'))) throw new Error('M: 2 End was not there');
    await waitFor(`document.querySelector('[data-screen="M"][data-step="end"] .mark-text--error')`, 'the refusal of an end on the start');
    await shift('after a refused 2');
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
    const ready = `document.querySelector('[data-screen="M"][data-step="ready"] ${markButton('analyse')}:not([disabled])')`;
    if (!await click('[data-screen="M"] ' + markButton('end'))) throw new Error('M: 2 End was not there after the drag');
    await waitFor(ready, 'M ready to analyse');
    await shift('after 2');
    if (!await click('[data-screen="M"] ' + markButton('undo'))) throw new Error('M: ↶ was not there, or disabled, after 2');
    await waitFor(`document.querySelector('[data-screen="M"][data-step="end"]')`, 'M back to the end after ↶');
    await shift('after ↶');
    if (!await click('[data-screen="M"] ' + markButton('end'))) throw new Error('M: 2 End was not there after ↶');
    await waitFor(ready, 'M ready to analyse again');
    await shift('after 2 again');
    one.markMs = lap();
    if (!await click('[data-screen="M"] ' + markButton('analyse'))) throw new Error('M: 3 Analyse was not there');

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
      if (!await click(`${card} .cue-card__more`)) throw new Error('A1: no "Details" on a scored cue');
      await waitFor(`document.querySelector('[data-screen="A2"]')`, 'A2 after "Details"');
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

  // 5a. d28: the session. H → the gym card → R1 (the preview plays, a lift is tapped) → Start → R2 (the clock moves, the real
  // rate reads 30 fps ± 1) → End session → H; every camera track (the streams' and their clones) has ended.
  if (!realClip) {
    await waitFor(`document.querySelector('[data-screen="H"]')`, 'H (the session)');
    await evaluate(`(() => {
      if (globalThis.__tracks) return;
      globalThis.__tracks = [];
      const keep = t => { globalThis.__tracks.push(t); return t; };
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async c => { const s = await gum(c); s.getTracks().forEach(keep); return s; };
      const clone = MediaStreamTrack.prototype.clone;
      MediaStreamTrack.prototype.clone = function () { return keep(clone.call(this)); };
    })()`);
    const session = { walked: true };
    result.session = session;
    if (!await click('[data-screen="H"] [data-card="session"]')) throw new Error('H: no gym session card');
    await waitFor(`document.querySelector('[data-screen="R1"][data-state="preview"] [data-record="start"]:not([disabled])')`, 'R1 with the camera in the preview', 30000);
    await waitFor(`(() => { const v = document.querySelector('[data-screen="R1"] video'); return v && v.readyState >= 2 && v.videoWidth > 0; })()`, "R1's preview playing", 30000);
    const lifts = await evaluate(`[...document.querySelectorAll('[data-screen="R1"] [data-lift]')].map(b => b.getAttribute('data-lift') + ':' + b.getAttribute('aria-pressed'))`);
    session.lifts = lifts;
    const tap = LIFTS[LIFTS.length - 1].lift;
    if (!await click(`[data-screen="R1"] [data-lift="${tap}"]`)) throw new Error('R1: no lift button');
    const pressed = await evaluate(`[...document.querySelectorAll('[data-screen="R1"] [data-lift][aria-pressed="true"]')].map(b => b.getAttribute('data-lift'))`);
    if (pressed.length !== 1 || pressed[0] !== tap) problems.push(`R1: tapping ${tap} pressed ${JSON.stringify(pressed)}`);
    session.line = await evaluate(`document.querySelector('[data-screen="R1"] .setup-line')?.textContent ?? null`);
    if (session.line !== '1080p · 30 fps · last 60 s') problems.push(`R1: the line under the preview says ${JSON.stringify(session.line)}`);
    if (!await click('[data-screen="R1"] [data-record="start"]')) throw new Error('R1: Start is disabled');
    await waitFor(`document.querySelector('[data-screen="R2"][data-state="recording"]')`, 'R2 recording', 30000);
    const clock = () => evaluate(`document.querySelector('[data-live="clock"]')?.textContent ?? null`);
    const seconds = t => (t || '0:00').split(':').reduce((a, x) => a * 60 + Number(x), 0);
    const first = seconds(await clock());
    await waitFor(`/^\\d+ fps$/.test(document.querySelector('[data-live="fps"]')?.textContent ?? '')`, "R2's real rate", 20000);
    await sleep(2500);
    const second = seconds(await clock());
    session.clockS = [first, second];
    if (!(second >= first + 2)) problems.push(`R2: the clock did not move: ${first} s, then ${second} s`);
    const fps = Number((await evaluate(`document.querySelector('[data-live="fps"]')?.textContent ?? ''`)).replace(/\D/g, ''));
    session.fps = fps;
    if (!(fps >= 29 && fps <= 31)) problems.push(`R2: the rate reads ${fps} fps, not 30 ± 1`);
    session.lift = await evaluate(`document.querySelector('[data-live="lift"]')?.textContent ?? null`);
    if (!String(session.lift).includes('last 60 s')) problems.push(`R2: the lift line says ${JSON.stringify(session.lift)}`);
    // d29: R2, wait 4 s, Replay → R3 (the position moves, ½× switches, a pause holds the countdown) → Keep and mark → M (1, a drag,
    // 2, 3 Analyse) → R2 with the queue line showing the lift → Q1 through that line, the job cancelled, "Back to the session" → R2.
    // The test build's replay engine picks a fixture track by the clip's rate and frame count and a recording matches none, so
    // the recorded lift's job is cancelled on Q1 before End session (the output says so).
    const walk = session.replay = { steps: [] };
    const stepped = what => { walk.steps.push(what); };
    const text = sel => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
    const posS = async () => { const m = /^(\d+):(\d\d) \//.exec(await text('[data-replay="position"]') || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    const countdownS = async () => seconds(await text('[data-replay="countdown"]'));
    await sleep(4000);
    if (!await click('[data-screen="R2"] [data-record="replay"]')) throw new Error('R2: no Replay button');
    await waitFor(`document.querySelector('[data-screen="R3"][data-phase="ready"] [data-replay="keep"]:not([disabled])')`, 'R3 with the snapshot open', 30000);
    stepped('R2 → Replay → R3');
    await waitFor(`(() => { const v = document.querySelector('[data-screen="R3"] video'); return v && v.readyState >= 2 && !v.paused; })()`, 'R3 playing', 20000);
    const seen = [];
    for (let k = 0; k < 6; k++) { seen.push(await posS()); await sleep(500); }
    walk.positions = seen;
    if (new Set(seen).size < 2) problems.push(`R3: the position did not move: ${JSON.stringify(seen)}`);
    stepped('R3 plays: the position moves');
    walk.ago = await text('[data-replay="ago"]');
    if (!/^\d+ s ago$/.test(walk.ago || '')) problems.push(`R3: the label says ${JSON.stringify(walk.ago)}`);
    if (!await click('[data-replay="speed"]')) throw new Error('R3: no ½× button');
    await waitFor(`document.querySelector('[data-replay="speed"]')?.textContent === '½×'`, 'R3 at ½×');
    walk.rate = await evaluate(`document.querySelector('[data-screen="R3"] video').playbackRate`);
    if (walk.rate !== 0.5) problems.push(`R3: ½× set the video's rate to ${walk.rate}`);
    await click('[data-replay="speed"]');
    await waitFor(`document.querySelector('[data-replay="speed"]')?.textContent === '1×'`, 'R3 back at 1×');
    stepped('R3: ½× switches to ½× and back');
    await click('[data-replay="play"]');
    await waitFor(`document.querySelector('[data-replay="play"][aria-label="Play"]')`, 'R3 paused');
    const held = await countdownS();
    await sleep(1600);
    const heldAfter = await countdownS();
    walk.held = [held, heldAfter];
    if (held !== heldAfter) problems.push(`R3: a pause did not hold the countdown: ${held} s, then ${heldAfter} s`);
    await click('[data-replay="play"]');
    await waitFor(`document.querySelector('[data-replay="play"][aria-label="Pause"]')`, 'R3 playing again');
    await sleep(1800);
    const running = await countdownS();
    walk.running = running;
    if (!(running < heldAfter)) problems.push(`R3: the countdown did not run while playing: ${heldAfter} s, then ${running} s`);
    stepped('R3: a pause holds the countdown, playing runs it');
    if (!await click('[data-replay="keep"]')) throw new Error('R3: no "Keep and mark" button');
    await waitFor(`document.querySelector('[data-screen="M"][data-step="start"] button[data-mark="start"]:not([disabled])')`, 'M open on the kept replay', 30000);
    stepped('R3 → Keep and mark → M (M1)');
    if (!await click('[data-screen="M"] button[data-mark="start"]')) throw new Error('M (session): no 1 Start');
    await waitFor(`document.querySelector('[data-screen="M"][data-step="end"] button[data-mark="end"]:not([disabled])')`, 'M (session) asking for the end');
    const strip = await evaluate(`(() => { const r = document.querySelector('.strip').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; })()`);
    const mouse = (type, x) => send('Input.dispatchMouseEvent', { type, x, y: strip.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' });
    await mouse('mousePressed', strip.x + strip.w - 10);
    for (let k = 1; k <= 10; k++) await mouse('mouseMoved', strip.x + strip.w - 10 - (strip.w - 20) * k / 10);
    await mouse('mouseReleased', strip.x + 10);
    let before = null, still = 0;
    for (let i = 0; i < 100 && still < 6; i++) {
      await sleep(100);
      const now = await evaluate(`document.querySelector('.strip')?.getAttribute('aria-valuenow') ?? null`);
      still = now !== null && now === before && Number(now) > 0 ? still + 1 : 0;
      before = now;
    }
    await sleep(300);
    if (!await click('[data-screen="M"] button[data-mark="end"]')) throw new Error('M (session): no 2 End');
    await waitFor(`document.querySelector('[data-screen="M"][data-step="ready"] button[data-mark="analyse"]:not([disabled])')`, 'M (session) ready to analyse');
    // the queue line is watched from the page: the job may end quickly (the replay engine has no track for a recording)
    await evaluate(`(() => {
      globalThis.__queueLines = [];
      new MutationObserver(() => { const q = document.querySelector('[data-live="queue"]'); const t = q ? q.textContent.trim() : null; const a = globalThis.__queueLines; if (t && a[a.length - 1] !== t) a.push(t); })
        .observe(document.body, { childList: true, subtree: true, characterData: true });
    })()`);
    // a recording matches no fixture track, so its job would fail at once: it is held at its clip (boot.mjs) until Q1 cancels it
    await evaluate(`(() => { globalThis.coachReplay.hold = new Promise(r => { globalThis.coachReplay.release = r; }); })()`);   // (the expression's value is not the promise: evaluate would wait for it)
    if (!await click('[data-screen="M"] button[data-mark="analyse"]')) throw new Error('M (session): no 3 Analyse');
    const shows = () => evaluate("(document.querySelector('[data-screen]')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 200)");
    await waitFor(`document.querySelector('[data-screen="R2"][data-state="recording"]')`, 'R2 again after 3 Analyse', 30000).catch(async e => { throw new Error(`${e.message}; the page shows ${await shows()}`); });
    await waitFor(`globalThis.__queueLines.length > 0`, 'the queue line showing the lift', 10000);
    walk.queue = (await evaluate(`globalThis.__queueLines`))[0];
    stepped('M: 1, a drag, 2, 3 Analyse → R2 with the queue line ' + JSON.stringify(walk.queue));
    // Q1 through the queue line while it shows (once the job has ended the line is gone, and the lift is on H's list)
    // the hold keeps the job pending, so the queue line stays up: a line that cannot be tapped is a regression
    try {
      walk.viaLine = await click('[data-live="queue"]');
      if (!walk.viaLine) {
        problems.push('R2: the queue line could not be tapped, Q1 not reached');
        stepped('R2: the queue line could not be tapped (the job is held, so it should show); Q1 not reached');
      } else {
        await waitFor(`document.querySelector('[data-screen="Q1"]')`, 'Q1 from the queue line');
        await waitFor(`[...document.querySelectorAll('[data-screen="Q1"] .button--quiet')].some(b => b.textContent.includes('Cancel'))`, "Q1's Cancel button", 10000).catch(() => {});
        walk.cancelled = await click('[data-screen="Q1"] .button--quiet', 'Cancel');
        if (!walk.cancelled) problems.push('Q1: the recorded lift\'s job has no Cancel button');
        stepped("Q1: the recorded lift's job cancelled (the replay engine has no track for a recording)");
        await evaluate(`(() => { globalThis.coachReplay.release(); globalThis.coachReplay.hold = null; })()`);   // the held job goes on, sees the cancel and stops
        await sleep(300);
        if (!await click('[data-screen="Q1"] button', 'Back to the session')) throw new Error('Q1: no "Back to the session"');
        await waitFor(`document.querySelector('[data-screen="R2"][data-state="recording"]')`, 'R2 after "Back to the session"');
        stepped('Q1 → Back to the session → R2');
      }
    } finally {
      // on every path the hold is let go and cleared, so a held job never stays pending
      await evaluate(`(() => { const r = globalThis.coachReplay; if (r) { if (r.release) r.release(); r.hold = null; } })()`).catch(() => {});
    }
    // the way back to the session: Q1 from the queue chip is not reachable with an empty queue; H's card is (R2 -> End is the way out)
    if (!await click('[data-screen="R2"] [data-record="end"]')) throw new Error('R2: no End session button');
    await waitFor(`document.querySelector('[data-screen="H"]')`, 'H after End session');
    const ended = await evaluate(`({ n: globalThis.__tracks.length, live: globalThis.__tracks.filter(t => t.readyState !== 'ended').length })`);
    session.tracks = ended.n;
    if (ended.n < 1) problems.push('the session: the page saw no camera track');
    if (ended.live) problems.push(`the session: ${ended.live} of ${ended.n} camera tracks are still live after End session`);
    const card = await evaluate(`document.querySelector('[data-screen="H"] [data-card="session"]')?.textContent ?? null`);
    if (!String(card).includes('Gym session')) problems.push(`H: after End session the gym card says ${JSON.stringify(card)}`);
  }

  // 5b. d23: a file that is not a video ends on the error screen, with a way back (the file is outside dist)
  if (!realClip) {
    const junk = join(dist, '..', `coach-page-junk-${process.pid}.mp4`);
    writeFileSync(junk, 'this is not a video\n');
    try {
      await waitFor(`document.querySelector('[data-screen="H"]')`, 'H (junk file)');
      const input = await evaluate(`document.querySelector('[data-screen="H"] input[type="file"]')`, { objectId: true });
      await send('DOM.setFileInputFiles', { files: [junk], objectId: input.objectId });
      await waitFor(`document.querySelector('[data-screen="L1"]')`, 'L1 (junk file)');
      if (!await click('[data-screen="L1"] [data-lift]')) throw new Error('L1 has no tile');
      await waitFor(`document.querySelector('[data-screen="M"][data-step="problem"] [data-problem="unreadable"]')`, "the error screen for a file that isn't a video");
      result.unreadableScreen = await evaluate(`document.querySelector('.problem__title')?.textContent ?? null`);
      if (!await click('[data-screen="M"] button', 'Back to home')) throw new Error('the error screen has no way back');
      await waitFor(`document.querySelector('[data-screen="H"]')`, 'H after the error screen');
    } finally { rmSync(junk, { force: true }); }
  }

  // 6. what went wrong anywhere: console, exceptions, rejections, failed requests (page, workers, service worker)
  await sleep(500);
  const sent = new Map();
  for (const e of events) if (e.method === 'Network.requestWillBeSent') sent.set(`${e.sessionId ?? ''}/${e.params.requestId}`, e.params.request.url);
  for (const e of events) {
    const p = e.params;
    if (e.method === 'Runtime.exceptionThrown') problems.push(`exception: ${(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).split('\n').slice(0, 6).join(' | ')} (${p.exceptionDetails.url ?? ''}:${p.exceptionDetails.lineNumber ?? ''})`);
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
  if (browser) await browser.close();   // the whole tree is gone before the profile is removed
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
// a lift the app offers with no fixture: listed every run, so a lift isn't left out of the walk unnoticed
if (!realClip && COVERAGE.untested.length) say(`page-test: not walked, no fixture in app/tools/lift-fixtures.mjs: ${COVERAGE.untested.join(', ')}`);
if (!realClip && result.session) say(`page-test: session walk (H, R1, Start, R2, R3, M, R2, Q1, R2, End session, H): ${result.session.fps} fps, clock ${result.session.clockS?.join(' → ')} s, ${result.session.tracks} camera tracks ended`);
if (!realClip && result.session?.replay) for (const st of result.session.replay.steps) say(`page-test:   ${st}`);
say(result.ok ? `page-test: PASSED in ${result.seconds} s` : `page-test: FAILED: ${result.problems[0] ?? 'a lift did not complete'}`);
process.exit(result.ok ? 0 : 1);
