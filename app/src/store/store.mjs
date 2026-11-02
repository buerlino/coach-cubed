// The store (c8): the lifts, their cut videos, tracks and results, the
// settings and the quota, all in OPFS (navigator.storage.getDirectory()) and
// nowhere else. Plain module, no DOM; `storage` is injectable, so tests run it
// on an in-memory fake (tests/app/fake-opfs.js).
//
// The layout, from the store's root (app/README.md has the long version):
//   index.json            the lifts' records, newest first: a cache of the folders
//   settings.json         S1's choices and A3's view options (settings.mjs)
//   meta.json             the answer persist() gave, kept so it is asked once
//   lifts/<id>/cut.mp4    the cut video (D6)
//   lifts/<id>/track.json the track, once analysed (contract: track.mjs)
//   lifts/<id>/result.json the ResultView, once analysed (cue-view.mjs)
//   lifts/<id>/lift.json  the StoredLift record (contract 3): written last in a
//                         save, so a folder with it is a complete lift and the
//                         index can be rebuilt from the folders alone.
// Every file is written whole (a writable commits on close). index.json,
// settings.json and meta.json are written atomically: a temporary file, then
// a move over the real one.
import { LIFTS_DIR, ID_RE } from '../contracts/common.mjs';
import { liftPaths, validateStoredLift } from '../contracts/stored-lift.mjs';
import { applySettings, readSettings, validateSettings, validateSettingsPatch } from './settings.mjs';

/** The app's version, stored with each lift (the manifest carries none yet). */
export const APP_VERSION = '0.1.0';

const INDEX = 'index.json';
const SETTINGS = 'settings.json';
const META = 'meta.json';
const LIFT_RECORD = 'lift.json';
const INDEX_VERSION = 1;
const LIFT_ABBR = { 'lateral-raise': 'lr', snatch: 'sn' };

/**
 * An error the UI can show. `code`: 'storage-full' (D3: the disk is full),
 * 'unavailable' (no OPFS), 'not-found' (no such lift or file), 'invalid'
 * (what was asked breaks a contract; the message lists why).
 */
export class StoreError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export const isStorageFull = e => e instanceof StoreError && e.code === 'storage-full';

const STORAGE_FULL = 'Storage full: there is no room left on this phone to save. Delete lifts or free some space, then try again.';

function wrap(e) {
  if (e instanceof StoreError) return e;
  if (e && (e.name === 'QuotaExceededError' || e.code === 22)) return new StoreError('storage-full', STORAGE_FULL, e);
  if (e && e.name === 'NotFoundError') return new StoreError('not-found', `Not found in the store: ${e.message}`, e);
  return e;
}

const isMissing = e => e && e.name === 'NotFoundError';
const invalid = (what, errors) => new StoreError('invalid', `${what}: ${errors.join('; ')}`);

/** Newest first; the id breaks a tie. */
const newestFirst = (a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : (a.id < b.id ? 1 : -1));

const localDay = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * Splits lifts into those stored on the local calendar day of `now` and the
 * earlier (or later) ones, each in the order given.
 * @param {import('../contracts/stored-lift.mjs').StoredLift[]} lifts
 * @param {Date} now
 */
export function groupLifts(lifts, now) {
  const today = localDay(now);
  const out = { today: [], earlier: [] };
  for (const l of lifts) out[localDay(new Date(l.created)) === today ? 'today' : 'earlier'].push(l);
  return out;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
function idBase(created, lift) {
  const d = new Date(created);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${LIFT_ABBR[lift] || 'x'}`;
}

function asBlob(v) {
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v;
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return new Blob([v], { type: 'video/mp4' });
  return null;
}

/**
 * @param {Object} [options]
 * @param {Object} [options.storage] navigator.storage, or a fake: getDirectory(), persist(), persisted(), estimate()
 * @param {() => Date} [options.now]
 * @param {string} [options.appVersion] stored with each lift
 */
export function createStore({ storage = globalThis.navigator && globalThis.navigator.storage, now = () => new Date(), appVersion = APP_VERSION } = {}) {
  let rootDir = null;
  const root = async () => {
    if (rootDir) return rootDir;
    if (!storage || typeof storage.getDirectory !== 'function') {
      throw new StoreError('unavailable', "This browser can't keep files for the app (no private file storage).");
    }
    rootDir = await storage.getDirectory();
    return rootDir;
  };

  // One change at a time: a save reads the index and writes it back.
  let chain = Promise.resolve();
  const exclusive = fn => {
    const p = chain.then(async () => { try { return await fn(); } catch (e) { throw wrap(e); } });
    chain = p.catch(() => {});
    return p;
  };

  // ---- files ----
  async function dirAt(parts, create) {
    let d = await root();
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return d;
  }
  async function exists(dir, name) {
    try { await dir.getFileHandle(name); return true; } catch (e) { if (isMissing(e)) return false; throw e; }
  }
  /** Writes a whole file. A file it created and could not fill is removed again. */
  async function writeFile(dir, name, data) {
    const existed = await exists(dir, name);
    const fh = await dir.getFileHandle(name, { create: true });
    try {
      const w = await fh.createWritable();
      try { await w.write(data); await w.close(); } catch (e) { await w.abort().catch(() => {}); throw e; }
    } catch (e) {
      if (!existed) await dir.removeEntry(name).catch(() => {});
      throw e;
    }
  }
  /** Write, then move over the real name: the real file is whole before and after. */
  async function writeAtomic(dir, name, text) {
    const tmp = `${name}.tmp`;
    await writeFile(dir, tmp, text);
    const fh = await dir.getFileHandle(tmp);
    if (typeof fh.move !== 'function') { // an engine without move(): write in place
      await writeFile(dir, name, text);
      await dir.removeEntry(tmp).catch(() => {});
      return;
    }
    try { await fh.move(name); } catch (e) { await dir.removeEntry(tmp).catch(() => {}); throw e; }
  }
  /** A JSON file's value; null when it is missing or not JSON. */
  async function readJson(dir, name) {
    try {
      const f = await (await dir.getFileHandle(name)).getFile();
      return JSON.parse(await f.text());
    } catch (e) {
      if (isMissing(e) || e instanceof SyntaxError) return null;
      throw e;
    }
  }
  async function fileAt(p) {
    const parts = p.split('/');
    const name = parts.pop();
    const dir = await dirAt(parts, false);
    return (await dir.getFileHandle(name)).getFile();
  }

  // ---- the index ----
  const indexOk = j => j && j.version === INDEX_VERSION && Array.isArray(j.lifts) && j.lifts.every(l => validateStoredLift(l).length === 0);
  const writeIndex = async lifts => {
    const sorted = [...lifts].sort(newestFirst);
    await writeAtomic(await root(), INDEX, JSON.stringify({ version: INDEX_VERSION, lifts: sorted }));
    return sorted;
  };

  /** Reads every folder's record. Deletes nothing. */
  async function scan() {
    const lifts = [];
    const skipped = [];
    let liftsDir;
    try { liftsDir = await dirAt([LIFTS_DIR], false); } catch (e) { if (isMissing(e)) return { lifts, skipped }; throw e; }
    for await (const [name, handle] of liftsDir.entries()) {
      if (handle.kind !== 'directory') { skipped.push(name); continue; }
      const rec = await readJson(handle, LIFT_RECORD);
      if (rec && rec.id === name && validateStoredLift(rec).length === 0) lifts.push(rec);
      else skipped.push(name);
    }
    return { lifts: lifts.sort(newestFirst), skipped };
  }

  async function rebuild() {
    const found = await scan();
    await writeIndex(found.lifts);
    return found;
  }

  async function loadIndex() {
    const j = await readJson(await root(), INDEX);
    if (indexOk(j)) return j.lifts;
    const found = await scan();
    try { await writeIndex(found.lifts); } catch (e) { if (wrap(e).code !== 'storage-full') throw e; } // reading still works on a full disk
    return found.lifts;
  }

  async function record(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    try { return await readJson(await dirAt([LIFTS_DIR, id], false), LIFT_RECORD); } catch (e) { if (isMissing(e)) return null; throw e; }
  }

  async function requireRecord(id) {
    const rec = await record(id);
    if (!rec) throw new StoreError('not-found', `No lift ${JSON.stringify(id)} in the store.`);
    return rec;
  }

  // ---- persist() and the quota ----
  async function ensurePersisted() {
    const dir = await root();
    const meta = await readJson(dir, META);
    if (meta && meta.persist && typeof meta.persist.granted === 'boolean') return meta.persist;
    let granted = false;
    try { granted = !!(typeof storage.persist === 'function' && await storage.persist()); } catch { granted = false; }
    const persist = { asked: now().toISOString(), granted };
    try { await writeAtomic(dir, META, JSON.stringify({ persist })); } catch { /* asked again next time */ }
    return persist;
  }

  // ---- lifts ----
  
  async function freshId(created, lift) {
    const taken = new Set((await loadIndex()).map(l => l.id));
    const base = idBase(created, lift);
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      if (!taken.has(id) && !(await dirAt([LIFTS_DIR, id], false).then(() => true, () => false))) return id;
    }
  }

  async function saveLift(input) {
    const known = ['lift', 'video', 'range', 'track', 'result', 'engine', 'id', 'created'];
    if (!input || typeof input !== 'object') throw invalid('saveLift', ['must be an object']);
    const extra = Object.keys(input).filter(k => !known.includes(k));
    if (extra.length) throw invalid('saveLift', extra.map(k => `${k}: unknown field`));
    const blob = asBlob(input.video);
    const created = input.created ?? now().toISOString();
    const build = id => {
      const p = liftPaths(id);
      return {
        id, created, lift: input.lift, video: p.video, range: input.range,
        track: input.track !== undefined ? p.track : null,
        result: input.result !== undefined ? p.result : null,
        appVersion, engine: input.engine ?? null,
      };
    };
    const precheck = validateStoredLift(build(input.id ?? idBase(new Date(Date.parse(created) || 0), input.lift)));
    if (!blob) precheck.unshift('video: must be a Blob (or bytes) holding the cut');
    if (precheck.length) throw invalid('lift', precheck);

    return exclusive(async () => {
      const id = input.id ?? await freshId(created, input.lift);
      if (input.id && (await record(id))) throw invalid('lift', [`id: ${id} is already stored`]);
      const rec = build(id);
      const errors = validateStoredLift(rec);
      if (errors.length) throw invalid('lift', errors);

      await ensurePersisted();
      const lifts = await loadIndex();
      const lifdir = await dirAt([LIFTS_DIR], true);
      const made = !(await lifdir.getDirectoryHandle(id).then(() => true, () => false));
      const folder = await lifdir.getDirectoryHandle(id, { create: true });
      try {
        await writeFile(folder, 'cut.mp4', blob);
        if (rec.track) await writeFile(folder, 'track.json', JSON.stringify(input.track));
        if (rec.result) await writeFile(folder, 'result.json', JSON.stringify(input.result));
        await writeFile(folder, LIFT_RECORD, JSON.stringify(rec));
        await writeIndex([...lifts.filter(l => l.id !== id), rec]);
      } catch (e) {
        if (made) await lifdir.removeEntry(id, { recursive: true }).catch(() => {});
        throw e;
      }
      return rec;
    });
  }

  async function updateLift(id, patch) {
    const known = ['track', 'result', 'engine', 'range'];
    if (!patch || typeof patch !== 'object') throw invalid('updateLift', ['must be an object']);
    const extra = Object.keys(patch).filter(k => !known.includes(k));
    if (extra.length) throw invalid('updateLift', extra.map(k => `${k}: can't be updated`));
    return exclusive(async () => {
      const cur = await requireRecord(id);
      const p = liftPaths(id);
      const next = { ...cur };
      if (patch.range !== undefined) next.range = patch.range;
      if (patch.track !== undefined) next.track = p.track;
      if (patch.result !== undefined) next.result = p.result;
      if (patch.engine !== undefined) next.engine = patch.engine;
      const errors = validateStoredLift(next);
      if (errors.length) throw invalid('lift', errors);

      const lifts = await loadIndex();
      const folder = await dirAt([LIFTS_DIR, id], false);
      const fresh = [];
      try {
        for (const [key, name] of [['track', 'track.json'], ['result', 'result.json']]) {
          if (patch[key] === undefined) continue;
          if (!(await exists(folder, name))) fresh.push(name);
          await writeFile(folder, name, JSON.stringify(patch[key]));
        }
        await writeFile(folder, LIFT_RECORD, JSON.stringify(next));
        await writeIndex([...lifts.filter(l => l.id !== id), next]);
      } catch (e) {
        for (const name of fresh) await folder.removeEntry(name).catch(() => {});
        throw e;
      }
      return next;
    });
  }

  async function deleteLift(id) {
    return exclusive(async () => {
      await requireRecord(id);
      const lifdir = await dirAt([LIFTS_DIR], false);
      const folder = await lifdir.getDirectoryHandle(id);
      // The record first: without it the folder is no lift, even if the next step stops.
      // Then the folder, to free the room before the (smaller) index is written.
      await folder.removeEntry(LIFT_RECORD);
      await lifdir.removeEntry(id, { recursive: true });
      const lifts = await loadIndex();
      await writeIndex(lifts.filter(l => l.id !== id));
    });
  }

  const readJsonOf = async (id, key) => {
    const rec = await requireRecord(id);
    if (!rec[key]) throw new StoreError('not-found', `Lift ${id} has no ${key} yet.`);
    try { return JSON.parse(await (await fileAt(rec[key])).text()); } catch (e) {
      if (isMissing(e)) throw new StoreError('not-found', `Lift ${id}: ${rec[key]} is missing.`, e);
      throw e;
    }
  };

  // ---- settings ----
  async function getSettings() {
    return exclusive(async () => readSettings(await readJson(await root(), SETTINGS)));
  }
  async function saveSettings(patch) {
    const errors = validateSettingsPatch(patch);
    if (errors.length) throw invalid('settings', errors);
    return exclusive(async () => {
      const dir = await root();
      const next = applySettings(readSettings(await readJson(dir, SETTINGS)), patch);
      const bad = validateSettings(next);
      if (bad.length) throw invalid('settings', bad);
      await writeAtomic(dir, SETTINGS, JSON.stringify(next));
      return next;
    });
  }

  // ---- usage ----
  async function folderBytes(dir) {
    let n = 0;
    for await (const [, h] of dir.entries()) n += h.kind === 'directory' ? await folderBytes(h) : (await h.getFile()).size;
    return n;
  }

  return {
    saveLift,
    updateLift,
    deleteLift,
    getLift: id => exclusive(() => record(id)),
    listLifts: () => exclusive(loadIndex),
    listByDay: () => exclusive(async () => groupLifts(await loadIndex(), now())),
    /** Reads every folder and writes the index again. @returns {Promise<{lifts: object[], skipped: string[]}>} */
    rebuildIndex: () => exclusive(rebuild),
    readVideo: id => exclusive(async () => {
      const rec = await requireRecord(id);
      try { return await fileAt(rec.video); } catch (e) {
        if (isMissing(e)) throw new StoreError('not-found', `Lift ${id}: ${rec.video} is missing.`, e);
        throw e;
      }
    }),
    readTrack: id => exclusive(() => readJsonOf(id, 'track')),
    readResult: id => exclusive(() => readJsonOf(id, 'result')),
    getSettings,
    saveSettings,
    /** What persist() answered the first time, `{asked, granted}`, or null before the first save. */
    persistAnswer: () => exclusive(async () => ((await readJson(await root(), META)) || {}).persist || null),
    /** S1's numbers: the origin's usage and quota from estimate(), the room left, and whether it is persistent. */
    storageInfo: () => exclusive(async () => {
      await root();
      const est = typeof storage.estimate === 'function' ? await storage.estimate() : {};
      const usage = typeof est.usage === 'number' ? est.usage : null;
      const quota = typeof est.quota === 'number' ? est.quota : null;
      const persisted = typeof storage.persisted === 'function' ? !!(await storage.persisted()) : false;
      return { usage, quota, free: usage !== null && quota !== null ? Math.max(0, quota - usage) : null, persisted };
    }),
    /** The bytes the lifts' folders hold (what deleting them all would free). */
    liftsBytes: () => exclusive(async () => {
      try { return await folderBytes(await dirAt([LIFTS_DIR], false)); } catch (e) { if (isMissing(e)) return 0; throw e; }
    }),
  };
}
