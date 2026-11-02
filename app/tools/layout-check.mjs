// node app/tools/layout-check.mjs [--browser PATH] [--shots DIR] [--break KIND]     (npm --prefix app run check:layout)
//
// The responsive check (package d25, plan step 5.7): every screen of the app at five window sizes, in the page
// test's build (assemble.mjs --test, app/README.md "The page test") in headless Brave or Chromium over the
// DevTools protocol. It walks the app the way the page test does (first-run intro, H, S1, S1's credits, S1b,
// Import, M in its three steps and its error, Q1, A1, A3's sheet, A2) and at each screen sets each size in turn:
//   phone portrait 360×800 and 412×915, phone landscape 800×360, tablet 768×1024, laptop 1280×800.
// It fails on
//   - horizontal scrolling: the page is wider than the window;
//   - content cut off: an element sticking out of the window to the side, outside anything that scrolls or
//     clips it by design; text clipped by its own box (overflow hidden, not a line clamp); a scrolling area
//     left with less than a touch target of height; a control that has no place in the window;
//   - a touch target under 44 px (tokens.css --touch) in either direction: buttons, links, inputs, selects,
//     summaries and sliders that are drawn. A link inside a sentence is exempt (WCAG 2.5.8's inline exception), and a
//     control inside a <label> is touched through the label, so the label's box counts.
// R2 and R3 are placeholders no flow step reaches in 0.1.0 (H's gym card is disabled), so they are not walked.
//
// --shots DIR   writes a PNG per screen and size into DIR (outside the repo: screenshots stay out of git).
// --break KIND  a deliberate fault to see the check fail (exit 1): scroll (a 2000 px wide element), clip (text in a
//               box that hides its overflow), small (a 30 px button), cut (an element beyond the right edge).
// No browser found: fails with one clear line, unless COACH_PAGE_TEST_SKIP=1 (then it says it skipped, exit 0).
// The browser is found, launched and ended by browser.mjs only (c47).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble } from './assemble.mjs';
import { createApp } from './serve.mjs';
import { BROWSERS, findBrowser, launchBrowser } from './browser.mjs';
import { WIDE_MIN_PX } from '../src/ui/wide-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const ROOT = resolve(APP, '..');

/** The five sizes of step 5.7, in CSS pixels. `mobile` is what the DevTools emulation needs for a phone or tablet. */
export const VIEWPORTS = Object.freeze([
  { name: 'phone portrait', width: 360, height: 800, mobile: true },
  { name: 'phone portrait, large', width: 412, height: 915, mobile: true },
  { name: 'phone landscape', width: 800, height: 360, mobile: true },
  { name: 'tablet portrait', width: 768, height: 1024, mobile: true },
  { name: 'laptop', width: 1280, height: 800, mobile: false },
]);
/** tokens.css --touch */
export const TOUCH_PX = 44;

/**
 * The page-side check, as a source string: evaluated in the page, returns the problems found as text.
 * Kept as a plain function (it is stringified), so it can be tested on a fake document.
 */
export function pageCheck(touch, vw) {   // vw: the width the size asked for (a mobile window's own width grows with a wide page)
  const problems = [];
  const doc = document.documentElement;
  const where = el => {
    const bits = [];
    for (let e = el; e && e !== document.body && bits.length < 3; e = e.parentElement) {
      bits.unshift(e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : ''));
    }
    const text = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    return `${bits.join(' > ')}${text ? ` "${text}"` : ''}`;
  };
  const drawn = el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const clipsX = cs => cs.overflowX !== 'visible';
  const clipsY = cs => cs.overflowY !== 'visible';

  // 1. horizontal scrolling
  if (doc.scrollWidth > vw + 1) problems.push(`horizontal scrolling: the page is ${doc.scrollWidth} px wide in a ${vw} px window`);
  if (document.body.scrollWidth > vw + 1 && doc.scrollWidth <= vw + 1) problems.push(`horizontal scrolling: the body is ${document.body.scrollWidth} px wide in a ${vw} px window`);

  // a scrolling area squeezed to nothing is not "drawn" (no height) and is the worst case of 2c: look at all of them
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && cs.display !== 'none' && el.scrollHeight > el.clientHeight + 1 && el.clientHeight < touch) {
      problems.push(`content cut off: ${where(el)} scrolls but is only ${el.clientHeight} px high`);
    }
  }
  const all = [...document.querySelectorAll('body *')].filter(drawn);
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // 2a. sticking out at the side, with nothing between it and the window that clips or scrolls it
    if (r.right > vw + 1 || r.left < -1) {
      let held = false;
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        if (clipsX(getComputedStyle(p))) { held = true; break; }
      }
      if (!held && cs.position !== 'fixed') problems.push(`cut off at the side: ${where(el)} spans ${Math.round(r.left)}–${Math.round(r.right)} px in a ${vw} px window`);
    }
    // 2b. text or content clipped by its own box
    const tag = el.tagName;
    if (!['CANVAS', 'VIDEO', 'IMG', 'SVG', 'svg'].includes(tag) && (clipsX(cs) || clipsY(cs))) {
      const clamp = cs.getPropertyValue('-webkit-line-clamp');
      const lineClamp = !!clamp && clamp !== 'none';
      const scrolls = (cs.overflowY === 'auto' || cs.overflowY === 'scroll');
      const scrollsX = (cs.overflowX === 'auto' || cs.overflowX === 'scroll');
      if (!lineClamp) {
        if (!scrollsX && clipsX(cs) && el.scrollWidth > el.clientWidth + 1) problems.push(`content cut off: ${where(el)} holds ${el.scrollWidth} px in ${el.clientWidth} px`);
        if (!scrolls && clipsY(cs) && el.scrollHeight > el.clientHeight + 1) problems.push(`content cut off: ${where(el)} holds ${el.scrollHeight} px in ${el.clientHeight} px`);
      }
    }
    // 3. touch targets
    const interactive = el.matches('button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="slider"], [role="switch"], [role="button"], [role="checkbox"], [role="radio"]');
    if (interactive) {
      const inline = el.tagName === 'A' && cs.display === 'inline';
      // a control inside a <label> is touched through the label: the label's box is the target
      const box = el.closest('label') ? el.closest('label').getBoundingClientRect() : r;
      if (!inline && (box.width < touch - 0.5 || box.height < touch - 0.5)) problems.push(`touch target under ${touch} px: ${where(el)} is ${Math.round(box.width)}×${Math.round(box.height)} px`);
    }
  }
  return problems;
}

/**
 * A1's arrangement (A4, d25), page side: from `wideMin` px the video and the selected cue's panel share a row and the
 * cues are a sidebar beside them, one cue is selected and its plot is drawn; below it everything is stacked in one
 * column and there is no panel. Stringified like pageCheck.
 */
export function a4Arrangement(vw, wideMin) {
  const problems = [];
  const q = s => document.querySelector(s);
  const box = s => { const e = q(s); return e ? e.getBoundingClientRect() : null; };
  const screen = q('[data-screen="A1"]');
  if (!screen) return ['A1 is not on the screen'];
  const stage = box('.result-stage'), cues = box('.cues'), panel = box('.result-selected'), bar = box('.result-bar .timeline');
  if (!stage || !cues || !bar) return ['A1 lacks its video, its cues or its timeline'];
  if (vw >= wideMin) {
    if (screen.dataset.layout !== 'wide') problems.push(`A4: A1 is "${screen.dataset.layout}" in a ${vw} px window`);
    if (!panel) problems.push('A4: no panel for the selected cue');
    else {
      if (!(panel.left >= stage.right - 1 && Math.abs(panel.top - stage.top) < 2)) problems.push('A4: the selected cue is not beside the video');
      if (!(cues.left >= panel.right - 1)) problems.push('A4: the cues are not in a sidebar beside the video and the panel');
      if (!(bar.top >= Math.max(stage.bottom, panel.bottom) - 1)) problems.push("A4: the player's bar is not under the video and the panel");
      const plot = box('.result-selected .detail-plot__canvas');
      if (!plot || plot.width < 100 || plot.height < 100) problems.push("A4: the selected cue's plot is not drawn");
    }
    if (document.querySelectorAll('.cue-card__head[aria-pressed="true"]').length !== 1) problems.push('A4: not exactly one cue is selected');
    if (document.querySelector('.cue-card__body')) problems.push('A4: a card is open in the sidebar');
  } else {
    if (screen.dataset.layout !== 'stacked') problems.push(`A4: A1 is "${screen.dataset.layout}" in a ${vw} px window`);
    if (panel) problems.push('A4: the panel shows while stacked');
    if (!(bar.top >= stage.bottom - 1 && cues.top >= bar.bottom - 1)) problems.push('stacked: the video, the bar and the cues are not in one column');
  }
  return problems;
}

const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt; };
const say = s => process.stdout.write(`${s}\n`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// What a deliberate fault adds to the page, to see the check fail.
const BREAKS = {
  scroll: `(() => { const d = document.createElement('div'); d.style.cssText = 'width:2000px;height:4px'; document.body.appendChild(d); })()`,
  clip: `(() => { const d = document.createElement('div'); d.style.cssText = 'width:40px;overflow:hidden;white-space:nowrap'; d.textContent = 'a line of text far too long for its box'; document.body.appendChild(d); })()`,
  small: `(() => { const b = document.createElement('button'); b.style.cssText = 'min-width:0;min-height:0;width:30px;height:30px;padding:0'; b.textContent = 'x'; document.body.appendChild(b); })()`,
  cut: `(() => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;top:0;left:' + (document.documentElement.clientWidth - 20) + 'px;width:80px;height:10px;background:currentColor'; document.body.appendChild(d); })()`,
};

async function main() {
  const breakKind = arg('--break');
  if (breakKind && !BREAKS[breakKind]) { console.error(`layout-check: --break wants ${Object.keys(BREAKS).join(', ')} (got ${breakKind})`); return 2; }
  const shots = arg('--shots');
  const browserPath = findBrowser();
  if (!browserPath) {
    if (process.env.COACH_PAGE_TEST_SKIP === '1') { say('layout-check: SKIPPED: no Brave or Chromium found (COACH_PAGE_TEST_SKIP=1)'); return 0; }
    console.error(`layout-check: FAILED: no Brave or Chromium found (looked for ${BROWSERS.join(', ')} on PATH; give one with --browser PATH, or set COACH_PAGE_TEST_SKIP=1 to skip)`);
    return 1;
  }
  if (shots) mkdirSync(shots, { recursive: true });

  const dist = mkdtempSync(join(tmpdir(), 'coach-layout-dist-'));
  const profile = mkdtempSync(join(tmpdir(), 'coach-layout-profile-'));
  const clip = join(ROOT, 'tests', 'app', 'clips', 'testsrc2-lateral-raise-25fps-75f.mp4');
  const junk = join(tmpdir(), `coach-layout-junk-${process.pid}.mp4`);
  const problems = [];
  const walked = [];   // "screen @ size" in the order checked
  const t0 = Date.now();
  let browser = null, server = null;
  const realLog = console.log;
  console.log = () => {};   // serve.mjs logs every request

  try {
    assemble({ out: dist, app: APP, src: join(ROOT, 'src'), test: true, log: () => {} });
    server = createApp(dist);
    await new Promise(r => server.listen(Number(process.env.COACH_PORT) || 0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await launchBrowser(profile, ['--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=390,844', 'about:blank'], { browser: browserPath });
    const target = await (await fetch(`http://127.0.0.1:${browser.port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools socket')); });
    let id = 0;
    const pending = new Map();
    const errors = [];   // console errors and exceptions: a broken page is not a laid-out one
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    };
    const send = (method, params = {}) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression, { timeout = 30000, objectId = false } = {}) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: !objectId, timeout });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      return objectId ? r.result.result : r.result?.result?.value;
    };
    async function waitFor(expression, what, ms = 20000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        try { const v = await evaluate(expression); if (v) return v; } catch { /* between documents */ }
        await sleep(100);
      }
      throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    }
    const click = (selector, text) => evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => ${text ? `e.textContent.includes(${JSON.stringify(text)}) || (e.getAttribute('aria-label') || '').includes(${JSON.stringify(text)})` : 'true'});
      if (!el || el.disabled) return false;
      el.click();
      return true;
    })()`);
    for (const d of ['Page', 'Runtime']) await send(`${d}.enable`);

    const setViewport = v => send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.mobile });
    const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Check the screen now showing at every size; `label` names it in the report.
    async function check(label, extra = null) {
      for (const v of VIEWPORTS) {
        await setViewport(v);
        await sleep(350);   // layout, the ResizeObserver redraws, A1's switch between the stacked and wide arrangements
        await evaluate('document.fonts.ready.then(() => true)').catch(() => {});
        if (breakKind) await evaluate(BREAKS[breakKind]);
        const found = await evaluate(`(${pageCheck.toString()})(${TOUCH_PX}, ${v.width})`);
        walked.push(`${label} @ ${v.width}×${v.height}`);
        if (extra) found.push(...await evaluate(`(${extra.toString()})(${v.width}, ${WIDE_MIN_PX})`));
        for (const p of found) problems.push(`${label} @ ${v.width}×${v.height} (${v.name}): ${p}`);
        if (shots) {
          const png = await send('Page.captureScreenshot', { format: 'png' });
          writeFileSync(join(shots, `${slug(label)}-${v.width}x${v.height}.png`), Buffer.from(png.result.data, 'base64'));
        }
        if (breakKind) throw new Error('--break: the first screen was checked');
      }
      await setViewport(VIEWPORTS[0]);
    }

    await setViewport(VIEWPORTS[0]);
    await send('Page.navigate', { url: `${origin}/` });
    // the first run: the intro
    await waitFor(`document.querySelector('[data-screen="Welcome"]')`, 'the intro on the first run');
    await check('Welcome');
    await click('.welcome__skip', 'Go to home');
    await waitFor(`document.querySelector('[data-screen="H"]')`, 'H');
    await check('H');

    // S1, its credits, S1b
    await click('button', 'Settings and about');
    await waitFor(`document.querySelector('[data-screen="S1"][data-view="main"]')`, 'S1');
    await check('S1');
    await click('button', 'Credits and licences');
    await waitFor(`document.querySelector('[data-screen="S1"][data-view="credits"]')`, "S1's credits");
    await evaluate(`document.querySelector('[data-screen="S1"] details')?.setAttribute('open', '')`);
    await check('S1 credits');
    await click('button', 'Back to settings');
    await waitFor(`document.querySelector('[data-screen="S1"][data-view="main"]')`, 'S1 again');
    await click('button', 'How the cues are scored');
    await waitFor(`document.querySelector('[data-screen="S1b"]')`, 'S1b');
    await check('S1b');
    await click('button', 'Back to settings');
    await waitFor(`document.querySelector('[data-screen="S1"][data-view="main"]')`, 'S1 once more');
    await click('button', 'Back to home');
    await waitFor(`document.querySelector('[data-screen="H"]')`, 'H again');

    // Import → M
    await click('button', 'Import a video');
    await waitFor(`document.querySelector('[data-screen="Import"]')`, 'Import');
    await check('Import');
    await evaluate(`document.querySelector('input[name="lift"][value="lateral-raise"]').click()`);
    const input = await evaluate(`document.querySelector('input[type="file"]')`, { objectId: true });
    await send('DOM.setFileInputFiles', { files: [clip], objectId: input.objectId });
    await waitFor(`document.querySelector('[data-screen="M"][data-step="start"] .mark-main--set:not([disabled])')`, 'M with the video open');
    await check('M (set the start)');
    await click('.mark-main--set');
    await waitFor(`document.querySelector('[data-screen="M"][data-step="end"]')`, 'M asking for the end');
    // the filmstrip dragged to the end, as the page test does (at the phone's size)
    await setViewport(VIEWPORTS[0]);
    await sleep(300);
    const strip = await evaluate(`(() => { const r = document.querySelector('.strip').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; })()`);
    const mouse = (type, x) => send('Input.dispatchMouseEvent', { type, x, y: strip.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' });
    await mouse('mousePressed', strip.x + strip.w - 10);
    for (let k = 1; k <= 10; k++) await mouse('mouseMoved', strip.x + strip.w - 10 - (strip.w - 20) * k / 10);
    await mouse('mouseReleased', strip.x + 10);
    await sleep(1500);
    await check('M (set the end)');
    await click('.mark-main--set');
    await waitFor(`document.querySelector('[data-screen="M"][data-step="ready"] .mark-main.button--primary:not([disabled])')`, 'M ready to analyse');
    await check('M (ready)');
    await click('.mark-main.button--primary');

    // Q1, then A1
    await waitFor(`document.querySelector('[data-screen="Q1"]')`, 'Q1', 30000);
    await check('Q1');
    await waitFor(`[...document.querySelectorAll('[data-screen="Q1"] button')].some(b => b.textContent.includes('Open the result'))`, 'the job to finish', 60000);
    await check('Q1 (done)');
    await click('button', 'Open the result');
    await waitFor(`document.querySelector('[data-screen="A1"] .cue-card')`, 'A1 with cue cards');
    await waitFor(`document.querySelector('[data-screen="A1"] .result-header__more:not([disabled])')`, 'A1 ready');
    await sleep(800);
    await check('A1', a4Arrangement);
    // A3 over A1
    await click('[data-screen="A1"] .result-header__more');
    await waitFor(`document.querySelector('.vo-sheet')`, 'A3');
    await check('A3');
    await click('.vo-done');
    await waitFor(`!document.querySelector('.vo-sheet')`, 'A3 closed');
    // A2: from the card's "Plot and details" (open by default on a cue to work on, or the panel's in the wide window)
    await setViewport(VIEWPORTS[0]);
    await sleep(400);
    if (!await click('.cue-card__more')) {
      await evaluate(`document.querySelector('.cue-card__head').click()`);
      await sleep(200);
      if (!await click('.cue-card__more')) throw new Error('A1 has no "Plot and details"');
    }
    await waitFor(`document.querySelector('[data-screen="A2"] .detail-play')`, 'A2');
    await sleep(500);
    await check('A2');
    await click('[data-screen="A2"] button', 'Back to the result');
    await waitFor(`document.querySelector('[data-screen="A1"] .result-header__more:not([disabled])')`, 'A1 again');
    await click('[data-screen="A1"] .result-header__more');
    await waitFor(`document.querySelector('.vo-sheet')`, 'A3 again');
    await click('.vo-done');
    await waitFor(`!document.querySelector('.vo-sheet')`, 'A3 closed again');
    await click('button', 'Back');
    await waitFor(`document.querySelector('[data-screen="H"]')`, 'H after the result');

    // a file that is not a video: the error screen
    writeFileSync(junk, 'this is not a video\n');
    await click('button', 'Import a video');
    await waitFor(`document.querySelector('[data-screen="Import"]')`, 'Import (junk file)');
    const input2 = await evaluate(`document.querySelector('input[type="file"]')`, { objectId: true });
    await send('DOM.setFileInputFiles', { files: [junk], objectId: input2.objectId });
    await waitFor(`document.querySelector('[data-screen="M"][data-step="problem"]')`, 'the error screen');
    await check('M (error)');

    if (errors.length) problems.push(`the page logged errors: ${[...new Set(errors)].slice(0, 3).join(' | ').slice(0, 400)}`);
    ws.close();
  } catch (e) {
    if (!(breakKind && /--break: the first screen/.test(e.message))) problems.push(`the run stopped: ${e.message}`);
  } finally {
    if (browser) await browser.close();
    if (server) server.close();
    await sleep(300);
    rmSync(junk, { force: true });
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    rmSync(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    console.log = realLog;
  }

  const unique = [...new Set(problems)];
  const screens = new Set(walked.map(w => w.split(' @ ')[0]));
  say(`layout-check: ${walked.length} checks (${screens.size} screens × ${VIEWPORTS.length} sizes) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  say(`screens: ${[...screens].join(', ')}`);
  for (const p of unique) say(`  ✗ ${p}`);
  const ok = unique.length === 0 && (breakKind ? true : screens.size >= 15);
  if (!breakKind && unique.length === 0 && !ok) say(`layout-check: too few screens walked (${screens.size})`);
  say(unique.length === 0 && ok ? 'layout-check: PASSED' : `layout-check: FAILED: ${unique[0] ?? 'too few screens walked'}`);
  return unique.length === 0 && ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
