'use strict';
// The store (c8): lifts, their cut videos, tracks and results, the index and
// the settings record, in OPFS (app/src/store/). Run against an in-memory
// fake of the OPFS calls (fake-opfs.js); the phone's real OPFS is curie's to
// measure. Built-ins only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createFakeStorage } = require('./fake-opfs.js');

const APP = path.resolve(__dirname, '..', '..', 'app');
const load = rel => import(pathToFileURL(path.join(APP, 'src', rel)).href);
const loadStore = () => load('store/index.mjs');
const loadContract = () => load('contracts/stored-lift.mjs');

const ENGINE = { model: 'movenet-thunder', backend: 'webgl', runtime: 'tfjs 4.22.0' };
// A small valid pair: a three-frame track (contracts/track.mjs) and the ResultView example (contracts/cue-view.mjs).
const loadMod = rel => import(pathToFileURL(path.join(APP, 'src', rel)).href);
let TRACK, RESULT;
test.before(async () => {
  const { trackFromFrames, appTrackMeta } = await loadMod('contracts/track.mjs');
  const { KEYPOINTS_EXAMPLE } = await loadMod('contracts/keypoints.mjs');
  const { RESULT_VIEW_EXAMPLE } = await loadMod('contracts/cue-view.mjs');
  const frames = [0, 1, 2].map(i => ({ index: i, tMs: i * 1000 / 30, keypoints: i === 1 ? null : KEYPOINTS_EXAMPLE }));
  TRACK = trackFromFrames(frames, appTrackMeta({ fps: 30, frameCount: 3, width: 640, height: 480 }));
  RESULT = RESULT_VIEW_EXAMPLE;
});
const padded = n => ({ ...TRACK, meta: { ...TRACK.meta, pad: 'x'.repeat(n) } });
const bytes = (...b) => new Blob([Uint8Array.from(b)], { type: 'video/mp4' });
const clock = iso => { let t = Date.parse(iso); return () => new Date(t++ * 1); };
const bytesOf = async blob => Array.from(new Uint8Array(await blob.arrayBuffer()));

async function setup(opts = {}) {
  const { createStore } = await loadStore();
  const fake = createFakeStorage(opts.fake);
  const make = (extra = {}) => createStore({
    storage: fake.storage, now: () => new Date('2026-11-01T17:42:05.120Z'), appVersion: '0.1.0', ...extra,
  });
  return { fake, store: make(), make, lib: await loadStore() };
}

const lr = (extra = {}) => ({ lift: 'lateral-raise', video: bytes(1, 2, 3, 4), range: { t0: 0.4, t1: 3.2 }, ...extra });

test('saves a lift: the cut, the track and the result, in its folder, and the record passes contract 3', async () => {
  const { validateStoredLift, liftPaths } = await loadContract();
  const { store, fake } = await setup();
  const saved = await store.saveLift(lr({ track: TRACK, result: RESULT, engine: ENGINE }));
  assert.deepEqual(validateStoredLift(saved), []);
  const p = liftPaths(saved.id);
  assert.equal(saved.video, p.video);
  assert.equal(saved.track, p.track);
  assert.equal(saved.result, p.result);
  assert.equal(saved.appVersion, '0.1.0');
  assert.equal(saved.created, '2026-11-01T17:42:05.120Z');
  assert.deepEqual(saved.engine, ENGINE);
  assert.ok(fake.exists(p.video) && fake.exists(p.track) && fake.exists(p.result));
  assert.deepEqual(JSON.parse(await fake.text(p.track)), TRACK);
  assert.deepEqual(await bytesOf(await store.readVideo(saved.id)), [1, 2, 3, 4]);
  assert.deepEqual(await store.readTrack(saved.id), TRACK);
  assert.deepEqual(await store.readResult(saved.id), RESULT);
  assert.deepEqual(await store.getLift(saved.id), saved);
});

test('saves a lift at Analyse: the cut alone, not analysed yet, still contract 3', async () => {
  const { validateStoredLift, isAnalysed } = await loadContract();
  const { store } = await setup();
  const saved = await store.saveLift(lr({ lift: 'snatch' }));
  assert.deepEqual(validateStoredLift(saved), []);
  assert.equal(isAnalysed(saved), false);
  assert.equal(saved.track, null);
  assert.equal(saved.result, null);
  assert.equal(saved.engine, null);
  assert.match(saved.id, /^20261101-174205-sn(-\d+)?$/);
  await assert.rejects(() => store.readTrack(saved.id), { code: 'not-found' });
});

test('an id is made from the time and the lift, and two lifts in one instant get two ids', async () => {
  const { store } = await setup();
  const a = await store.saveLift(lr());
  const b = await store.saveLift(lr());
  assert.equal(a.id, '20261101-174205-lr');
  assert.notEqual(a.id, b.id);
  assert.equal((await store.listLifts()).length, 2);
});

test('a bad lift is refused before anything is written', async () => {
  const { store, fake } = await setup();
  await assert.rejects(() => store.saveLift(lr({ lift: 'squat' })), { code: 'invalid' });
  await assert.rejects(() => store.saveLift(lr({ range: { t0: 3, t1: 1 } })), { code: 'invalid' });
  await assert.rejects(() => store.saveLift(lr({ video: 'cut.mp4' })), { code: 'invalid' });
  await assert.rejects(() => store.saveLift(lr({ track: TRACK })), { code: 'invalid' }); // a track needs a result and an engine
  await assert.rejects(() => store.saveLift(lr({ id: '../x' })), { code: 'invalid' });
  assert.deepEqual(fake.paths(), []);
});

test('lists lifts newest first, and groups today\'s apart from earlier ones (the local day)', async () => {
  const { store, lib } = await setup();
  const mk = (created, lift = 'lateral-raise') => store.saveLift(lr({ lift, created }));
  const old = await mk('2026-10-30T18:00:00.000Z');
  const yday = await mk('2026-10-31T09:00:00.000Z', 'snatch');
  const t1 = await mk('2026-11-01T08:00:00.000Z');
  const t2 = await mk('2026-11-01T16:30:00.000Z');
  assert.deepEqual((await store.listLifts()).map(l => l.id), [t2.id, t1.id, yday.id, old.id]);
  // "now" is built in local time, so the test holds in any time zone
  const now = new Date(2026, 10, 1, 12, 0, 0);
  const at = (y, m, d, h) => new Date(y, m, d, h).toISOString();
  const day = await setup();
  const e1 = await day.store.saveLift(lr({ created: at(2026, 9, 31, 23) }));
  const t3 = await day.store.saveLift(lr({ created: at(2026, 10, 1, 0) }));
  const t4 = await day.store.saveLift(lr({ created: at(2026, 10, 1, 23) }));
  const g = lib.groupLifts(await day.store.listLifts(), now);
  assert.deepEqual(g.today.map(l => l.id), [t4.id, t3.id]);
  assert.deepEqual(g.earlier.map(l => l.id), [e1.id]);
  const viaStore = await day.make({ now: () => now }).listByDay();
  assert.deepEqual(viaStore, g);
});

test('updates a lift\'s state: analysed with its track, result and engine; it stays after a restart', async () => {
  const { validateStoredLift, isAnalysed, liftPaths } = await loadContract();
  const { store, make, fake } = await setup();
  const saved = await store.saveLift(lr());
  const done = await store.updateLift(saved.id, { track: TRACK, result: RESULT, engine: ENGINE });
  assert.deepEqual(validateStoredLift(done), []);
  assert.equal(isAnalysed(done), true);
  assert.equal(done.track, liftPaths(saved.id).track);
  assert.equal(done.created, saved.created);
  assert.deepEqual(JSON.parse(await fake.text(liftPaths(saved.id).result)), RESULT);
  const again = make(); // a new store on the same folders: the app restarted
  assert.deepEqual(await again.getLift(saved.id), done);
  assert.deepEqual((await again.listLifts()).map(l => l.id), [saved.id]);
  // the range can be re-marked
  const re = await again.updateLift(saved.id, { range: { t0: 0.5, t1: 2.5 } });
  assert.deepEqual(re.range, { t0: 0.5, t1: 2.5 });
});

test('an update that would break contract 3, or name an unknown lift or field, is refused', async () => {
  const { store } = await setup();
  const saved = await store.saveLift(lr());
  await assert.rejects(() => store.updateLift(saved.id, { track: TRACK }), { code: 'invalid' }); // no result, no engine
  await assert.rejects(() => store.updateLift(saved.id, { engine: { model: 'x', backend: 'tpu', runtime: 'y' }, track: TRACK, result: RESULT }), { code: 'invalid' });
  await assert.rejects(() => store.updateLift(saved.id, { id: 'other' }), { code: 'invalid' });
  await assert.rejects(() => store.updateLift('nope', { range: { t0: 0, t1: 1 } }), { code: 'not-found' });
  assert.deepEqual(await store.getLift(saved.id), saved);
});

test('deletes a lift with its folder and leaves the others', async () => {
  const { store, fake } = await setup();
  const a = await store.saveLift(lr({ track: TRACK, result: RESULT, engine: ENGINE, created: '2026-11-01T08:00:00.000Z' }));
  const b = await store.saveLift(lr({ created: '2026-11-01T09:00:00.000Z' }));
  await store.deleteLift(a.id);
  assert.equal(fake.exists(`lifts/${a.id}`), false);
  assert.deepEqual(fake.paths().filter(p => p.includes(a.id)), []);
  assert.ok(fake.exists(`lifts/${b.id}/cut.mp4`));
  assert.deepEqual((await store.listLifts()).map(l => l.id), [b.id]);
  assert.equal(await store.getLift(a.id), null);
  await assert.rejects(() => store.deleteLift(a.id), { code: 'not-found' });
  // gone for a rebuild too
  await store.rebuildIndex();
  assert.deepEqual((await store.listLifts()).map(l => l.id), [b.id]);
});

test('the index is written atomically: a temporary file, then a move over index.json', async () => {
  const { store, fake } = await setup();
  await store.saveLift(lr());
  const writes = fake.ops.filter(o => o[0] === 'write').map(o => o[1]);
  assert.ok(!writes.includes('index.json'), 'index.json is never written in place');
  const mv = fake.ops.filter(o => o[0] === 'move');
  assert.deepEqual(mv[mv.length - 1], ['move', 'index.json.tmp', 'index.json']);
  assert.ok(fake.ops.findIndex(o => o[0] === 'write' && o[1] === 'index.json.tmp') < fake.ops.lastIndexOf(mv[mv.length - 1]));
  assert.equal(fake.exists('index.json.tmp'), false);
  assert.deepEqual(JSON.parse(await fake.text('index.json')).lifts.length, 1);
});

test('the index is rebuilt from the folders when it is missing', async () => {
  const { store, make, fake } = await setup();
  const a = await store.saveLift(lr({ created: '2026-11-01T08:00:00.000Z' }));
  const b = await store.saveLift(lr({ lift: 'snatch', created: '2026-11-01T09:00:00.000Z', track: TRACK, result: RESULT, engine: ENGINE }));
  fake.remove('index.json');
  const again = make();
  const lifts = await again.listLifts();
  assert.deepEqual(lifts.map(l => l.id), [b.id, a.id]);
  assert.deepEqual(lifts[0], b);
  assert.ok(fake.exists('index.json'), 'the rebuilt index is written back');
});

test('the index is rebuilt when it is damaged: not JSON, the wrong shape, an invalid entry', async () => {
  const { store, make, fake } = await setup();
  const a = await store.saveLift(lr());
  for (const bad of ['{"lifts": [', '[]', '{"version":1,"lifts":"x"}', JSON.stringify({ version: 1, lifts: [{ id: a.id }] }), '']) {
    fake.put('index.json', bad);
    assert.deepEqual((await make().listLifts()).map(l => l.id), [a.id], `rebuilt from ${JSON.stringify(bad)}`);
    assert.deepEqual(JSON.parse(await fake.text('index.json')).lifts.map(l => l.id), [a.id]);
  }
});

test('a rebuild skips a folder that holds no complete lift, and says which', async () => {
  const { store, make, fake } = await setup();
  const a = await store.saveLift(lr());
  fake.put('lifts/half-saved/cut.mp4', 'xx'); // a save that stopped before its record
  fake.put('lifts/broken/lift.json', '{"id":'); // a damaged record
  fake.put('lifts/stray.txt', 'x'); // a file where only folders belong
  fake.remove('index.json');
  const again = make();
  const r = await again.rebuildIndex();
  assert.deepEqual(r.lifts.map(l => l.id), [a.id]);
  assert.deepEqual(r.skipped.sort(), ['broken', 'half-saved', 'stray.txt']);
  assert.ok(fake.exists('lifts/half-saved/cut.mp4'), 'a rebuild deletes nothing');
});

test('a failed index write leaves the old index in place', async () => {
  const { store, fake } = await setup();
  const a = await store.saveLift(lr());
  const before = await fake.text('index.json');
  fake.setQuota(fake.used() + 10); // room for the cut, not for another index
  await assert.rejects(() => store.saveLift(lr({ video: bytes(1) })), { code: 'storage-full' });
  assert.equal(await fake.text('index.json'), before);
  assert.deepEqual((await store.listLifts()).map(l => l.id), [a.id]);
});

test('settings read with v1\'s defaults: a 20 s replay, a 60 s buffer, videos kept', async () => {
  const { store, lib, fake } = await setup();
  const s = await store.getSettings();
  assert.equal(s.replayS, 20);
  assert.equal(s.bufferS, 60);
  assert.equal(s.keepVideos, true);
  assert.equal(s.replayMode, 'replay');
  assert.equal(s.delayS, 10);
  assert.equal(s.defaultLift, 'lateral-raise');
  assert.equal(s.camera, 'back');
  assert.deepEqual(lib.validateSettings(s), []);
  assert.deepEqual(s, lib.DEFAULT_SETTINGS);
  assert.deepEqual(s.view, { skeleton: true, cues: true, unsure: false, loop: true, speed: 1, smoothingSigmaMs: 50 });
  assert.equal(fake.exists('settings.json'), false, 'reading writes nothing');
  s.replayS = 99; // a copy: the defaults are not shared
  assert.equal((await store.getSettings()).replayS, 20);
});

test('settings are saved by patch, kept after a restart, and an unknown or invalid one is refused', async () => {
  const { store, make } = await setup();
  const saved = await store.saveSettings({ replayS: 30, keepVideos: false, view: { speed: 0.5 } });
  assert.equal(saved.replayS, 30);
  assert.equal(saved.keepVideos, false);
  assert.equal(saved.bufferS, 60);
  assert.deepEqual(saved.view, { skeleton: true, cues: true, unsure: false, loop: true, speed: 0.5, smoothingSigmaMs: 50 });
  assert.deepEqual(await make().getSettings(), saved);
  await assert.rejects(() => store.saveSettings({ replayS: -1 }), { code: 'invalid' });
  await assert.rejects(() => store.saveSettings({ defaultLift: 'squat' }), { code: 'invalid' });
  await assert.rejects(() => store.saveSettings({ colour: 'red' }), { code: 'invalid' });
  await assert.rejects(() => store.saveSettings({ view: { zoom: 2 } }), { code: 'invalid' });
  assert.deepEqual(await make().getSettings(), saved);
});

test('a damaged settings record reads as the defaults, and fields it lacks take theirs', async () => {
  const { store, fake, lib } = await setup();
  fake.put('settings.json', '{"replayS": ');
  assert.deepEqual(await store.getSettings(), lib.DEFAULT_SETTINGS);
  fake.put('settings.json', JSON.stringify({ replayS: 15, bufferS: 'lots' }));
  const s = await store.getSettings();
  assert.equal(s.replayS, 15);
  assert.equal(s.bufferS, 60);
});

test('d51: smoothing is capped at 300 ms (A3\'s slider): the store refuses more, and an older record above it reads as 300', async () => {
  const { store, fake, lib } = await setup();
  assert.deepEqual(lib.validateSettingsPatch({ view: { smoothingSigmaMs: 300 } }), []);
  assert.match(lib.validateSettingsPatch({ view: { smoothingSigmaMs: 301 } })[0], /view\.smoothingSigmaMs: .*300/);
  await assert.rejects(() => store.saveSettings({ view: { smoothingSigmaMs: 1000 } }), { code: 'invalid' });
  // a record stored when the cap was 1000: it still reads, clamped, and the other fields stay
  fake.put('settings.json', JSON.stringify({ replayS: 15, view: { smoothingSigmaMs: 800, speed: 0.5 } }));
  const s = await store.getSettings();
  assert.equal(s.view.smoothingSigmaMs, 300);
  assert.equal(s.view.speed, 0.5);
  assert.equal(s.replayS, 15);
  assert.equal(lib.readSettings({ view: { smoothingSigmaMs: 300 } }).view.smoothingSigmaMs, 300);
  assert.equal(lib.readSettings({ view: { smoothingSigmaMs: -5 } }).view.smoothingSigmaMs, lib.DEFAULT_SETTINGS.view.smoothingSigmaMs, 'a negative or non-number value is still damaged, not clamped');
});

test('persist() is asked at the first save, once, and the answer is kept', async () => {
  const { store, make, fake } = await setup();
  assert.equal(fake.calls.persist, 0, 'not asked before a save');
  await store.saveLift(lr());
  assert.equal(fake.calls.persist, 1);
  await store.saveLift(lr());
  assert.equal(fake.calls.persist, 1, 'not asked again');
  const again = make();
  await again.saveLift(lr());
  assert.equal(fake.calls.persist, 1, 'not asked again after a restart');
  assert.equal((await again.storageInfo()).persisted, true);
  assert.equal((await again.persistAnswer()).granted, true);
});

test('a refused persist() is kept too, and does not stop the save', async () => {
  const { store, make, fake } = await setup({ fake: { persistGrant: false } });
  await store.saveLift(lr());
  await make().saveLift(lr());
  assert.equal(fake.calls.persist, 1);
  const a = await store.persistAnswer();
  assert.equal(a.granted, false);
  assert.match(a.asked, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await store.storageInfo()).persisted, false);
});

test('usage and quota come from estimate(); the lifts\' own bytes are counted too', async () => {
  const { store, fake } = await setup({ fake: { quota: 1000000 } });
  const empty = await store.storageInfo();
  assert.equal(empty.quota, 1000000);
  assert.equal(empty.usage, fake.used());
  assert.equal(empty.free, empty.quota - empty.usage);
  assert.equal(await store.liftsBytes(), 0);
  await store.saveLift(lr({ video: new Blob([new Uint8Array(5000)]) }));
  const info = await store.storageInfo();
  assert.equal(info.usage, fake.used());
  assert.ok(info.usage >= 5000);
  assert.equal(info.free, 1000000 - info.usage);
  assert.ok(fake.calls.estimate >= 2);
  const lb = await store.liftsBytes();
  assert.ok(lb >= 5000 && lb <= info.usage);
});

test('a full disk is an error the UI can show: "storage full", nothing half-saved', async () => {
  const { store, fake, lib } = await setup({ fake: { quota: 1000 } });
  const kept = await store.saveLift(lr());
  const before = fake.paths();
  let err;
  try { await store.saveLift(lr({ video: new Blob([new Uint8Array(5000)]), created: '2026-11-01T18:00:00.000Z' })); } catch (e) { err = e; }
  assert.ok(err instanceof lib.StoreError);
  assert.equal(err.code, 'storage-full');
  assert.match(err.message, /storage full/i);
  assert.equal(lib.isStorageFull(err), true);
  assert.deepEqual(fake.paths(), before, 'the half-written folder is gone');
  assert.deepEqual((await store.listLifts()).map(l => l.id), [kept.id]);
  // the same for the track and result of an update, and for the settings
  await assert.rejects(() => store.updateLift(kept.id, { track: padded(5000), result: RESULT, engine: ENGINE }), { code: 'storage-full' });
  assert.deepEqual(await store.getLift(kept.id), kept);
  assert.deepEqual(fake.paths(), before);
  fake.setQuota(fake.used());
  await assert.rejects(() => store.saveSettings({ replayS: 25 }), { code: 'storage-full' });
});

test('without OPFS the store says so, with a code the UI can show', async () => {
  const { createStore } = await loadStore();
  const s = createStore({ storage: {} });
  await assert.rejects(() => s.listLifts(), { code: 'unavailable' });
  await assert.rejects(() => s.saveLift(lr()), { code: 'unavailable' });
});

test('writes only to OPFS: only the store\'s own files appear, and its source touches no other storage', async () => {
  const { store, fake } = await setup();
  const a = await store.saveLift(lr({ track: TRACK, result: RESULT, engine: ENGINE }));
  await store.saveSettings({ replayS: 30 });
  assert.deepEqual(fake.paths(), [
    'index.json', 'lifts/', `lifts/${a.id}/`, `lifts/${a.id}/cut.mp4`, `lifts/${a.id}/lift.json`,
    `lifts/${a.id}/result.json`, `lifts/${a.id}/track.json`, 'meta.json', 'settings.json',
  ].sort());
  const dir = path.join(APP, 'src', 'store');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|caches\.|fetch\(|XMLHttpRequest|showSaveFilePicker|createObjectURL/, f);
  }
});

test('an invalid track or result is refused with "invalid", and nothing is written', async () => {
  const { store, fake } = await setup();
  const saved = await store.saveLift(lr());
  const before = fake.paths();
  const badTrack = { meta: { fps: 30 }, keypoints: [[[1, 2, 0.9]]] };
  const badResult = { cues: [], notes: [] };
  await assert.rejects(() => store.updateLift(saved.id, { track: badTrack, result: RESULT, engine: ENGINE }), { code: 'invalid', message: /track\.json/ });
  await assert.rejects(() => store.updateLift(saved.id, { track: TRACK, result: badResult, engine: ENGINE }), { code: 'invalid', message: /result\.json/ });
  await assert.rejects(() => store.saveLift(lr({ track: badTrack, result: RESULT, engine: ENGINE })), { code: 'invalid' });
  await assert.rejects(() => store.saveLift(lr({ track: TRACK, result: badResult, engine: ENGINE })), { code: 'invalid' });
  assert.deepEqual(fake.paths(), before);
  assert.deepEqual(await store.getLift(saved.id), saved);
});

test('an update whose index write fails puts everything back: the old record, and the files it overwrote or made', async () => {
  const sizeOf = v => new Blob([typeof v === 'string' ? v : JSON.stringify(v)]).size;
  // A dry run on an identical store measures the record's growth.
  const dry = await setup();
  const d0 = await dry.store.saveLift(lr());
  const d1 = await dry.store.updateLift(d0.id, { track: TRACK, result: RESULT, engine: ENGINE });
  const room = sizeOf(TRACK) + sizeOf(RESULT) + sizeOf(d1) - sizeOf(d0); // the three files, not the index

  // (a) the files are new
  const { store, fake } = await setup();
  const saved = await store.saveLift(lr());
  const before = fake.paths();
  fake.setQuota(fake.used() + room);
  await assert.rejects(() => store.updateLift(saved.id, { track: TRACK, result: RESULT, engine: ENGINE }), { code: 'storage-full' });
  assert.deepEqual(await store.getLift(saved.id), saved, 'the old record is back');
  assert.deepEqual(fake.paths(), before, 'the new files are gone');
  assert.deepEqual((await store.listLifts()).map(l => l.id), [saved.id]);

  // (b) the files are overwritten: the old ones come back byte for byte
  const two = await setup();
  const kept = await two.store.saveLift(lr({ track: TRACK, result: RESULT, engine: ENGINE }));
  const newTrack = { ...TRACK, meta: { ...TRACK.meta, pad: 'y' } };
  const trackBefore = await two.fake.text(kept.track);
  const resultBefore = await two.fake.text(kept.result);
  const recordBefore = await two.fake.text(`lifts/${kept.id}/lift.json`);
  const newEngine = { ...ENGINE, runtime: 'tfjs 4.22.10' };
  two.fake.setQuota(two.fake.used() + (sizeOf(newTrack) - sizeOf(TRACK)) + 1); // the grown track and record fit, the index copy does not
  await assert.rejects(() => two.store.updateLift(kept.id, { track: newTrack, result: RESULT, engine: newEngine }), { code: 'storage-full' });
  assert.equal(await two.fake.text(kept.track), trackBefore);
  assert.equal(await two.fake.text(kept.result), resultBefore);
  assert.equal(await two.fake.text(`lifts/${kept.id}/lift.json`), recordBefore);
  assert.deepEqual(await two.store.getLift(kept.id), kept);
  assert.deepEqual(await two.store.readTrack(kept.id), TRACK);
  assert.deepEqual(await two.store.readResult(kept.id), RESULT);
});

// The store on `fake`, but removing a folder with its content fails while `state.fail` is set.
function flaky(storage, state) {
  const wrap = d => new Proxy(d, {
    get(t, p) {
      if (p === 'removeEntry') {
        return async (name, opts) => {
          if (state.fail && opts && opts.recursive) throw new Error('the page was killed');
          return t.removeEntry(name, opts);
        };
      }
      if (p === 'getDirectoryHandle') return async (...a) => wrap(await t.getDirectoryHandle(...a));
      const v = t[p];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { ...storage, getDirectory: async () => wrap(await storage.getDirectory()) };
}

test('a delete that stops halfway can be finished: the next delete removes the folder and the entry', async () => {
  const { fake, lib } = await setup();
  const state = { fail: false };
  const store = lib.createStore({ storage: flaky(fake.storage, state), now: () => new Date('2026-11-01T17:42:05.120Z') });
  const a = await store.saveLift(lr({ created: '2026-11-01T08:00:00.000Z', track: TRACK, result: RESULT, engine: ENGINE }));
  const b = await store.saveLift(lr({ created: '2026-11-01T09:00:00.000Z' }));
  state.fail = true;
  await assert.rejects(() => store.deleteLift(a.id), /killed/);
  assert.ok(fake.exists(`lifts/${a.id}/cut.mp4`), 'the cut is still there');
  assert.equal(fake.exists(`lifts/${a.id}/lift.json`), false, 'the record went first');
  assert.deepEqual((await store.listLifts()).map(l => l.id), [b.id, a.id], 'the index still lists it');
  state.fail = false;
  await store.deleteLift(a.id); // the retry: not "not-found"
  assert.deepEqual(fake.paths().filter(p => p.includes(a.id)), []);
  assert.deepEqual((await store.listLifts()).map(l => l.id), [b.id]);
  assert.ok(fake.exists(`lifts/${b.id}/cut.mp4`));
  await assert.rejects(() => store.deleteLift(a.id), { code: 'not-found' });
});

test('a record-less folder (a delete that stopped, and the index lost) is removed by a delete too', async () => {
  const { store, fake } = await setup();
  const a = await store.saveLift(lr());
  fake.remove(`lifts/${a.id}/lift.json`);
  fake.remove('index.json');
  await store.deleteLift(a.id);
  assert.equal(fake.exists(`lifts/${a.id}`), false);
});
