'use strict';
// A2, a cue's detail (package d18): the plot as plain functions (app/src/draw/plot.mjs) against a fake 2D
// context, and the screen's texts (app/src/ui/detail-model.mjs): the tiles, the cue and "How it's scored"
// straight from diagnostics.js through s4's and s39's API. The views are built by the scoring adapter from
// committed fixture tracks, never typed in: the lateral raise (cable 1, the clip the mockup shows) and a snatch
// (Session14). Expected strings: design/mockups/CueDetail.dc.html (the headings and the grid), tokens.css.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadDiagnostics } = require('../loadDiagnostics');
const { loadManifests, trackPathFor } = require('../fixtures');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const load = rel => import(pathToFileURL(path.join(APP, 'src', rel)).href);
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const LATERAL = 'global/example/lateral-raise-cable-1';
const SNATCH = 'global/snatch/Session14_01_0h18m07s_made';
const manifest = loadManifests();
const track = slug => JSON.parse(fs.readFileSync(trackPathFor(slug), 'utf8'));
const D = loadDiagnostics();

async function scored(slug, sigmaMs = 50) {
  const { scoreLift } = await load('scoring/score.mjs');
  const { view, computed } = scoreLift(track(slug), manifest[slug].diagnostics, { Diagnostics: D, sigmaMs });
  return { view, computed };
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

// the tokens a style reads, as a fake getPropertyValue
const TOKENS = {
  '--font-text': 'Barlow, sans-serif', '--size-mark': '12px',
  '--text': 'T', '--text-soft': 'TS', '--text-quiet': 'TQ', '--surface': 'SURF', '--ground': 'G', '--line': 'LINE',
  '--status-good': 'S-good', '--status-watch': 'S-watch', '--status-work-on': 'S-work', '--status-cant-score': 'S-cant',
  '--status-good-word': '"Good"', '--status-watch-word': '"Watch"', '--status-work-on-word': '"Work on"', '--status-cant-score-word': '"Can\'t score"',
  '--zone-good': 'Z-good', '--zone-watch': 'Z-watch', '--zone-work-on': 'Z-work',
  '--plot-band': 'BAND', '--plot-phase': 'PHASE',
  '--plot-pad-left': '36px', '--plot-pad-right': '12px', '--plot-pad-top': '10px', '--plot-pad-bottom': '26px',
  '--plot-marker': '5px', '--plot-trace': '2.5px', '--plot-hairline': '1px', '--plot-dash': '4px',
  '--plot-height': '190px', '--plot-label-gap': '6px', '--plot-label-drop': '4px', '--plot-label-rise': '4px', '--plot-label-inset': '4px',
  '--plot-zone-label-top': '16px', '--plot-time-gap': '8px', '--plot-marker-gap': '8px', '--plot-marker-below': '18px',
  '--plot-marker-top': '10px', '--plot-flip-margin': '56px', '--plot-playhead': '1.5px', '--plot-ring': '2px',
};
const read_ = n => TOKENS[n] ?? '';

// a 2D context that records its calls
function fakeCtx() {
  const calls = [];
  const rec = name => (...args) => { calls.push({ name, args, fill: ctx.fillStyle, stroke: ctx.strokeStyle, dash: ctx.dash }); };
  const ctx = {
    calls, fillStyle: null, strokeStyle: null, lineWidth: null, font: null, textAlign: null, dash: [],
    canvas: { width: 358, height: 190 },
    setLineDash(d) { ctx.dash = d; },
  };
  for (const n of ['clearRect', 'fillRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'arc', 'fillText', 'save', 'restore']) ctx[n] = rec(n);
  return ctx;
}

const SIZE = { width: 358, height: 190 };
const PAD = { left: 36, right: 12, top: 10, bottom: 26 };

// ---- the plot's geometry ----

test('plot: the scales map the domain onto the plot box, time left to right and value bottom to top', async () => {
  const p = await load('draw/plot.mjs');
  const { view } = await scored(LATERAL);
  const cue = view.cues.find(c => c.id === 'lateral-raise-elbow-lead');
  const g = p.plotGeometry(cue, D.zones(cue.id), { ...SIZE, pad: PAD });
  assert.deepStrictEqual(g.box, { left: 36, top: 10, width: 358 - 36 - 12, height: 190 - 10 - 26 });
  near(g.x(g.domain.t0), g.box.left, 'domain start is the box\'s left');
  near(g.x(g.domain.t1), g.box.left + g.box.width, 'domain end is the box\'s right');
  near(g.y(g.domain.v1), g.box.top, 'the top value is the box\'s top');
  near(g.y(g.domain.v0), g.box.top + g.box.height, 'the bottom value is the box\'s bottom');
  assert.ok(g.y(10) < g.y(0), 'larger values are higher');
  // the domain holds the whole series, its band, the phase and the reference line
  for (const s of cue.series) {
    assert.ok(s.t >= g.domain.t0 && s.t <= g.domain.t1, 'time');
    assert.ok(s.lo >= g.domain.v0 && s.hi <= g.domain.v1, 'value');
  }
  assert.ok(cue.phase.t0 >= g.domain.t0 && cue.phase.t1 <= g.domain.t1, 'the phase');
});

test('plot: the zones are diagnostics.js\'s zones(id), lowest first, clipped to the plot, with its status words', async () => {
  const p = await load('draw/plot.mjs');
  const { view } = await scored(LATERAL);
  for (const id of ['lateral-raise-elbow-lead', 'lateral-raise-top-height', 'lateral-raise-tempo']) {
    const cue = view.cues.find(c => c.id === id);
    const zones = D.zones(id);
    const g = p.plotGeometry(cue, zones, { ...SIZE, pad: PAD });
    assert.ok(g.zones.length >= 2, id);
    // every band is one of the API's, in its order, and within the box
    let at = 0;
    for (const b of g.zones) {
      while (at < zones.length && zones[at].status !== b.status) at++;
      assert.ok(at < zones.length, `${id}: a band that is not in zones(): ${b.status}`);
      at++;
      assert.ok(b.top >= g.box.top - 1e-9 && b.bottom <= g.box.top + g.box.height + 1e-9 && b.top < b.bottom, `${id}: ${b.status} inside the box`);
    }
    // the bands sit where the API's edges put them: an edge inside the domain is at y(edge)
    const elbow = id === 'lateral-raise-elbow-lead';
    if (elbow) {
      const work = g.zones.find(b => b.status === 'work on'), good = g.zones.find(b => b.status === 'good');
      near(work.top, g.y(-5), 'work on ends at -5');
      near(good.bottom, g.y(5), 'good starts at +5');
      assert.ok(work.top > good.bottom, 'work on is below good');
    }
  }
});

test('plot: a cue whose zones() is null gets no bands (an SD, a decline or a deficit is not on the plot)', async () => {
  const p = await load('draw/plot.mjs');
  const { view } = await scored(LATERAL);
  const cue = view.cues.find(c => c.id === 'lateral-raise-torso-lean');
  assert.equal(D.zones(cue.id), null);
  const g = p.plotGeometry(cue, null, { ...SIZE, pad: PAD });
  assert.deepStrictEqual(g.zones, []);
  assert.deepStrictEqual(g.edges, []);
  assert.ok(g.line.length > 1, 'the trace is still drawn');
});

test('plot: the phase band, the reference line and the worst moment\'s marker sit at the view\'s numbers', async () => {
  const p = await load('draw/plot.mjs');
  const { view } = await scored(LATERAL);
  const cue = view.cues.find(c => c.id === 'lateral-raise-elbow-lead');
  const g = p.plotGeometry(cue, D.zones(cue.id), { ...SIZE, pad: PAD, format: v => `<${v.toFixed(1)}>` });
  near(g.phase.left, g.x(cue.phase.t0), 'phase start');
  near(g.phase.right, g.x(cue.phase.t1), 'phase end');
  assert.ok(cue.referenceLine, 'the elbow lead has a reference line');
  assert.ok(g.reference, 'the plot draws it');
  near(g.reference.y, g.y(cue.referenceLine.value), 'reference value');
  assert.equal(g.reference.label, cue.referenceLine.label);
  near(g.worst.x, g.x(cue.worst.t), 'worst time');
  near(g.worst.y, g.y(cue.worst.value), 'worst value');
  assert.equal(g.worst.label, `<${cue.worst.value.toFixed(1)}>`);
  // the trace and the two sides' band are the series
  assert.equal(g.line.length, cue.series.length);
  cue.series.forEach((s, i) => { near(g.line[i][0], g.x(s.t), 'trace x'); near(g.line[i][1], g.y(s.value), 'trace y'); });
  assert.equal(g.band.length, 2 * cue.series.length);
  near(g.band[0][1], g.y(cue.series[0].hi), 'band starts on the high side');
  near(g.band.at(-1)[1], g.y(cue.series[0].lo), 'and returns on the low side');
});

test('plot: no band without lo and hi, no reference without a line, no marker without a worst moment', async () => {
  const p = await load('draw/plot.mjs');
  const cue = { unit: '°', series: [{ t: 1, value: 3 }, { t: 2, value: 5 }], phase: { t0: 1, t1: 2 }, referenceLine: null, worst: null };
  const g = p.plotGeometry(cue, null, { ...SIZE, pad: PAD });
  assert.equal(g.band, null);
  assert.equal(g.reference, null);
  assert.equal(g.worst, null);
  // a flat trace is not magnified into apparent wobble: the value axis spans at least a few units
  const flat = p.plotGeometry({ ...cue, series: [{ t: 1, value: 3 }, { t: 2, value: 3 }] }, null, { ...SIZE, pad: PAD });
  assert.ok(flat.domain.v1 - flat.domain.v0 >= 10, 'degrees and percent: at least 10');
  const ratio = p.plotGeometry({ ...cue, unit: 'x', series: [{ t: 1, value: 1.1 }, { t: 2, value: 1.1 }] }, null, { ...SIZE, pad: PAD });
  assert.ok(ratio.domain.v1 - ratio.domain.v0 >= 1 && ratio.domain.v1 - ratio.domain.v0 < 10, 'a ratio: at least 1');
  // one sample (a single rep's top) still has a time axis
  const one = p.plotGeometry({ ...cue, series: [{ t: 2, value: 3 }], phase: { t0: 2, t1: 2 } }, null, { ...SIZE, pad: PAD });
  assert.ok(one.domain.t1 > one.domain.t0);
});

test('plot: the time ticks read from the marked range\'s start, the way A1\'s clock does', async () => {
  const p = await load('draw/plot.mjs');
  const { view } = await scored(LATERAL);
  const cue = view.cues.find(c => c.id === 'lateral-raise-elbow-lead');
  const g = p.plotGeometry(cue, null, { ...SIZE, pad: PAD, origin: 0.5 });
  assert.ok(g.ticks.time.length >= 3);
  for (const k of g.ticks.time) {
    near(k.x, g.x(k.t), 'tick x');
    assert.equal(k.label, `${(k.t - 0.5).toFixed(1)} s`);
  }
  for (const k of g.ticks.value) near(k.y, g.y(k.v), 'value tick y');
});

test('plot: a tap on it seeks: the time under the finger, inside the plot\'s own time axis', async () => {
  const p = await load('draw/plot.mjs');
  const { view } = await scored(LATERAL);
  const cue = view.cues.find(c => c.id === 'lateral-raise-elbow-lead');
  const g = p.plotGeometry(cue, null, { ...SIZE, pad: PAD });
  const rect = { left: 100, width: 358 };
  near(p.timeAtTap(100 + g.x(1.234), rect, g), 1.234 < g.domain.t0 ? g.domain.t0 : Math.min(1.234, g.domain.t1), 'inverse of x');
  const mid = (g.domain.t0 + g.domain.t1) / 2;
  near(p.timeAtTap(100 + g.x(mid), rect, g), mid, 'the middle');
  assert.equal(p.timeAtTap(-1000, rect, g), g.domain.t0, 'left of the plot');
  assert.equal(p.timeAtTap(9000, rect, g), g.domain.t1, 'right of the plot');
  // the canvas shown smaller than its CSS size still maps the tap right: a half-width rect, a tap at its middle
  assert.equal(p.timeAtTap(100 + 179 / 2, { left: 100, width: 179 }, g), p.timeAtTap(100 + 358 / 2, { left: 100, width: 358 }, g));
});

// ---- the plot drawn ----

test('plot: plotStyle reads the tokens, never a literal; drawPlot paints the bands, the trace and the marker with them', async () => {
  const p = await load('draw/plot.mjs');
  const { view } = await scored(LATERAL);
  const cue = view.cues.find(c => c.id === 'lateral-raise-elbow-lead');
  const style = p.plotStyle(read_, cue.status);
  assert.deepStrictEqual(style.pad, PAD);
  assert.equal(style.zone.good, 'Z-good');
  assert.equal(style.status.good, 'S-good');
  assert.equal(style.words['work on'], 'Work on', 'the word from --status-*-word, quotes off');
  assert.equal(style.marker, 'S-work', 'the marker is the cue\'s status colour');
  assert.equal(style.trace, 'T');

  const g = p.plotGeometry(cue, D.zones(cue.id), { ...SIZE, pad: style.pad, format: v => String(v) });
  const ctx = fakeCtx();
  p.drawPlot(ctx, g, style, { at: cue.worst.t });
  const fills = ctx.calls.filter(c => c.name === 'fillRect');
  for (const b of g.zones) assert.ok(fills.some(c => c.fill === style.zone[b.status] && Math.abs(c.args[1] - b.top) < 1e-9), `band ${b.status}`);
  assert.ok(fills.some(c => c.fill === 'PHASE'), 'the phase band');
  assert.ok(ctx.calls.some(c => c.name === 'fill' && c.fill === 'BAND'), 'the two sides\' band');
  assert.ok(ctx.calls.some(c => c.name === 'stroke' && c.stroke === 'T'), 'the trace');
  const dot = ctx.calls.find(c => c.name === 'arc');
  assert.ok(dot && Math.abs(dot.args[0] - g.worst.x) < 1e-9 && Math.abs(dot.args[1] - g.worst.y) < 1e-9, 'the worst moment\'s dot');
  const words = ctx.calls.filter(c => c.name === 'fillText').map(c => c.args[0]);
  for (const w of ['Good', 'Watch', 'Work on']) assert.ok(words.includes(w), w);
  assert.ok(cue.referenceLine, 'the elbow lead has a reference line');
  assert.ok(words.includes(cue.referenceLine.label), 'the reference line\'s label');
  assert.ok(words.includes(g.worst.label), 'the marker\'s value');
  // every colour set on the context came from the style
  const allowed = new Set([...Object.values(style.zone), ...Object.values(style.status), style.trace, style.text, style.textSoft, style.ground, style.band, style.phase, style.line, style.marker, style.reference, style.playhead, null]);
  for (const c of ctx.calls) for (const col of [c.fill, c.stroke]) assert.ok(allowed.has(col), `a colour that is not a token's: ${col}`);
});

test('plot: the text offsets, the flip margin and the line widths are tokens: changing one moves the drawing, and drawPlot types no spacing literal', async () => {
  const p = await load('draw/plot.mjs');
  const { view } = await scored(LATERAL);
  const cue = view.cues.find(c => c.id === 'lateral-raise-elbow-lead');
  const base = p.plotStyle(read_, cue.status);
  const g = p.plotGeometry(cue, D.zones(cue.id), { ...SIZE, pad: base.pad, format: v => String(v) });
  const texts = style => { const ctx = fakeCtx(); p.drawPlot(ctx, g, style, { at: cue.worst.t }); return ctx.calls; };
  const at = (calls, label) => calls.find(c => c.name === 'fillText' && c.args[0] === label).args;
  const before = texts(base);
  const moved = (name, value, check) => {
    const style = p.plotStyle(n => (n === name ? value : read_(n)), cue.status);
    check(texts(style), before);
  };
  const edge = String(+g.edges[0].v.toFixed(2));
  moved('--plot-label-gap', '10px', (c, b) => near(at(c, edge)[1] - at(b, edge)[1], -4, 'offset'));
  moved('--plot-label-drop', '9px', (c, b) => near(at(c, edge)[2] - at(b, edge)[2], 5, 'offset'));
  moved('--plot-time-gap', '12px', (c, b) => { const l = g.ticks.time[0].label; assert.equal(at(c, l)[2] - at(b, l)[2], -4); });
  moved('--plot-zone-label-top', '20px', (c, b) => { const w = 'Work on'; assert.notEqual(at(c, w)[2], at(b, w)[2]); });
  if (cue.referenceLine) {
    moved('--plot-label-inset', '9px', (c, b) => near(at(c, cue.referenceLine.label)[1] - at(b, cue.referenceLine.label)[1], 5, 'offset'));
    moved('--plot-label-rise', '9px', (c, b) => near(at(c, cue.referenceLine.label)[2] - at(b, cue.referenceLine.label)[2], -5, 'offset'));
  }
  moved('--plot-marker-gap', '12px', (c, b) => assert.notEqual(at(c, g.worst.label)[1], at(b, g.worst.label)[1]));
  moved('--plot-ring', '3px', c => assert.ok(c.some(x => x.name === 'stroke')));
  // the flip: a margin wider than the box always flips the label to the dot's left
  moved('--plot-flip-margin', '5000px', (c, b) => near(at(c, g.worst.label)[1] - g.worst.x, -8, 'offset'));
  // the source: drawPlot has no numeric literal besides 0, 1, 2π and the empty dash
  const src = read('app', 'src', 'draw', 'plot.mjs');
  const body = src.slice(src.indexOf('export function drawPlot'));
  const lits = (body.replace(/\/\/.*$/gm, '').replace(/'[^']*'/g, '').match(/(?<![\w.])\d+(\.\d+)?/g) || []).filter(n => !['0', '1', '2'].includes(n));
  assert.deepStrictEqual(lits, []);
  const a2 = read('app', 'src', 'ui', 'screens', 'A2.mjs');
  assert.ok(!/\|\|\s*\d{2,}/.test(a2), 'A2 has no size fallback typed');
});

test('plot: a cue with no zones draws no bands and no status words', async () => {
  const p = await load('draw/plot.mjs');
  const { view } = await scored(LATERAL);
  const cue = view.cues.find(c => c.id === 'lateral-raise-torso-lean');
  const style = p.plotStyle(read_, cue.status);
  const g = p.plotGeometry(cue, null, { ...SIZE, pad: style.pad });
  const ctx = fakeCtx();
  p.drawPlot(ctx, g, style, {});
  assert.ok(!ctx.calls.some(c => c.name === 'fillRect' && Object.values(style.zone).includes(c.fill)), 'no band');
  const words = ctx.calls.filter(c => c.name === 'fillText').map(c => c.args[0]);
  for (const w of ['Good', 'Watch', 'Work on']) assert.ok(!words.includes(w), w);
});

// ---- the screen's texts ----

test('detail: the model gives the tiles and the cue as the view has them, the view\'s tiles being s4\'s tiles(id, result)', async () => {
  const m = await load('ui/detail-model.mjs');
  for (const slug of [LATERAL, SNATCH]) {
    const { view, computed } = await scored(slug);
    for (const cue of view.cues.filter(c => c.status !== "can't score")) {
      const d = m.detailOf({ Diagnostics: D, view, computed, cueId: cue.id, range: { t0: 0, t1: 10 } });
      assert.deepStrictEqual(d.tiles.map(t => [t.label, t.value, t.sub ?? null]), D.tiles(cue.id, computed.results[cue.id]).map(t => [t.label, t.value, t.sub ?? null]), `${cue.id}: s4's tiles`);
      assert.equal(d.cue, cue.cue);
      assert.equal(d.verdict, cue.verdict);
      assert.equal(d.title, cue.title.split(' — ')[0]);
      assert.equal(d.provisional, cue.provisional);
      assert.equal(d.worst.t, cue.worst.t);
    }
  }
});

test('detail: a tile\'s status is a verdict level mapped to a status class; a colour string from the engine is not used', async () => {
  const m = await load('ui/detail-model.mjs');
  assert.equal(m.tileClass('good'), 'good');
  assert.equal(m.tileClass('warning'), 'watch');
  assert.equal(m.tileClass('critical'), 'work-on');
  assert.equal(m.tileClass('rgb(12, 200, 40)'), null);
  assert.equal(m.tileClass(undefined), null);
});

test('detail: "How it\'s scored" is s39\'s scoringLines(id, computed, {smoothingMs: view.smoothing.sigmaMs}), the line for the time smoothing saying the σ the verdicts were scored with', async () => {
  const m = await load('ui/detail-model.mjs');
  for (const sigma of [0, 50, 120]) {
    const { view, computed } = await scored(LATERAL, sigma);
    assert.equal(view.smoothing.sigmaMs, sigma);
    for (const cue of view.cues.filter(c => c.status !== "can't score")) {
      const d = m.detailOf({ Diagnostics: D, view, computed, cueId: cue.id, range: { t0: 0, t1: 10 } });
      assert.deepStrictEqual(d.lines, D.scoringLines(cue.id, computed, { smoothingMs: sigma }), cue.id);
      const smooth = d.lines.filter(l => l.label === 'Time smoothing');
      assert.equal(smooth.length, 1, `${cue.id}: exactly one Time smoothing line`);
      if (sigma > 0) assert.ok(smooth[0].text.includes(`σ = ${sigma} ms`), `${cue.id}: says ${sigma} ms`);
      else assert.ok(!/σ =/.test(smooth[0].text), `${cue.id}: raw track says no σ`);
    }
  }
});

test('detail: the plot is not given a σ of its own: a view scored with σ 120 asks the API with 120, not the app\'s default', async () => {
  const m = await load('ui/detail-model.mjs');
  const { view, computed } = await scored(LATERAL, 120);
  const asked = [];
  const spy = { ...D, scoringLines: (id, c, o) => { asked.push(o.smoothingMs); return D.scoringLines(id, c, o); }, zones: id => D.zones(id) };
  m.detailOf({ Diagnostics: spy, view, computed, cueId: 'lateral-raise-elbow-lead', range: { t0: 0, t1: 10 } });
  assert.deepStrictEqual(asked, [120]);
});

test('detail: the zones come from zones(id): none when it gives null; the rule sentence is built from them', async () => {
  const m = await load('ui/detail-model.mjs');
  const { view, computed } = await scored(LATERAL);
  const lean = m.detailOf({ Diagnostics: D, view, computed, cueId: 'lateral-raise-torso-lean', range: { t0: 0, t1: 10 } });
  assert.equal(lean.zones, null);
  assert.equal(lean.rule, null, 'no zones, no sentence');
  const elbow = m.detailOf({ Diagnostics: D, view, computed, cueId: 'lateral-raise-elbow-lead', range: { t0: 0, t1: 10 } });
  assert.deepStrictEqual(elbow.zones, D.zones('lateral-raise-elbow-lead'));
  assert.equal(elbow.rule, 'Good from +5%, work on below −5%');
});

test('detail: the sentence follows the API\'s zones, whatever the numbers are', async () => {
  const m = await load('ui/detail-model.mjs');
  const z = (status, from, to) => ({ status, from, to });
  // mirrored about zero (the top height): within; work on beyond
  assert.equal(m.ruleSentence('%', [z('work on', null, -30), z('watch', -30, -15), z('good', -15, 15), z('watch', 15, 30), z('work on', 30, null)]), 'Good within 15%, work on beyond 30%');
  assert.equal(m.ruleSentence('%', [z('work on', null, -9), z('watch', -9, -4), z('good', -4, 4), z('watch', 4, 9), z('work on', 9, null)]), 'Good within 4%, work on beyond 9%');
  // a lower bound only; a signed scale keeps its signs
  assert.equal(m.ruleSentence('%', [z('work on', null, -5), z('watch', -5, 5), z('good', 5, null)]), 'Good from +5%, work on below −5%');
  // an upper bound only, a ratio
  assert.equal(m.ruleSentence('x', [z('good', null, 1.5), z('watch', 1.5, 2.5), z('work on', 2.5, null)]), 'Good up to 1.5×, work on beyond 2.5×');
  // no good band: nothing to say; no zones: nothing
  assert.equal(m.ruleSentence('%', [z('watch', null, 1), z('work on', 1, null)]), null);
  assert.equal(m.ruleSentence('%', null), null);
  assert.equal(m.ruleSentence('%', []), null);
});

test('detail: a cue that can\'t be scored has no plot, tiles or lines; the model says why in the engine\'s words', async () => {
  const m = await load('ui/detail-model.mjs');
  const { view, computed } = await scored(LATERAL);
  const cue = view.cues.find(c => c.status === "can't score");
  const d = m.detailOf({ Diagnostics: D, view, computed, cueId: cue.id, range: { t0: 0, t1: 10 } });
  assert.equal(d.scored, false);
  assert.equal(d.reason, cue.reason);
  assert.deepStrictEqual(d.tiles, []);
  assert.deepStrictEqual(d.lines, []);
  assert.equal(d.worst, null);
});

test('detail: the chips and the plot read times from the marked range\'s start; an unknown cue is an error, not another cue', async () => {
  const m = await load('ui/detail-model.mjs');
  const { view, computed } = await scored(LATERAL);
  const elbow = view.cues.find(c => c.id === 'lateral-raise-elbow-lead');
  const d = m.detailOf({ Diagnostics: D, view, computed, cueId: elbow.id, range: { t0: 0.5, t1: 10 } });
  assert.equal(d.moment.time, (elbow.worst.t - 0.5).toFixed(2));
  assert.equal(d.moment.label, 'Worst moment');
  assert.equal(d.origin, 0.5);
  assert.throws(() => m.detailOf({ Diagnostics: D, view, computed, cueId: 'nope', range: { t0: 0, t1: 1 } }), /nope/);
});

test('detail: S1\'s text is built from scoringLines of a stored lift, and from the cues\' rules alone when there is none', async () => {
  const m = await load('ui/detail-model.mjs');
  const { view, computed } = await scored(LATERAL);
  const t = m.scoringText({ Diagnostics: D, lift: 'lateral-raise', view, computed });
  assert.deepStrictEqual(t.cues.map(c => c.id), D.describe('lateral-raise').map(d => d.id));
  const elbow = t.cues.find(c => c.id === 'lateral-raise-elbow-lead');
  assert.deepStrictEqual(elbow.lines, D.scoringLines('lateral-raise-elbow-lead', computed, { smoothingMs: view.smoothing.sigmaMs }));
  assert.equal(elbow.rule, 'Good from +5%, work on below −5%');
  assert.equal(elbow.cue, D.describe('lateral-raise').find(d => d.id === elbow.id).cue);
  assert.equal(t.cues.find(c => c.id === 'lateral-raise-symmetry').lines.length, 0, 'a cue that can\'t score has no lines');
  assert.equal(t.measured, true);
  const bare = m.scoringText({ Diagnostics: D, lift: 'snatch', view: null, computed: null });
  assert.equal(bare.measured, false);
  assert.deepStrictEqual(bare.cues.map(c => c.id), D.describe('snatch').map(d => d.id));
  assert.ok(bare.cues.every(c => c.lines.length === 0 && typeof c.cue === 'string'));
});

// ---- the screen, the flow, the tokens ----

test('A2 replaces the placeholder: it draws the model and the plot, seeks on a tap, and goes back to the result', () => {
  const src = read('app', 'src', 'ui', 'screens', 'A2.mjs');
  assert.ok(!/Coming in a later version|A placeholder/.test(src), 'no placeholder');
  for (const name of ['detailOf', 'plotGeometry', 'drawPlot', 'timeAtTap', 'paintCue']) assert.ok(src.includes(name), name);
  assert.match(src, /flow\.go\('result'/);
  assert.match(src, /flow\.params/);
  // the mockup's headings and button label for what this package builds
  for (const s of ['Back to the result', 'The cue', 'Worst moment']) assert.ok(src.includes(s) || read('app', 'src', 'ui', 'detail-model.mjs').includes(s), s);
  assert.ok(/How it.s scored/.test(src), 'How it\'s scored');
});

test('S1\'s "How the cues are scored" is enabled and opens its text through the flow', async () => {
  const { createFlow, STATES, SCREEN_OF } = await load('flow/flow.mjs');
  assert.ok(STATES.includes('scoring'));
  const flow = createFlow('settings');
  assert.ok(flow.can('scoring'));
  flow.go('scoring');
  assert.ok(flow.can('settings'), 'back to settings');
  assert.ok(fs.existsSync(path.join(APP, 'src', 'ui', 'screens', `${SCREEN_OF.scoring}.mjs`)));
  assert.equal(createFlow('home').can('scoring'), false, 'only from the settings');
  const s1 = read('app', 'src', 'ui', 'screens', 'S1.mjs');
  const at = s1.indexOf('How the cues are scored');
  const start = s1.lastIndexOf('<button', at);
  const row = s1.slice(start, s1.indexOf('</button>', at));
  assert.ok(at > 0 && start > 0, 'the row is a button');
  assert.ok(!/disabled/.test(row.slice(0, row.indexOf('>'))), 'the row\'s button is not disabled');
  assert.match(row, /flow\.go\('scoring'\)/);
  assert.ok(!/Coming in a later version/.test(s1.slice(s1.indexOf('How the cues are scored') - 400, s1.indexOf('How the cues are scored') + 200)), 'no more "Coming in a later version" on the row');
});

test('the plot and the screens\' colours come from tokens: no literal in app/src/ui/ or app/src/draw/, and the plot tokens exist', () => {
  const hits = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js)$/.test(e.name)) fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (/#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(l)) hits.push(`${p}:${i + 1}`); });
    }
  };
  walk(path.join(APP, 'src', 'ui'));
  walk(path.join(APP, 'src', 'draw'));
  assert.deepStrictEqual(hits, []);
  const tokens = read('app', 'src', 'styles', 'tokens.css');
  for (const t of Object.keys(TOKENS).filter(n => /^--(zone|plot)-/.test(n))) assert.ok(tokens.includes(`${t}:`), t);
  // the plot's draw code asks for each token it uses by name
  const plot = read('app', 'src', 'draw', 'plot.mjs');
  for (const t of Object.keys(TOKENS).filter(n => /^--(zone|plot)-/.test(n))) assert.ok(plot.includes(`'${t}'`), `${t} read in plot.mjs`);
});
