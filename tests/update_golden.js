'use strict';
// Regenerates a golden snapshot from the current diagnostics.js against a
// fixture. Run after a deliberate change to phase()/measure()/verdict() logic
// (never to silence a test that failed for an unknown reason — read the diff
// first):
//
//   node tests/update_golden.js example/athlete-a-trim
//
// With no argument, regenerates every golden file that has a matching fixture.
const fs = require('node:fs');
const path = require('node:path');
const { loadDiagnostics } = require('./loadDiagnostics');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const GOLDEN_DIR = path.join(__dirname, 'golden');

function goldenNameFor(slug) {
  return slug.replace(/\//g, '-') + '.json';
}

function allFixtureSlugs() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, 'manifest.json'), 'utf8'));
  return Object.keys(manifest);
}

function update(slug) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, 'manifest.json'), 'utf8'));
  const trackPath = path.join(FIXTURES_DIR, `${slug}.track.json`);
  const track = JSON.parse(fs.readFileSync(trackPath, 'utf8'));
  const personId = track.meta.tracks.kept;

  const Diagnostics = loadDiagnostics();
  // Same per-fixture set as diagnostics.test.js, or the golden would be scored
  // against the wrong lift's cues.
  Diagnostics.setPage(manifest[slug].diagnostics || 'snatch');
  const out = Diagnostics.computeResults(track.keypoints, track.meta, personId);

  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  const goldenPath = path.join(GOLDEN_DIR, goldenNameFor(slug));
  fs.writeFileSync(goldenPath, JSON.stringify(out.results, null, 2) + '\n');
  console.log(`wrote ${path.relative(process.cwd(), goldenPath)}`);
}

const slugs = process.argv.slice(2);
for (const slug of slugs.length ? slugs : allFixtureSlugs()) update(slug);
