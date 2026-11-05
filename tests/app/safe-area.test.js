// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// d62: the shell pads its top by the status bar's inset. Capacitor 8.5.3's SystemBars draws the APK edge to edge on a WebView of
// 140 or later (viewport-fit=cover) and puts the real insets in env(safe-area-inset-*); nothing padded the top, so H's wordmark sat
// under the status bar. Source checks only: headless Brave has no inset (env() is 0), so the layout can't be seen to change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..', '..', 'app');
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8');
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('d62: the viewport keeps viewport-fit=cover (without it env() is 0 and the WebView is padded natively)', () => {
  const meta = read('index.html').match(/<meta name="viewport"[^>]*>/)?.[0] ?? '';
  assert.match(meta, /viewport-fit=cover/);
});

test('d62: tokens.css defines the top inset once and the screen\'s height from it', () => {
  const tokens = stripComments(read('src', 'styles', 'tokens.css'));
  assert.equal([...tokens.matchAll(/--inset-top:/g)].length, 1);
  assert.match(tokens, /--inset-top:\s*env\(safe-area-inset-top,\s*0px\)\s*;/);
  // once in :root, and once more in c65's fallback for a browser without dvh (tests/app/chrome101.test.js pins it)
  assert.equal([...tokens.matchAll(/--screen-h:/g)].length, 2);
  assert.equal([...tokens.replace(/@supports not \(height: 100dvh\) \{[^}]*\}\s*\}/, '').matchAll(/--screen-h:/g)].length, 1);
  assert.match(tokens, /--screen-h:\s*calc\(100dvh - var\(--inset-top\)\)\s*;/);
  assert.match(read('src', 'styles', 'tokens.css'), /d62/, 'the comment names d62');
});

test('d62: #app pads its top by the inset, for every screen', () => {
  const css = read('src', 'styles', 'base.css');
  const rule = css.match(/(^|\n)#app \{([^}]*)\}/);
  assert.ok(rule, '#app has a rule');
  assert.match(rule[2], /padding-top:\s*var\(--inset-top\)/);
  assert.doesNotMatch(css, /safe-area-inset-top/, 'the top inset is read in tokens.css only');
});

test('d62: no rule in base.css uses 100dvh itself: the full-height screens use var(--screen-h), so page plus inset is the window', () => {
  const css = stripComments(read('src', 'styles', 'base.css'));
  assert.doesNotMatch(css, /100dvh/);
  const rule = sel => css.match(new RegExp(`(^|\\n)(?:@media [^{]*\\{\\s*)?${sel.replace('.', '\\.')} \\{([^}]*)\\}`))?.[2] ?? '';
  assert.match(rule('.mark'), /height:\s*var\(--screen-h\)/);
  assert.match(rule('.setup, .live'), /min-height:\s*var\(--screen-h\)/);
  assert.match(rule('.replay'), /min-height:\s*var\(--screen-h\)/);
  assert.match(rule('.delayed'), /min-height:\s*var\(--screen-h\)/);
  assert.match(rule('.result'), /height:\s*var\(--screen-h\)/);
  assert.match(rule('.detail'), /height:\s*var\(--screen-h\)/);
  // the six rules above, .result's phone-landscape override and the wide .result: eight uses in all
  assert.equal([...css.matchAll(/var\(--screen-h\)/g)].length, 8, 'every former 100dvh');
  assert.doesNotMatch(stripComments(read('src', 'styles', 'tokens.css')).replace(/--screen-h:[^;]*;/, '').replace('@supports not (height: 100dvh)', ''), /100dvh/,
    '--screen-h is the one place (and c65\'s fallback asks for it)');
});

test('d62: capacitor.config.json leaves SystemBars\' insetsHandling alone (never "disable")', () => {
  const cfg = JSON.parse(read('capacitor.config.json'));
  assert.notEqual(cfg.plugins?.SystemBars?.insetsHandling, 'disable');
});
