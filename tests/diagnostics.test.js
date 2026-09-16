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

function lateralRaiseResults(signal) {
  const Diagnostics = loadDiagnostics();
  Diagnostics.setPage('lateral-raise');
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
  return Diagnostics.computeResults(keypoints, meta, '1').results;
}

test('lateral raise finds consecutive reps without a full resting reset', () => {
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
  const results = lateralRaiseResults(signal);
  assert.equal(results['lateral-raise-top-height'].summary.reps, 2);
  assert.equal(results['lateral-raise-symmetry'].summary.reps, 2);
});

test('lateral raise counts eight reps as range decreases with fatigue', () => {
  const signal = [];
  for (const amplitude of [0.6, 0.54, 0.48, 0.42, 0.36, 0.30, 0.24, 0.18]) {
    const peak = -0.8 + amplitude;
    signal.push(...Array(8).fill(-0.8));
    signal.push(...Array.from({ length: 18 }, (_, i) => -0.8 + amplitude * (i + 1) / 18));
    signal.push(...Array(8).fill(peak));
    signal.push(...Array.from({ length: 18 }, (_, i) => peak - amplitude * (i + 1) / 18));
  }
  signal.push(...Array(8).fill(-0.8));

  const results = lateralRaiseResults(signal);
  assert.equal(results['lateral-raise-top-height'].summary.reps, 8);
  assert.equal(results['lateral-raise-symmetry'].summary.reps, 8);
});

test('lateral raise ignores low-amplitude tracking jitter', () => {
  const signal = Array.from({ length: 240 }, (_, i) => -0.8 + 0.05 * Math.sin(i / 5));
  const results = lateralRaiseResults(signal);
  assert.match(results['lateral-raise-top-height'].error, /No rep/);
});

// --- first pull start trigger ------------------------------------------------
//
// A synthetic side-on barbell lifter: fixed trunk and legs, wrists scripted by
// `wrist(frame) -> { dx, dy }` as pixel offsets from their setup position on
// the floor. Torso is ~150px, so 1 torso-length/s is 150px/s (5px/frame at
// 30fps). The bar estimate (wrist + forearm/6) starts below the knee and
// crosses it once the wrists have risen ~125px, which is what ends the phase.
// `jitter` adds deterministic pseudo-random noise of that amplitude to every
// keypoint, since the trigger's whole job is to hold under pose jitter.
function barbellResults(page, frames, wrist, jitter) {
  const Diagnostics = loadDiagnostics();
  Diagnostics.setPage(page);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const j = () => jitter ? (rnd() * 2 - 1) * jitter : 0;
  const keypoints = {};
  const frameIndices = Array.from({ length: frames }, (_, i) => i);
  for (const f of frameIndices) {
    const { dx, dy } = wrist(f);
    const wy = 620 + dy, wx = 240 + dx;
    const pt = (y, x) => [y + j(), x + j(), 1];
    const points = Array.from({ length: 17 }, () => [0, 0, 0]);
    points[5] = pt(250, 215); points[6] = pt(250, 225);   // shoulders
    points[7] = pt(480, 230); points[8] = pt(480, 240);   // elbows
    points[9] = pt(wy, wx - 5); points[10] = pt(wy, wx + 5);   // wrists
    points[11] = pt(400, 155); points[12] = pt(400, 165);  // hips
    points[13] = pt(520, 205); points[14] = pt(520, 215);  // knees
    points[15] = pt(640, 195); points[16] = pt(640, 205);  // ankles
    keypoints[String(f)] = { '1': points };
  }
  const meta = { fps: 30, frame_indices: frameIndices, frame_times_ms: frameIndices.map(i => i * 1000 / 30) };
  return Diagnostics.computeResults(keypoints, meta, '1').results;
}

// Setup with everything a forward "hands start moving" search would fire on,
// then the pull at frame 40: a re-grip that drops and lifts the hands (frames
// 10–18), then the bar rolled into the shins — continuous SIDEWAYS wrist motion
// right up to the moment the bar leaves the floor, so the lifter is never
// still before the pull.
const PULL_AT = 40;
function busySetupThenPull(f) {
  if (f < 10) return { dx: 0, dy: 0 };
  if (f < 18) return { dx: 0, dy: f < 14 ? 2 * (f - 10) : 2 * (18 - f) };   // 8px dip and back
  if (f < PULL_AT) return { dx: 2 * (f - 18), dy: 0 };                    // roll-in: 2px/frame sideways
  return { dx: 44, dy: -5 * (f - PULL_AT) };                               // pull: 1 torso-length/s up
}

for (const page of ['snatch', 'clean-and-jerk']) {
  const id = page === 'snatch' ? 'first-pull-back-angle' : 'clean-first-pull-back-angle';
  for (const jitter of [0, 3, 5]) {
    test(`${page} first pull starts where the wrists rise, not at the re-grip or roll-in (±${jitter}px jitter)`, () => {
      const r = barbellResults(page, 100, busySetupThenPull, jitter)[id];
      assert.ok(!r.error, r.error);
      assert.equal(r.phase.triggers.clamped, false);
      // The smoothed rise leads the true onset by up to half the window, so the
      // start may sit a few samples early — never late, never back in the setup.
      assert.ok(r.phase.startIdx >= PULL_AT - 5 && r.phase.startIdx <= PULL_AT,
        `start at ${r.phase.startIdx}, expected within [${PULL_AT - 5}, ${PULL_AT}]`);
      assert.ok(r.phase.endIdx > r.phase.startIdx + 10);
      assert.ok(r.phase.triggers.setupRise < r.phase.triggers.onsetRise);
    });
  }
}

test('first pull start is clamped and flagged when the clip opens mid-pull', () => {
  const r = barbellResults('snatch', 60, f => ({ dx: 0, dy: -5 * f }), 0)['first-pull-back-angle'];
  assert.ok(!r.error, r.error);
  assert.equal(r.phase.startIdx, 0);
  assert.equal(r.phase.triggers.clamped, true);
  assert.equal(r.phase.triggers.clampReason, 'head');
  assert.ok(r.notes.some(n => /starts mid-pull/.test(n)));
});

test('a still lifter under jitter never starts a first pull early', () => {
  // 60 still frames, then the pull. The only frames a start may land on are
  // the pull's own (with the smoothing lead) — never the still stretch.
  const r = barbellResults('snatch', 120, f => ({ dx: 0, dy: f < 60 ? 0 : -5 * (f - 60) }), 5)['first-pull-back-angle'];
  assert.ok(!r.error, r.error);
  assert.equal(r.phase.triggers.clamped, false);
  assert.ok(r.phase.startIdx >= 55 && r.phase.startIdx <= 60, `start at ${r.phase.startIdx}`);
});

test('the snatch and the clean first pull share one start and end trigger', () => {
  const s = barbellResults('snatch', 100, busySetupThenPull, 3)['first-pull-back-angle'];
  const c = barbellResults('clean-and-jerk', 100, busySetupThenPull, 3)['clean-first-pull-back-angle'];
  assert.equal(s.phase.startIdx, c.phase.startIdx);
  assert.equal(s.phase.endIdx, c.phase.endIdx);
});
