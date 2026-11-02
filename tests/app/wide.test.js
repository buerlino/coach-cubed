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
  for (const n of ['--wide-max', '--wide-aside', '--wide-stage', '--wide-stage-max', '--size-wordmark-wide', '--size-tile', '--chip-h', '--tile-min']) {
    assert.match(tokens, new RegExp(`${n}:`), `tokens.css defines ${n}`);
  }
});

test('a slider is a touch target: --slider-h is --touch (the responsive check found 32 px in A3)', () => {
  assert.match(read('src', 'styles', 'tokens.css'), /--slider-h:\s*var\(--touch\)/);
});

test('crumbOf: the session and the lift\'s name with its time and length', async () => {
  const { crumbOf } = await load('src', 'ui', 'wide-model.mjs');
  const created = new Date(2026, 10, 2, 14, 27, 5).toISOString();
  const lift = { lift: 'lateral-raise', created, range: { t0: 1, t1: 4.04 } };
  assert.deepEqual(crumbOf(lift, new Date(2026, 10, 2, 20, 0)), { parent: "Today's session", current: 'Lateral raise \u00b7 14:27 \u00b7 3.0 s' });
  assert.equal(crumbOf(lift, new Date(2026, 10, 5, 9, 0)).parent, 'Earlier sessions');
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

test('layout-check: the five sizes of step 5.7 and the 44 px of tokens.css', async () => {
  const { VIEWPORTS, TOUCH_PX } = await load('tools', 'layout-check.mjs');
  assert.deepEqual(VIEWPORTS.map(v => `${v.width}x${v.height}`), ['360x800', '412x915', '800x360', '768x1024', '1280x800']);
  assert.match(read('src', 'styles', 'tokens.css'), new RegExp(`--touch:\\s*${TOUCH_PX}px`));
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
for (const [kind, words] of [['scroll', /horizontal scrolling/], ['clip', /content cut off: div/], ['small', /touch target under 44 px: button/], ['cut', /cut off at the side/]]) {
  test(`layout-check --break ${kind} fails with its own words`, t => {
    if (!findBrowserSync()) { t.skip('no Brave or Chromium on PATH'); return; }
    const r = spawnSync(process.execPath, [path.join(APP, 'tools', 'layout-check.mjs'), '--break', kind], { encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, words);
  });
}
