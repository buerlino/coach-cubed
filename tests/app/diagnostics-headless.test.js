'use strict';
// diagnostics.js's headless API for the new UI (package s4; docs/app-plan.md,
// "The contracts", item 4): each cue's descriptor, its tiles and reference
// line, its worst moment, and its overlay drawn on any canvas, all from
// computeResults()'s output passed in, with no mounted panel, no DOM and no
// module state.
//
// The fixtures are the committed tracks a lateral raise
// (global/example/lateral-raise-cable-1, the clip the mockups show) and a
// snatch (global/snatch/Session14_01_0h18m07s_made). The old page is driven
// through its own mount()/setTrack()/overlay() on small fakes, so "what the
// old panel shows" is read off the old panel itself, never retyped here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadDiagnostics } = require('../loadDiagnostics');
const { loadManifests, trackPathFor, diagnosticsSet } = require('../fixtures');

const LATERAL = 'global/example/lateral-raise-cable-1';
const SNATCH = 'global/snatch/Session14_01_0h18m07s_made';
const manifest = loadManifests();
// The set a fixture scores against, read off its manifest entry. (fixtures.js's
// diagnosticsSet checks it with setPage, which would rebuild a mounted panel.)
const setOf = slug => manifest[slug].diagnostics;

function loadTrack(slug) {
  return JSON.parse(fs.readFileSync(trackPathFor(slug), 'utf8'));
}

// computeResults() exactly as tests/diagnostics.test.js runs it for the goldens.
function computed(slug) {
  const D = loadDiagnostics();
  D.setPage(diagnosticsSet(manifest, slug, D));
  const track = loadTrack(slug);
  return { D, track, out: D.computeResults(track.keypoints, track.meta, track.meta.tracks.kept) };
}

// --- fakes --------------------------------------------------------------------

// A 2D context that records every call and every property set, in order. Any
// method name is accepted, so the overlays draw on it unchanged.
function recordingContext(width = 1280, height = 720) {
  const calls = [];
  const props = {};
  const canvas = { width, height };
  return new Proxy({}, {
    get(_, k) {
      if (k === 'canvas') return canvas;
      if (k === 'calls') return calls;
      if (typeof k === 'symbol' || k === 'then') return undefined;
      if (Object.prototype.hasOwnProperty.call(props, k)) return props[k];
      if (k === 'measureText') return s => { calls.push(['measureText', s]); return { width: String(s).length * 7 }; };
      return (...args) => { calls.push([k, ...args]); };
    },
    set(_, k, v) { props[k] = v; calls.push(['=' + String(k), v]); return true; },
  });
}

// Just enough DOM for the old page's mount(): elements that hold innerHTML and
// children, canvases that hand out recording contexts.
function fakeElement(tag) {
  const listeners = {};
  const e = {
    tagName: tag, children: [], style: {}, innerHTML: '', className: '', textContent: '', value: null,
    listeners,
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    getBoundingClientRect() { return { left: 0, top: 0, width: this.width || 0, height: this.height || 0 }; },
  };
  if (tag === 'canvas') {
    let ctx = null;
    e.getContext = () => ctx || (ctx = recordingContext(e.width, e.height));
  }
  return e;
}

// The old page mounted on fakes, scoring the fixture's kept person (the one the
// goldens use), as app.py's page would after the lifter is picked.
// `set` scores the fixture against another set than its own; `smoothingMs` is
// what the page tells the panel the track was smoothed with (setTrack's opts).
function oldPage(slug, { smooth = false, cubic, sections = false, set, smoothingMs } = {}) {
  global.document = { createElement: fakeElement };
  try {
    const D = loadDiagnostics();
    D.setPage(set || diagnosticsSet(manifest, slug, D));
    const el = {
      select: fakeElement('select'),
      wrap: fakeElement('div'),
      video: () => null,
      smoothMotion: smooth ? () => true : undefined,
      cubic,
    };
    if (sections) el.sections = fakeElement('div');
    D.mount(el);
    const track = loadTrack(slug);
    D.setTrack(track.keypoints, track.meta, smoothingMs === undefined ? {} : { smoothingMs });
    el.select.value = track.meta.tracks.kept;
    for (const fn of el.select.listeners.change || []) fn();
    return { D, el };
  } finally {
    delete global.document;
  }
}

// Every sample's time, the midpoints between them (where interpolation shows),
// and a stretch before and after the clip.
function sweep(samples) {
  const ts = [samples[0].t - 0.5];
  samples.forEach((s, i) => {
    ts.push(s.t);
    if (samples[i + 1]) ts.push((s.t + samples[i + 1].t) / 2);
  });
  ts.push(samples[samples.length - 1].t + 0.5);
  return ts;
}

// A deliberately odd interpolator, so a run that ignored the caller's cubic
// would draw somewhere else and show up.
const testCubic = (v0, v1, v2, v3, t0, t1, t2, t3, u) => v1 + (v2 - v1) * u * u;

const MODES = {
  step: {},
  linear: { smooth: true },
  cubic: { smooth: true, cubic: testCubic },
};

function digest(calls) {
  const json = JSON.stringify(calls, (k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v));
  return crypto.createHash('sha256').update(json).digest('hex');
}

// --- the old page's overlay, pinned before the refactor -------------------------
//
// Diagnostics.overlay() on the mounted old page, over every sample time and the
// midpoints between them, in each motion mode. The digests in
// golden/overlay-digests.json were recorded from phase-0's src/diagnostics.js
// (8a4fcdf), before s4 touched it, on the committed tracks above
// (UPDATE_OVERLAY_DIGESTS=1 node --test tests/app/diagnostics-headless.test.js).
// They prove the shared drawing code still draws exactly what it drew.
const DIGESTS = path.join(__dirname, 'golden', 'overlay-digests.json');

function oldOverlayRecord(slug, mode) {
  const { D } = oldPage(slug, MODES[mode]);
  const { out } = computed(slug);
  const ctx = recordingContext();
  const perTime = [];
  for (const t of sweep(out.samples)) {
    const before = ctx.calls.length;
    D.overlay(ctx, t);
    perTime.push(ctx.calls.slice(before));
  }
  return { ctx, perTime, out };
}

test('the old page draws the same overlay as before s4 (digests from phase-0)', () => {
  const now = {};
  for (const slug of [LATERAL, SNATCH]) {
    now[slug] = {};
    for (const mode of Object.keys(MODES)) {
      const { ctx } = oldOverlayRecord(slug, mode);
      assert.ok(ctx.calls.length > 1000, `${slug} ${mode}: the old overlay drew almost nothing`);
      now[slug][mode] = { calls: ctx.calls.length, sha256: digest(ctx.calls) };
    }
  }
  if (process.env.UPDATE_OVERLAY_DIGESTS) {
    fs.mkdirSync(path.dirname(DIGESTS), { recursive: true });
    fs.writeFileSync(DIGESTS, JSON.stringify(now, null, 1) + '\n');
  }
  assert.deepStrictEqual(now, JSON.parse(fs.readFileSync(DIGESTS, 'utf8')));
});

// --- describe(set) ------------------------------------------------------------
//
// The text the old page shows, as written in src/diagnostics.js at phase-0
// (8a4fcdf). Pinned here so a change to a title, cue, unit or phase label shows
// up as a failing test, not only as a moved mockup.
const CUES = {
  'lateral-raise': [
    { id: 'lateral-raise-top-height', title: 'Top of rep — raise to shoulder height',
      cue: 'At the top of each rep the arms lift to about shoulder height — not swung above it, not stopped short.',
      unit: '%', phaseLabel: null },
    { id: 'lateral-raise-torso-lean', title: 'Torso lean — stay upright through the set',
      cue: 'The trunk stays upright throughout the set: the weight is raised by the arms, not by leaning or swinging the torso.',
      unit: '°', phaseLabel: null },
    { id: 'lateral-raise-elbow-lead', title: 'Elbow lead — elbow tracks at or above the wrist',
      cue: 'Through the raise the elbow stays at or slightly above the wrist — the wrist shouldn\'t flick up and lead the lift.',
      unit: '%', phaseLabel: null },
    { id: 'lateral-raise-tempo', title: 'Tempo — controlled lowering, not dropped',
      cue: 'The weight is lowered under control — the descent isn\'t noticeably faster than the raise.',
      unit: 'x', phaseLabel: null },
    { id: 'lateral-raise-symmetry', title: 'Rep-to-rep symmetry — consistent height across the set',
      cue: 'Every rep in the set reaches about the same height as the first — height dropping as the set goes on is fatigue, not a one-off.',
      unit: '%', phaseLabel: null },
  ],
  'snatch': [
    { id: 'first-pull-back-angle', title: 'First pull — constant back angle',
      cue: 'Through the first pull the back angle to the floor stays constant: the knees open and the bar rises, but the trunk keeps its inclination.',
      unit: '°', phaseLabel: 'first pull' },
    { id: 'second-pull-triple-extension', title: 'Second pull — full triple extension',
      cue: 'At the top of the second pull the hips and knees open fully — "triple extension" — before the arms bend into the turnover.',
      unit: '°', phaseLabel: 'second pull' },
  ],
};

// Every threshold constant in src/diagnostics.js is commented "provisional"
// (SD_GOOD/SD_WARN, EXT_GOOD/EXT_WARN, TOP_*, LEAN_*, ELBOW_*, TEMPO_*, SYM_*),
// and docs/rules-core.md keeps them so until they're checked on real lifts.
test('describe(set) lists the set\'s cues in order, with their text and provisional thresholds', () => {
  const D = loadDiagnostics();
  for (const [set, cues] of Object.entries(CUES)) {
    assert.deepStrictEqual(D.describe(set), cues.map(c => Object.assign({}, c, { provisional: true })), set);
  }
  // the clean's set too, which no fixture covers: every cue provisional
  const clean = D.describe('clean-and-jerk');
  assert.deepStrictEqual(clean.map(c => c.id), ['clean-first-pull-back-angle']);
  assert.equal(clean[0].provisional, true);
  assert.equal(clean[0].phaseLabel, 'first pull');
});

test('describe(set) is plain data, independent of the active page, and refuses an unknown set', () => {
  const D = loadDiagnostics();
  D.setPage('snatch');
  const a = D.describe('lateral-raise');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), a);
  a[0].title = 'changed';
  assert.equal(D.describe('lateral-raise')[0].title, CUES['lateral-raise'][0].title);
  assert.throws(() => D.describe('deadlift'), /deadlift/);
});

test('describe(set) matches the titles the old panel shows', () => {
  for (const slug of [LATERAL, SNATCH]) {
    const { D, el } = oldPage(slug, { sections: true });
    const shown = el.sections.children.map(b => b.children[0].textContent);
    assert.deepStrictEqual(shown, D.describe(setOf(slug)).map(c => c.title), slug);
  }
});

// --- tiles(id, result) and referenceLine(id, result) ---------------------------

function contains(haystack, needles) {
  let at = 0;
  for (const n of needles) {
    const i = haystack.indexOf(n, at);
    if (i < 0) return `missing ${JSON.stringify(n)} after offset ${at}`;
    at = i + n.length;
  }
  return null;
}

test('tiles(id, result) are the tiles the old panel shows for each cue', () => {
  for (const slug of [LATERAL, SNATCH]) {
    const { D, el } = oldPage(slug, { sections: true });
    const { out } = computed(slug);
    const cues = D.describe(setOf(slug));
    cues.forEach((c, k) => {
      const html = el.sections.children[k].children[1].innerHTML;
      const res = out.results[c.id];
      const tiles = D.tiles(c.id, res);
      if (res.error) {
        assert.deepStrictEqual(tiles, [], `${c.id}: a cue that can't be scored has no tiles`);
        assert.equal(html, '');
        return;
      }
      assert.ok(tiles.length > 0, c.id);
      assert.equal(html.split('class="diag-tile"').length - 1, tiles.length, c.id);
      const miss = contains(html, tiles.flatMap(t => ['>' + t.label + '<', '>' + t.value + '<', '>' + (t.sub || '') + '<']));
      assert.equal(miss, null, `${c.id}: ${miss}`);
      // the headline tile carries the verdict
      assert.equal(tiles[0].status, res.verdict.status, c.id);
    });
  }
});

test('referenceLine(id, result) is the line the old chart draws, null when the cue has no plot', () => {
  for (const slug of [LATERAL, SNATCH]) {
    const { D, el } = oldPage(slug, { sections: true });
    const { out } = computed(slug);
    D.describe(setOf(slug)).forEach((c, k) => {
      const res = out.results[c.id];
      const chart = el.sections.children[k].children[2].children[0].getContext('2d');
      const line = D.referenceLine(c.id, res);
      if (res.error) { assert.equal(line, null, c.id); return; }
      assert.ok(line && typeof line.value === 'number' && typeof line.label === 'string', c.id);
      assert.ok(chart.calls.some(call => call[0] === 'fillText' && call[1] === line.label),
        `${c.id}: the old chart never wrote ${JSON.stringify(line.label)}`);
      assert.equal(D.referenceLine(c.id), null, `${c.id}: no result, no line`);
    });
  }
});

test('tiles and referenceLine refuse an unknown cue id', () => {
  const D = loadDiagnostics();
  assert.throws(() => D.tiles('no-such-cue', {}), /no-such-cue/);
  assert.throws(() => D.referenceLine('no-such-cue', {}), /no-such-cue/);
});

// --- drawCue(ctx, id, t, computed) ----------------------------------------------

test('drawCue draws inside each cue\'s phase and nothing outside it, with no panel, DOM or module state', () => {
  for (const slug of [LATERAL, SNATCH]) {
    const { D, out } = computed(slug);
    const cues = D.describe(setOf(slug));
    // A second, never-mounted copy of the module on another lift's set: drawCue
    // reads only what it is handed.
    const fresh = loadDiagnostics();
    fresh.setPage('clean-and-jerk');
    assert.equal(global.document, undefined);
    let drewSome = false;
    for (const c of cues) {
      const res = out.results[c.id];
      const t0 = res.error ? null : out.samples[res.phase.startIdx].t;
      const t1 = res.error ? null : out.samples[res.phase.endIdx].t;
      for (const t of sweep(out.samples)) {
        const ctx = recordingContext();
        const drew = fresh.drawCue(ctx, c.id, t, out);
        const inside = !res.error && t >= t0 && t <= t1;
        assert.equal(drew, inside, `${slug} ${c.id} at ${t}`);
        assert.equal(ctx.calls.length > 0, inside, `${slug} ${c.id} at ${t}: ${ctx.calls.length} calls`);
        drewSome = drewSome || drew;
      }
    }
    assert.ok(drewSome, slug);
  }
});

test('drawCue draws exactly what the old page\'s overlay draws, in every motion mode', () => {
  for (const slug of [LATERAL, SNATCH]) {
    for (const [mode, motion] of Object.entries(MODES)) {
      const { perTime, out } = oldOverlayRecord(slug, mode);
      const D = loadDiagnostics();
      const cues = D.describe(setOf(slug));
      sweep(out.samples).forEach((t, k) => {
        const ctx = recordingContext();
        let row = 0;
        for (const c of cues) {
          if (D.drawCue(ctx, c.id, t, out, Object.assign({ labelRow: row }, motion)) && c.phaseLabel) row++;
        }
        assert.equal(digest(ctx.calls), digest(perTime[k]), `${slug} ${mode} at t=${t}`);
      });
    }
  }
});

test('drawCue can leave the phase label off, and refuses an unknown cue id', () => {
  const { D, out } = computed(SNATCH);
  const res = out.results['first-pull-back-angle'];
  const t = out.samples[res.phase.startIdx].t;
  const withLabel = recordingContext(), without = recordingContext();
  assert.equal(D.drawCue(withLabel, 'first-pull-back-angle', t, out), true);
  assert.equal(D.drawCue(without, 'first-pull-back-angle', t, out, { label: false }), true);
  assert.ok(withLabel.calls.some(c => c[0] === 'fillText' && c[1] === 'first pull'));
  assert.ok(!without.calls.some(c => c[0] === 'fillText'));
  assert.throws(() => D.drawCue(recordingContext(), 'no-such-cue', t, out), /no-such-cue/);
  assert.equal(D.drawCue(recordingContext(), 'first-pull-back-angle', NaN, out), false);
});

// --- worstMoment(id, result) ----------------------------------------------------
//
// The rule each cue uses (reported per cue in s4's report):
//   summary-worst       the series sample whose value the summary names as worst
//   summary-last        the last rep, which the summary's decline is measured to
//   farthest-from-mean  the sample farthest from the mean the verdict's SD is taken around
//   phase-end           the last sample, the top of the pull where the extension is read
const RULES = {
  'lateral-raise-top-height': 'summary-worst',
  'lateral-raise-elbow-lead': 'summary-worst',
  'lateral-raise-tempo': 'summary-worst',
  'lateral-raise-symmetry': 'summary-last',
  'lateral-raise-torso-lean': 'farthest-from-mean',
  'first-pull-back-angle': 'farthest-from-mean',
  'clean-first-pull-back-angle': 'farthest-from-mean',
  'second-pull-triple-extension': 'phase-end',
};

function checkWorst(D, id, res, samples) {
  const w = D.worstMoment(id, res);
  assert.ok(w, id);
  assert.equal(w.rule, RULES[id], id);
  const s = res.series.find(x => x.idx === w.idx);
  assert.ok(s, `${id}: the worst moment is a sample of the cue's series`);
  assert.deepStrictEqual({ t: w.t, frame: w.frame, value: w.value }, { t: s.t, frame: s.frame, value: s.value }, id);
  assert.ok(w.t >= samples[res.phase.startIdx].t && w.t <= samples[res.phase.endIdx].t, `${id}: inside the phase`);
  const vals = res.series.map(x => x.value);
  if (w.rule === 'summary-worst') assert.equal(w.value, res.summary.worst, id);
  if (w.rule === 'summary-last') assert.equal(w.value, res.summary.last, id);
  if (w.rule === 'phase-end') assert.equal(w.idx, res.series[res.series.length - 1].idx, id);
  if (w.rule === 'farthest-from-mean') {
    const far = Math.max(...vals.map(v => Math.abs(v - res.summary.mean)));
    assert.equal(Math.abs(w.value - res.summary.mean), far, id);
  }
  return w;
}

test('worstMoment gives each scored cue the time its verdict rests on, and null when it can\'t score', () => {
  let scored = 0;
  for (const slug of [LATERAL, SNATCH]) {
    const { D, out } = computed(slug);
    for (const c of D.describe(setOf(slug))) {
      const res = out.results[c.id];
      if (res.error) { assert.equal(D.worstMoment(c.id, res), null, c.id); continue; }
      const w = checkWorst(D, c.id, res, out.samples);
      assert.equal(D.drawCue(recordingContext(), c.id, w.t, out), true, `${c.id}: drawn at its worst moment`);
      scored++;
    }
  }
  // lateral-raise-cable-1 has one rep, so its symmetry can't be scored (its golden)
  assert.equal(scored, 6);
  assert.throws(() => loadDiagnostics().worstMoment('no-such-cue', {}), /no-such-cue/);
});

// Symmetry needs two reps or more, which neither fixture has: the synthetic
// eight-rep fatigue set of tests/diagnostics.test.js, its height falling rep by rep.
test('worstMoment of a scored symmetry is the last rep', () => {
  const D = loadDiagnostics();
  D.setPage('lateral-raise');
  const signal = [];
  for (const amplitude of [0.6, 0.54, 0.48, 0.42, 0.36, 0.30, 0.24, 0.18]) {
    const peak = -0.8 + amplitude;
    signal.push(...Array(8).fill(-0.8));
    signal.push(...Array.from({ length: 18 }, (_, i) => -0.8 + amplitude * (i + 1) / 18));
    signal.push(...Array(8).fill(peak));
    signal.push(...Array.from({ length: 18 }, (_, i) => peak - amplitude * (i + 1) / 18));
  }
  signal.push(...Array(8).fill(-0.8));
  const keypoints = {};
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
  const idx = signal.map((_, i) => i);
  const out = D.computeResults(keypoints, { fps: 30, frame_indices: idx, frame_times_ms: idx.map(i => i * 1000 / 30) }, '1');
  const res = out.results['lateral-raise-symmetry'];
  assert.ok(!res.error, res.error);
  assert.equal(res.summary.reps, 8);
  const w = checkWorst(D, 'lateral-raise-symmetry', res, out.samples);
  assert.equal(w.idx, res.series[7].idx);
});

// --- scoringLines(id, computed, {smoothingMs}) and zones(id) --------------------
//
// A2's "How it's scored · provisional" block and the plot's zones (package s39;
// docs/ui-design.md, A2; design/mockups/CueDetail.dc.html). The lines are read
// off the old panel itself (drawPanels' <li> items under the plot), so "what
// the old panel lists" is never retyped here.
const vm = require('node:vm');

const COMMITTED = Object.keys(manifest).filter(slug => manifest[slug].scope === 'global');

// A second copy of diagnostics.js that also hands the test its cue objects, so a
// test can call a cue's own verdict() or plant a bad cue. The shipped file is
// unchanged: the hook is added to the source text here, in memory.
function loadInternals() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'diagnostics.js'), 'utf8');
  const hook = 'window.Diagnostics = Diagnostics;';
  assert.equal(src.split(hook).length, 2, 'diagnostics.js sets window.Diagnostics once');
  const win = {};
  vm.runInNewContext(src.replace(hook, hook + ' window.__internals = { CUE_BY_ID, DIAGNOSTIC_SETS };'), { window: win });
  return { D: win.Diagnostics, cues: win.__internals.CUE_BY_ID, sets: Object.keys(win.__internals.DIAGNOSTIC_SETS) };
}
// Its arrays and objects come from another realm, which deepStrictEqual tells apart.
const plain = v => JSON.parse(JSON.stringify(v));

function computedFor(D, slug, set) {
  D.setPage(set);
  const track = loadTrack(slug);
  return D.computeResults(track.keypoints, track.meta, track.meta.tracks.kept);
}

// The old panel's transparency bullets for the k-th cue of the mounted set.
function panelLines(el, k) {
  const html = el.sections.children[k].children[3].innerHTML;
  return Array.from(html.matchAll(/<li>([\s\S]*?)<\/li>/g), m => m[1]);
}

const MARKUP = /[<>]|&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/;
// Every scored cue has exactly one "Time smoothing" line (s42: the tempo and the
// symmetry had none before): the σ when smoothing is on, "off — …" when it is off.
function assertSmoothingLine(lines, smoothingMs, where) {
  const smoothing = lines.filter(l => l.label === 'Time smoothing');
  assert.equal(smoothing.length, 1, where);
  if (smoothingMs) assert.match(smoothing[0].text, new RegExp(`σ = ${smoothingMs} ms`), where);
  else assert.match(smoothing[0].text, /^off — /, where);
}

test('scoringLines gives each cue\'s transparency lines as plain text that joins back to the old panel\'s, on every committed fixture and set', () => {
  const { cues, sets } = loadInternals();
  const scoredIds = new Set();
  for (const smoothingMs of [0, 50]) {
    for (const slug of COMMITTED) {
      for (const set of sets) {
        const { el } = oldPage(slug, { sections: true, set, smoothingMs });
        const D = loadDiagnostics();   // never mounted
        const out = computedFor(D, slug, set);
        D.describe(set).forEach((c, k) => {
          const where = `${slug} ${set} ${c.id} σ ${smoothingMs}`;
          const lines = D.scoringLines(c.id, out, { smoothingMs });
          if (out.results[c.id].error) {
            assert.deepStrictEqual(lines, [], `${where}: a cue that can't be scored has no lines`);
            return;
          }
          scoredIds.add(c.id);
          assert.ok(lines.length > 0, where);
          for (const line of lines) {
            assert.deepStrictEqual(Object.keys(line), ['label', 'text'], where);
            assert.ok(line.label && !MARKUP.test(line.label), `${where}: label ${JSON.stringify(line.label)}`);
            assert.ok(!MARKUP.test(line.text), `${where}: markup left in ${JSON.stringify(line.text)}`);
          }
          assert.deepStrictEqual(lines.map(l => `<strong>${l.label}</strong> — ${l.text}`), panelLines(el, k), where);
          assertSmoothingLine(lines, smoothingMs, where);
        });
      }
    }
  }
  // every cue of every set has been checked on a scored result, the symmetry
  // aside: it needs two reps, which no committed fixture has (the next test)
  assert.deepStrictEqual([...cues.keys()].filter(id => !scoredIds.has(id)), ['lateral-raise-symmetry']);
});

// The symmetry's lines on the eight-rep fatigue set above, against the panel's
// own transparencyLines called directly.
test('scoringLines gives a scored symmetry\'s lines too', () => {
  const { D, cues } = loadInternals();
  D.setPage('lateral-raise');
  const signal = [];
  for (const amplitude of [0.6, 0.54, 0.48, 0.42, 0.36, 0.30, 0.24, 0.18]) {
    const peak = -0.8 + amplitude;
    signal.push(...Array(8).fill(-0.8));
    signal.push(...Array.from({ length: 18 }, (_, i) => -0.8 + amplitude * (i + 1) / 18));
    signal.push(...Array(8).fill(peak));
    signal.push(...Array.from({ length: 18 }, (_, i) => peak - amplitude * (i + 1) / 18));
  }
  signal.push(...Array(8).fill(-0.8));
  const keypoints = {};
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
  const idx = signal.map((_, i) => i);
  const out = D.computeResults(keypoints, { fps: 30, frame_indices: idx, frame_times_ms: idx.map(i => i * 1000 / 30) }, '1');
  const id = 'lateral-raise-symmetry';
  assert.ok(!out.results[id].error, out.results[id].error);
  for (const smoothingMs of [0, 50]) {
    assertSmoothingLine(D.scoringLines(id, out, { smoothingMs }), smoothingMs, `symmetry σ ${smoothingMs}`);
  }
  const lines = D.scoringLines(id, out, { smoothingMs: 50 });
  const html = cues.get(id).transparencyLines(out.results[id], out.samples, { smoothingMs: 50, scale: out.scale, axis: out.axis });
  assert.ok(lines.length > 0 && lines.every(l => !MARKUP.test(l.label) && !MARKUP.test(l.text)));
  assert.deepStrictEqual(plain(lines.map(l => `<strong>${l.label}</strong> — ${l.text}`)), plain(html));
});

test('scoringLines: [] for a cue that can\'t be scored, the smoothing required, an unknown id throws, no mount needed', () => {
  const { out } = computed(LATERAL);
  const fresh = loadDiagnostics();
  fresh.setPage('clean-and-jerk');
  assert.equal(global.document, undefined);
  // lateral-raise-cable-1 has one rep: its symmetry can't be scored (its golden)
  assert.ok(out.results['lateral-raise-symmetry'].error);
  assert.deepStrictEqual(fresh.scoringLines('lateral-raise-symmetry', out, { smoothingMs: 0 }), []);
  // a cue the computed output didn't score at all (another set's)
  assert.deepStrictEqual(fresh.scoringLines('first-pull-back-angle', out, { smoothingMs: 0 }), []);
  assert.ok(fresh.scoringLines('lateral-raise-elbow-lead', out, { smoothingMs: 0 }).length > 0);
  // without the smoothing it was scored with, the "Time smoothing" line would guess
  for (const opts of [undefined, {}, { smoothingMs: -1 }, { smoothingMs: '50' }, { smoothingMs: NaN }]) {
    assert.throws(() => fresh.scoringLines('lateral-raise-elbow-lead', out, opts), /smoothingMs/, JSON.stringify(opts));
  }
  assert.throws(() => fresh.scoringLines('no-such-cue', out, { smoothingMs: 0 }), /no-such-cue/);
});

test('scoringLines fails loudly on a line with markup besides its label', () => {
  const { D, cues } = loadInternals();
  const out = computedFor(D, LATERAL, 'lateral-raise');
  const tempo = cues.get('lateral-raise-tempo');
  const real = tempo.transparencyLines;
  assert.ok(D.scoringLines(tempo.id, out, { smoothingMs: 0 }).length > 0);
  for (const bad of [
    '<strong>Phase</strong> — 3 rep(s), <em>frames</em> 1–9.',
    '<strong>Phase</strong> — frames 1&ndash;9.',
    'Phase — no label of its own.',
    '<strong>Ph<em>a</em>se</strong> — a tag inside the label.',
    '<b>Phase</b> — another tag for the label.',
  ]) {
    tempo.transparencyLines = (...args) => real.apply(tempo, args).concat([bad]);
    assert.throws(() => D.scoringLines(tempo.id, out, { smoothingMs: 0 }), /lateral-raise-tempo/, bad);
  }
});

test('zones(id) are each cue\'s verdict bands on its series\' scale, or null where the series doesn\'t plot the verdict\'s value', async () => {
  const { VERDICT_STATUS, STATUS_WORDS } = await import('../../app/src/contracts/cue-view.mjs');
  const { D: inner, cues } = loadInternals();
  const D = loadDiagnostics();
  D.setPage('snatch');
  assert.equal(global.document, undefined);
  let banded = 0;
  for (const [id, d] of cues) {
    assert.ok(RULES[id], `${id}: every cue has its worst-moment rule in RULES`);
    const zones = D.zones(id);
    assert.deepStrictEqual(plain(inner.zones(id)), zones, id);
    if (RULES[id] !== 'summary-worst') { assert.equal(zones, null, `${id}: scored on ${RULES[id]}, not a series value`); continue; }
    assert.ok(Array.isArray(zones) && zones.length >= 3, id);
    banded++;
    zones.forEach((z, i) => {
      assert.deepStrictEqual(Object.keys(z), ['status', 'from', 'to'], id);
      assert.ok(STATUS_WORDS.includes(z.status) && z.status !== "can't score", `${id}: ${z.status}`);
      assert.equal(z.from === null, i === 0, `${id}: only the lowest band is open below`);
      assert.equal(z.to === null, i === zones.length - 1, `${id}: only the highest band is open above`);
      if (z.from !== null && z.to !== null) assert.ok(z.from < z.to, id);
      if (i) assert.equal(z.from, zones[i - 1].to, `${id}: the bands meet`);
      // the cue's own verdict(), on a summary whose verdict value sits in this
      // band: its middle and just inside each edge (VERDICT_VALUE: summary.worst,
      // and its size, worstAbs, for the top height)
      const span = (z.from !== null && z.to !== null) ? z.to - z.from : 1;
      const eps = 1e-6 * span;
      const at = [];
      if (z.from !== null) at.push(z.from + eps);
      if (z.to !== null) at.push(z.to - eps);
      if (z.from !== null && z.to !== null) at.push((z.from + z.to) / 2);
      if (z.from === null) at.push(z.to - Math.max(1, Math.abs(z.to)));
      if (z.to === null) at.push(z.from + Math.max(1, Math.abs(z.from)));
      for (const v of at) {
        const verdict = d.verdict({ worst: v, worstAbs: Math.abs(v) });
        assert.equal(VERDICT_STATUS[verdict.status], z.status, `${id}: verdict at ${v} is ${verdict.status}, the band says ${z.status}`);
      }
    });
  }
  assert.equal(banded, 3);
  // The top height's verdict reads the worst rep's size (worstAbs): the bands are
  // mirrored about shoulder height, as its verdict treats too high and too low alike.
  const top = D.zones('lateral-raise-top-height');
  assert.deepStrictEqual(top.map(z => z.status), [...top].reverse().map(z => z.status));
  top.forEach((z, i) => {
    const m = top[top.length - 1 - i];
    assert.deepStrictEqual([z.from, z.to], [m.to === null ? null : -m.to, m.from === null ? null : -m.from]);
  });
  // design/mockups/CueDetail.dc.html: good from +5 %, watch between +5 % and −5 %, work on below −5 %
  assert.deepStrictEqual(D.zones('lateral-raise-elbow-lead'), [
    { status: 'work on', from: null, to: -5 },
    { status: 'watch', from: -5, to: 5 },
    { status: 'good', from: 5, to: null },
  ]);
  // plain data, a fresh copy each call
  const a = D.zones('lateral-raise-tempo');
  a[0].to = 99;
  assert.notEqual(D.zones('lateral-raise-tempo')[0].to, 99);
});

test('zones: an unknown id throws, and so does a cue that declares none', () => {
  const D = loadDiagnostics();
  assert.throws(() => D.zones('no-such-cue'), /no-such-cue/);
  const { D: inner, cues } = loadInternals();
  delete cues.get('lateral-raise-tempo').zones;
  assert.throws(() => inner.zones('lateral-raise-tempo'), /lateral-raise-tempo/);
});

// --- rule(id): the unit's noun, what decides the verdict, its bands (s45) --------
//
// A1's rule line and A2's "How it's scored" (design/mockups/Result.dc.html,
// design/mockups/CueDetail.dc.html: "…15% of torso length", "The lowest margin
// in the rep decides", "watch between +5% and −5%") need words the screens may
// not type (contract 4). Every cue of every set gives them, next to its own
// threshold constants; the bands are checked against the cue's own verdict(),
// never retyped here.

// The words a cue's rule names its worst-moment rule with (RULES above).
const RULE_WORDS = {
  'summary-worst': /\b(lowest|highest|fastest|farthest|worst)\b/,
  'summary-last': /\blast\b/,
  'farthest-from-mean': /\(SD\)/,
  'phase-end': /\blast\b/,
};
const UNIT_SYMBOL = { '%': '%', '°': '°', x: '×' };

test('rule(id) gives every cue of every set its unit noun, one sentence on what decides the verdict and its good, watch and work-on bands', async () => {
  const { VERDICT_STATUS } = await import('../../app/src/contracts/cue-view.mjs');
  const { D: inner, cues, sets } = loadInternals();
  const D = loadDiagnostics();
  assert.equal(typeof D.rule, 'function', 'the headless API has rule(id)');
  let n = 0;
  for (const set of sets) {
    for (const c of D.describe(set)) {
      const id = c.id, d = cues.get(id);
      const r = D.rule(id);
      n++;
      assert.deepStrictEqual(Object.keys(r), ['noun', 'basis', 'bands'], id);
      assert.deepStrictEqual(plain(inner.rule(id)), r, id);
      // the noun follows a number: it starts with the cue's unit and holds no number of its own
      assert.equal(typeof r.noun, 'string', id);
      assert.ok(r.noun.startsWith(UNIT_SYMBOL[c.unit]), `${id}: "${r.noun}" starts with the unit ${c.unit}`);
      assert.ok(r.noun.length > UNIT_SYMBOL[c.unit].length, `${id}: a noun, not the bare unit`);
      // one sentence, plain text, no number typed in it, naming the cue's worst-moment rule
      assert.match(r.basis, /^[A-Z][^.]*\bdecides\b[^.]*\.$/, `${id}: one sentence that says what decides`);
      for (const s of [r.noun, r.basis]) {
        assert.ok(!MARKUP.test(s), `${id}: no markup in ${JSON.stringify(s)}`);
        assert.ok(!/\d/.test(s), `${id}: no number typed in ${JSON.stringify(s)}`);
      }
      assert.match(r.basis, RULE_WORDS[d.worstRule], `${id}: the sentence matches its rule ${d.worstRule}`);
      // the bands: zones(id) where the plot shows the verdict's value, else the bands of the value it reads
      const zones = D.zones(id);
      if (zones) assert.deepStrictEqual(r.bands, zones, `${id}: the plot's zones`);
      const statuses = r.bands.map(b => b.status);
      for (const s of ['good', 'watch', 'work on']) assert.ok(statuses.includes(s), `${id}: names its ${s} band`);
      r.bands.forEach((b, i) => {
        assert.deepStrictEqual(Object.keys(b), ['status', 'from', 'to'], id);
        assert.equal(b.from === null, i === 0, `${id}: only the lowest band is open below`);
        assert.equal(b.to === null, i === r.bands.length - 1, `${id}: only the highest band is open above`);
        if (i) assert.equal(b.from, r.bands[i - 1].to, `${id}: the bands meet`);
        // the cue's own verdict() on a value in this band, whichever summary field it reads
        const eps = 1e-6;
        const at = [];
        if (b.from !== null) at.push(b.from + eps);
        if (b.to !== null) at.push(b.to - eps);
        if (b.from === null) at.push(b.to - Math.max(1, Math.abs(b.to)));
        if (b.to === null) at.push(b.from + Math.max(1, Math.abs(b.from)));
        for (const v of at) {
          const verdict = d.verdict({ worst: v, worstAbs: Math.abs(v), sd: v, decline: v, hipDeficit: v, kneeDeficit: v });
          assert.equal(VERDICT_STATUS[verdict.status], b.status, `${id}: verdict at ${v} is ${verdict.status}, the band says ${b.status}`);
        }
      });
    }
  }
  assert.ok(n >= 8, 'every cue of every set');
  // plain data, a fresh copy each call
  const a = D.rule('lateral-raise-torso-lean');
  a.bands[0].to = 99;
  a.noun = 'changed';
  assert.notEqual(D.rule('lateral-raise-torso-lean').bands[0].to, 99);
  assert.notEqual(D.rule('lateral-raise-torso-lean').noun, 'changed');
});

test('rule(id): the mockups\' unit nouns and bands for the lateral raise', () => {
  const D = loadDiagnostics();
  // design/mockups/Result.dc.html: "…15% of torso length of shoulder height", "3° of sway (SD)", "1.5× faster down than up"
  assert.equal(D.rule('lateral-raise-top-height').noun, '% of torso length of shoulder height');
  assert.equal(D.rule('lateral-raise-torso-lean').noun, '° of sway (SD)');
  assert.equal(D.rule('lateral-raise-tempo').noun, '× faster down than up');
  assert.equal(D.rule('lateral-raise-elbow-lead').noun, '% of torso length');
  // the same mockup: good up to 3°, work on beyond 7° for the lean, whose zones are null
  assert.equal(D.zones('lateral-raise-torso-lean'), null);
  assert.deepStrictEqual(D.rule('lateral-raise-torso-lean').bands, [
    { status: 'good', from: null, to: 3 },
    { status: 'watch', from: 3, to: 7 },
    { status: 'work on', from: 7, to: null },
  ]);
});

test('rule: an unknown id throws, and so does a cue without its noun, its sentence or its bands', () => {
  const D = loadDiagnostics();
  assert.throws(() => D.rule('no-such-cue'), /no-such-cue/);
  for (const [id, field] of [['lateral-raise-tempo', 'unitNoun'], ['lateral-raise-tempo', 'verdictBasis'], ['lateral-raise-torso-lean', 'bands']]) {
    const { D: inner, cues } = loadInternals();
    delete cues.get(id)[field];
    assert.throws(() => inner.rule(id), new RegExp(id), `${id} without ${field}`);
  }
  // zones and bands both: two sources for one threshold
  const { D: inner, cues } = loadInternals();
  cues.get('lateral-raise-tempo').bands = cues.get('lateral-raise-tempo').zones;
  assert.throws(() => inner.rule('lateral-raise-tempo'), /lateral-raise-tempo/);
});
