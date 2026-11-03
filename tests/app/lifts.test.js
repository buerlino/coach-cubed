// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// The lift registry (app/src/contracts/lifts.mjs, s49): one entry per lift, and
// everything in app/ that names a lift reads it from there. A third lift,
// registered here and only here (never in the shipped list), must reach H's
// import choices, the settings, the store and the icons with no other edit. The
// registry doesn't import diagnostics.js; these tests hold the two together:
// every shipped lift has its set in DIAGNOSTIC_SETS and its LIFT_WINDOW_SETS entry.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createFakeStorage } = require('./fake-opfs.js');
const { loadDiagnostics } = require('../loadDiagnostics');

// icons.mjs draws with Preact: give Node index.html's import map
register(pathToFileURL(path.join(__dirname, 'import-map.mjs')));

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const load = (...p) => import(pathToFileURL(path.join(APP, ...p)).href);
const registry = () => load('src', 'contracts', 'lifts.mjs');

// The test-only lift: diagnostics.js's third set, which the app doesn't offer
// (offering it is Noah's and nordmu's decision, not a test's). Its figure is
// the test's own, so the icon it gets is told apart from the raise's.
const TEST_LIFT = Object.freeze({
  id: 'clean-and-jerk',
  label: 'Clean and jerk (test only)',
  abbr: 'cj',
  provisional: true,
  icon: { head: { cx: 24, cy: 9 }, path: 'M6 15h36M24 15v17M24 32l-5 12M24 32l5 12' },
  framing: 'A test sentence: nothing in the app reads it yet.',
});

const newStore = async () => {
  const { createStore } = await load('src', 'store', 'index.mjs');
  return createStore({ storage: createFakeStorage().storage, now: () => new Date('2026-11-03T09:30:00.000Z'), appVersion: '0.1.0' });
};
const video = () => new Blob([new Uint8Array(4)], { type: 'video/mp4' });

// The figure an icon draws: its head's centre and its path, read off Preact's vnode.
function figureOf(vnode) {
  assert.equal(vnode.type, 'svg');
  const kids = [vnode.props.children].flat(Infinity).filter(Boolean);
  const head = kids.find(k => k.type === 'circle');
  const body = kids.find(k => k.type === 'path');
  return { head: { cx: Number(head.props.cx), cy: Number(head.props.cy) }, path: body.props.d };
}

test('a third lift, registered in the test only, reaches H\'s choices, the settings, the store and the icons', async () => {
  const D = loadDiagnostics();
  assert.ok(D.describe(TEST_LIFT.id).length > 0, 'the test lift is a set diagnostics.js has');
  const reg = await registry();
  assert.ok(!reg.SHIPPED_LIFTS.some(l => l.id === TEST_LIFT.id), 'the test lift is not in the shipped list');

  const undo = reg.registerLift(TEST_LIFT);
  try {
    assert.deepEqual([...reg.LIFTS], [...reg.SHIPPED_LIFTS.map(l => l.id), TEST_LIFT.id]);

    // H and L1: the lift step offers it, with its label, after the shipped lifts, and takes it into the flow
    const home = await load('src', 'ui', 'home-model.mjs');
    assert.deepEqual(home.liftChoices().at(-1), { id: TEST_LIFT.id, label: TEST_LIFT.label, provisional: true });
    assert.equal(home.liftLabel(TEST_LIFT.id), TEST_LIFT.label);
    const { createFlow } = await load('src', 'flow', 'flow.mjs');
    const flow = createFlow();
    const file = { name: 'c.mp4', type: 'video/mp4', size: 4 };
    assert.deepEqual(home.pickStep(flow, file), { ok: true });
    const lift = await load('src', 'ui', 'lift-model.mjs');
    assert.ok(lift.liftTiles(null).some(t => t.id === TEST_LIFT.id && t.provisional), 'L1 draws a tile for it');
    assert.deepEqual(lift.chooseLift(flow, TEST_LIFT.id), { ok: true });
    assert.equal(flow.params.lift, TEST_LIFT.id);

    // the settings: a default lift, which L1 rings and S1 offers
    const settings = await load('src', 'store', 'settings.mjs');
    assert.deepEqual(settings.validateSettingsPatch({ defaultLift: TEST_LIFT.id }), []);
    assert.equal(settings.readSettings({ defaultLift: TEST_LIFT.id }).defaultLift, TEST_LIFT.id);
    assert.equal(home.startLift({ defaultLift: TEST_LIFT.id }), TEST_LIFT.id);
    const { recordingView } = await load('src', 'ui', 'settings-model.mjs');
    const s1 = recordingView(settings.readSettings({ defaultLift: TEST_LIFT.id })).rows.find(r => r.field === 'defaultLift');
    assert.equal(s1.value, TEST_LIFT.id);
    assert.ok(s1.options.some(o => o.value === TEST_LIFT.id && o.label === TEST_LIFT.label), 'S1 offers it');

    // the store: the setting kept, and a lift of it filed under its own abbreviation
    const store = await newStore();
    await store.saveSettings({ defaultLift: TEST_LIFT.id });
    assert.equal((await store.getSettings()).defaultLift, TEST_LIFT.id);
    const saved = await store.saveLift({ lift: TEST_LIFT.id, video: video(), range: { t0: 0.2, t1: 2.4 } });
    assert.equal(saved.id, '20261103-093000-cj');
    assert.equal(saved.lift, TEST_LIFT.id);
    assert.deepEqual((await store.listLifts()).map(l => l.id), [saved.id]);

    // the icons: its own figure
    const { LiftIcon } = await load('src', 'ui', 'components', 'icons.mjs');
    assert.deepEqual(figureOf(LiftIcon({ lift: TEST_LIFT.id })), TEST_LIFT.icon);
  } finally {
    undo();
  }
  assert.deepEqual([...reg.LIFTS], reg.SHIPPED_LIFTS.map(l => l.id), 'undo removes it');
  const settings = await load('src', 'store', 'settings.mjs');
  assert.equal(settings.validateSettingsPatch({ defaultLift: TEST_LIFT.id }).length, 1, 'and the settings refuse it again');
});

test('a lift with no icon of its own gets the lateral raise\'s; the snatch its own', async () => {
  const reg = await registry();
  const { LiftIcon } = await load('src', 'ui', 'components', 'icons.mjs');
  const raise = LiftIcon({ lift: 'lateral-raise' });
  const { icon, ...plain } = TEST_LIFT;
  const undo = reg.registerLift(plain);
  try {
    assert.equal(LiftIcon({ lift: TEST_LIFT.id }), raise, 'no icon: the raise\'s');
  } finally {
    undo();
  }
  assert.equal(LiftIcon({ lift: 'no-such-lift' }), raise, 'an id the registry lacks: the raise\'s');
  assert.deepEqual(figureOf(LiftIcon({ lift: 'snatch' })), reg.liftOf('snatch').icon);
  assert.notDeepEqual(figureOf(raise), reg.liftOf('snatch').icon);
});

// ---- the registry and diagnostics.js ----

// The sets src/diagnostics.js lists in LIFT_WINDOW_SETS, read from its source: the object isn't exported.
function liftWindowKeys() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'diagnostics.js'), 'utf8');
  const m = src.match(/^const LIFT_WINDOW_SETS = \{\n([\s\S]*?)^\};/m);
  assert.ok(m, 'src/diagnostics.js has no LIFT_WINDOW_SETS');
  return [...m[1].matchAll(/^\s*'([a-z0-9-]+)':\s*(true|false),/gm)].map(x => x[1]);
}

// The ids among `ids` with no set in DIAGNOSTIC_SETS (describe() throws for those) or no LIFT_WINDOW_SETS entry.
function missingInDiagnostics(D, ids) {
  const windows = liftWindowKeys();
  const out = [];
  for (const id of ids) {
    let set = null;
    try { set = D.describe(id); } catch { set = null; }
    if (!set) out.push(`${id}: no set in DIAGNOSTIC_SETS`);
    if (!windows.includes(id)) out.push(`${id}: no LIFT_WINDOW_SETS entry`);
    else if (set && typeof set.hasLiftWindow !== 'boolean') out.push(`${id}: describe() gives no hasLiftWindow`);
  }
  return out;
}

test('every shipped lift has its set in diagnostics.js\'s DIAGNOSTIC_SETS and its LIFT_WINDOW_SETS entry', async () => {
  const D = loadDiagnostics();
  const { SHIPPED_LIFTS } = await registry();
  assert.deepEqual(missingInDiagnostics(D, SHIPPED_LIFTS.map(l => l.id)), []);
  // the check bites: an id diagnostics.js doesn't have is named, both ways
  assert.deepEqual(missingInDiagnostics(D, ['no-such-lift']), ['no-such-lift: no set in DIAGNOSTIC_SETS', 'no-such-lift: no LIFT_WINDOW_SETS entry']);
  // and a shipped lift's window flag is the one scoring reads (s36: a lateral raise has none)
  assert.equal(D.describe('lateral-raise').hasLiftWindow, false);
  assert.equal(D.describe('snatch').hasLiftWindow, true);
});

// ---- the shipped list ----

test('the shipped lifts: the lateral raise, then the snatch, provisional, each with v1\'s framing tip', async () => {
  const { SHIPPED_LIFTS, LIFTS, validateLiftEntry } = await registry();
  // labels and provisional as home-model.mjs had them (d13, step 3.6); abbreviations as store.mjs had them (c8);
  // the tips are v1's, quoted in s49's package; the snatch's figure is icons.mjs's from the mockup (Main.dc.html)
  assert.deepEqual(SHIPPED_LIFTS.map(({ icon, ...rest }) => rest), [
    { id: 'lateral-raise', label: 'Lateral raise', abbr: 'lr', provisional: false, framing: 'Face the camera from 3–4 m, phone at hip height, arms fully in frame.' },
    { id: 'snatch', label: 'Snatch', abbr: 'sn', provisional: true, framing: 'Film from the side, phone at hip height, bar and both feet in frame for the whole pull.' },
  ]);
  assert.equal(SHIPPED_LIFTS[0].icon, undefined, 'the lateral raise draws the default figure');
  assert.deepEqual(SHIPPED_LIFTS[1].icon, { head: { cx: 24, cy: 17 }, path: 'M5 7h38M8 3v8M40 3v8M24 23l-8-16M24 23l8-16M24 21v13M24 34l-8 4 2 6M24 34l8 4-2 6' });
  assert.ok(!SHIPPED_LIFTS.some(l => l.id === 'clean-and-jerk'), 'clean-and-jerk is not offered (a decision for Noah and nordmu)');
  for (const l of SHIPPED_LIFTS) assert.deepEqual(validateLiftEntry(l), [], l.id);
  assert.ok(Object.isFrozen(SHIPPED_LIFTS) && SHIPPED_LIFTS.every(Object.isFrozen));
  const { LIFTS: fromCommon } = await load('src', 'contracts', 'common.mjs');
  assert.deepEqual([...fromCommon], [...LIFTS]);
  assert.deepEqual([...LIFTS], ['lateral-raise', 'snatch']);
});

test('registerLift refuses an entry that breaks the registry, and names the field', async () => {
  const { registerLift, LIFTS } = await registry();
  const before = [...LIFTS];
  const refuses = (entry, field) => assert.throws(() => registerLift(entry), e => e instanceof TypeError && e.message.includes(field), field);
  refuses({ ...TEST_LIFT, id: 'snatch' }, 'id: snatch is there twice');
  refuses({ ...TEST_LIFT, abbr: 'lr' }, 'abbr: lr is another lift\'s');
  refuses({ ...TEST_LIFT, abbr: 'C1' }, 'abbr:');
  refuses({ ...TEST_LIFT, id: 'Clean Jerk' }, 'id:');
  refuses({ ...TEST_LIFT, label: '' }, 'label:');
  refuses({ ...TEST_LIFT, provisional: 'yes' }, 'provisional:');
  refuses({ ...TEST_LIFT, colour: 'red' }, 'colour: unknown field');
  refuses({ ...TEST_LIFT, icon: { head: { cx: 24, cy: 9 }, path: '<script>' } }, 'icon.path:');
  refuses({ ...TEST_LIFT, icon: { head: { cx: 60, cy: 9 }, path: 'M0 0' } }, 'icon.head:');
  refuses({ ...TEST_LIFT, framing: ' ' }, 'framing:');
  const { abbr, ...noAbbr } = TEST_LIFT;
  refuses(noAbbr, 'abbr: missing');
  assert.deepEqual([...LIFTS], before, 'nothing was added');
});

// ---- the fixtures, per lift ----

test('the page test and the assemble step take their fixtures from one list; a lift with none is listed', async () => {
  const { LIFT_FIXTURES, fixtureCoverage } = await load('tools', 'lift-fixtures.mjs');
  const { TEST_TRACKS } = await load('tools', 'assemble.mjs');
  const reg = await registry();
  assert.deepEqual(TEST_TRACKS, LIFT_FIXTURES.map(f => ({ id: f.track.id, lift: f.lift, file: f.track.file })));
  for (const f of LIFT_FIXTURES) {
    assert.ok(reg.SHIPPED_LIFTS.some(l => l.id === f.lift), `${f.lift}: a fixture for a lift the app doesn't ship`);
    assert.ok(fs.existsSync(path.join(ROOT, 'tests', 'fixtures', 'global', 'example', f.track.file)), f.track.file);
    assert.ok(fs.existsSync(path.join(ROOT, 'tests', 'app', 'clips', f.clip)), f.clip);
  }
  const shipped = fixtureCoverage();
  assert.deepEqual(shipped.untested, [], 'every shipped lift is walked by the page test');
  assert.deepEqual(shipped.walked.map(f => f.lift), reg.SHIPPED_LIFTS.map(l => l.id));

  const undo = reg.registerLift(TEST_LIFT);
  try {
    const withTest = fixtureCoverage();
    assert.deepEqual(withTest.untested, [TEST_LIFT.id], 'a registered lift with no fixture is listed, not skipped');
    assert.deepEqual(withTest.walked.map(f => f.lift), reg.SHIPPED_LIFTS.map(l => l.id));
  } finally {
    undo();
  }
});

// ---- where a lift's id may still be written out in app/src ----

test('app/src names a lift only in the registry, the settings\' default and the contracts\' examples', () => {
  const allowed = [
    ['contracts/lifts.mjs', /./],
    ['store/settings.mjs', /^\s*defaultLift: 'lateral-raise',$/],
    ['contracts/stored-lift.mjs', /^\s*lift: 'lateral-raise',$/],   // STORED_LIFT_EXAMPLE
    ['contracts/cue-view.mjs', /^\s*lift: 'lateral-raise',$/],      // RESULT_VIEW_EXAMPLE
  ];
  const found = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.m?js$/.test(e.name)) {
        const rel = path.relative(path.join(APP, 'src'), full).split(path.sep).join('/');
        fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
          if (!/'(lateral-raise|snatch)'/.test(line)) return;
          if (allowed.some(([f, re]) => f === rel && re.test(line))) return;
          found.push(`app/src/${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
  };
  walk(path.join(APP, 'src'));
  assert.deepEqual(found, []);
});
