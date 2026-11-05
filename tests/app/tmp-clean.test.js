// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// c48: the app tests leave no temp folders behind. The four files that make temp
// folders run in a child `node --test` with TMPDIR (os.tmpdir() reads it) set to a
// fresh empty folder; after the child exits that folder must be empty, and the
// child's own failures fail this test too. The folder is removed at the end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FILES = ['assemble', 'serve', 'sw', 'settings'].map((n) => path.join(__dirname, `${n}.test.js`));

test('assemble, serve, sw and settings tests remove every temp folder they make', () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-tmpclean-'));
  try {
    // NODE_TEST_CONTEXT marks a process started by a test runner; left set, the child's `--test` runs nothing.
    const env = { ...process.env, TMPDIR: tmpdir };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', ...FILES], {
      env, encoding: 'utf8', timeout: 540000,
    });
    assert.equal(r.status, 0, `the child run failed (status ${r.status}, signal ${r.signal}):\n${(r.stdout || '').slice(-3000)}\n${(r.stderr || '').slice(-1000)}`);
    assert.deepEqual(fs.readdirSync(tmpdir), [], 'temp entries left in TMPDIR');
  } finally { fs.rmSync(tmpdir, { recursive: true, force: true }); }
});
