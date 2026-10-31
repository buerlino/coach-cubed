'use strict';
// src/track/: smoothing and the lift window, pinned to the old page they were
// ported from (restructure-plan step 3.2). The old code is taken out of
// src/app.py's INDEX_HTML and src/diagnostics.js as they are (loadOldCode.js),
// so a drift in either the port or a careless edit of the old page fails here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadDiagnostics } = require('./loadDiagnostics');
const { loadManifests, trackPathFor } = require('./fixtures');
const { oldPage, oldDiagnostics, diagnosticsLine } = require('./loadOldCode');

const smoothing = import('../src/track/smoothing.mjs');
const liftWindow = import('../src/track/lift-window.mjs');

const OLD = oldPage(['CONF_THRESHOLD', 'SIGMA_CUTOFF', 'sampleTimes', 'smoothKeypoints',
  'E_FINE', 'retimeAlongPath', 'gauss1d', 'SCRUB_THUMB', 'markLeft', 'markWidth', 'liftMarkHtml']);
const OLD_DIAG = oldDiagnostics(['personIds']);
// setTrack's choice of lifter, the one statement inside that method.
const oldKeep = diagnosticsLine('const keep = ids.', ['ids', 'prev'], 'keep');

const manifest = loadManifests();
const FIXTURES = Object.keys(manifest).sort().map(slug => ({
  slug, set: manifest[slug].diagnostics || 'snatch',
  track: JSON.parse(fs.readFileSync(trackPathFor(slug), 'utf8')),
}));

// A track that walks into every branch: a stride with uneven decoder times, a
// frame missing, two people (one from frame 2), null and low-confidence
// points, and a joint confident in only two frames (too few to re-time).
function syntheticTrack() {
  const frames = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];
  const keypoints = {};
  frames.forEach((f, s) => {
    if (f === 10) return;
    const person = k => Array.from({ length: 17 }, (_, i) => {
      if (i === 3 && s % 4 === 1) return null;
      const conf = i === 4 ? (s === 2 || s === 7 ? 0.9 : 0.1) : (i === 6 && s % 3 === 0 ? 0.2 : 0.5 + 0.03 * i);
      return [100 + 40 * Math.sin(s / 2 + i) + k, 200 + 25 * Math.cos(s / 3 - i) + 3 * (s % 2), conf];
    });
    keypoints[String(f)] = s >= 2 ? { '7': person(0), '3': person(50) } : { '7': person(0) };
  });
  const times = frames.map((f, s) => f * 1000 / 60 + (s % 3) * 4);
  return { keypoints, meta: { fps: 60, frame_stride: 2, frame_indices: frames, frame_times_ms: times } };
}

test('track: sampleTimes matches the old page, with and without decoder times', async () => {
  const { sampleTimes } = await smoothing;
  const syn = syntheticTrack();
  const cases = [...FIXTURES.map(f => f.track), syn,
    { keypoints: syn.keypoints, meta: { fps: 60 } },
    { keypoints: syn.keypoints, meta: { frame_indices: [0, 2, 4], frame_times_ms: [0, null, 70] } }];
  for (const { keypoints, meta } of cases) {
    assert.deepStrictEqual(sampleTimes(meta, keypoints), OLD.sampleTimes(meta, keypoints));
  }
});

test('track: smoothKeypoints matches the old page on every fixture, bit for bit', async () => {
  const { smoothKeypoints } = await smoothing;
  for (const { slug, track } of FIXTURES) {
    for (const sigma of [0.02, 0.05, 0.1, 0.3]) {
      for (const keep of [true, false]) {
        assert.deepStrictEqual(smoothKeypoints(track.keypoints, track.meta, sigma, keep),
          OLD.smoothKeypoints(track.keypoints, track.meta, sigma, keep), `${slug} σ=${sigma} keepVelocity=${keep}`);
      }
    }
  }
});

test('track: smoothKeypoints matches the old page on a track with gaps, strides and two people', async () => {
  const { smoothKeypoints } = await smoothing;
  const { keypoints, meta } = syntheticTrack();
  for (const sigma of [0.01, 0.05, 0.2]) {
    for (const keep of [true, false]) {
      const got = smoothKeypoints(keypoints, meta, sigma, keep);
      assert.deepStrictEqual(got, OLD.smoothKeypoints(keypoints, meta, sigma, keep), `σ=${sigma} keepVelocity=${keep}`);
      assert.notDeepStrictEqual(got, keypoints, 'it did smooth something');
    }
  }
});

test('track: σ of 0 or less returns the raw track itself, like the old page', async () => {
  const { smoothKeypoints } = await smoothing;
  const { keypoints, meta } = syntheticTrack();
  for (const sigma of [0, -1, NaN]) {
    assert.equal(smoothKeypoints(keypoints, meta, sigma, true), keypoints);
    assert.equal(OLD.smoothKeypoints(keypoints, meta, sigma, true), keypoints);
  }
});

test('track: the defaults are the old page\'s', async () => {
  const { CONF_THRESHOLD, DEFAULT_SIGMA_MS, DEFAULT_KEEP_VELOCITY } = await smoothing;
  assert.equal(CONF_THRESHOLD, OLD.CONF_THRESHOLD);
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.py'), 'utf8');
  assert.match(html, new RegExp(`<input id="vsmooth" type="range"[^>]* value="${DEFAULT_SIGMA_MS}"`));
  assert.match(html, DEFAULT_KEEP_VELOCITY ? /<input id="vkeepvel" type="checkbox" checked/ : /<input id="vkeepvel" type="checkbox" (?!checked)/);
});

test('track: personIds and pickPerson choose the lifter the way diagnostics.js does', async () => {
  const { personIds, pickPerson } = await liftWindow;
  const tie = { 0: { 12: [], 3: [] }, 1: { 12: [], 3: [] }, 2: { 40: [] } };
  for (const kp of [...FIXTURES.map(f => f.track.keypoints), syntheticTrack().keypoints, tie, {}]) {
    const ids = personIds(kp);
    assert.deepStrictEqual(ids, OLD_DIAG.personIds(kp));
    for (const prev of [undefined, null, '3', '12', '40', '99']) {
      assert.equal(pickPerson(kp, prev), oldKeep(ids, prev), `previous ${prev}`);
    }
  }
});

test('track: scoreTrack gives the old page\'s lift window and scores on every fixture', async () => {
  const { scoreTrack } = await liftWindow;
  for (const { slug, set, track } of FIXTURES) {
    // The old page: applySmoothing at its defaults, then setTrack's lifter.
    const smoothed = OLD.smoothKeypoints(track.keypoints, track.meta, 0.05, true);
    const person = oldKeep(OLD_DIAG.personIds(smoothed), undefined);
    const D = loadDiagnostics();
    D.setPage(set);
    const want = D.computeResults(smoothed, track.meta, person);

    const got = scoreTrack(loadDiagnostics(), track, set);
    assert.equal(got.personId, person, slug);
    assert.deepStrictEqual(got.keypoints, smoothed, slug);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(got.lift)), JSON.parse(JSON.stringify(want.lift)), slug);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(got.results)), JSON.parse(JSON.stringify(want.results)), slug);
  }
});

test('track: scoreTrack on a track with nobody in it has no window and scores nothing', async () => {
  const { scoreTrack } = await liftWindow;
  const got = scoreTrack(loadDiagnostics(), { keypoints: { 0: {}, 1: {} }, meta: { fps: 30 } }, 'lateral-raise');
  assert.equal(got.personId, null);
  assert.equal(got.lift, null);
  assert.ok(Object.keys(got.results).length > 0);
  for (const r of Object.values(got.results)) assert.equal(r.error, 'No person was detected in any sampled frame.');
});

test('track: liftMarks puts the marks where the old page\'s time bars do', async () => {
  const { liftMarks } = await liftWindow;
  // Every percentage the old markup holds, in order: `calc(7.0px + P% - ...)`.
  const percents = html => [...html.matchAll(/calc\([^)]*?([\d.]+)%/g)].map(m => m[1]);
  const cases = [[1.2, 3.4, 7.4], [0.5, null, 3], [null, null, 3], [-0.2, 9, 7.4], [0, 3, 3]];
  for (const [t0, t1, dur] of cases) {
    const marks = liftMarks({ t0, t1 }, dur);
    const pct = r => (r * 100).toFixed(4);
    const want = [];
    if (marks.span) want.push(pct(marks.span[0]), pct(marks.span[1] - marks.span[0]));
    for (const r of marks.marks) want.push(pct(r));
    assert.deepStrictEqual(want, percents(OLD.liftMarkHtml(t0, t1, dur)), `${t0}, ${t1}, ${dur}`);
  }
  assert.equal(liftMarks(null, 3), null);
  assert.equal(liftMarks({ t0: 1, t1: 2 }, NaN), null);
});
