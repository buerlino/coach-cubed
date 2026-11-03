// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Regenerates a golden snapshot from the current diagnostics.js against a
// fixture. Run after a deliberate change to phase()/measure()/verdict() logic
// (never to silence a test that failed for an unknown reason — read the diff
// first):
//
//   node tests/update_golden.js global/example/athlete-a-trim
//
// Slugs carry their scope ("global/..." committed, "local/..." gitignored).
// With no argument, regenerates every golden file that has a matching fixture
// in either scope.
const fs = require('node:fs');
const path = require('node:path');
const { loadDiagnostics } = require('./loadDiagnostics');
const { loadManifests, trackPathFor, goldenPathFor, diagnosticsSet } = require('./fixtures');

function update(slug) {
  const manifest = loadManifests();
  if (!manifest[slug]) {
    throw new Error(`unknown fixture "${slug}" — known: ${Object.keys(manifest).join(', ')}`);
  }
  const trackPath = trackPathFor(slug);
  const track = JSON.parse(fs.readFileSync(trackPath, 'utf8'));
  const personId = track.meta.tracks.kept;

  const Diagnostics = loadDiagnostics();
  // Same per-fixture set as diagnostics.test.js, or the golden would be scored
  // against the wrong lift's cues.
  Diagnostics.setPage(diagnosticsSet(manifest, slug, Diagnostics));
  const out = Diagnostics.computeResults(track.keypoints, track.meta, personId);

  const goldenPath = goldenPathFor(slug);
  fs.mkdirSync(path.dirname(goldenPath), { recursive: true });
  fs.writeFileSync(goldenPath, JSON.stringify(out.results, null, 2) + '\n');
  console.log(`wrote ${path.relative(process.cwd(), goldenPath)}`);
}

const slugs = process.argv.slice(2);
for (const slug of slugs.length ? slugs : Object.keys(loadManifests())) update(slug);
