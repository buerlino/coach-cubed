'use strict';
// Whether a lift has a lift window (package s36). diagnostics.js's lift window
// is the barbell's: the bar below knee height, then a held lockout
// (liftWindow()). A lateral raise has no bar, so its set says it has no window
// (nordmu, 2026-11-02): computeResults() gives it a lift with no window, no
// error and `hasLiftWindow: false`, describe(set) says so, and the old page
// draws no lift markers for it. The barbell sets keep their windows exactly.
//
// Where the expected values come from:
//  - the barbell windows, from golden/lift-windows.json: phase-0's
//    computeResults().lift (src/diagnostics.js at b8039d4, before s36) on every
//    committed fixture, scored raw as the goldens are, under each set that has
//    a window. Recorded with
//      git show b8039d4:src/diagnostics.js > /tmp/phase0-diagnostics.js
//      RECORD_LIFT_WINDOWS=/tmp/phase0-diagnostics.js node --test tests/app/lift-window-flag.test.js
//    s36 adds one field to them, hasLiftWindow: true, and changes nothing else.
//  - which sets have a window, from the package (nordmu's decision above).
//  - what the old page shows, from its own renderLiftMarks(), cut out of
//    src/app.py's INDEX_HTML and run on fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadDiagnostics } = require('../loadDiagnostics');
const { loadManifests, trackPathFor } = require('../fixtures');

const manifest = loadManifests();
const SLUGS = Object.keys(manifest).filter(s => manifest[s].scope === 'global').sort();
const loadTrack = slug => JSON.parse(fs.readFileSync(trackPathFor(slug), 'utf8'));
const json = v => JSON.parse(JSON.stringify(v));
const GOLDEN = path.join(__dirname, 'golden', 'lift-windows.json');

// The package's decision: the barbell lifts have a window, the lateral raise none.
const HAS_WINDOW = { 'snatch': true, 'clean-and-jerk': true, 'lateral-raise': false };
const WINDOW_SETS = Object.keys(HAS_WINDOW).filter(s => HAS_WINDOW[s]);

function liftOf(D, set, slug) {
  D.setPage(set);
  const t = loadTrack(slug);
  return D.computeResults(t.keypoints, t.meta, t.meta.tracks.kept).lift;
}

// A made-up standing person, for the tracks no fixture covers (too short, no body scale).
function madeUpTrack(frames, { bodyless = false } = {}) {
  const keypoints = {};
  const idx = Array.from({ length: frames }, (_, i) => i);
  for (const f of idx) {
    const pts = Array.from({ length: 17 }, () => [0, 0, 0]);
    const c = bodyless ? 0.05 : 0.95;
    pts[5] = [250, 215, c]; pts[6] = [250, 225, c]; pts[11] = [400, 155, c]; pts[12] = [400, 165, c];
    keypoints[String(f)] = { 0: pts };
  }
  return { keypoints, meta: { fps: 30, frame_indices: idx, frame_times_ms: idx.map(i => i * 1000 / 30) } };
}

if (process.env.RECORD_LIFT_WINDOWS) {
  test('record phase-0\'s lift windows', () => {
    const file = path.resolve(process.env.RECORD_LIFT_WINDOWS);
    global.window = {};
    delete require.cache[file];
    require(file);
    const D = global.window.Diagnostics;
    const out = {};
    for (const slug of SLUGS) {
      out[slug] = {};
      for (const set of WINDOW_SETS) out[slug][set] = json(liftOf(D, set, slug));
    }
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(out, null, 1) + '\n');
  });
}

test('describe(set) says whether the set has a lift window', () => {
  const D = loadDiagnostics();
  for (const [set, has] of Object.entries(HAS_WINDOW)) {
    assert.equal(D.describe(set).hasLiftWindow, has, set);
  }
  // the array is still the plain list of cues every reader maps and compares
  const cues = D.describe('lateral-raise');
  assert.ok(Array.isArray(cues));
  assert.deepStrictEqual(Object.keys(cues), cues.map((_, i) => String(i)));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(cues)), cues);
});

test('computeResults(): a lateral raise\'s lift has no window, no error, and says it has none', () => {
  const tracks = SLUGS.filter(s => manifest[s].diagnostics === 'lateral-raise').map(s => [s, loadTrack(s)]);
  assert.ok(tracks.length >= 2, 'the committed lateral raises');
  tracks.push(['made-up, 3 frames', madeUpTrack(3)], ['made-up, no body scale', madeUpTrack(40, { bodyless: true })]);
  for (const [name, t] of tracks) {
    const D = loadDiagnostics();
    D.setPage('lateral-raise');
    const out = D.computeResults(t.keypoints, t.meta, t.meta.tracks ? t.meta.tracks.kept : '0');
    assert.deepStrictEqual(json(out.lift),
      { hasLiftWindow: false, error: null, startIdx: -1, endIdx: -1, t0: null, t1: null, notes: [] }, name);
  }
});

test('computeResults(): the snatch\'s and the clean and jerk\'s lift windows are phase-0\'s, on every committed fixture', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepStrictEqual(Object.keys(golden).sort(), SLUGS, 'every committed fixture is pinned');
  let windows = 0;
  for (const slug of SLUGS) {
    for (const set of WINDOW_SETS) {
      const want = golden[slug][set];
      assert.ok(want, `${slug} ${set}: pinned`);
      const got = json(liftOf(loadDiagnostics(), set, slug));
      assert.deepStrictEqual(got, { ...want, hasLiftWindow: true }, `${slug} ${set}`);
      if (got.t0 != null && got.t1 != null) windows++;
    }
  }
  // not vacuous: athlete-a-trim and the snatch each have both ends, under both barbell sets
  assert.ok(windows >= 4, `${windows} windows with both ends`);
  // and a barbell set on a track too short still says why, with the flag
  const D = loadDiagnostics();
  D.setPage('snatch');
  const t = madeUpTrack(3);
  const lift = D.computeResults(t.keypoints, t.meta, '0').lift;
  assert.equal(lift.hasLiftWindow, true);
  assert.match(lift.error, /only 3 sampled frame/);
});

// --- the old page ---------------------------------------------------------------
//
// INDEX_HTML is frozen; its lift markers read Diagnostics.liftWindow() after the
// lifter is picked. renderLiftMarks() and liftMarkHtml() are cut out of it as
// they are and run on fakes, so what the page shows is read off the page's own code.
const APP_PY = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'app.py'), 'utf8');

function oldMarkers(D, duration) {
  const start = APP_PY.indexOf('const SCRUB_THUMB = 14;');
  const end = APP_PY.indexOf('// Click-to-seek on the times in the note');
  assert.ok(start > 0 && end > start, 'renderLiftMarks() is where it was in app.py');
  const els = { vliftnote: { innerHTML: 'stale' }, vliftmarks: { checked: true }, m1: { innerHTML: 'stale' }, m2: { innerHTML: 'stale' } };
  // eslint-disable-next-line no-new-func
  const run = new Function('$', 'Diagnostics', 'vvideo', 'SCRUBS',
    APP_PY.slice(start, end) + '\nrenderLiftMarks();');
  run(id => els[id], D, { duration }, [{ marks: 'm1' }, { marks: 'm2' }]);
  return { note: els.vliftnote.innerHTML, marks: [els.m1.innerHTML, els.m2.innerHTML] };
}

// The old page mounted on fakes with a fixture loaded and its kept lifter picked.
function mountedOldPage(slug) {
  const fake = tag => {
    const listeners = {};
    return {
      tagName: tag, children: [], style: {}, innerHTML: '', listeners,
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      getContext: () => new Proxy({}, { get: (_, k) => (k === 'canvas' ? { width: 620, height: 240 } : k === 'measureText' ? () => ({ width: 1 }) : () => {}), set: () => true }),
    };
  };
  global.document = { createElement: fake };
  try {
    const D = loadDiagnostics();
    D.setPage(manifest[slug].diagnostics);
    const el = { select: fake('select'), wrap: fake('div'), sections: fake('div'), video: () => null };
    D.mount(el);
    const t = loadTrack(slug);
    D.setTrack(t.keypoints, t.meta, {});
    el.select.value = t.meta.tracks.kept;
    for (const fn of el.select.listeners.change || []) fn();
    return { D, duration: t.meta.frame_times_ms.at(-1) / 1000 };
  } finally {
    delete global.document;
  }
}

test('the old page shows no lift markers and no barbell error for a lateral raise, and the snatch\'s as before', () => {
  for (const slug of SLUGS) {
    const set = manifest[slug].diagnostics;
    const { D, duration } = mountedOldPage(slug);
    const shown = oldMarkers(D, duration);
    if (HAS_WINDOW[set]) {
      const lift = D.liftWindow();
      assert.ok(lift && lift.t0 != null && lift.t1 != null, `${slug}: the barbell window is there`);
      assert.match(shown.note, /<b>lift<\/b> <span/, slug);
      assert.ok(shown.marks.every(m => m.includes('scrub-mark')), slug);
    } else {
      assert.equal(D.liftWindow(), null, `${slug}: no window to show`);
      assert.deepStrictEqual(shown, { note: '', marks: ['', ''] }, slug);
      assert.doesNotMatch(shown.note, /bar|knee/, slug);
    }
  }
});
