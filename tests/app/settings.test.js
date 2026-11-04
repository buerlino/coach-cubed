// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// S1, Settings and about (package d24): the settings model (app/src/ui/settings-model.mjs),
// the credits (app/src/credits.mjs) against THIRD_PARTY.md, and what assemble ships. The screen
// (screens/S1.mjs) is Preact and is checked in a browser (c21); everything it draws comes from the
// model, so the model is what these tests pin. Built-ins only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createFakeStorage } = require('./fake-opfs.js');
const { tempDir } = require('../fixtures.js');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const load = (...p) => import(pathToFileURL(path.join(APP, ...p)).href);
const model = () => load('src', 'ui', 'settings-model.mjs');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

async function setup(opts = {}) {
  const { createStore } = await load('src', 'store', 'index.mjs');
  const fake = createFakeStorage(opts.fake);
  const make = () => createStore({ storage: fake.storage, now: () => new Date('2026-11-02T10:00:00.000Z'), appVersion: '0.1.0' });
  return { fake, store: make(), make };
}
const lr = (bytes = 4) => ({ lift: 'lateral-raise', video: new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }), range: { t0: 0.4, t1: 3.2 } });

// ---- the settings ----

test('S1 shows v1\'s defaults from the store, in the mockup\'s words', async () => {
  const { recordingView } = await model();
  const { store } = await setup();
  const v = recordingView(await store.getSettings());
  assert.deepEqual(v.rows.map(r => [r.label, r.shown]), [
    ['Replay length', '20 s'], ['Keep in memory', 'last 60 s'], ['Camera', 'Back'],
    ['Quality', '1080p · 30 fps'], ['Default lift', 'Lateral raise'],
  ]);
  assert.deepEqual(v.modes.map(m => [m.label, m.on]), [['Replay button', true], ['Delayed view', false]]);
  assert.equal(v.note, 'Up to 30 fps; less in dim light.');
});

test('the delayed view swaps the replay length for the delay, 10 s by default', async () => {
  const { recordingView } = await model();
  const { store } = await setup();
  const v = recordingView(await store.saveSettings({ replayMode: 'delayed' }));
  assert.deepEqual(v.rows.map(r => [r.label, r.shown]).slice(0, 2), [['Delay', '10 s'], ['Keep in memory', 'last 60 s']]);
  assert.equal(v.modes.find(m => m.on).label, 'Delayed view');
});

test('a choice is saved, kept after a restart and shown again', async () => {
  const { recordingView } = await model();
  const { store, make } = await setup();
  await store.saveSettings({ defaultLift: 'snatch' });
  const again = recordingView(await make().getSettings());
  assert.equal(again.rows.find(r => r.field === 'defaultLift').shown, 'Snatch');
});

test('d28, d29b: the replay mode, lengths, buffer, camera and the delay are enabled; the quality (one value) is not', async () => {
  const { recordingView, NOT_YET } = await model();
  const { store } = await setup();
  const v = recordingView(await store.getSettings());
  assert.equal(v.modesDisabled, false);
  assert.deepEqual([...NOT_YET].sort(), ['quality']);
  for (const r of v.rows) assert.equal(r.disabled, NOT_YET.includes(r.field), r.field);
  assert.equal(recordingView({ ...(await store.getSettings()), replayMode: 'delayed' }).rows[0].disabled, false, 'the delay, which R3b uses (d29b)');
});

test('S1 offers values only inside c8\'s ranges, and the default among them', async () => {
  const { lengthOptions } = await model();
  const { RANGES, DEFAULT_SETTINGS } = await load('src', 'store', 'index.mjs');
  assert.deepEqual(RANGES, { replayS: { min: 5, max: 60 }, delayS: { min: 5, max: 20 }, bufferS: { min: 10, max: 300 } });
  for (const field of ['replayS', 'delayS', 'bufferS']) {
    const values = lengthOptions(field, DEFAULT_SETTINGS[field]).map(o => o.value);
    assert.ok(values.length > 1, field);
    assert.ok(values.includes(DEFAULT_SETTINGS[field]), `${field} offers its default`);
    for (const v of values) assert.ok(v >= RANGES[field].min && v <= RANGES[field].max, `${field} ${v}`);
  }
});

test('every value S1 offers, the store accepts', async () => {
  const { recordingView } = await model();
  const { store } = await setup();
  for (const mode of ['replay', 'delayed']) {
    const v = recordingView(await store.saveSettings({ replayMode: mode }));
    for (const r of v.rows) for (const o of r.options) await store.saveSettings({ [r.field]: o.value });
  }
});

test('"Keep the video of each analysed lift" is not drawn in 0.1.0, but keepVideos stays in the store', async () => {
  const { recordingView, storageView } = await model();
  const { store } = await setup();
  const s = await store.getSettings();
  assert.equal(s.keepVideos, true, 'the store keeps the field, true by default (D2)');
  const drawn = JSON.stringify([recordingView(s), storageView({ count: 3, liftsBytes: 5000, info: null })]);
  assert.doesNotMatch(drawn, /keep the video|keepVideos|Off: keep only/i);
  const screen = read('app', 'src', 'ui', 'screens', 'S1.mjs').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(screen, /keepVideos|Keep the video|role="switch"/);
});

test('the provisional ranges are said in settings.mjs above FIELDS and in the README\'s store section', () => {
  const src = read('app', 'src', 'store', 'settings.mjs');
  const at = src.indexOf('const FIELDS');
  assert.ok(at > 0);
  const above = src.slice(src.lastIndexOf('\n\n', at), at);
  assert.match(above, /PROVISIONAL/);
  // c27 runs on the laptop alone (nordmu, 2026-11-02): c30 measures the buffer's memory on the phone
  assert.match(above, /c30/);
  assert.doesNotMatch(src, /c27/);
  const readme = read('app', 'README.md');
  const store = readme.slice(readme.indexOf('## The store'), readme.indexOf('## The frame source'));
  assert.match(store, /provisional/i);
  assert.match(store, /c30/);
  assert.doesNotMatch(store, /until `c27`/);
});

// ---- storage ----

test('storage shows what the lifts hold, what the app uses and the room left, from the store\'s estimate', async () => {
  const { loadStorage, storageView, formatBytes } = await model();
  const { store } = await setup({ fake: { quota: 5e6 } });
  await store.saveLift(lr(1500));
  await store.saveLift(lr(2500));
  const view = storageView(await loadStorage(store));
  const info = await store.storageInfo();
  assert.equal(view.lifts, `2 lifts · ${formatBytes(await store.liftsBytes())}`);
  assert.equal(view.used, formatBytes(info.usage));
  assert.equal(view.free, formatBytes(info.free));
  assert.equal(view.canDelete, true);
});

test('storage not persisted is information, never an error (the APK\'s WebView answers persist() with false)', async () => {
  const { loadStorage, storageView } = await model();
  const { store } = await setup({ fake: { persistGrant: false } });
  await store.saveLift(lr());
  const view = storageView(await loadStorage(store));
  assert.equal(view.persisted, 'No');
  assert.ok(view.persistedNote, 'it says what that means');
  assert.doesNotMatch(JSON.stringify(view), /error|failed|denied|warning/i);
  const granted = (await setup()).store;
  await granted.saveLift(lr());
  const ok = storageView(await loadStorage(granted));
  assert.equal(ok.persisted, 'Yes');
  assert.equal(ok.persistedNote, null);
});

test('a storage figure that cannot be read says unknown instead of throwing', async () => {
  const { loadStorage, storageView } = await model();
  const fail = async () => { throw new Error('x'); };
  const view = storageView(await loadStorage({ listLifts: fail, liftsBytes: fail, storageInfo: fail }));
  assert.equal(view.used, 'unknown');
  assert.equal(view.persisted, 'unknown');
  assert.equal(view.canDelete, false);
});

test('byte and lift counts read like the mockup: "23 lifts · 412 MB"', async () => {
  const { formatBytes, liftsText } = await model();
  assert.equal(`${liftsText(23)} · ${formatBytes(412e6)}`, '23 lifts · 412 MB');
  assert.equal(liftsText(1), '1 lift');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1500), '1.5 kB');
  assert.equal(formatBytes(null), 'unknown');
});

test('delete all removes every lift, and is held back while the queue has work', async () => {
  const { deleteAllLifts, queueBusy, loadStorage, storageView } = await model();
  const { store } = await setup();
  await store.saveLift(lr());
  await store.saveLift(lr());
  assert.equal(await deleteAllLifts(store), 2);
  assert.deepEqual(await store.listLifts(), []);
  assert.equal(await store.liftsBytes(), 0);
  assert.equal(storageView(await loadStorage(store)).canDelete, false);
  assert.equal(queueBusy([{ state: 'done' }, { state: 'failed' }]), false);
  for (const state of ['queued', 'reading', 'pose', 'scoring']) assert.equal(queueBusy([{ state }]), true, state);
});

// ---- about ----

test('the privacy text says what the app keeps, where, and that it sends nothing; it carries no draft text', async () => {
  const { PRIVACY } = await model();
  const all = `${PRIVACY.lead} ${PRIVACY.body}`;
  assert.match(all, /Nothing leaves this phone/);
  assert.match(all, /cut video/);
  assert.match(all, /pose track/);
  assert.match(all, /private storage on this phone/);
  assert.match(all, /sends nothing/);
  assert.equal('draft' in PRIVACY, false, 'nordmu approved the text on 2026-11-02');
  assert.doesNotMatch(JSON.stringify(PRIVACY), /draft|to approve/i);
  const screen = read('app', 'src', 'ui', 'screens', 'S1.mjs').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(screen, /draft|to approve/i, 'S1 shows no draft tag');
  assert.match(screen, /PRIVACY\.lead/);
});

// ---- the credits ----

/** The first cells of the table in THIRD_PARTY.md's "In the new app (`app/`)" section. */
function newAppRows() {
  const md = read('THIRD_PARTY.md');
  const from = md.indexOf('## In the new app (`app/`)');
  const to = md.indexOf('\n## ', from + 1);
  assert.ok(from >= 0 && to > from);
  return md.slice(from, to).split('\n')
    .filter(l => l.startsWith('| ') && !l.startsWith('| Component') && !l.startsWith('| ---'))
    .map(l => l.slice(2).split(' | ')[0].replace(/`/g, ''));
}

test('the credits list every component of THIRD_PARTY.md\'s section for the new app, in its order, and none of the old page\'s', async () => {
  const { CREDITS } = await load('src', 'credits.mjs');
  const rows = newAppRows();
  assert.ok(rows.length >= 14, `the table has ${rows.length} rows`);
  assert.equal(CREDITS.length, rows.length, 'one credit per row');
  rows.forEach((cell, i) => assert.ok(cell.startsWith(CREDITS[i].row), `row ${i}: "${cell.slice(0, 40)}" starts with "${CREDITS[i].row}"`));
  const text = JSON.stringify(CREDITS);
  for (const old of ['MediaPipe', 'three.js', 'BodyParts3D']) assert.doesNotMatch(text, new RegExp(old), `${old} is the old page's`);
  for (const c of CREDITS) {
    assert.ok(c.name && c.version && c.licence && c.notice && c.text, c.row);
    assert.match(c.licence, /^(MIT|Apache-2\.0|OFL-1\.1|MPL-2\.0|CC-BY-SA-4\.0)$/);
  }
});

test('each credit\'s licence text is in the repo, or comes from the TF.js build, and is the licence it names', async () => {
  const { CREDITS } = await load('src', 'credits.mjs');
  const MARK = { MIT: /Permission is hereby granted, free of charge/, 'Apache-2.0': /Apache License\s+Version 2\.0/, 'OFL-1.1': /SIL OPEN FONT LICENSE Version 1\.1/i, 'MPL-2.0': /Mozilla Public License Version 2\.0/, 'CC-BY-SA-4.0': /Attribution-ShareAlike 4\.0 International/ };
  for (const c of CREDITS) {
    const file = path.join(APP, c.text);
    if (c.built && !fs.existsSync(file)) continue; // app/vendor/tfjs/ is gitignored: made by build-tfjs.mjs
    assert.ok(fs.existsSync(file), `${c.name}: ${c.text} exists`);
    assert.match(fs.readFileSync(file, 'utf8'), MARK[c.licence], `${c.name}: ${c.text} holds ${c.licence}`);
  }
  assert.ok(CREDITS.filter(c => c.built).every(c => c.text.startsWith('vendor/tfjs/LICENSE-')));
});

test('the URLs the screen fetches point at the files assemble ships', async () => {
  const { CREDITS, creditUrl, thirdPartyUrl } = await load('src', 'credits.mjs');
  const { fileURLToPath } = require('node:url');
  for (const c of CREDITS) assert.equal(fileURLToPath(creditUrl(c)), path.join(APP, c.text));
  assert.equal(fileURLToPath(thirdPartyUrl()), path.join(APP, 'licences', 'THIRD_PARTY.md'));
});

test('assemble ships the licence texts and THIRD_PARTY.md, so the credits read offline', async (t) => {
  const { assemble, checkLicences } = await load('tools', 'assemble.mjs');
  const { CREDITS } = await load('src', 'credits.mjs');
  const out = tempDir('coach-d24-');
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const { files } = assemble({ out, app: APP, src: path.join(ROOT, 'src'), log: () => {} });
  assert.deepEqual(await checkLicences(out, APP), []);
  const have = fs.existsSync(path.join(out, 'vendor', 'tfjs'));
  for (const c of CREDITS) if (!c.built || have) assert.ok(files.includes(c.text), `${c.text} is in files.json, so the service worker caches it`);
  assert.ok(files.includes('licences/THIRD_PARTY.md'));
  const shipped = fs.readFileSync(path.join(out, 'licences', 'THIRD_PARTY.md'), 'utf8');
  assert.ok(shipped.startsWith('## In the new app (`app/`)'));
  assert.ok(shipped.includes('| Preact') && shipped.includes('mediabunny'));
  assert.equal(shipped.split('\n').filter(l => l.startsWith('## ')).length, 1, 'one section only');
  for (const old of ['In the old page', 'MediaPipe', 'BodyParts3D', 'three.js', 'In the dev server', 'Phase 3 spike', 'ultralytics']) {
    assert.ok(!shipped.includes(old), `the shipped list has no "${old}"`);
  }
});

test('checkLicences names a text the credits need and the output lacks', async (t) => {
  const { assemble, checkLicences } = await load('tools', 'assemble.mjs');
  const out = tempDir('coach-d24-');
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  assemble({ out, app: APP, src: path.join(ROOT, 'src'), log: () => {} });
  fs.rmSync(path.join(out, 'vendor', 'htm', 'LICENSE'));
  assert.deepEqual(await checkLicences(out, APP), ['vendor/htm/LICENSE']);
});

// ---- the look ----

test('the screens use tokens only: no hex colour in app/src/ui/', () => {
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(APP, 'src', 'ui'))) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /#[0-9a-fA-F]{3,8}\b/, f);
});

test('S1 draws the mockup\'s strings for what this package builds', () => {
  const screen = read('app', 'src', 'ui', 'screens', 'S1.mjs') + read('app', 'src', 'ui', 'settings-model.mjs');
  for (const s of ['Settings and about', 'Gym session', 'How the replay shows up', 'Replay button', 'Delayed view', 'Replay length', 'Delay', 'Keep in memory', 'Camera',
    'Quality', 'Default lift', 'Storage', 'On this phone', 'Delete all lifts…', 'About', 'Credits and licences', 'How the cues are scored', 'Source code', 'AGPL-3.0-or-later',
    'Back to home', 'Up to 30 fps; less in dim light.']) assert.ok(screen.includes(s), s);
});

test('"Delete all lifts…" is drawn as the destructive action: danger colour, weight 600, quiet when disabled', () => {
  const screen = read('app', 'src', 'ui', 'screens', 'S1.mjs');
  assert.match(screen, /class="row row--action row--danger"[^\n]*>Delete all lifts…/);
  const css = read('app', 'src', 'styles', 'base.css');
  assert.match(css, /\.row--danger\s*\{[^}]*color:\s*var\(--danger-text\)[^}]*font-weight:\s*var\(--weight-semibold\)/);
  assert.match(css, /\.row--danger:disabled\s*\{[^}]*color:\s*var\(--text-quiet\)/);
});

test('app/licences/Apache-2.0.txt is apache.org\'s LICENSE-2.0.txt byte for byte, as THIRD_PARTY.md says', () => {
  const crypto = require('node:crypto');
  const buf = fs.readFileSync(path.join(APP, 'licences', 'Apache-2.0.txt'));
  assert.equal(buf.length, 11358);
  assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');
  assert.ok(read('THIRD_PARTY.md').includes('cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'));
});
