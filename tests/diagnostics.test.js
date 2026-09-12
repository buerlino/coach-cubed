'use strict';
// One subtest per fixture listed in tests/fixtures/{global,local}/manifest.json
// — adding a new stance/clip needs nothing wired up here, only a golden
// snapshot (node tests/update_golden.js <scope>/<slug>) once the fixture
// itself exists. Local fixtures and their goldens are gitignored, so a fresh
// checkout sees only the global ones. See tests/README.md for the full
// add-a-fixture workflow.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadDiagnostics } = require('./loadDiagnostics');

const { FIXTURES_DIR, loadManifests, trackPathFor, goldenPathFor } = require('./fixtures');

// Keyed "<scope>/<stance>/<clip-stem>", both scopes merged.
const manifest = loadManifests();

for (const slug of Object.keys(manifest).sort()) {
  test(`computeResults on ${slug} matches its golden snapshot`, () => {
    const trackPath = trackPathFor(slug);
    assert.ok(fs.existsSync(trackPath), `missing fixture ${trackPath}`);
    const goldenPath = goldenPathFor(slug);
    assert.ok(fs.existsSync(goldenPath),
      `no golden snapshot for ${slug} — run: node tests/update_golden.js ${slug}`);
    // (a local fixture freshly extracted on this machine lands here until its
    // golden is generated — that's expected, not a regression)

    const Diagnostics = loadDiagnostics();
    // Each fixture scores against its own lift's diagnostic set — manifest's
    // own "diagnostics" field, same key PAGES/DIAGNOSTIC_SETS use, falling back
    // to "snatch" for fixtures predating that field so old goldens still match.
    Diagnostics.setPage(manifest[slug].diagnostics || 'snatch');
    const track = JSON.parse(fs.readFileSync(trackPath, 'utf8'));
    const personId = track.meta.tracks.kept;
    const out = Diagnostics.computeResults(track.keypoints, track.meta, personId);

    // Round-tripped through JSON so the comparison sees exactly what the
    // golden file (itself written by JSON.stringify — see
    // tests/update_golden.js) sees, rather than tripping on e.g. NaN, which
    // deepStrictEqual treats specially but JSON.stringify turns into null.
    // Deliberately not asserting out.scale/out.axis here: a fixture where
    // the pose pass legitimately fails (bad footage) is still a valid golden
    // snapshot — its results are just all { error }, and the deepStrictEqual
    // below already catches that changing.
    const results = JSON.parse(JSON.stringify(out.results));
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));

    assert.deepStrictEqual(
      results, golden,
      `diagnostic output changed for ${slug} — if intentional, regenerate with: ` +
      `node tests/update_golden.js ${slug}`
    );
  });
}

// Fails loudly rather than silently testing nothing if the manifest is
// empty — an empty passing suite looks identical to a broken one otherwise.
test('at least one fixture is under test', () => {
  assert.ok(Object.keys(manifest).length > 0,
    `no fixtures found under ${FIXTURES_DIR}/{global,local}/manifest.json`);
});
