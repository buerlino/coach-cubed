// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// The "more below" cue (package d55, design/checkpoint-a/round-1.html's H): a fade and a ⌄ button at the bottom
// edge of the window while the page can scroll further down. The rule is a plain function
// (app/src/ui/more-below-model.mjs); the component (components/more-below.mjs) and the shell draw it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP = path.resolve(__dirname, '..', '..', 'app');
const load = rel => import(pathToFileURL(path.join(APP, 'src', rel)).href);
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8');
const page = (scrollTop, clientHeight, scrollHeight) => ({ scrollTop, clientHeight, scrollHeight });

test('the cue shows while the page can scroll more than 8 px further down', async () => {
  const { moreBelow } = await load('ui/more-below-model.mjs');
  assert.equal(moreBelow(page(0, 800, 1600)), true, 'at the top of a long page');
  assert.equal(moreBelow(page(300, 800, 1600)), true, 'in the middle');
  assert.equal(moreBelow(page(0, 800, 809)), true, '9 px to go');
  assert.equal(moreBelow(page(0, 800, 808)), false, '8 px to go is not more than 8');
});

test('the cue is hidden at the bottom and when nothing scrolls', async () => {
  const { moreBelow } = await load('ui/more-below-model.mjs');
  assert.equal(moreBelow(page(800, 800, 1600)), false, 'at the bottom');
  assert.equal(moreBelow(page(799.5, 800, 1600)), false, 'a fractional scroll position next to the bottom');
  assert.equal(moreBelow(page(0, 800, 800)), false, 'nothing scrolls');
  assert.equal(moreBelow(page(0, 800, 400)), false, 'a page shorter than the window');
  assert.equal(moreBelow(page(0, 0, 0)), false, 'no size yet');
});

test('the button scrolls down by most of a window, without animation under prefers-reduced-motion', async () => {
  const { scrollStep, scrollBehavior } = await load('ui/more-below-model.mjs');
  assert.equal(scrollStep(800), 640);
  assert.equal(scrollStep(360), 288);
  assert.equal(scrollBehavior(false), 'smooth');
  assert.equal(scrollBehavior(true), 'auto');
});

test('the shell draws the cue once, for every screen; it follows scrolling, resizing and growing content', () => {
  const app = read('src', 'ui', 'app.mjs');
  assert.equal((app.match(/<\$\{MoreBelow\}/g) || []).length, 1, 'drawn once by the shell');
  const src = read('src', 'ui', 'components', 'more-below.mjs');
  assert.match(src, /aria-label="More below"/);
  assert.match(src, /ResizeObserver/, 'content that grows');
  assert.match(src, /addEventListener\('scroll'/);
  assert.match(src, /addEventListener\('resize'/);
  assert.match(src, /prefers-reduced-motion/);
  assert.match(src, /aria-modal/, 'hidden while a sheet is open');
});

test('the fade lets taps through, keeps the safe-area inset, and the button is a touch target; colours from tokens', () => {
  const css = read('src', 'styles', 'base.css');
  const fade = /\.more-below\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(fade, /pointer-events:\s*none/);
  assert.match(fade, /env\(safe-area-inset-bottom/);
  assert.match(fade, /position:\s*fixed/);
  const button = /\.more-below button\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
  assert.match(button, /pointer-events:\s*auto/);
  assert.match(button, /width:\s*var\(--touch\)/);
  assert.match(button, /height:\s*var\(--touch\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^{]*\{[^}]*\.more-below[^}]*transition:\s*none/);
});
