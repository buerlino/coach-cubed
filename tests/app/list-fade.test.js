// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// d58: A1's cue list, which scrolls inside the 100dvh screen, has its own fade at its bottom edge, driven by the list's
// scroller with the rule of d55's page cue (moreBelow, more-below-model.mjs): shown while the list has more than 8 px to
// go below, hidden at its end or when nothing scrolls; no transition under reduced motion; taps pass through it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..', '..', 'app');
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8');
const rule = (css, sel) => new RegExp(`${sel.replace(/[.[\]]/g, '\\$&')}\\s*\\{[^}]*\\}`).exec(css)?.[0] ?? '';

test('A1 draws the list fade as the last child of its cue list, the scroller', () => {
  const a1 = read('src', 'ui', 'screens', 'A1.mjs');
  const list = /<aside class="cues"[\s\S]*?<\/aside>/.exec(a1)?.[0] ?? '';
  assert.match(list, /<\$\{ListFade\} \/>\s*<\/aside>/, 'the fade is the last element of the aside');
  assert.match(a1, /import \{ ListFade \} from '\.\.\/components\/list-fade\.mjs'/);
});

test('the fade reads its own scroller (the parent), with moreBelow\'s rule, on scroll, resize and content that changes', () => {
  const src = read('src', 'ui', 'components', 'list-fade.mjs');
  assert.match(src, /import \{ moreBelow \} from '\.\.\/more-below-model\.mjs'/, 'the same rule as the page cue');
  assert.match(src, /parentElement/, 'the list it sits in is the scroller');
  assert.match(src, /moreBelow\(scroller\)/, 'not the page (document.scrollingElement)');
  assert.doesNotMatch(src, /scrollingElement/);
  assert.match(src, /scroller\.addEventListener\('scroll'/);
  assert.match(src, /ResizeObserver/);
  assert.match(src, /MutationObserver/, 'a card opens: the list grows');
  assert.match(src, /hidden=\$\{!shown\}/);
  assert.match(src, /aria-hidden="true"/, 'decoration: no name, no button');
  assert.doesNotMatch(src, /<button/, 'a fade only: the finger is on the list already (d58 report)');
  assert.match(read('src', 'ui', 'components', 'more-below.mjs'), /document\.scrollingElement/, 'H\'s page cue still follows the page');
});

test('the fade is zero-height in the list\'s flow (the list does not change size when it shows or hides), uses --more-fade and --ground, lets taps through', () => {
  const css = read('src', 'styles', 'base.css');
  const fade = rule(css, '.list-fade');
  assert.ok(fade, 'a .list-fade rule');
  assert.match(fade, /position:\s*sticky/);
  assert.match(fade, /bottom:\s*0/);
  assert.match(fade, /height:\s*0/);
  assert.match(fade, /margin-top:\s*calc\(-1 \* var\(--space-2\)\)/, 'cancels the list\'s gap');
  assert.match(fade, /pointer-events:\s*none/);
  assert.match(rule(css, '.list-fade[hidden]'), /display:\s*none/);
  const inner = rule(css, '.list-fade::before');
  assert.match(inner, /height:\s*var\(--more-fade\)/);
  assert.match(inner, /linear-gradient\(transparent, var\(--ground\)/);
  assert.match(inner, /pointer-events:\s*none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^{]*\{[^}]*\.list-fade[^}]*transition:\s*none/, 'no transition under reduced motion');
  assert.match(fade + inner, /transition:/, 'with motion it fades');
  assert.doesNotMatch(fade + inner, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no new colours');
});
