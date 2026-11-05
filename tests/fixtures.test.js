// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// A fixture says which lift's cues it is scored against, in its manifest
// entry's "diagnostics" field. Without the field the tests used to score it as
// a snatch, silently; now the helper in fixtures.js throws, naming the slug.
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadDiagnostics } = require('./loadDiagnostics');
const { loadManifests, diagnosticsSet } = require('./fixtures');

test('diagnosticsSet returns the set a manifest entry names', () => {
  const D = loadDiagnostics();
  const manifest = { 'global/example/a': { diagnostics: 'lateral-raise' } };
  assert.equal(diagnosticsSet(manifest, 'global/example/a', D), 'lateral-raise');
});

test('diagnosticsSet throws, naming the slug, for an entry without diagnostics', () => {
  const D = loadDiagnostics();
  const manifest = { 'global/example/no-field': { stance: 'example' } };
  assert.throws(() => diagnosticsSet(manifest, 'global/example/no-field', D),
    /global\/example\/no-field/);
});

test('diagnosticsSet throws, naming the slug, for a set diagnostics.js does not know', () => {
  const D = loadDiagnostics();
  const manifest = { 'local/curl/c1': { diagnostics: 'bicep-curl' } };
  assert.throws(() => diagnosticsSet(manifest, 'local/curl/c1', D),
    /local\/curl\/c1.*bicep-curl|bicep-curl.*local\/curl\/c1/);
});

test('diagnosticsSet throws, naming the slug, for a slug the manifest lacks', () => {
  const D = loadDiagnostics();
  assert.throws(() => diagnosticsSet({}, 'global/x/y', D), /global\/x\/y/);
});

test('every entry of the committed global manifest names a set diagnostics.js knows', () => {
  const D = loadDiagnostics();
  const global = Object.entries(loadManifests()).filter(([, e]) => e.scope === 'global');
  assert.ok(global.length > 0, 'the global manifest has entries');
  const manifest = Object.fromEntries(global);
  for (const [slug] of global) {
    assert.doesNotThrow(() => diagnosticsSet(manifest, slug, D), slug);
  }
});
