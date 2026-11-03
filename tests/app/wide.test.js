// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// d25: A4, the wide result (design/mockups/Desktop.dc.html), and the responsive check. The model's plain functions, the
// breakpoint's two spellings agreeing, the tokens rule, and layout-check.mjs's own behaviour (its faults, no browser).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const load = (...p) => import(pathToFileURL(path.join(APP, ...p)).href);
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8');

test('the breakpoint is written the same in the model and in base.css, and is in the mockup\'s reach', async () => {
  const { WIDE_MIN_PX, WIDE_QUERY } = await load('src', 'ui', 'wide-model.mjs');
  assert.equal(WIDE_QUERY, `(min-width: ${WIDE_MIN_PX}px)`);
  const css = read('src', 'styles', 'base.css');
  const queries = [...css.matchAll(/@media \(min-width: (\d+)px\)/g)].map(m => Number(m[1]));
  assert.deepEqual(queries, [WIDE_MIN_PX], 'base.css has exactly one min-width query, A4\'s');
  // the mockup's main column 560 + gap 24 + sidebar 340 + 2 × 24 of padding = 972: the breakpoint is not below it
  assert.ok(WIDE_MIN_PX >= 560 + 24 + 340 + 48, `${WIDE_MIN_PX} px fits the mockup's two columns`);
  // and above the widest phone landscape and the portrait tablet that the responsive check walks (they stack)
  assert.ok(WIDE_MIN_PX > 800 && WIDE_MIN_PX > 768);
});

test('A4 draws from tokens only: no colour literal in app/src/ui/, no px or colour literal in its CSS block', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(APP, 'src', 'ui'))) {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(fs.readFileSync(f, 'utf8')), `${path.relative(ROOT, f)} holds a colour literal`);
  }
  const css = read('src', 'styles', 'base.css');
  const block = css.slice(css.indexOf('/* A4, the wide result'));
  assert.ok(block.length > 500);
  const lines = block.split('\n').filter(l => !l.startsWith('/*') && !/^\s+\S.*\*\/$/.test(l) && !l.startsWith('   '));
  for (const l of lines) {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(l), `a colour literal: ${l}`);
    assert.ok(!/\d(px|rem|em)\b/.test(l.replace(/@media \(min-width: \d+px\)/, '').replace(/\b1px\b/g, '')), `a size literal outside tokens.css: ${l}`);
  }
  const tokens = read('src', 'styles', 'tokens.css');
  for (const n of ['--wide-max', '--wide-aside', '--wide-stage', '--wide-stage-max', '--size-wordmark-wide', '--size-tile', '--chip-h', '--tile-min', '--wide-panel-min']) {
    assert.match(tokens, new RegExp(`${n}:`), `tokens.css defines ${n}`);
  }
});

test('A4: the video column gives way to the panel and the sidebar (fixed at 1024 px, where the page scrolled sideways)', () => {
  // The stage is min(560 px, 480 px × ratio) wide: 560 for a landscape or square video. 560 + 340 + 32 + the panel does not fit in
  // 932 px (980 px less 2 × 24), so the video track shrinks (minmax(0, auto), the stage at max-width 100%) and the panel keeps
  // the mockup's 300 px. The response is pinned in the browser by layout-check.mjs (A1 with a landscape video at 1024 and 980 px).
  const css = read('src', 'styles', 'base.css');
  const grid = css.match(/grid-template-columns: ([^;]+);\s*grid-template-areas: "stage selected cues"/);
  assert.ok(grid, 'the wide grid');
  assert.equal(grid[1], 'minmax(0, auto) minmax(var(--wide-panel-min), 1fr) var(--wide-aside)');
  const stage = css.match(/\.result-stage \{ grid-area: stage;[^}]*\}/)[0];
  assert.match(stage, /max-width: 100%/);
});

test('a slider is a touch target: --slider-h is --touch (the responsive check found 32 px in A3)', () => {
  assert.match(read('src', 'styles', 'tokens.css'), /--slider-h:\s*var\(--touch\)/);
});

test('crumbOf: the session and the lift\'s name with its time and length', async () => {
  const { crumbOf } = await load('src', 'ui', 'wide-model.mjs');
  const created = new Date(2026, 10, 2, 14, 27, 5).toISOString();
  const lift = { lift: 'lateral-raise', created, range: { t0: 1, t1: 4.04 } };
  assert.deepEqual(crumbOf(lift, new Date(2026, 10, 2, 20, 0)), { parent: 'Today', current: 'Lateral raise \u00b7 14:27 \u00b7 3.0 s' });
  assert.equal(crumbOf(lift, new Date(2026, 10, 5, 9, 0)).parent, 'Earlier');
});

test('selectedOf: the chosen cue, else the first to work on, else to watch, else the first; null with none', async () => {
  const { selectedOf } = await load('src', 'ui', 'wide-model.mjs');
  const cards = [{ id: 'a', status: 'good' }, { id: 'b', status: 'watch' }, { id: 'c', status: 'work on' }, { id: 'd', status: "can't score" }];
  assert.equal(selectedOf(cards, 'd').id, 'd');
  assert.equal(selectedOf(cards, null).id, 'c');
  assert.equal(selectedOf(cards, 'gone').id, 'c');
  assert.equal(selectedOf(cards.filter(c => c.id !== 'c'), null).id, 'b');
  assert.equal(selectedOf(cards.filter(c => c.id === 'a' || c.id === 'd'), null).id, 'a');
  assert.equal(selectedOf([], null), null);
});

test('footOf and the labels: the rule sentence, then the mockup\'s provisional sentence', async () => {
  const { footOf, cuesHeading, frameLabel, PROVISIONAL_FOOT } = await load('src', 'ui', 'wide-model.mjs');
  assert.equal(PROVISIONAL_FOOT, 'Provisional: not yet checked on real lifts.');
  const zones = [{ status: 'work on', from: null, to: -5 }, { status: 'watch', from: -5, to: 5 }, { status: 'good', from: 5, to: null }];
  const foot = footOf({ reason: null, unit: '%', provisional: true }, zones, null);
  assert.ok(foot.startsWith('Good from +5%'), foot);
  assert.ok(foot.endsWith(` ${PROVISIONAL_FOOT}`), foot);
  assert.equal(footOf({ reason: "only one rep", unit: '%', provisional: true }, zones, null), PROVISIONAL_FOOT);
  assert.equal(footOf({ reason: "only one rep", unit: '%', provisional: false }, zones, null), null);
  assert.equal(cuesHeading(5), '5 cues');
  assert.equal(cuesHeading(1), '1 cue');
  assert.equal(frameLabel(3.24, { t0: 1, t1: 4 }), 'Video with the pose skeleton, at 2.24 s');
});

test('layout-check: the five sizes of step 5.7, two just above the breakpoint, and the 44 px of tokens.css', async () => {
  const { VIEWPORTS, TOUCH_PX, LANDSCAPE_VIDEO } = await load('tools', 'layout-check.mjs');
  const { WIDE_MIN_PX } = await load('src', 'ui', 'wide-model.mjs');
  assert.deepEqual(VIEWPORTS.map(v => `${v.width}x${v.height}`), ['360x800', '412x915', '800x360', '768x1024', '1280x800', '1024x768', `${WIDE_MIN_PX}x720`]);
  assert.match(LANDSCAPE_VIDEO, /--frame-ratio/, 'A1 is also walked with a landscape video, which asks for the stage\'s full width');
  assert.match(read('src', 'styles', 'tokens.css'), new RegExp(`--touch:\\s*${TOUCH_PX}px`));
});

test('d54 layout-check: M at 360×640, 360×800, 412×760 and 412×915 has no vertical scroll and every control inside the window', async () => {
  const { M_NO_SCROLL, M_SIZES, VIEWPORTS, markFits } = await load('tools', 'layout-check.mjs');
  const { MARK_CONTROLS } = await load('tools', 'shift-check.mjs');
  assert.deepEqual(M_NO_SCROLL.map(v => `${v.width}x${v.height}`), ['360x640', '360x800', '412x760', '412x915']);
  assert.deepEqual(M_SIZES.map(v => `${v.width}x${v.height}`), [...VIEWPORTS.map(v => `${v.width}x${v.height}`), '360x640', '412x760']);
  const page = (scrollHeight, boxes) => {
    globalThis.document = {
      documentElement: { scrollHeight },
      querySelector: sel => { const b = boxes[sel]; return b ? { getBoundingClientRect: () => b } : null; },
    };
  };
  const inside = Object.fromEntries(MARK_CONTROLS.map(([, sel], i) => [sel, { left: 16, top: 60 + 60 * i, right: 344, bottom: 100 + 60 * i }]));
  const fits = (vw, vh) => markFits(vw, 980, vh, M_NO_SCROLL, MARK_CONTROLS);
  try {
    page(640, inside);
    assert.deepEqual(fits(360, 640), []);
    page(700, inside);
    assert.deepEqual(fits(360, 640), ['M scrolls: the page is 700 px high in a 640 px window']);
    assert.deepEqual(fits(800, 360), [], 'phone landscape may scroll');
    const below = { ...inside, [MARK_CONTROLS[8][1]]: { left: 250, top: 600, right: 344, bottom: 668 } };
    page(640, below);
    assert.deepEqual(fits(360, 640), ['M: 3 Analyse is not inside the window (250,600 to 344,668 in 360×640)']);
    page(640, { ...inside, [MARK_CONTROLS[5][1]]: undefined });
    assert.deepEqual(fits(360, 640), ['M: ↶ is not on the screen']);
  } finally { delete globalThis.document; }
  const src = read('tools', 'layout-check.mjs');
  for (const label of ['M (set the start)', 'M (set the end)', 'M (ready)']) assert.ok(src.includes(`check('${label}', markFits, null, M_SIZES)`), label);
  assert.doesNotMatch(src, /mark-main/);
});

test('d58 layout-check: A1 and A2 at the four portrait sizes have no vertical scroll, their lists scroll inside, every control inside the window', async () => {
  const { M_NO_SCROLL, M_SIZES, RESULT_CONTROLS, DETAIL_CONTROLS, fitsWindow } = await load('tools', 'layout-check.mjs');
  const page = (scrollHeight, boxes, cueShown = false) => {
    globalThis.document = {
      documentElement: { scrollHeight },
      querySelector: sel => (sel === '.more-below' ? { hidden: !cueShown } : boxes[sel] ? { getBoundingClientRect: () => boxes[sel] } : null),
    };
  };
  const placed = controls => Object.fromEntries(controls.map(([, sel], i) => [sel, { left: 8, top: 10 + 30 * i, right: 300, bottom: 30 + 30 * i }]));
  try {
    for (const [controls, name] of [[RESULT_CONTROLS, 'A1'], [DETAIL_CONTROLS, 'A2']]) {
      const ok = placed(controls);
      for (const s of M_NO_SCROLL) {
        page(s.height, ok);
        assert.deepEqual(fitsWindow(s.width, 980, s.height, M_NO_SCROLL, controls, name), [], `${name} at ${s.width}×${s.height}`);
      }
      // A1 as it was on phase-0: .screen's flex: 1 gave it its content's height, and the page scrolled instead of the list
      page(1185, ok, true);
      assert.deepEqual(fitsWindow(360, 980, 640, M_NO_SCROLL, controls, name), [`${name} scrolls: the page is 1185 px high in a 640 px window`, `${name}: the "more below" cue shows although ${name} fits its window`]);
      page(640, { ...ok, [controls[controls.length - 1][1]]: { left: 0, top: 510, right: 360, bottom: 1185 } });
      assert.match(fitsWindow(360, 980, 640, M_NO_SCROLL, controls, name)[0], new RegExp(`^${name}: the (cue list|detail body) is not inside the window`));
      page(640, { ...ok, [controls[0][1]]: undefined });
      assert.deepEqual(fitsWindow(360, 980, 640, M_NO_SCROLL, controls, name), [`${name}: ${controls[0][0]} is not on the screen`]);
    }
  } finally { delete globalThis.document; }
  assert.ok(RESULT_CONTROLS.some(([, sel]) => /\.cues$/.test(sel)) && DETAIL_CONTROLS.some(([, sel]) => /\.detail-body$/.test(sel)), 'the lists that scroll are among the controls');
  const src = read('tools', 'layout-check.mjs');
  assert.ok(src.includes("check('A1', [a4Arrangement, fitsWindow], null, M_SIZES, RESULT_CONTROLS, 'A1')"), 'A1 is walked at M_SIZES with the fit check');
  assert.ok(src.includes("check('A2', fitsWindow, null, M_SIZES, DETAIL_CONTROLS, 'A2')"), 'A2 is walked at M_SIZES with the fit check');
  assert.equal(M_SIZES.length, 9);
});

test('d58: A1 and A2 are 100dvh screens that keep their height: .screen\'s flex: 1 (a basis of 0%) overrode it and the page scrolled; the wide A1 stays as it was', () => {
  const css = read('src', 'styles', 'base.css');
  const rule = sel => css.match(new RegExp(`^${sel.replace('.', '\\.')} \\{[^}]*\\}`, 'm'))?.[0] ?? '';
  for (const sel of ['.result', '.detail']) {
    assert.match(rule(sel), /flex:\s*none/, `${sel} has flex: none`);
    assert.match(rule(sel), /height:\s*100dvh/, `${sel} is 100dvh high`);
  }
  assert.match(css, /@media \(min-width: 980px\) \{\s*\.result \{ height: auto; min-height: 100dvh;/, 'A1\'s wide layout is unchanged');
});

test('layout-check: no browser is one clear line (exit 1), or a skip with COACH_PAGE_TEST_SKIP=1', () => {
  const run = env => spawnSync(process.execPath, [path.join(APP, 'tools', 'layout-check.mjs')], { encoding: 'utf8', env: { ...process.env, COACH_BROWSER: '/nonexistent/browser', ...env } });
  const failed = run({ COACH_PAGE_TEST_SKIP: '' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /layout-check: FAILED: no Brave or Chromium found/);
  const skipped = run({ COACH_PAGE_TEST_SKIP: '1' });
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /SKIPPED/);
});

// the faults: each must fail the check with its own words (a browser is needed; none is a skip)
const { findBrowserSync } = (() => {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const names = ['brave-browser', 'brave', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  return { findBrowserSync: () => process.env.COACH_BROWSER || dirs.flatMap(d => names.map(n => path.join(d, n))).find(p => fs.existsSync(p)) || null };
})();
// Four browser runs, 15 s to 1 min each, started inside `npm --prefix app test`, made other tests in the same run fail on a loaded
// machine (decode stalls, timers). They run on their own: `npm --prefix app run test:layout-breaks`, or with COACH_LAYOUT_BREAKS=1.
for (const [kind, words] of [['scroll', /horizontal scrolling/], ['clip', /content cut off: div/], ['small', /touch target under 44 px: button/], ['cut', /cut off at the side/]]) {
  test(`layout-check --break ${kind} fails with its own words`, t => {
    if (process.env.COACH_LAYOUT_BREAKS !== '1') { t.skip('browser run: npm --prefix app run test:layout-breaks (COACH_LAYOUT_BREAKS=1)'); return; }
    if (!findBrowserSync()) { t.skip('no Brave or Chromium on PATH'); return; }
    const r = spawnSync(process.execPath, [path.join(APP, 'tools', 'layout-check.mjs'), '--break', kind], { encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, words);
  });
}
