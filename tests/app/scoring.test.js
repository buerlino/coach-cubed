'use strict';
// The scoring adapter (package s11, app/src/scoring/): a track in, contract 4's
// ResultView out. diagnostics.js is the classic script it is, loaded here by
// tests/loadDiagnostics.js and handed to the adapter; in the app index.html
// loads it and the adapter finds window.Diagnostics.
//
// Where the expected values come from:
//  - the verdicts, values, series, notes and reasons of a fixture, from its
//    committed golden snapshot (tests/golden/, written by
//    tests/update_golden.js from the engine; the goldens score RAW tracks,
//    which is why smoothing is off for that test: docs/backlog.md,
//    "Unverified"). The status word, the value and the worst moment are read
//    off the golden with the contract's own functions (VERDICT_STATUS,
//    verdictValue) and diagnostics.js's headless API.
//  - the smoothed run, from src/track/smoothing.mjs (pinned to the old page
//    by tests/track.test.js) followed by computeResults(), called directly.
//  - the reasons of a track too short or without a body scale, from
//    computeResults() on that track.
// Nothing is typed in by hand except the shape of a made-up track.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadDiagnostics } = require('../loadDiagnostics');
const { loadManifests, trackPathFor, goldenPathFor } = require('../fixtures');

const ROOT = path.join(__dirname, '..', '..');
const scoring = import('../../app/src/scoring/score.mjs');
const cueView = import('../../app/src/contracts/cue-view.mjs');
const smoothing = import('../../src/track/smoothing.mjs');
const trackMod = import('../../src/track/lift-window.mjs');

const manifest = loadManifests();
const SLUGS = Object.keys(manifest).sort();
const loadTrack = slug => JSON.parse(fs.readFileSync(trackPathFor(slug), 'utf8'));
const json = v => JSON.parse(JSON.stringify(v));

// A made-up person for the cases no fixture covers: `frames` frames at 30 fps,
// a standing lifter whose hips and shoulders are confident unless `bodyless`.
function madeUpTrack(frames, { bodyless = false } = {}) {
  const keypoints = {};
  const idx = Array.from({ length: frames }, (_, i) => i);
  for (const f of idx) {
    const pts = Array.from({ length: 17 }, () => [0, 0, 0]);
    const c = bodyless ? 0.05 : 0.95;
    pts[5] = [250, 215, c]; pts[6] = [250, 225, c]; pts[11] = [400, 155, c]; pts[12] = [400, 165, c];
    pts[0] = [150, 220, 0.9];
    keypoints[String(f)] = { 0: pts };
  }
  return { keypoints, meta: { fps: 30, frame_indices: idx, frame_times_ms: idx.map(i => i * 1000 / 30), tracks: { kept: '0' } } };
}

// Every string leaf of a value.
function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => strings(x, out));
  return out;
}

test('scoring: with smoothing off, every committed fixture gives its golden\'s verdicts and values', async (t) => {
  const { scoreLift } = await scoring;
  const { validateResultView, VERDICT_STATUS, verdictValue } = await cueView;
  assert.ok(SLUGS.length > 0);
  for (const slug of SLUGS) {
    const goldenPath = goldenPathFor(slug);
    if (!fs.existsSync(goldenPath)) { assert.notEqual(manifest[slug].scope, 'global', `no golden for ${slug}`); continue; }
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
    const track = loadTrack(slug);
    const D = loadDiagnostics();
    const set = manifest[slug].diagnostics;
    const out = scoreLift(track, set, { Diagnostics: D, sigmaMs: 0 });
    const view = out.view;

    assert.deepStrictEqual(validateResultView(view), [], slug);
    assert.equal(view.lift, set, slug);
    assert.deepStrictEqual(view.cues.map(c => c.id), D.describe(set).map(d => d.id), `${slug}: the cues in diagnostics.js's order`);
    assert.deepStrictEqual(view.cues.map(c => c.id).sort(), Object.keys(golden).sort(), slug);

    for (const cue of view.cues) {
      const g = golden[cue.id];
      const where = `${slug} ${cue.id}`;
      if (g.error) {
        assert.equal(cue.status, "can't score", where);
        assert.equal(cue.reason, g.error, where);
        assert.deepStrictEqual([cue.verdict, cue.value, cue.referenceLine, cue.phase, cue.worst], [null, null, null, null, null], where);
        assert.deepStrictEqual([cue.tiles, cue.series], [[], []], where);
        continue;
      }
      assert.equal(cue.status, VERDICT_STATUS[g.verdict.status], where);
      assert.equal(cue.verdict, g.verdict.label, where);
      assert.equal(cue.reason, null, where);
      const worst = D.worstMoment(cue.id, g);
      assert.deepStrictEqual(cue.worst, worst, where);
      assert.equal(cue.value, verdictValue(worst.rule, g.summary), where);
      assert.notEqual(cue.value, null, `${where}: a scored cue has its value`);
      assert.deepStrictEqual(cue.tiles, json(D.tiles(cue.id, g)), where);
      assert.deepStrictEqual(cue.referenceLine, json(D.referenceLine(cue.id, g)), where);
      assert.deepStrictEqual(cue.series.map(s => s.t), g.series.map(s => s.t), where);
      assert.deepStrictEqual(cue.series.map(s => s.value), g.series.map(s => s.value), where);
      assert.deepStrictEqual(cue.notes, g.notes, where);
    }
  }
});

test('scoring: the status words map from the verdict levels and from errors', async () => {
  const { cueStatus } = await scoring;
  assert.equal(cueStatus({ verdict: { status: 'good' } }), 'good');
  assert.equal(cueStatus({ verdict: { status: 'warning' } }), 'watch');
  assert.equal(cueStatus({ verdict: { status: 'critical' } }), 'work on');
  assert.equal(cueStatus({ error: 'Only one rep was found.' }), "can't score");
  // an error wins over a verdict that happens to be there
  assert.equal(cueStatus({ error: 'x', verdict: { status: 'good' } }), "can't score");
  // a level diagnostics.js grows must not be shown as another word
  assert.throws(() => cueStatus({ verdict: { status: 'excellent' } }), /excellent/);
  assert.throws(() => cueStatus(undefined));
});

test('scoring: the three levels and the error all reach the screen on the committed lifts', async () => {
  const { scoreLift } = await scoring;
  const seen = new Set();
  for (const slug of SLUGS) {
    const D = loadDiagnostics();
    for (const c of scoreLift(loadTrack(slug), manifest[slug].diagnostics, { Diagnostics: D, sigmaMs: 0 }).view.cues) seen.add(c.status);
  }
  assert.deepStrictEqual([...seen].sort(), ['good', 'watch', 'work on', "can't score"].sort());
});

test('scoring: with the default smoothing it is src/track/ smoothing followed by computeResults()', async () => {
  const { scoreLift, DEFAULT_SIGMA_MS, DEFAULT_KEEP_VELOCITY } = await scoring;
  const { smoothKeypoints } = await smoothing;
  const { pickPerson } = await trackMod;
  const { validateResultView } = await cueView;
  let changedSomething = false;
  for (const slug of SLUGS) {
    const track = loadTrack(slug);
    const D = loadDiagnostics();
    const set = manifest[slug].diagnostics;
    const out = scoreLift(track, set, { Diagnostics: D });
    // the view says which smoothing its verdicts were scored with (contract 4), so result.json keeps it
    assert.deepStrictEqual(out.view.smoothing, { sigmaMs: DEFAULT_SIGMA_MS, keepVelocity: DEFAULT_KEEP_VELOCITY }, slug);
    assert.equal(out.smoothing, undefined, 'one place for it: the view, not beside it');
    assert.deepStrictEqual(validateResultView(out.view), [], slug);

    // the reference: the app's smoothing, then the engine, called directly
    const ref = loadDiagnostics();
    ref.setPage(set);
    const smoothed = smoothKeypoints(track.keypoints, track.meta, DEFAULT_SIGMA_MS / 1000, DEFAULT_KEEP_VELOCITY);
    const want = ref.computeResults(smoothed, track.meta, pickPerson(smoothed, track.meta.tracks.kept));
    assert.deepStrictEqual(json(out.computed.results), json(want.results), slug);
    assert.deepStrictEqual(json(out.computed.lift), json(want.lift), slug);
    for (const cue of out.view.cues) {
      const r = want.results[cue.id];
      if (r.error) { assert.equal(cue.reason, r.error, slug); continue; }
      assert.equal(cue.verdict, r.verdict.label, `${slug} ${cue.id}`);
      assert.deepStrictEqual(cue.series.map(s => s.value), r.series.map(s => s.value), `${slug} ${cue.id}`);
    }
    // not vacuous: smoothing moved a number somewhere
    const raw = scoreLift(track, set, { Diagnostics: loadDiagnostics(), sigmaMs: 0 }).view;
    if (JSON.stringify(raw.cues.map(c => c.series)) !== JSON.stringify(out.view.cues.map(c => c.series))) changedSomething = true;
  }
  assert.ok(changedSomething, 'the default smoothing changes the series of at least one fixture');
});

test('scoring: sigmaMs and keepVelocity are the caller\'s, and sigmaMs 0 is the raw track', async () => {
  const { scoreLift } = await scoring;
  const { smoothKeypoints } = await smoothing;
  const slug = SLUGS.find(s => manifest[s].diagnostics === 'snatch');
  const track = loadTrack(slug);
  const set = 'snatch';
  const a = scoreLift(track, set, { Diagnostics: loadDiagnostics(), sigmaMs: 100, keepVelocity: false });
  assert.deepStrictEqual(a.view.smoothing, { sigmaMs: 100, keepVelocity: false });
  const ref = loadDiagnostics();
  ref.setPage(set);
  const sm = smoothKeypoints(track.keypoints, track.meta, 0.1, false);
  assert.deepStrictEqual(json(a.computed.results), json(ref.computeResults(sm, track.meta, track.meta.tracks.kept).results));
  const raw = scoreLift(track, set, { Diagnostics: loadDiagnostics(), sigmaMs: 0 });
  assert.deepStrictEqual(raw.view.smoothing, { sigmaMs: 0, keepVelocity: true });
  assert.deepStrictEqual(json(raw.computed.results), json(ref.computeResults(track.keypoints, track.meta, track.meta.tracks.kept).results));
});

test('scoring: a track too short says "can\'t score" for every cue, in the engine\'s words', async () => {
  const { scoreLift } = await scoring;
  const { validateResultView } = await cueView;
  for (const set of ['lateral-raise', 'snatch']) {
    const D = loadDiagnostics();
    const track = madeUpTrack(3);
    D.setPage(set);
    const want = D.computeResults(track.keypoints, track.meta, '0');
    const { view } = scoreLift(track, set, { Diagnostics: D, sigmaMs: 0 });
    assert.deepStrictEqual(validateResultView(view), [], set);
    assert.ok(view.cues.length > 0);
    for (const c of view.cues) {
      assert.equal(c.status, "can't score", c.id);
      assert.equal(c.reason, want.results[c.id].error, c.id);
      assert.match(c.reason, /only 3 sampled frame/, c.id);
    }
    assert.equal(view.liftWindow, null);
    assert.equal(view.liftWindowReason, want.lift.error);
  }
});

test('scoring: a track without a body scale says "can\'t score" with the engine\'s reason', async () => {
  const { scoreLift } = await scoring;
  const { validateResultView } = await cueView;
  const D = loadDiagnostics();
  const track = madeUpTrack(40, { bodyless: true });
  D.setPage('lateral-raise');
  const want = D.computeResults(track.keypoints, track.meta, '0');
  assert.match(want.results['lateral-raise-top-height'].error, /no body scale/);   // the engine says it
  const { view } = scoreLift(track, 'lateral-raise', { Diagnostics: D });
  assert.deepStrictEqual(validateResultView(view), []);
  for (const c of view.cues) {
    assert.equal(c.status, "can't score", c.id);
    assert.equal(c.reason, want.results[c.id].error, c.id);
  }
  assert.equal(view.liftWindow, null);
  assert.equal(view.liftWindowReason, want.lift.error);
});

test('scoring: a track with nobody in it can\'t be scored, in the engine\'s words', async () => {
  const { scoreLift } = await scoring;
  const { validateResultView } = await cueView;
  const D = loadDiagnostics();
  const track = { keypoints: { 0: {}, 1: {}, 2: {}, 3: {}, 4: {}, 5: {} }, meta: { fps: 30 } };
  const { view } = scoreLift(track, 'snatch', { Diagnostics: D });
  assert.deepStrictEqual(validateResultView(view), []);
  for (const c of view.cues) {
    assert.equal(c.status, "can't score");
    assert.match(c.reason, /only 0 sampled frame/);
  }
});

test('scoring: every cue carries its provisional flag, as diagnostics.js says it', async () => {
  const { scoreLift } = await scoring;
  for (const slug of SLUGS) {
    const D = loadDiagnostics();
    const set = manifest[slug].diagnostics;
    const { view } = scoreLift(loadTrack(slug), set, { Diagnostics: D });
    const flags = Object.fromEntries(D.describe(set).map(d => [d.id, d.provisional]));
    for (const c of view.cues) {
      assert.equal(typeof c.provisional, 'boolean', c.id);
      assert.equal(c.provisional, flags[c.id], c.id);
    }
  }
  // a short track too: an unscored cue is just as provisional
  const D = loadDiagnostics();
  for (const c of scoreLift(madeUpTrack(3), 'snatch', { Diagnostics: D }).view.cues) assert.equal(typeof c.provisional, 'boolean');
  // and none is marked checked yet: every threshold is unvalidated (diagnostics.js, above the Diagnostics object)
  for (const set of ['lateral-raise', 'snatch']) for (const d of D.describe(set)) assert.equal(d.provisional, true, d.id);
});

test('scoring: the lift window and the worst moments are in seconds', async () => {
  const { scoreLift } = await scoring;
  const SHIFT_S = 10;
  for (const slug of SLUGS) {
    const set = manifest[slug].diagnostics;
    const track = loadTrack(slug);
    const a = scoreLift(track, set, { Diagnostics: loadDiagnostics(), sigmaMs: 0 });
    // the same track filmed ten seconds later (decoder times in ms): everything moves by ten seconds, nothing else
    const later = { ...track, meta: { ...track.meta, frame_times_ms: track.meta.frame_times_ms.map(ms => ms + SHIFT_S * 1000) } };
    const b = scoreLift(later, set, { Diagnostics: loadDiagnostics(), sigmaMs: 0 });
    // diagnostics.js's phase edges can land a frame apart when only the clock's origin moves (float
    // comparisons on t), so a shift is checked to a frame and a half: seconds against milliseconds is
    // a factor of a thousand.
    const frame = 1 / track.meta.fps;
    const near = (x, y, what) => assert.ok(Math.abs(x - y) < 1.5 * frame, `${slug} ${what}: ${x} vs ${y}`);
    const times = new Set(track.meta.frame_times_ms.map(ms => ms / 1000));
    if (a.view.liftWindow) {
      near(b.view.liftWindow.t0, a.view.liftWindow.t0 + SHIFT_S, 'window t0');
      near(b.view.liftWindow.t1, a.view.liftWindow.t1 + SHIFT_S, 'window t1');
    }
    a.view.cues.forEach((c, i) => {
      const d = b.view.cues[i];
      if (c.status === "can't score") return;
      near(d.worst.t, c.worst.t + SHIFT_S, `${c.id} worst`);
      near(d.phase.t0, c.phase.t0 + SHIFT_S, `${c.id} phase t0`);
      near(d.phase.t1, c.phase.t1 + SHIFT_S, `${c.id} phase t1`);
      // the worst moment, the phase and the series sit at times the track has, in seconds
      for (const x of [c.worst.t, c.phase.t0, c.phase.t1, ...c.series.map(s => s.t)]) assert.ok(times.has(x), `${slug} ${c.id}: ${x}`);
      // the phase is where the series is
      assert.ok(c.phase.t0 <= c.series[0].t + 1e-9 && c.series[c.series.length - 1].t <= c.phase.t1 + 1e-9, `${slug} ${c.id}`);
    });
  }
});

test('scoring: the lift window is the engine\'s, or its reason for having none', async () => {
  const { scoreLift } = await scoring;
  let found = 0, absent = 0;
  for (const slug of SLUGS) {
    const D = loadDiagnostics();
    const set = manifest[slug].diagnostics;
    const track = loadTrack(slug);
    const { view, computed } = scoreLift(track, set, { Diagnostics: D, sigmaMs: 0 });
    const lift = computed.lift;
    if (lift.t0 != null && lift.t1 != null) {
      found++;
      assert.deepStrictEqual(view.liftWindow, { t0: lift.t0, t1: lift.t1 }, slug);
      assert.equal(view.liftWindowReason, null, slug);
      assert.deepStrictEqual(view.notes, lift.notes, slug);
    } else if (lift.t0 != null && !lift.error) {
      assert.deepStrictEqual(view.liftWindow, { t0: lift.t0, t1: null }, slug);
      assert.equal(view.liftWindowReason, lift.notes.at(-1), slug);
    } else {
      assert.equal(view.liftWindow, null, slug);
      if (lift.error) { absent++; assert.equal(view.liftWindowReason, lift.error, slug); assert.deepStrictEqual(view.notes, lift.notes, slug); }
    }
  }
  assert.ok(found > 0 && absent > 0, `fixtures with a window (${found}) and without (${absent})`);
});

test('scoring: a start found with no end keeps its start, {t0, t1: null}, and says why in the engine\'s words', async () => {
  // The snatch never held a finish: diagnostics.js returns t0, no t1 and no error, and notes
  // (the last is why the lift has no end marker). Contract 4 keeps the start (s11's adapter
  // dropped it whole); that note is the reason, the others stay notes.
  // The track: the longest committed snatch (over 400 frames), cut off at 2.0 s.
  const { scoreLift } = await scoring;
  const { validateResultView } = await cueView;
  const D = loadDiagnostics();
  const slug = SLUGS.find(s => manifest[s].diagnostics === 'snatch' && loadTrack(s).meta.frame_count > 400);
  const track = loadTrack(slug);
  // cut the clip off at 2.0 s: the pull is in it, the finish is not
  const keep = track.meta.frame_times_ms.map((ms, i) => (ms <= 2000 ? i : -1)).filter(i => i >= 0);
  const frames = keep.map(i => track.meta.frame_indices[i]);
  const cut = {
    keypoints: Object.fromEntries(frames.map(f => [String(f), track.keypoints[String(f)]])),
    meta: { ...track.meta, frame_indices: frames, frame_times_ms: keep.map(i => track.meta.frame_times_ms[i]) },
  };
  D.setPage('snatch');
  const want = D.computeResults(cut.keypoints, cut.meta, track.meta.tracks.kept).lift;
  assert.ok(want.t0 != null && want.t1 == null && !want.error, 'the cut clip has a start and no end: ' + JSON.stringify(want).slice(0, 200));
  const { view } = scoreLift(cut, 'snatch', { Diagnostics: D, sigmaMs: 0 });
  assert.deepStrictEqual(validateResultView(view), []);
  assert.deepStrictEqual(view.liftWindow, { t0: want.t0, t1: null });
  assert.equal(view.liftWindowReason, want.notes[want.notes.length - 1]);
  assert.match(view.liftWindowReason, /no end marker/);
  assert.deepStrictEqual(view.notes, want.notes.slice(0, -1));
});

test('scoring: every string on the view model comes from diagnostics.js, none from the adapter', async () => {
  const { scoreLift } = await scoring;
  const { STATUS_WORDS } = await cueView;
  const cases = SLUGS.map(slug => [loadTrack(slug), manifest[slug].diagnostics]);
  cases.push([madeUpTrack(3), 'snatch'], [madeUpTrack(40, { bodyless: true }), 'lateral-raise']);
  for (const [track, set] of cases) {
    for (const sigmaMs of [0, 50]) {
      const D = loadDiagnostics();
      const { view, computed } = scoreLift(track, set, { Diagnostics: D, sigmaMs });
      const allowed = new Set([...STATUS_WORDS, set, 'summary-worst', 'summary-last', 'farthest-from-mean', 'phase-end']);
      strings(D.describe(set)).forEach(s => allowed.add(s));
      strings(computed.lift).forEach(s => allowed.add(s));
      for (const [id, r] of Object.entries(computed.results)) {
        if (r.error) { allowed.add(r.error); continue; }
        allowed.add(r.verdict.label);
        strings(r.notes).forEach(s => allowed.add(s));
        strings(D.tiles(id, r)).forEach(s => allowed.add(s));
        strings(D.referenceLine(id, r)).forEach(s => allowed.add(s));
        strings(D.worstMoment(id, r)).forEach(s => allowed.add(s));
      }
      // verdict statuses ('good', …) arrive as tile statuses: they are diagnostics.js's
      for (const s of strings(view)) assert.ok(allowed.has(s), `not from diagnostics.js: ${JSON.stringify(s)}`);
    }
  }
});

test('scoring: the view model survives result.json (JSON round trip) and the input track is left alone', async () => {
  const { scoreLift } = await scoring;
  const { validateResultView } = await cueView;
  for (const slug of SLUGS) {
    const track = loadTrack(slug);
    const before = JSON.stringify(track);
    const { view } = scoreLift(track, manifest[slug].diagnostics, { Diagnostics: loadDiagnostics() });
    assert.equal(JSON.stringify(track), before, `${slug}: the track was changed`);
    assert.deepStrictEqual(json(view), view, slug);
    assert.deepStrictEqual(validateResultView(json(view)), [], slug);
  }
});

test('scoring: a lift in one call does not leak into the next (setPage each time)', async () => {
  const { scoreLift } = await scoring;
  const D = loadDiagnostics();
  const sn = SLUGS.find(s => manifest[s].diagnostics === 'snatch');
  const lr = SLUGS.find(s => manifest[s].diagnostics === 'lateral-raise');
  const a = scoreLift(loadTrack(sn), 'snatch', { Diagnostics: D, sigmaMs: 0 }).view;
  const b = scoreLift(loadTrack(lr), 'lateral-raise', { Diagnostics: D, sigmaMs: 0 }).view;
  const c = scoreLift(loadTrack(sn), 'snatch', { Diagnostics: D, sigmaMs: 0 }).view;
  assert.ok(b.cues.every(x => x.id.startsWith('lateral-raise-')));
  assert.deepStrictEqual(a, c);
});

test('scoring: an unknown lift is refused, not scored as an empty set', async () => {
  const { scoreLift } = await scoring;
  assert.throws(() => scoreLift(madeUpTrack(10), 'deadlift', { Diagnostics: loadDiagnostics() }), /deadlift/);
});

test('scoring: diagnostics.js is found as window.Diagnostics, the classic script\'s global', async () => {
  const { getDiagnostics, scoreLift } = await scoring;
  const saved = global.window;
  try {
    global.window = undefined;
    assert.throws(() => getDiagnostics(), /diagnostics\.js/);
    assert.throws(() => scoreLift(madeUpTrack(10), 'snatch'), /diagnostics\.js/);
    const D = loadDiagnostics();   // sets global.window = { Diagnostics }
    assert.equal(getDiagnostics(), D);
    const { view } = scoreLift(madeUpTrack(3), 'snatch');   // no Diagnostics passed: the page's
    assert.equal(view.cues.length, D.describe('snatch').length);
  } finally {
    global.window = saved;
  }
});

test('scoring: index.html loads diagnostics.js as a classic script before the app\'s module', () => {
  const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
  const classic = html.match(/<script(?![^>]*type=)[^>]*src="\.\/src\/diagnostics\.js"[^>]*>/);
  assert.ok(classic, 'a plain <script src="./src/diagnostics.js">, relative');
  assert.ok(!/\b(defer|async)\b/.test(classic[0]), 'it runs when parsed, before the deferred module');
  assert.ok(html.indexOf(classic[0]) < html.indexOf('src="./src/main.mjs"'));
});

test('scoring: the adapter is a plain module: no DOM, nothing from the UI, nothing but contracts and src/track/', () => {
  const dir = path.join(ROOT, 'app', 'src', 'scoring');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.mjs'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /\bdocument\b|\bnavigator\b|\blocalStorage\b|\bfetch\(/, f);
    for (const m of src.matchAll(/^\s*(?:import|export)\b[^'"]*from\s*['"]([^'"]+)['"]/gm)) {
      assert.match(m[1], /^\.\/|^\.\.\/(contracts|track)\//, `${f} imports ${m[1]}`);
    }
  }
});
