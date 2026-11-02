'use strict';
// A1's timeline and cards (package d17): app/src/ui/result-model.mjs, the plain functions screens/A1.mjs
// draws from. The views are built by the scoring adapter from committed fixture tracks, never typed in:
// the lateral raise (cable 1, the clip the mockups show: one rep, so symmetry can't be scored, and no lift
// window, s36), a snatch with both ends of its window (Session14), and the same snatch cut off before its
// finish (a start with no end, s35). Expected strings: design/mockups/Result.dc.html (the values, verdicts
// and titles of its cards, which show this clip's engine output), tokens.css (the status words),
// diagnostics.js (describe()'s order and flags).
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

const LATERAL = 'global/example/lateral-raise-cable-1';
const SNATCH = 'global/snatch/Session14_01_0h18m07s_made';
const manifest = loadManifests();
const track = slug => JSON.parse(fs.readFileSync(trackPathFor(slug), 'utf8'));

async function scored(slug, tr = track(slug)) {
  const { scoreLift } = await load('scoring/score.mjs');
  const D = loadDiagnostics();
  const { view } = scoreLift(tr, manifest[slug].diagnostics, { Diagnostics: D, sigmaMs: 0 });
  return { view, D };
}
const rangeOf = tr => ({ t0: 0, t1: tr.meta.frame_times_ms.at(-1) / 1000 });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

// The snatch cut off at 2.0 s: the pull is in it, the finish is not (as scoring.test.js does).
function cutSnatch() {
  const slug = Object.keys(manifest).filter(s => manifest[s].diagnostics === 'snatch').find(s => track(s).meta.frame_count > 400);
  const tr = track(slug);
  const keep = tr.meta.frame_times_ms.map((ms, i) => (ms <= 2000 ? i : -1)).filter(i => i >= 0);
  const frames = keep.map(i => tr.meta.frame_indices[i]);
  return {
    slug,
    tr: {
      keypoints: Object.fromEntries(frames.map(f => [String(f), tr.keypoints[String(f)]])),
      meta: { ...tr.meta, frame_indices: frames, frame_times_ms: keep.map(i => tr.meta.frame_times_ms[i]) },
    },
  };
}

// ---- the cards ----

test('result: the cards are the view\'s cues, in diagnostics.js\'s order, with the status word, icon, verdict and value', async () => {
  const m = await load('ui/result-model.mjs');
  const { view, D } = await scored(LATERAL);
  const cards = m.cardsOf(view);
  assert.deepStrictEqual(cards.map(c => c.id), D.describe('lateral-raise').map(d => d.id), 'diagnostics.js\'s order');
  const byId = Object.fromEntries(cards.map(c => [c.id, c]));
  // the mockup's cards (Result.dc.html CUES): title, status, verdict, value
  const want = {
    'lateral-raise-elbow-lead': ['Elbow lead', 'work on', 'Work on', 'work', 'wrist rises above elbow', '−11.4%'],
    'lateral-raise-top-height': ['Top of rep', 'good', 'Good', 'good', 'right at shoulder height', '+10.8%'],
    'lateral-raise-torso-lean': ['Torso lean', 'good', 'Good', 'good', 'stays upright', '1.2°'],
    'lateral-raise-tempo': ['Tempo', 'good', 'Good', 'good', 'controlled descent', '1.07×'],
    'lateral-raise-symmetry': ['Rep-to-rep symmetry', "can't score", "Can't score", 'cant', null, '—'],
  };
  assert.deepStrictEqual(Object.keys(byId).sort(), Object.keys(want).sort());
  for (const [id, [title, status, word, icon, verdict, value]] of Object.entries(want)) {
    const c = byId[id];
    assert.deepStrictEqual([c.title, c.status, c.word, c.icon, c.verdict, c.value], [title, status, word, icon, verdict, value], id);
  }
  // the full title is the view's, and the dash splits it
  assert.equal(byId['lateral-raise-top-height'].fullTitle, view.cues.find(c => c.id === 'lateral-raise-top-height').title);
});

test('result: every card has an icon and a word, never colour alone: the modifiers and words are tokens.css\'s', async () => {
  const m = await load('ui/result-model.mjs');
  const { STATUS_WORDS } = await load('contracts/cue-view.mjs');
  const tokens = fs.readFileSync(path.join(APP, 'src', 'styles', 'tokens.css'), 'utf8');
  const base = fs.readFileSync(path.join(APP, 'src', 'styles', 'base.css'), 'utf8');
  const icons = new Set();
  for (const status of STATUS_WORDS) {
    const look = m.lookOf(status);
    assert.ok(look.icon && look.word, status);
    icons.add(look.icon);
    assert.ok(tokens.includes(`--status-${look.cls}-word: "${look.word}";`), `${status}: tokens.css spells it "${look.word}"`);
    assert.ok(base.includes(`.status--${look.cls} `), `${status}: base.css styles .status--${look.cls}`);
  }
  assert.equal(icons.size, STATUS_WORDS.length, 'each status has its own icon');
  assert.throws(() => m.lookOf('excellent'), /excellent/, 'a word the contract lacks is never shown as another');
});

test('result: the value is the view\'s, signed where the cue is scored on its worst sample, with its unit', async () => {
  const m = await load('ui/result-model.mjs');
  const cue = (value, unit, rule) => ({ value, unit, worst: rule ? { rule } : null });
  assert.equal(m.valueText(cue(-11.383, '%', 'summary-worst')), '−11.4%');
  assert.equal(m.valueText(cue(10.827, '%', 'summary-worst')), '+10.8%');
  assert.equal(m.valueText(cue(1.2148, '°', 'farthest-from-mean')), '1.2°');
  assert.equal(m.valueText(cue(1.0702, 'x', 'summary-worst')), '1.07×', 'a ratio has no sign');
  assert.equal(m.valueText(cue(-0.04, '%', 'summary-worst')), '+0.0%', 'no minus on a zero');
  assert.equal(m.valueText(cue(null, '%', null)), '—');
  // a unit the card has never seen is still shown, after the number
  assert.equal(m.valueText(cue(4, 'kg', 'phase-end')), '4.0kg');
  // the snatch: sizes, not signed
  const { view } = await scored(SNATCH);
  for (const c of m.cardsOf(view)) assert.match(c.value, /^\d+\.\d°$/, c.id);
});

test('result: "provisional" is the cue\'s flag from diagnostics.js, and the header note says so', async () => {
  const m = await load('ui/result-model.mjs');
  const { view, D } = await scored(LATERAL);
  const flags = Object.fromEntries(D.describe('lateral-raise').map(d => [d.id, d.provisional]));
  for (const c of m.cardsOf(view)) assert.equal(c.provisional, flags[c.id], c.id);
  assert.ok(m.cardsOf(view).every(c => c.provisional));
  assert.equal(m.provisionalNote(view), 'Thresholds are provisional: not yet checked on real lifts.');
  // a cue whose thresholds are checked: no note once none is provisional
  assert.equal(m.provisionalNote({ cues: [{ provisional: false }] }), null);
});

test('result: a cue that can\'t be scored says why in the engine\'s words, and shows no value', async () => {
  const m = await load('ui/result-model.mjs');
  const { view } = await scored(LATERAL);
  const sym = m.cardsOf(view).find(c => c.id === 'lateral-raise-symmetry');
  const engine = view.cues.find(c => c.id === 'lateral-raise-symmetry').reason;
  assert.equal(engine, "Only one rep was found in this clip — there's nothing to compare rep-to-rep.");   // the mockup's sentence
  assert.deepStrictEqual([sym.scored, sym.reason, sym.line, sym.verdict, sym.value], [false, engine, engine, null, '—']);
  const ok = m.cardsOf(view).find(c => c.id === 'lateral-raise-elbow-lead');
  assert.deepStrictEqual([ok.scored, ok.reason, ok.line], [true, null, ok.verdict]);
});

test('result: the view\'s camera notes are on the card, as the engine wrote them', async () => {
  const m = await load('ui/result-model.mjs');
  const { view } = await scored(LATERAL);
  const lean = m.cardsOf(view).find(c => c.id === 'lateral-raise-torso-lean');
  assert.equal(lean.notes.length, 1);
  assert.match(lean.notes[0], /^The two sides disagree by 10\.0° on average\. A steady offset means the camera is not square to the lifter/);
  assert.deepStrictEqual(lean.notes, view.cues.find(c => c.id === 'lateral-raise-torso-lean').notes);
  assert.deepStrictEqual(m.cardsOf(view).filter(c => c.id !== lean.id).flatMap(c => c.notes), []);
});

test('result: the counts under the header are worst first, as the mockup has them', async () => {
  const m = await load('ui/result-model.mjs');
  const { view } = await scored(LATERAL);
  assert.deepStrictEqual(m.summaryOf(view).map(s => s.text), ['1 work on', '3 good', "1 can't score"]);
});

test('result: a cue added to diagnostics.js appears as a card with no change here', async () => {
  // The cards come from view.cues alone: a set with another cue (any id, title, unit) gives one more card.
  const m = await load('ui/result-model.mjs');
  const { view } = await scored(LATERAL);
  const extra = { ...view.cues[0], id: 'lateral-raise-new-cue', title: 'A new cue — whatever it checks', unit: 'kg', status: 'watch', verdict: 'a new verdict', value: 3.25 };
  const cards = m.cardsOf({ ...view, cues: [...view.cues, extra] });
  assert.equal(cards.length, view.cues.length + 1);
  assert.deepStrictEqual(cards.at(-1).id, 'lateral-raise-new-cue');
  assert.deepStrictEqual([cards.at(-1).title, cards.at(-1).word, cards.at(-1).cls, cards.at(-1).value], ['A new cue', 'Watch', 'watch', '+3.3kg']);
  // and the screen names no cue: no cue id or title in A1's component or the model
  for (const f of ['ui/screens/A1.mjs', 'ui/result-model.mjs']) {
    const src = fs.readFileSync(path.join(APP, 'src', f), 'utf8');
    assert.ok(!/lateral-raise-|first-pull|second-pull|Elbow lead|Torso lean/.test(src.replace(/\/\/.*$/gm, '')), f);
  }
});

// ---- the timeline ----

test('result: a lateral raise shows no lift window and no reason (s36), but its cues\' phases and worst moments', async () => {
  const m = await load('ui/result-model.mjs');
  const tr = track(LATERAL);
  const { view } = await scored(LATERAL);
  assert.equal(view.hasLiftWindow, false);
  const range = rangeOf(tr);   // 0–2.96 s
  const tl = m.timelineOf(view, range);
  assert.deepStrictEqual([tl.window, tl.label, tl.reason, tl.lift], [null, null, null, null]);
  const byId = Object.fromEntries(tl.cues.map(c => [c.id, c]));
  assert.deepStrictEqual(tl.cues.map(c => c.id), view.cues.map(c => c.id));
  // the elbow lead (work on): phase 1.16–2.96 s, worst moment 2.24 s (the mockup's lift span and diamond)
  const elbow = byId['lateral-raise-elbow-lead'];
  const dur = range.t1 - range.t0;
  assert.deepStrictEqual([elbow.phase.t0, elbow.phase.t1, elbow.phase.start, elbow.phase.end], [1.16, 2.96, 1.16, 2.96]);
  near(elbow.phase.from, 1.16 / dur, 'phase from');
  near(elbow.phase.to, 1, 'phase to');
  assert.deepStrictEqual([elbow.worst.t, elbow.worst.at, elbow.marked], [2.24, 2.24, true]);
  near(elbow.worst.fraction, 2.24 / dur, 'worst share');
  // a good cue has its worst moment but no mark on the bar; one that can't be scored has neither
  assert.deepStrictEqual([byId['lateral-raise-top-height'].marked, byId['lateral-raise-top-height'].worst.t], [false, 2.24]);
  assert.deepStrictEqual([byId['lateral-raise-symmetry'].phase, byId['lateral-raise-symmetry'].worst, byId['lateral-raise-symmetry'].marked], [null, null, false]);
});

test('result: a marked range that does not start at 0 counts the phases and moments from its start', async () => {
  const m = await load('ui/result-model.mjs');
  const { view } = await scored(LATERAL);
  const range = { t0: 0.4, t1: 3.4 };
  const elbow = m.timelineOf(view, range).cues.find(c => c.id === 'lateral-raise-elbow-lead');
  near(elbow.worst.at, 2.24 - 0.4, 'seconds into the range');
  near(elbow.worst.fraction, (2.24 - 0.4) / 3, 'share');
  near(elbow.phase.start, 1.16 - 0.4, 'phase start');
  assert.equal(elbow.worst.t, 2.24, 'the time to seek to stays the cut\'s');
  // a range that ends before the moment clamps it to the bar
  assert.equal(m.timelineOf(view, { t0: 0, t1: 1 }).cues.find(c => c.id === 'lateral-raise-elbow-lead').worst.fraction, 1);
});

test('result: a snatch with a full window shows both ends, as seconds and as shares of the clip', async () => {
  const m = await load('ui/result-model.mjs');
  const tr = track(SNATCH);
  const { view } = await scored(SNATCH, tr);
  assert.equal(view.hasLiftWindow, true);
  assert.ok(view.liftWindow.t1 > view.liftWindow.t0 && view.liftWindowReason === null);
  const range = rangeOf(tr);
  const tl = m.timelineOf(view, range);
  const dur = range.t1 - range.t0;
  assert.deepStrictEqual([tl.window.t0, tl.window.t1], [view.liftWindow.t0, view.liftWindow.t1]);
  assert.deepStrictEqual([tl.window.start, tl.window.end], [view.liftWindow.t0, view.liftWindow.t1]);
  near(tl.window.from, view.liftWindow.t0 / dur, 'from');
  near(tl.window.to, view.liftWindow.t1 / dur, 'to');
  assert.equal(tl.reason, null);
  assert.equal(tl.label, `lift ${view.liftWindow.t0.toFixed(2)}–${view.liftWindow.t1.toFixed(2)} s`);
  assert.ok(tl.lift.span, 'draw/\'s span, for the bar');
  // each cue's phase, in order along the lift
  const [pull, extension] = tl.cues;
  assert.ok(pull.phase.to <= extension.phase.from + 1e-9 && extension.phase.to > extension.phase.from);
  assert.equal(extension.marked, true, 'the second pull is "watch"');
  assert.equal(pull.marked, false);
});

test('result: a window with no end shows its start and the view\'s reason (s35)', async () => {
  const m = await load('ui/result-model.mjs');
  const { slug, tr } = cutSnatch();
  const { view } = await scored(slug, tr);
  assert.equal(view.liftWindow.t1, null);
  assert.match(view.liftWindowReason, /no end marker/);
  const range = rangeOf(tr);
  const tl = m.timelineOf(view, range);
  assert.deepStrictEqual([tl.window.t1, tl.window.end, tl.window.to], [null, null, null]);
  assert.equal(tl.window.t0, view.liftWindow.t0);
  near(tl.window.from, view.liftWindow.t0 / (range.t1 - range.t0), 'from');
  assert.equal(tl.reason, view.liftWindowReason, 'the engine\'s words, not the screen\'s');
  assert.equal(tl.label, `lift starts ${view.liftWindow.t0.toFixed(2)} s, no end found`);
  assert.equal(tl.lift.span, null);
  assert.equal(tl.lift.marks.length, 1, 'one mark: the start');
});

test('result: no lift found says why, and no window', async () => {
  const m = await load('ui/result-model.mjs');
  const { scoreLift } = await load('scoring/score.mjs');
  const keypoints = {};
  const idx = Array.from({ length: 3 }, (_, i) => i);
  for (const f of idx) keypoints[String(f)] = { 0: Array.from({ length: 17 }, () => [0, 0, 0]) };
  const tr = { keypoints, meta: { fps: 30, frame_indices: idx, frame_times_ms: idx.map(i => i * 1000 / 30), tracks: { kept: '0' } } };
  const { view } = scoreLift(tr, 'snatch', { Diagnostics: loadDiagnostics(), sigmaMs: 0 });
  assert.equal(view.liftWindow, null);
  const tl = m.timelineOf(view, { t0: 0, t1: 0.1 });
  assert.deepStrictEqual([tl.window, tl.label, tl.lift], [null, null, null]);
  assert.equal(tl.reason, view.liftWindowReason);
  assert.ok(tl.reason.length > 0);
});

test('result: a tap on a worst-moment mark seeks to that moment, any other tap to the pointer\'s time', async () => {
  const m = await load('ui/result-model.mjs');
  const { view } = await scored(LATERAL);
  const range = { t0: 0, t1: 2.96 };
  const rect = { left: 16, width: 358 };
  const moments = m.timelineOf(view, range).cues.filter(c => c.marked).map(c => c.worst);
  assert.equal(moments.length, 1);
  const xAt = f => rect.left + f * rect.width;
  assert.equal(m.seekTime(xAt(moments[0].fraction) + 10, rect, range, moments), 2.24, 'within the mark: its exact time');
  near(m.seekTime(xAt(0.25), rect, range, moments), 0.25 * 2.96, 'elsewhere: where the finger is');
  assert.equal(m.seekTime(xAt(moments[0].fraction) + m.SNAP_PX + 3, rect, range, moments) === 2.24, false, 'beyond the snap');
  assert.equal(m.seekTime(-50, rect, range, moments), 0, 'clamped');
  assert.equal(m.seekTime(500, rect, range, moments), 2.96, 'clamped');
  assert.equal(m.seekTime(100, { left: 0, width: 0 }, range, moments), 0, 'a bar with no width');
});

// ---- the screen, the flow, the tokens ----

test('result: a card opens A2, a placeholder until d18: the flow has a state for it', async () => {
  const { createFlow, STATES, SCREEN_OF } = await load('flow/flow.mjs');
  assert.ok(STATES.includes('detail'));
  assert.equal(SCREEN_OF.detail, 'A2');
  const flow = createFlow('result');
  assert.ok(flow.can('detail'));
  flow.go('detail', { liftId: 'x', cue: 'lateral-raise-elbow-lead' });
  assert.deepStrictEqual(flow.params, { liftId: 'x', cue: 'lateral-raise-elbow-lead' });
  assert.ok(flow.can('result'), 'back to the result');
  assert.equal(createFlow('home').can('detail'), false, 'only from a result');
  const app = fs.readFileSync(path.join(APP, 'src', 'ui', 'app.mjs'), 'utf8');
  assert.match(app, /\bA2\b/, 'the shell knows the screen');
  assert.ok(fs.existsSync(path.join(APP, 'src', 'ui', 'screens', 'A2.mjs')));
});

test('result: A1 draws the model\'s timeline and cards (one timeline, the cards under it)', () => {
  const src = fs.readFileSync(path.join(APP, 'src', 'ui', 'screens', 'A1.mjs'), 'utf8');
  assert.equal((src.match(/class="timeline"/g) || []).length, 1, 'never a second timeline');
  for (const name of ['cardsOf', 'timelineOf', 'summaryOf', 'seekTime', 'provisionalNote']) assert.ok(src.includes(name), name);
  assert.match(src, /flow\.go\('detail'/);
  // the status word comes from the token through base.css's .status, not typed on the screen
  assert.match(src, /status status--/);
  for (const word of ['Work on', 'Can\'t score']) assert.ok(!src.includes(`'${word}'`) && !src.includes(`>${word}<`), word);
});

test('result: colours, type and spacing in the screens come from tokens.css only', () => {
  const hits = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js|css)$/.test(e.name)) fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (/#[0-9a-fA-F]{3,8}\b/.test(l)) hits.push(`${p}:${i + 1}`); });
    }
  };
  walk(path.join(APP, 'src', 'ui'));
  assert.deepStrictEqual(hits, []);
  // the new rules in base.css use var(--…) for every colour
  const base = fs.readFileSync(path.join(APP, 'src', 'styles', 'base.css'), 'utf8');
  const cards = base.split('\n').filter(l => /^\.(cue|cues|timeline__phase|timeline__reason)/.test(l));
  assert.ok(cards.length > 5, 'the cards are styled');
  for (const l of cards) assert.ok(!/#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(l), l);
});
