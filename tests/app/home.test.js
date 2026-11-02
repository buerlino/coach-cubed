'use strict';
// H's logic as plain functions (app/src/ui/home-model.mjs, package d13): what
// to show from the store's lifts and the queue's jobs, and what the import
// step hands the flow. No Preact, no DOM; the screens draw what these give.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP = path.resolve(__dirname, '..', '..', 'app');
const load = (...p) => import(pathToFileURL(path.join(APP, 'src', ...p)).href);
const model = () => load('ui', 'home-model.mjs');

const ENGINE = { model: 'movenet-thunder', backend: 'webgl', runtime: 'tfjs 4.22.0' };
// Local time, so the day and the clock the rows show don't depend on the machine's zone.
const NOW = new Date(2026, 10, 1, 18, 0, 0);
const iso = (y, m, d, h, min) => new Date(y, m, d, h, min, 5).toISOString();
const stored = (id, lift, created, extra = {}) => ({
  id, created, lift, video: `lifts/${id}/cut.mp4`, range: { t0: 0.4, t1: 3.4 },
  track: null, result: null, appVersion: '0.1.0', engine: null, ...extra,
});
const analysed = (id, lift, created) => stored(id, lift, created, {
  track: `lifts/${id}/track.json`, result: `lifts/${id}/result.json`, engine: ENGINE,
});
const job = (l, state, extra = {}) => ({
  id: `job-${l.id}`, liftId: l.id, lift: l.lift, source: l.video, range: { ...l.range },
  state, progress: null, error: null, ...extra,
});
const progress = (stage, done, total, etaS = null) => ({ stage, done, total, etaS });

const TODAY_A = stored('20261101-143205-lr', 'lateral-raise', iso(2026, 10, 1, 14, 32), { range: { t0: 0, t1: 13 } });
const TODAY_B = analysed('20261101-142705-lr', 'lateral-raise', iso(2026, 10, 1, 14, 27));
const TODAY_C = stored('20261101-144105-sn', 'snatch', iso(2026, 10, 1, 14, 41));

test('a lift\'s state: queued is waiting', async () => {
  const { liftState } = await model();
  assert.deepEqual(liftState(TODAY_C, [job(TODAY_C, 'queued')]).kind, 'waiting');
});

test('a lift\'s state: reading, pose and scoring are analysing, with the progress as a percent', async () => {
  const { liftState } = await model();
  for (const [state, p, percent] of [
    ['reading', progress('reading', 0, 1), 0],
    ['pose', progress('pose', 60, 100, 12), 60],
    ['scoring', progress('scoring', 0, 1), 99],
  ]) {
    const s = liftState(TODAY_A, [job(TODAY_A, state, { progress: p })]);
    assert.equal(s.kind, 'analysing', state);
    assert.equal(s.percent, percent, state);
    assert.equal(s.stage, state);
  }
});

test('a lift\'s state: failed carries the job\'s error, in its words', async () => {
  const { liftState } = await model();
  const s = liftState(TODAY_A, [job(TODAY_A, 'failed', { error: 'No person found in the video' })]);
  assert.equal(s.kind, 'failed');
  assert.equal(s.error, 'No person found in the video');
});

test('a lift\'s state: an analysed lift is ready, even when its done job is still listed', async () => {
  const { liftState } = await model();
  assert.equal(liftState(TODAY_B, []).kind, 'ready');
  assert.equal(liftState(TODAY_B, [job(TODAY_B, 'done')]).kind, 'ready');
});

test('a cancelled job\'s lift stays stored and unanalysed: H shows it as stopped, as it does a lift with no job', async () => {
  const { liftState } = await model();
  assert.equal(liftState(TODAY_A, [job(TODAY_A, 'cancelled')]).kind, 'stopped');
  assert.equal(liftState(TODAY_A, []).kind, 'stopped');
});

test('a done job whose lift the store has not shown as analysed yet is still analysing, never ready', async () => {
  const { liftState } = await model();
  const s = liftState(TODAY_A, [job(TODAY_A, 'done')]);
  assert.equal(s.kind, 'analysing');
  assert.equal(s.percent, 99);
});

test('the state looks at its own lift\'s job only', async () => {
  const { liftState } = await model();
  const jobs = [job(TODAY_A, 'pose', { progress: progress('pose', 1, 10) }), job(TODAY_C, 'queued')];
  assert.equal(liftState(TODAY_C, jobs).kind, 'waiting');
  assert.equal(liftState(TODAY_A, jobs).kind, 'analysing');
  assert.equal(liftState(TODAY_B, jobs).kind, 'ready');
});

test('a waiting lift says whether another job is ahead of it in the queue', async () => {
  const { liftState } = await model();
  const first = job(TODAY_A, 'pose', { progress: progress('pose', 1, 10) });
  assert.equal(liftState(TODAY_C, [first, job(TODAY_C, 'queued')]).ahead, 1);
  assert.equal(liftState(TODAY_C, [job(TODAY_C, 'queued')]).ahead, 0);
  assert.equal(liftState(TODAY_C, [job(TODAY_A, 'failed', { error: 'x' }), job(TODAY_C, 'queued')]).ahead, 0, 'an ended job is not ahead');
});

test('the result summary counts the cues by status word, work on first', async () => {
  const { summariseResult } = await model();
  const cue = status => ({ status });
  const s = summariseResult({ cues: [cue('good'), cue('good'), cue("can't score"), cue('work on'), cue('good'), cue('watch')] });
  assert.deepEqual(s, [
    { status: 'work-on', count: 1, text: '1 work on' },
    { status: 'watch', count: 1, text: '1 watch' },
    { status: 'good', count: 3, text: '3 good' },
    { status: 'cant-score', count: 1, text: "1 can't score" },
  ]);
  assert.deepEqual(summariseResult({ cues: [cue('good')] }).map(x => x.text), ['1 good'], 'a status with no cue is left out');
  assert.deepEqual(summariseResult(null), []);
});

test('a row: lift, clock, length, state and what opening it does', async () => {
  const { rowOf } = await model();
  const a = rowOf(TODAY_A, [job(TODAY_A, 'pose', { progress: progress('pose', 6, 10) })]);
  assert.equal(a.title, 'Lateral raise');
  assert.equal(a.meta, '14:32 · 13.0 s');
  assert.equal(a.state.kind, 'analysing');
  assert.deepEqual(a.open, { to: 'queued', params: { liftId: TODAY_A.id } });
  const b = rowOf(TODAY_B, [], { result: { cues: [{ status: 'good' }] } });
  assert.equal(b.meta, '14:27 · 3.0 s');
  assert.deepEqual(b.open, { to: 'result', params: { liftId: TODAY_B.id } });
  assert.deepEqual(b.summary.map(x => x.text), ['1 good']);
  const c = rowOf(TODAY_C, [job(TODAY_C, 'queued')]);
  assert.equal(c.title, 'Snatch');
  assert.deepEqual(c.open, { to: 'queued', params: { liftId: TODAY_C.id } });
});

test('a failed or stopped lift opens the queue screen, where its job can be retried', async () => {
  const { rowOf } = await model();
  assert.equal(rowOf(TODAY_A, [job(TODAY_A, 'failed', { error: 'e' })]).open.to, 'queued');
  assert.equal(rowOf(TODAY_A, []).open.to, 'queued');
});

test('home: today\'s lifts keep the store\'s order (newest first), with the count, and earlier lifts group by day', async () => {
  const { homeView } = await model();
  const e1 = stored('20261029-180000-lr', 'lateral-raise', iso(2026, 9, 29, 18, 0));
  const e2 = analysed('20261029-170000-sn', 'snatch', iso(2026, 9, 29, 17, 0));
  const e3 = analysed('20261029-160000-lr', 'lateral-raise', iso(2026, 9, 29, 16, 0));
  const e4 = analysed('20261027-090000-sn', 'snatch', iso(2026, 9, 27, 9, 0));
  const view = homeView({ today: [TODAY_C, TODAY_A, TODAY_B], earlier: [e1, e2, e3, e4] }, [job(TODAY_A, 'queued')]);
  assert.deepEqual(view.today.rows.map(r => r.id), [TODAY_C.id, TODAY_A.id, TODAY_B.id]);
  assert.equal(view.today.count, '3 lifts kept');
  assert.equal(view.empty, false);
  assert.deepEqual(view.earlier.map(s => [s.heading, s.lifts]), [
    ['Thu 29 Oct · 3 lifts', 'Lateral raise, snatch'],
    ['Tue 27 Oct · 1 lift', 'Snatch'],
  ]);
  assert.deepEqual(view.earlier[0].rows.map(r => r.id), [e1.id, e2.id, e3.id], 'a day keeps the store\'s order');
});

test('home: one lift is "1 lift kept"; no lift today hides the section; no lift at all is the empty state', async () => {
  const { homeView } = await model();
  assert.equal(homeView({ today: [TODAY_B], earlier: [] }, []).today.count, '1 lift kept');
  const none = homeView({ today: [], earlier: [analysed('20261029-160000-lr', 'lateral-raise', iso(2026, 9, 29, 16, 0))] }, []);
  assert.equal(none.today, null);
  assert.equal(none.empty, false);
  const empty = homeView({ today: [], earlier: [] }, []);
  assert.equal(empty.empty, true);
  assert.equal(empty.today, null);
  assert.deepEqual(empty.earlier, []);
});

test('home: a ready lift\'s summary comes from the results given; none given, none shown', async () => {
  const { homeView } = await model();
  const view = homeView({ today: [TODAY_B], earlier: [] }, [], { [TODAY_B.id]: { cues: [{ status: 'work on' }] } });
  assert.deepEqual(view.today.rows[0].summary.map(x => x.text), ['1 work on']);
  assert.deepEqual(homeView({ today: [TODAY_B], earlier: [] }, []).today.rows[0].summary, []);
});

test('the import choices: lateral raise, and the snatch marked provisional while step 3.6 is open', async () => {
  const { LIFT_CHOICES } = await model();
  assert.deepEqual(LIFT_CHOICES, [
    { id: 'lateral-raise', label: 'Lateral raise', provisional: false },
    { id: 'snatch', label: 'Snatch', provisional: true },
  ]);
  const { LIFTS } = await load('contracts', 'common.mjs');
  assert.deepEqual(LIFT_CHOICES.map(c => c.id), [...LIFTS]);
});

test('the import step: the chosen lift goes into the flow with the file, on the way to marking', async () => {
  const { importStep } = await model();
  const { createFlow } = await load('flow', 'flow.mjs');
  const flow = createFlow();
  flow.go('import');
  const file = { name: 'clip.mp4', type: 'video/mp4', size: 10 };
  const step = importStep(flow, file, 'snatch');
  assert.equal(step.ok, true);
  assert.equal(flow.state, 'mark');
  assert.deepEqual(flow.params, { file, lift: 'snatch' });
});

test('the import step: no lift or an unknown one, no file, or a file that is not a video, changes nothing', async () => {
  const { importStep } = await model();
  const { createFlow } = await load('flow', 'flow.mjs');
  const flow = createFlow('import');
  const file = { name: 'clip.mp4', type: 'video/mp4' };
  for (const [f, lift] of [[file, null], [file, 'squat'], [null, 'snatch'], [{ name: 'a.txt', type: 'text/plain' }, 'snatch']]) {
    const step = importStep(flow, f, lift);
    assert.equal(step.ok, false);
    assert.ok(typeof step.error === 'string' && step.error.length > 0);
    assert.equal(flow.state, 'import');
  }
});

test('the import step takes a file with no type (some Android pickers give none)', async () => {
  const { importStep } = await model();
  const { createFlow } = await load('flow', 'flow.mjs');
  const flow = createFlow('import');
  assert.equal(importStep(flow, { name: 'IMG_0001.MP4', type: '' }, 'lateral-raise').ok, true);
  assert.equal(flow.state, 'mark');
});

test('H follows the queue through the queue it is given, and stops when it is told to', async () => {
  const { followQueue } = await model();
  const listeners = new Set();
  const queue = { subscribe(fn) { listeners.add(fn); fn([]); return () => listeners.delete(fn); } };
  const seen = [];
  const off = followQueue(queue, jobs => seen.push(jobs.length));
  for (const fn of listeners) fn([{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual(seen, [0, 2]);
  off();
  assert.equal(listeners.size, 0);
});

test('H shows no state before the queue has loaded: the first [] of subscribe is not passed on', async () => {
  const { followQueue } = await model();
  const listeners = new Set();
  let finish;
  const kept = [{ id: 'j1', liftId: 'a', state: 'queued' }, { id: 'j2', liftId: 'b', state: 'failed', error: 'x' }];
  const queue = {
    subscribe(fn) { listeners.add(fn); fn([]); return () => listeners.delete(fn); },
    load() { return new Promise(res => { finish = () => { for (const fn of listeners) fn(kept); res(kept); }; }); },
  };
  const seen = [];
  const off = followQueue(queue, jobs => seen.push(jobs.length));
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(seen, [], 'nothing is passed on while the queue loads');
  finish();
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(seen, [2], 'the kept jobs are the first thing H sees');
  for (const fn of listeners) fn([kept[0]]);
  assert.deepEqual(seen, [2, 1], 'later changes follow');
  off();
  assert.equal(listeners.size, 0);
});

test('H follows a queue whose load fails: it passes on what the queue has', async () => {
  const { followQueue } = await model();
  const queue = { subscribe(fn) { fn([]); return () => {}; }, load: () => Promise.reject(new Error('no store')) };
  const seen = [];
  followQueue(queue, jobs => seen.push(jobs.length));
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(seen, [0]);
});

test('a waiting lift says "starts after the one above" for one job ahead, the plural for more', async () => {
  const { waitingText } = await model();
  assert.equal(waitingText(1), 'Waiting · starts after the one above');
  assert.equal(waitingText(2), 'Waiting · starts after the ones ahead');
  assert.equal(waitingText(0), 'Waiting');
});

test('base.css has no literal spacing or radius: pixel values only in tokens.css', () => {
  const fs = require('node:fs');
  const css = fs.readFileSync(path.join(APP, 'src', 'styles', 'base.css'), 'utf8').replace(/@font-face[^}]*}/g, '');
  for (const m of css.matchAll(/(?:^|[;{\s])(padding|gap|margin|border-radius)[a-z-]*:\s*([^;}]*)/g)) {
    const bad = m[2].replace(/var\([^)]*\)/g, '').match(/\b[2-9]\d*px|\b1\d+px|\b[2-9]px/g);
    assert.equal(bad, null, `${m[1]}: ${m[2]}`);
  }
});

test('H\'s sections sit 16 px from the sides and 24 px (Earlier 20 px) below the cards, as in the mockup', () => {
  const fs = require('node:fs');
  const css = fs.readFileSync(path.join(APP, 'src', 'styles', 'base.css'), 'utf8');
  const tokens = fs.readFileSync(path.join(APP, 'src', 'styles', 'tokens.css'), 'utf8');
  const space = n => Number(tokens.match(new RegExp(`--space-${n}:\\s*(\\d+)px`))[1]);
  const rule = sel => css.match(new RegExp(`^${sel.replace('.', '\\.')}\\s*{([^}]*)}`, 'm'))[1];
  const pad = sel => rule(sel).match(/padding(-top)?:\s*([^;]*)/);
  const px = v => v.match(/var\(--space-(\d)\)|\b0\b/g).map(t => (t === '0' ? 0 : space(t.match(/\d/)[0])));
  assert.deepEqual(px(pad('.section')[2]), [24, 16, 0]);
  assert.deepEqual(px(pad('.section--earlier')[2]), [20]);
  const h = fs.readFileSync(path.join(APP, 'src', 'ui', 'screens', 'H.mjs'), 'utf8');
  assert.match(h, /class="section section--earlier"/);
});

test('H and Import change the flow\'s state only: no other screen, no queue or store import, no literal colour', () => {
  const fs = require('node:fs');
  for (const f of ['H.mjs', 'Import.mjs']) {
    const text = fs.readFileSync(path.join(APP, 'src', 'ui', 'screens', f), 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      assert.ok(!/analysis|store/.test(m[1]), `${f} imports ${m[1]}: the queue and the store are injected`);
      assert.ok(!m[1].startsWith('./'), `${f} imports a sibling screen: ${m[1]}`);
    }
  }
  const dir = path.join(APP, 'src', 'ui');
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(dir)) assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(fs.readFileSync(f, 'utf8')), `${f} has a literal colour`);
});

test('main.mjs makes the app\'s queue once at boot and warms the engine after the first screen draws', () => {
  const fs = require('node:fs');
  const text = fs.readFileSync(path.join(APP, 'src', 'main.mjs'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.equal((text.match(/appQueue\(/g) || []).length, 1, 'appQueue() once');
  assert.equal((text.match(/warmUp\(/g) || []).length, 1, 'warmUp() once');
  assert.ok(text.indexOf('render(') < text.indexOf('warmUp('), 'warmUp after the first draw');
});
