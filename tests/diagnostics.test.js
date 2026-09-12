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

test('lateral raise finds consecutive reps without a full resting reset', () => {
  const Diagnostics = loadDiagnostics();
  Diagnostics.setPage('lateral-raise');

  const signal = [
    ...Array(12).fill(-0.8),
    ...Array.from({ length: 18 }, (_, i) => -0.8 + 0.6 * (i + 1) / 18),
    ...Array(8).fill(-0.2),
    ...Array.from({ length: 18 }, (_, i) => -0.2 - 0.32 * (i + 1) / 18),
    ...Array(8).fill(-0.52),
    ...Array.from({ length: 18 }, (_, i) => -0.52 + 0.32 * (i + 1) / 18),
    ...Array(8).fill(-0.2),
    ...Array.from({ length: 18 }, (_, i) => -0.2 - 0.6 * (i + 1) / 18),
    ...Array(12).fill(-0.8),
  ];
  const keypoints = {};
  const frameIndices = signal.map((_, i) => i);
  signal.forEach((height, frame) => {
    const wristY = 100 - height * 100;
    const points = Array.from({ length: 17 }, () => [0, 0, 0]);
    points[5] = [100, 80, 1]; points[6] = [100, 120, 1];
    points[7] = [(100 + wristY) / 2, 75, 1]; points[8] = [(100 + wristY) / 2, 125, 1];
    points[9] = [wristY, 70, 1]; points[10] = [wristY, 130, 1];
    points[11] = [200, 85, 1]; points[12] = [200, 115, 1];
    points[13] = [280, 90, 1]; points[14] = [280, 110, 1];
    points[15] = [360, 90, 1]; points[16] = [360, 110, 1];
    keypoints[String(frame)] = { '1': points };
  });
  const meta = {
    fps: 30,
    frame_indices: frameIndices,
    frame_times_ms: frameIndices.map(i => i * 1000 / 30),
  };

  const out = Diagnostics.computeResults(keypoints, meta, '1');
  assert.equal(out.results['lateral-raise-top-height'].summary.reps, 2);
  assert.equal(out.results['lateral-raise-symmetry'].summary.reps, 2);
});
