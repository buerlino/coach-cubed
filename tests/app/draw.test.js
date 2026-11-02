'use strict';
// The skeleton overlay (package d16, plan step 5.5): app/src/draw/, pinned to the old page.
// The old page's own code is taken out of src/app.py's INDEX_HTML as it is
// (tests/loadOldCode.js) and run on the same tracks and times as the port: the pose at a
// playhead time (poseAtTime and the cubic under it), which bones and joints drawOverlay
// draws and the confidence gate it applies, a missing or unsure joint, and the lift
// window's markers (liftMarkHtml). Each case runs on the old code and on the new module.
//
// What differs on purpose, and is tested as such: the look (the mockup's accent bones and ringed
// joints from the tokens, not the old page's white 2 px), a null joint (the old joint loop
// throws on it; the port skips it) and the timeline (the mockup's plain bar; the old sliders
// offset the marks by the thumb's width). Where the cue drawings are concerned, s4's
// tests/app/diagnostics-headless.test.js pins drawCue to the old overlay; here drawCues is held to
// drawCue with the old page's interpolator.
//
// Expected values come from the old code, run, never typed in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { loadDiagnostics } = require('../loadDiagnostics');
const { loadManifests, trackPathFor, diagnosticsSet } = require('../fixtures');
const { oldPage } = require('../loadOldCode');

const APP = path.resolve(__dirname, '..', '..', 'app');
const load = rel => import(pathToFileURL(path.join(APP, 'src', rel)).href);
const draw = () => load('draw/index.mjs');
const smoothing = () => load('track/smoothing.mjs');

const LATERAL = 'global/example/lateral-raise-cable-1';
const SNATCH = 'global/snatch/Session14_01_0h18m07s_made';
const manifest = loadManifests();
const loadTrack = slug => JSON.parse(fs.readFileSync(trackPathFor(slug), 'utf8'));

// ---- the old page, with the globals its drawOverlay reads ----

const OLD = oldPage(['CONF_THRESHOLD', 'SKELETON', 'sampleTimes', 'monoTangent', 'cubicAt', 'slotForTime',
  'poseAtTime', 'drawOverlay', 'SCRUB_THUMB', 'markLeft', 'markWidth', 'liftMarkHtml']);

// Records every call and property set on a 2D context.
function recordingContext(width = 1080, height = 1920) {
  const calls = [];
  const props = {};
  const canvas = { width, height };
  return new Proxy({}, {
    get(_, k) {
      if (k === 'canvas') return canvas;
      if (k === 'calls') return calls;
      if (typeof k === 'symbol' || k === 'then') return undefined;
      if (Object.prototype.hasOwnProperty.call(props, k)) return props[k];
      return (...args) => { calls.push([k, ...args]); };
    },
    set(_, k, v) { props[k] = v; return true; },
  });
}

// The old page's state for one track, then drawOverlay(t) on a recording context: what it draws.
// Diagnostics, the plot, the sliders, the readouts and the 3D view are stubbed away.
function oldDraws(keypoints, meta, t, { interpolate = true } = {}) {
  const ctx = recordingContext(meta.width || 1080, meta.height || 1920);
  const el = () => new Proxy({ style: {}, checked: true }, { get: (o, k) => (k in o ? o[k] : ''), set: (o, k, v) => { o[k] = v; return true; } });
  Object.assign(globalThis, {
    vctx: ctx, vcanvas: ctx.canvas, vKeypoints: keypoints, vMeta: meta, vSample: OLD.sampleTimes(meta, keypoints),
    vInterp: interpolate, vSigmaMs: 0, vKeepVel: true, vLoopRestarts: 0, vvideo: { currentTime: t },
    $: el, renderLiftMarks() {}, drawPlot() {}, syncScrubs() {},
    Diagnostics: { draw() {}, overlay() {} }, window: { CoachAnatomy: null, Viewer: null },
  });
  OLD.drawOverlay(t);
  return ctx.calls;
}
// Only the geometry of a call list: where the bones run and the joints sit.
const geometry = calls => calls.filter(c => ['moveTo', 'lineTo', 'arc'].includes(c[0]))
  .map(c => (c[0] === 'arc' ? ['arc', c[1], c[2]] : c));

function sweep(times, extra = []) {
  const ts = [times[0] - 0.4, ...extra];
  times.forEach((t, i) => { ts.push(t); if (times[i + 1] !== undefined) ts.push(t + (times[i + 1] - t) * 0.31, (t + times[i + 1]) / 2, t + (times[i + 1] - t) * 0.9); });
  ts.push(times[times.length - 1] + 0.4);
  return ts;
}

// A track that walks into every branch: uneven decoder times, a frame with nobody, a person in
// only one of two frames, unsure joints (below the gate and exactly on it), a joint confident in
// one frame only and a neighbour that is unsure.
function oddTrack({ nulls = false } = {}) {
  const frames = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18];
  const keypoints = {};
  frames.forEach((f, s) => {
    if (s === 4) { keypoints[String(f)] = {}; return; }
    const person = k => Array.from({ length: 17 }, (_, i) => {
      if (nulls && i === 3 && s % 3 === 1) return null;
      let conf = 0.6 + 0.02 * i;
      if (i === 9 && s % 2 === 0) conf = 0.29999;
      if (i === 10 && s === 3) conf = 0.3;   // exactly the gate: drawn
      if (i === 5 && s === 5) conf = 0.1;
      if (i === 11 && s === 6) conf = 0.05;  // an unsure outer neighbour
      return [300 + 40 * Math.sin(s / 2 + i) + k, 400 + 25 * Math.cos(s / 3 - i) + 3 * (s % 2), conf];
    });
    keypoints[String(f)] = s >= 6 ? { 7: person(0), 3: person(60) } : { 7: person(0) };
  });
  const times = frames.map((f, s) => f * 1000 / 60 + (s % 3) * 4);
  const meta = {
    fps: 60, width: 1080, height: 1920, frame_stride: 2, frame_indices: frames, frame_times_ms: times,
    skeleton: [[15, 13], [13, 11], [16, 14], [14, 12], [11, 12], [5, 11], [6, 12], [5, 6], [5, 7], [6, 8], [7, 9], [8, 10], [1, 2], [0, 1], [0, 2], [1, 3], [2, 4], [0, 5], [0, 6]],
    tracks: { kept: '7', kept_frames: 8, dropped: [] },
  };
  return { keypoints, meta };
}

async function cases() {
  const { smoothKeypoints } = await smoothing();
  const lat = loadTrack(LATERAL);
  const smoothed = smoothKeypoints(lat.keypoints, lat.meta, 0.05, true);
  return [
    ['lateral raise, raw', lat.keypoints, lat.meta],
    ['lateral raise, smoothed 50 ms', smoothed, lat.meta],
    ['odd track', oddTrack().keypoints, oddTrack().meta],
  ];
}

// ---- the ported maths ----

test('draw: cubicAt, monoTangent and slotForTime are the old page\'s, on a grid including the degenerate ends', async () => {
  const D = await draw();
  const vs = [0, 3, -2.5, 10, 10.0000001];
  const ts = [0, 0.04, 0.05, 0.1, 0.1 + 1e-12, 0.3];
  for (const v0 of [null, ...vs]) for (const v1 of vs) for (const v2 of vs) for (const v3 of [null, ...vs]) {
    for (const u of [0, 0.25, 0.5, 1]) {
      for (const [t0, t1, t2, t3] of [[-0.04, 0, 0.04, 0.08], [-0.1, 0, 0.04, 0.3], [0, 0, 0, 0], [0, 0.04, 0.04, 0.1]]) {
        assert.equal(D.cubicAt(v0, v1, v2, v3, t0, t1, t2, t3, u), OLD.cubicAt(v0, v1, v2, v3, t0, t1, t2, t3, u));
      }
    }
  }
  for (const [a, b, c, d] of [[1, 2, 3, 4], [1, 2, -3, 4], [0, 1, 1, 1], [-5, 2, -1, 3], [1, 1, 1, 1e-12]]) {
    assert.equal(D.monoTangent(a, b, c, d), OLD.monoTangent(a, b, c, d));
  }
  const times = [0, 0.04, 0.09, 0.2, 0.21];
  for (const t of ts.concat(times, [-1, 5, 0.205])) {
    global.vSample = { times };
    assert.equal(D.slotForTime(times, t), OLD.slotForTime(t));
  }
});

test('draw: poseAtTime gives the old page\'s pose at every playhead time, interpolated and not', async () => {
  const D = await draw();
  for (const [name, keypoints, meta] of await cases()) {
    const sample = OLD.sampleTimes(meta, keypoints);
    const track = D.trackSamples(keypoints, meta);
    assert.deepStrictEqual({ frames: track.frames, times: track.times }, sample, name);
    for (const interpolate of [true, false]) {
      Object.assign(globalThis, { vKeypoints: keypoints, vMeta: meta, vSample: sample, vInterp: interpolate });
      for (const t of sweep(sample.times)) {
        assert.deepStrictEqual(D.poseAtTime(track, t, { smooth: interpolate }), OLD.poseAtTime(t, OLD.slotForTime(t)), `${name} t=${t} interpolate=${interpolate}`);
      }
    }
  }
});

test('draw: the pose is interpolated by default, and a track with no samples has no pose', async () => {
  const D = await draw();
  const { keypoints, meta } = oddTrack();
  const track = D.trackSamples(keypoints, meta);
  const mid = (track.times[0] + track.times[1]) / 2;
  assert.deepStrictEqual(D.poseAtTime(track, mid), D.poseAtTime(track, mid, { smooth: true }));
  assert.notDeepStrictEqual(D.poseAtTime(track, mid), D.poseAtTime(track, mid, { smooth: false }));
  assert.equal(D.poseAtTime(D.trackSamples({}, { fps: 30, frame_indices: [] }), 1), null);
});

test('draw: interpolation never invents a peak: the curve stays inside the samples it is built from', async () => {
  const D = await draw();
  // a rep's top: y rises to 100 and falls back; an unclamped spline would overshoot it
  const ys = [200, 150, 100, 100.5, 150, 200];
  const keypoints = {}, meta = { fps: 30, frame_indices: ys.map((_, i) => i), frame_times_ms: ys.map((_, i) => i * 1000 / 30) };
  ys.forEach((y, i) => { keypoints[String(i)] = { 0: Array.from({ length: 17 }, () => [y, 50, 0.9]) }; });
  const track = D.trackSamples(keypoints, meta);
  for (let t = 0; t <= 5 / 30; t += 0.001) {
    const y = D.poseAtTime(track, t)['0'][0][0];
    assert.ok(y >= 100 - 1e-9 && y <= 200 + 1e-9, `t=${t}: y=${y}`);
  }
});

// ---- the skeleton: which bones, the gate, a joint that is unsure or missing ----

test('draw: the bones and joints drawn are the old drawOverlay\'s, at every playhead time (the gate, unsure joints, two people)', async () => {
  const D = await draw();
  const style = D.overlayStyle(() => '1px');
  let drawn = 0;
  for (const [name, keypoints, meta] of await cases()) {
    const track = D.trackSamples(keypoints, meta);
    for (const t of sweep(track.times)) {
      const want = geometry(oldDraws(keypoints, meta, t));
      drawn += want.length;
      const ctx = recordingContext();
      D.drawSkeleton(ctx, D.poseAtTime(track, t), D.bonesOf(meta), style);
      assert.deepStrictEqual(geometry(ctx.calls), want, `${name} t=${t}`);
    }
  }
  assert.ok(drawn > 1000, 'the old page draws plenty on these tracks: the comparison is not empty');
});

test('draw: the confidence gate is 0.3 and keeps a joint exactly on it; a bone needs both ends sure', async () => {
  const D = await draw();
  assert.equal(D.CONF_THRESHOLD, OLD.CONF_THRESHOLD);
  const pts = Array.from({ length: 17 }, (_, i) => [10 * i, 20 * i, 0.9]);
  pts[9] = [1, 2, 0.3];            // on the gate: shown
  pts[10] = [3, 4, 0.29999];       // under it: hidden
  const shapes = D.skeletonShapes(pts, D.bonesOf(null));
  assert.ok(shapes.joints.some(([x, y]) => x === 2 && y === 1), 'a joint at the gate is drawn');
  assert.ok(!shapes.joints.some(([x, y]) => x === 4 && y === 3), 'a joint under it is not');
  assert.equal(shapes.joints.length, 16);
  assert.ok(shapes.bones.every(b => !(b[0] === 4 && b[1] === 3) && !(b[2] === 4 && b[3] === 3)), 'no bone ends in it');
  assert.ok(shapes.bones.some(b => b[0] === 2 || b[2] === 2), 'bones to the joint at the gate are drawn');
  assert.equal(shapes.bones.length, D.bonesOf(null).length - 1, 'one bone ends in the unsure wrist (r_elbow to r_wrist), none are lost at the gate');
});

test('draw: a missing (null) joint shows as nothing, with no bone to it, where the old page\'s joint loop would throw', async () => {
  const D = await draw();
  const { keypoints, meta } = oddTrack({ nulls: true });
  const track = D.trackSamples(keypoints, meta);
  let sawNull = false;
  for (const t of sweep(track.times)) {
    const pose = D.poseAtTime(track, t, { smooth: false });
    if (pose && Object.values(pose).some(p => p.some(j => j === null))) sawNull = true;
    const ctx = recordingContext();
    D.drawSkeleton(ctx, D.poseAtTime(track, t), D.bonesOf(meta), D.overlayStyle(() => '1px'));
    for (const p of Object.values(D.poseAtTime(track, t) || {})) {
      const s = D.skeletonShapes(p, D.bonesOf(meta));
      assert.ok(s.joints.length <= p.filter(j => j && j[2] >= 0.3).length);
    }
  }
  assert.ok(sawNull, 'the track has a null joint in some frame');
  // the old page: bones skip a null end (!pa), but the joint loop reads p[2] of null
  assert.throws(() => oldDraws(keypoints, meta, track.times[1]), TypeError);
});

test('draw: bones come from the track\'s own skeleton, else COCO-17\'s', async () => {
  const D = await draw();
  const { COCO17_SKELETON } = await load('contracts/track.mjs');
  assert.deepStrictEqual(D.bonesOf(null), COCO17_SKELETON);
  assert.deepStrictEqual(D.bonesOf({ skeleton: [] }), COCO17_SKELETON);
  assert.deepStrictEqual(D.bonesOf({ skeleton: [[0, 1]] }), [[0, 1]]);
  const lat = loadTrack(LATERAL);
  assert.deepStrictEqual(D.bonesOf(lat.meta), lat.meta.skeleton);
  assert.equal(lat.meta.skeleton.length, 19);
});

test('draw: the look is read from the tokens, scaled to the frame\'s pixels', async () => {
  const D = await draw();
  const asked = [];
  const tokens = { '--accent-bone': ' rgba(1, 2, 3, 0.5) ', '--bone-width': '3px', '--text': '#111111', '--joint-size': '7px', '--ground': '#222222', '--joint-ring': '1.5px' };
  const style = D.overlayStyle(n => { asked.push(n); return tokens[n]; }, 4);
  assert.deepStrictEqual(style, { bone: 'rgba(1, 2, 3, 0.5)', boneWidth: 12, joint: '#111111', jointRadius: 14, ring: '#222222', ringWidth: 6 });
  assert.deepStrictEqual([...new Set(asked)].sort(), Object.keys(tokens).sort());
  const css = fs.readFileSync(path.join(APP, 'src', 'styles', 'tokens.css'), 'utf8');
  for (const name of Object.keys(tokens)) assert.match(css, new RegExp(`${name}:`), `${name} is a token`);
  const ctx = recordingContext();
  const { keypoints, meta } = oddTrack();
  D.drawSkeleton(ctx, keypoints['0'], D.bonesOf(meta), style);
  assert.ok(ctx.calls.some(c => c[0] === 'arc' && c[3] === 14), 'the joint\'s radius is the token\'s, scaled');
});

// ---- the cue drawings ----

test('draw: each cue is drawn through drawCue with smooth: true and the ported cubic, stacking the labels', async () => {
  const D = await draw();
  const calls = [];
  const Diagnostics = { drawCue(ctx, id, t, computed, opts) { calls.push({ id, t, computed, opts }); return id !== 'b'; } };
  const view = { cues: [
    { id: 'a', status: 'good', phaseLabel: 'pull' }, { id: 'b', status: 'watch', phaseLabel: 'second' },
    { id: 'c', status: "can't score", phaseLabel: 'third' }, { id: 'd', status: 'work on', phaseLabel: null }, { id: 'e', status: 'good', phaseLabel: 'last' }] };
  const computed = { samples: [] };
  const drawn = D.drawCues({}, Diagnostics, view, computed, 1.5);
  assert.deepStrictEqual(drawn, ['a', 'd', 'e']);
  assert.deepStrictEqual(calls.map(c => c.id), ['a', 'b', 'd', 'e'], 'a cue that can\'t be scored is not asked');
  for (const c of calls) {
    assert.equal(c.opts.smooth, true);
    assert.equal(c.opts.cubic, D.cubicAt);
    assert.equal(c.computed, computed);
    assert.equal(c.t, 1.5);
  }
  assert.deepStrictEqual(calls.map(c => c.opts.labelRow), [0, 1, 1, 1], 'a row is taken only by a cue that drew a label');
  assert.deepStrictEqual(D.drawCues({}, Diagnostics, view, computed, 1.5, { ids: ['e'] }), ['e']);
});

test('draw: drawCues on the real engine draws what drawCue draws with the old page\'s cubic, at every time', async () => {
  const D = await draw();
  for (const slug of [LATERAL, SNATCH]) {
    const Diag = loadDiagnostics();
    Diag.setPage(manifest[slug].diagnostics);
    const track = loadTrack(slug);
    const out = Diag.computeResults(track.keypoints, track.meta, track.meta.tracks.kept);
    const cues = Diag.describe(manifest[slug].diagnostics).map(c => ({ id: c.id, status: out.results[c.id].error ? "can't score" : 'good', phaseLabel: c.phaseLabel }));
    let drawnSomething = 0;
    for (const t of sweep(out.samples.map(s => s.t))) {
      const want = recordingContext(), got = recordingContext();
      let row = 0;
      for (const c of cues) {
        if (c.status === "can't score") continue;
        if (Diag.drawCue(want, c.id, t, out, { smooth: true, cubic: OLD.cubicAt, labelRow: row }) && c.phaseLabel) row++;
      }
      D.drawCues(got, Diag, { cues }, out, t);
      assert.deepStrictEqual(got.calls, want.calls, `${slug} t=${t}`);
      if (want.calls.length) drawnSomething++;
    }
    assert.ok(drawnSomething > 0, `${slug}: some cue is drawn somewhere`);
  }
});

test('draw: paintOverlay clears, then paints the skeleton and the cues; each can be switched off', async () => {
  const D = await draw();
  const { keypoints, meta } = oddTrack();
  const track = D.trackSamples(keypoints, meta);
  const Diagnostics = { drawCue: () => true };
  const scene = { track, meta, Diagnostics, view: { cues: [{ id: 'x', status: 'good', phaseLabel: null }] }, computed: {} };
  const style = D.overlayStyle(() => '1px');
  const t = track.times[2];
  const all = recordingContext();
  const r = D.paintOverlay(all, scene, t, { skeleton: true, cues: true, style });
  assert.deepStrictEqual(all.calls[0], ['clearRect', 0, 0, 1080, 1920]);
  assert.deepStrictEqual(r.cues, ['x']);
  assert.ok(r.pose && all.calls.some(c => c[0] === 'arc'));
  const noSkel = recordingContext();
  const r2 = D.paintOverlay(noSkel, scene, t, { skeleton: false, cues: true, style });
  assert.deepStrictEqual(noSkel.calls, [['clearRect', 0, 0, 1080, 1920]]);
  assert.deepStrictEqual(r2.cues, ['x']);
  const noCues = recordingContext();
  assert.deepStrictEqual(D.paintOverlay(noCues, scene, t, { skeleton: true, cues: false, style }).cues, []);
  assert.deepStrictEqual(noCues.calls.filter(c => c[0] === 'arc').length, all.calls.filter(c => c[0] === 'arc').length);
});

// ---- the lift window's markers ----

// Every percentage in the old markup, in order: `calc(7.0px + P% - ...)`.
const percents = html => [...html.matchAll(/calc\([^)]*?([\d.]+)%/g)].map(m => m[1]);
const pct = r => (r * 100).toFixed(4);
const cueAt = (id, status, t) => ({ id, status, worst: t == null ? null : { t, idx: 0, frame: 0, value: 0, rule: 'summary-worst' } });

test('draw: the lift window\'s marks sit where the old page\'s time bars put them; a start-only window marks its start only, none marks none', async () => {
  const D = await draw();
  const cases = [[1.2, 3.4, 7.4], [0.5, null, 3], [-0.2, 9, 7.4], [0, 3, 3], [0.5, 0.5, 3]];
  for (const [t0, t1, dur] of cases) {
    const got = D.timelineMarks({ liftWindow: { t0, t1 }, cues: [] }, { t0: 0, t1: dur }).lift;
    const want = [];
    if (got.span) want.push(pct(got.span[0]), pct(got.span[1] - got.span[0]));
    for (const r of got.marks) want.push(pct(r));
    assert.deepStrictEqual(want, percents(OLD.liftMarkHtml(t0, t1, dur)), `${t0}, ${t1}, ${dur}`);
  }
  const start = D.timelineMarks({ liftWindow: { t0: 0.5, t1: null }, cues: [] }, { t0: 0, t1: 3 }).lift;
  assert.equal(start.span, null, 'no span without an end');
  assert.equal(start.marks.length, 1, 'one mark: the start');
  assert.ok(Math.abs(start.marks[0] - 0.5 / 3) < 1e-12);
  assert.equal(OLD.liftMarkHtml(0.5, null, 3).includes('scrub-span'), false);
  assert.equal(D.timelineMarks({ liftWindow: null, cues: [] }, { t0: 0, t1: 3 }).lift, null);
  assert.equal(OLD.liftMarkHtml(null, null, 3), '', 'the old page draws no markers without a window');
});

test('draw: the bar shows the marked range, so the window and the worst moments are placed from its start', async () => {
  const D = await draw();
  const range = { t0: 0.4, t1: 3.4 };
  const m = D.timelineMarks({
    liftWindow: { t0: 1.56, t1: 3.36 },
    cues: [cueAt('elbow', 'work on', 2.64), cueAt('top', 'good', 2.64), cueAt('lean', 'watch', 0.4), cueAt('tempo', 'watch', 9), cueAt('sym', "can't score", null), cueAt('x', 'watch', null)],
  }, range);
  assert.deepStrictEqual(m.lift.marks.map(pct), [pct(1.16 / 3), pct(2.96 / 3)]);
  assert.deepStrictEqual(m.moments.map(x => [x.cue, x.status]), [['elbow', 'work on'], ['lean', 'watch'], ['tempo', 'watch']], 'only where a cue went wrong, and only if it has a worst moment');
  assert.ok(Math.abs(m.moments[0].fraction - 0.74666666) < 1e-6);
  assert.equal(m.moments[1].fraction, 0);
  assert.equal(m.moments[2].fraction, 1, 'clamped to the bar');
});

// ---- the token rule ----

test('draw: no colour literal in app/src/ui/ or app/src/draw/ (colours come from tokens.css)', () => {
  const hits = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js|css)$/.test(e.name)) fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (/#[0-9a-fA-F]{3,8}\b/.test(l) || /\brgba?\(/.test(l)) hits.push(`${p}:${i + 1}`); });
    }
  };
  assert.ok(fs.readdirSync(path.join(APP, 'src', 'draw')).some(f => f.endsWith('.mjs')), 'the draw module is there');
  walk(path.join(APP, 'src', 'draw'));
  walk(path.join(APP, 'src', 'ui'));
  assert.deepStrictEqual(hits, []);
});
