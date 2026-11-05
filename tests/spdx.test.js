// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Step 2.7 as a test: every tracked source file of our own (.js, .mjs, .cjs,
// .py, .sh, .css, .html) names its licence in its first three lines, as
// `SPDX-License-Identifier: AGPL-3.0-or-later` in the file's comment style
// (after a `#!` line or an HTML doctype). Vendored third-party code (any
// vendor/ folder) keeps its own licence and is skipped, as THIRD_PARTY.md
// says. JSON can't hold a comment and isn't checked. Built-ins only, like
// docs.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = /\.(?:js|mjs|cjs|py|sh|css|html)$/;
const VENDOR = /(^|\/)vendor\//;
const ID = 'SPDX-License-Identifier: AGPL-3.0-or-later';

function ourSources() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\0').filter(f => f && SOURCE.test(f) && !VENDOR.test(f) && fs.existsSync(path.join(ROOT, f)));
}

test('every source file of our own carries the AGPL SPDX header in its first three lines', () => {
  const files = ourSources();
  assert.ok(files.length > 100, `expected the repo's sources, found ${files.length}`);
  const missing = files.filter(f => {
    const head = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n', 3).join('\n');
    return !head.includes(ID);
  });
  assert.deepEqual(missing, [], `add "${ID}" as the first line (after a #! line or an HTML doctype), in the file's comment style`);
});
