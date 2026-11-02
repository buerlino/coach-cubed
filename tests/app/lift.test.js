'use strict';
// L1, "Which lift?" (package d53): the lift is chosen once, after the video, and M shows it. The model
// (app/src/ui/lift-model.mjs) is a plain module; the screens' files are read as text. Built-ins only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP = path.resolve(__dirname, '..', '..', 'app');
const load = (...p) => import(pathToFileURL(path.join(APP, ...p)).href);
const read = (...p) => fs.readFileSync(path.join(APP, ...p), 'utf8');
const strip = t => t.replace(/\/\/.*$/gm, '');
const FILE = { name: 'PXL_1832.mp4', type: 'video/mp4', size: 10 };

test('L1 offers the registry\'s lifts in its order, each with its label and provisional flag', async () => {
  const { liftTiles } = await load('src', 'ui', 'lift-model.mjs');
  const { liftEntries } = await load('src', 'contracts', 'lifts.mjs');
  const tiles = liftTiles(null);
  assert.deepEqual(tiles.map(t => [t.id, t.label, t.provisional]), liftEntries().map(e => [e.id, e.label, e.provisional]));
  assert.deepEqual(tiles.map(t => [t.id, t.provisional]), [['lateral-raise', false], ['snatch', true]]);
});

test('L1 marks S1\'s default lift: the first lift while the settings load or for a lift the registry lacks', async () => {
  const { liftTiles } = await load('src', 'ui', 'lift-model.mjs');
  const defaults = s => liftTiles(s).filter(t => t.isDefault).map(t => t.id);
  assert.deepEqual(defaults(null), ['lateral-raise']);
  assert.deepEqual(defaults(undefined), ['lateral-raise']);
  assert.deepEqual(defaults({}), ['lateral-raise']);
  assert.deepEqual(defaults({ defaultLift: 'squat' }), ['lateral-raise']);
  assert.deepEqual(defaults({ defaultLift: 'snatch' }), ['snatch']);
  assert.deepEqual(defaults({ defaultLift: 'lateral-raise' }), ['lateral-raise']);
});

test('a tile\'s accessible name is its label, with "provisional" where it is, and ", default" at the end for the default', async () => {
  const { liftTiles } = await load('src', 'ui', 'lift-model.mjs');
  const names = s => Object.fromEntries(liftTiles(s).map(t => [t.id, t.name]));
  assert.deepEqual(names({ defaultLift: 'snatch' }), { 'lateral-raise': 'Lateral raise', snatch: 'Snatch, provisional, default' });
  assert.deepEqual(names(null), { 'lateral-raise': 'Lateral raise, default', snatch: 'Snatch, provisional' });
});

test('choosing a lift goes to M with { file, lift }', async () => {
  const { chooseLift } = await load('src', 'ui', 'lift-model.mjs');
  const { createFlow } = await load('src', 'flow', 'flow.mjs');
  for (const lift of ['lateral-raise', 'snatch']) {
    const flow = createFlow();
    flow.go('lift', { file: FILE });
    assert.deepEqual(chooseLift(flow, lift), { ok: true });
    assert.equal(flow.state, 'mark');
    assert.deepEqual(flow.params, { file: FILE, lift });
  }
});

test('choosing a lift the registry lacks, or with no file, changes nothing', async () => {
  const { chooseLift } = await load('src', 'ui', 'lift-model.mjs');
  const { createFlow } = await load('src', 'flow', 'flow.mjs');
  const flow = createFlow();
  flow.go('lift', { file: FILE });
  assert.equal(chooseLift(flow, 'squat').ok, false);
  assert.equal(chooseLift(flow, null).ok, false);
  assert.equal(flow.state, 'lift');
  const bare = createFlow();
  bare.go('lift');
  assert.equal(chooseLift(bare, 'snatch').ok, false);
  assert.equal(bare.state, 'lift');
});

test('L1 is a screen module that draws from the registry: tiles from liftTiles, the film icon, Back, the footer line', () => {
  const l1 = read('src', 'ui', 'screens', 'L1.mjs');
  const text = strip(l1);
  assert.doesNotMatch(text, /'(lateral-raise|snatch)'/, 'no lift is written out in L1');
  assert.match(text, /export function L1\(/);
  assert.match(text, /aria-label="Back"/);
  assert.match(text, /flow\.go\('home'\)/);
  assert.match(text, /Which lift\?/);
  assert.match(text, /data-lift=\$\{[^}]+\.id\}/);
  assert.match(text, /liftTiles\(/);
  assert.match(text, /<\$\{LiftIcon\} lift=/);
  assert.match(text, /flow\.params\.file/);
  assert.match(text, /LockIcon/);
  assert.match(text, /getSettings\(/);
  assert.doesNotMatch(l1, /#[0-9a-fA-F]{3,8}\b/);
  assert.ok(!fs.existsSync(path.join(APP, 'src', 'ui', 'screens', 'Import.mjs')), 'Import.mjs is gone');
});

test('the pickers: H, the first run, M\'s problem screen and Q1 open the phone\'s picker from a real button', () => {
  const comp = read('src', 'ui', 'components', 'PickVideo.mjs');
  assert.match(comp, /<input type="file" accept="video\/\*"/);
  assert.match(comp, /<button type="button"/);
  assert.match(comp, /\.click\(\)/);
  for (const f of ['H.mjs', 'Welcome.mjs', 'M.mjs', 'Q1.mjs']) {
    const s = read('src', 'ui', 'screens', f);
    assert.match(s, /<\$\{PickVideo\}/, `${f} opens the picker`);
    assert.doesNotMatch(s, /go\("import"\)|"import"/, `${f} does not go to import`);
  }
  assert.match(read('src', 'ui', 'screens', 'Welcome.mjs'), /finishWelcome\(store, flow, 'lift', \{ file \}\)/);
});

test('the base.css no longer carries the Import screen\'s radio group and picker label', () => {
  const css = read('src', 'styles', 'base.css');
  assert.doesNotMatch(css, /\.choice\b|\.picker\b|\.mark-lift\b/);
  assert.match(css, /\.lift-tile\b/);
});
