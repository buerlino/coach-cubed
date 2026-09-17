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


// --- the lift window (start/end markers) -------------------------------------
//
// A synthetic side-on lifter scripted in SECONDS and then sampled at a given
// fps, because every threshold in the end trigger is a time or a speed: half a
// second of held extension, at under a third of a torso-length per second.
// Sampling one script at 30 and at 60fps is the test that none of them is
// secretly a frame count.
//
// Geometry: each side's hip and ankle sit on one vertical line, so a knee built
// as the apex of the isoceles triangle over hip->ankle has EXACTLY the scripted
// angle. The same construction bends the elbow between shoulder and wrist.
// Neither is anatomy (a 90° knee puts the joint absurdly far forward); both are
// exact angles, which is what the trigger reads.
//
// The body moves: `trunk` is the pixels the hip and shoulder (and with them the
// knee, and so the height the bar is compared against) drop from standing, and
// `feet` the pixels the ankles leave the floor by. A lifter pinned in place
// while only the arms travel would be a dishonest fixture here — the stillness
// gate reads the median speed over every joint, so half a skeleton nailed down
// passes it trivially, and no real lifter has that half.
function bendPoint(a, b, deg) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
  const off = (L / 2) / Math.tan(deg * Math.PI / 360);
  return { x: (a.x + b.x) / 2 + (dy / L) * off, y: (a.y + b.y) / 2 - (dx / L) * off };
}

// Piecewise-linear over keyframes [t, wristY, kneeDeg, elbowDeg, trunkDy, feetDy].
function atTime(script, t) {
  let k = 0;
  while (k < script.length - 2 && script[k + 1][0] <= t) k++;
  const a = script[k], b = script[Math.min(k + 1, script.length - 1)];
  const u = b[0] > a[0] ? Math.min(Math.max((t - a[0]) / (b[0] - a[0]), 0), 1) : 0;
  const mix = i => a[i] + (b[i] - a[i]) * u;
  return { wristY: mix(1), knee: mix(2), elbow: mix(3), trunk: mix(4), feet: mix(5) };
}

function liftWindowOf(script, fps, seconds) {
  const Diagnostics = loadDiagnostics();
  Diagnostics.setPage('snatch');
  const keypoints = {};
  const frameIndices = Array.from({ length: Math.round(seconds * fps) }, (_, i) => i);
  for (const f of frameIndices) {
    const { wristY, knee, elbow, trunk, feet } = atTime(script, f / fps);
    const points = Array.from({ length: 17 }, () => [0, 0, 0]);
    for (const [side, dx] of [[0, -5], [1, 5]]) {
      const hip = { x: 155 + dx, y: 400 + trunk }, ankle = { x: 155 + dx, y: 640 + feet };
      const sho = { x: 215 + dx, y: 250 + trunk }, wri = { x: 240 + dx, y: wristY };
      const kne = bendPoint(hip, ankle, knee), elb = bendPoint(sho, wri, elbow);
      const put = (i, p) => { points[i] = [p.y, p.x, 1]; };
      put(5 + side, sho); put(7 + side, elb); put(9 + side, wri);
      put(11 + side, hip); put(13 + side, kne); put(15 + side, ankle);
    }
    keypoints[String(f)] = { '1': points };
  }
  const meta = { fps, frame_indices: frameIndices, frame_times_ms: frameIndices.map(i => i * 1000 / fps) };
  return Diagnostics.computeResults(keypoints, meta, '1').lift;
}

// Stand (everything extended, for well over half a second), set up over the
// bar, pull, ride THROUGH full extension in flight at 2.2-2.35s, catch deep,
// then stand up out of the catch: the knees pass 170° at t=3.14 while the body
// is still travelling, and everything comes to rest at 3.2.
const LIFT = [
  [0.00, 400, 175, 175,   0, 0],
  [0.70, 400, 175, 175,   0, 0],
  [1.20, 620,  90, 175, 130, 0],
  [1.50, 620,  90, 175, 130, 0],
  [2.20, 380, 178, 175,   0, 0],
  [2.35, 340, 178, 175,   0, 0],
  [2.55, 320, 100, 175, 150, 0],
  [2.70, 310, 100, 175, 150, 0],
  [3.20, 305, 180, 175,   0, 0],   // knee passes 170 at t = 3.14, body stops at 3.20
  [4.50, 305, 180, 175,   0, 0],
];

for (const fps of [30, 60]) {
  test(`lift window marks the held finish, not the extension passed through (${fps}fps)`, () => {
    const lift = liftWindowOf(LIFT, fps, 4.5);
    assert.equal(lift.error, null);
    // Start: the pull off the floor at 1.5s. The smoothed rise leads the true
    // onset by up to half its window, so a little early is expected — but never
    // back in the drop to the bar, and never in the standing prologue.
    assert.ok(lift.t0 > 1.2 && lift.t0 <= 1.55, `start at ${lift.t0}`);
    // End: after the knees lock (3.14) AND the body has come to rest (3.20),
    // plus the lag of a speed that is smoothed over a window rather than
    // differenced frame to frame. Emphatically NOT 2.2 (full extension held
    // 0.35s in flight) and not 0 (standing, extended, for 0.7s).
    assert.ok(lift.t1 >= 3.14 && lift.t1 <= 3.6, `end at ${lift.t1}, expected 3.14-3.6`);
    assert.equal(lift.truncated, false);
    assert.ok(lift.triggers.holdSeconds >= 0.5);
    assert.ok(lift.triggers.minElbow > 150);
    assert.ok(lift.triggers.minKnee > 170);
    assert.ok(lift.triggers.peakSpeed <= lift.triggers.stillSpeed);
    assert.ok(lift.triggers.netDrift <= lift.triggers.stillDrift);
  });
}

test('the lift window is a duration, not a frame count, across frame rates', () => {
  const a = liftWindowOf(LIFT, 30, 4.5), b = liftWindowOf(LIFT, 60, 4.5);
  assert.ok(Math.abs(a.t0 - b.t0) <= 2 / 30, `start ${a.t0} vs ${b.t0}`);
  assert.ok(Math.abs(a.t1 - b.t1) <= 2 / 30, `end ${a.t1} vs ${b.t1}`);
});

test('extension reached at speed is not a finish', () => {
  // The lifter rides straight through full extension and keeps travelling: the
  // angles qualify for two full seconds, the body never slows down. This is the
  // premature end marker the stillness gate exists for.
  const flying = [
    [0.00, 400, 175, 175,   0,    0],
    [0.70, 400, 175, 175,   0,    0],
    [1.20, 620,  90, 175, 130,    0],
    [1.50, 620,  90, 175, 130,    0],
    [2.20, 380, 178, 175,   0,    0],
    [4.50, 100, 178, 175, -280, -280],   // whole body still rising at the last frame
  ];
  const lift = liftWindowOf(flying, 30, 4.5);
  assert.equal(lift.error, null);
  assert.ok(lift.t0 != null);
  assert.equal(lift.t1, null);
  assert.ok(lift.notes.some(n => /passed through in flight/.test(n)),
    `notes were: ${JSON.stringify(lift.notes)}`);
});

test('a slow recovery that keeps going the same way is not a finish', () => {
  // Every joint locked from 2.6s and the body never exceeding 0.30
  // torso-lengths/s — under the instantaneous gate — but all of that motion
  // going one way: the lifter is still coming up at the last frame. Net travel
  // across any half second is the only thing that separates this from standing.
  const creeping = [
    [0.00, 400, 175, 175,   0, 0],
    [0.70, 400, 175, 175,   0, 0],
    [1.20, 620,  90, 175, 130, 0],
    [1.50, 620,  90, 175, 130, 0],
    [2.20, 380, 120, 175, 100, 0],
    [2.60, 340, 180, 175, 100, 0],
    [4.70, 240, 180, 175,   0, 0],   // 100px over 2.1s ~ 0.29 torso-lengths/s, one way
  ];
  const lift = liftWindowOf(creeping, 30, 4.5);
  assert.equal(lift.error, null);
  assert.ok(lift.t0 != null);
  assert.equal(lift.t1, null);
  assert.ok(lift.notes.some(n => /keeps travelling the same way/.test(n)),
    `notes were: ${JSON.stringify(lift.notes)}`);
});

test('a finish with the elbows still bent is not a finish', () => {
  // The clean left in the rack position: knees locked, body at rest, elbows at
  // 100°. Every other part of the trigger is satisfied.
  const racked = LIFT.map(k => [k[0], k[1], k[2], k[0] >= 2.7 ? 100 : k[3], k[4], k[5]]);
  const lift = liftWindowOf(racked, 30, 4.5);
  assert.equal(lift.error, null);
  assert.ok(lift.t0 != null);
  assert.equal(lift.t1, null);
});

test('a clip that ends inside the hold is marked and flagged', () => {
  const lift = liftWindowOf(LIFT, 30, 3.6);   // cut a third of a second into the hold
  assert.equal(lift.error, null);
  assert.ok(lift.t1 >= 3.14 && lift.t1 <= 3.6, `end at ${lift.t1}`);
  assert.equal(lift.truncated, true);
  assert.ok(lift.triggers.holdSeconds < 0.5);
  assert.ok(lift.notes.some(n => /into the hold/.test(n)));
});

test('a lift with no bar on the floor has no markers at all', () => {
  const lift = liftWindowOf([[0, 300, 175, 175, 0, 0], [3, 300, 175, 175, 0, 0]], 30, 3);
  assert.equal(lift.t0, null);
  assert.equal(lift.t1, null);
  assert.match(lift.error, /below knee height/);
});
