// The page test's boot (package c21), test build only: assemble.mjs --test puts it before main.mjs in
// index.html. It sets the app queue's defaults (setAppQueueDefaults): the replay engine in place of MoveNet,
// and the fixture's size and rate on the job's source (replay.mjs). It makes no queue: main.mjs's
// appQueue({ store }) makes the app's one, with these deps and main.mjs's own store, as the shipped app does.
// With `?real` in the page's URL it sets nothing, so the queue gets the real engine (the page test's --real
// mode: MoveNet on TF.js's WebGL backend, which headless Brave runs in software, on the CPU).
import { setAppQueueDefaults } from '../src/analysis/index.mjs';
import { PoseEngine } from '../src/pose/pose-client.mjs';
import { openFrameSource } from '../src/media/frame-source.mjs';
import { createReplay } from './replay.mjs';

const real = new URLSearchParams(globalThis.location.search).has('real');

if (!real) {
  // d57: `globalThis.coachReplay.mode` = 'no-person' or 'unreadable' makes the next job end that way (replay.mjs); null replays the track
  const control = (globalThis.coachReplay = { mode: null });
  const manifest = fetch('./page-test/tracks.json').then(r => {
    if (!r.ok) throw new Error(`page-test/tracks.json: ${r.status}`);
    return r.json();
  });
  const loaded = manifest.then(async list => {
    const tracks = await Promise.all(list.map(async t => {
      const r = await fetch(`./page-test/${t.file}`);
      if (!r.ok) throw new Error(`page-test/${t.file}: ${r.status}`);
      return { id: t.id, lift: t.lift, track: await r.json() };
    }));
    return createReplay(tracks, control);
  });
  loaded.catch(() => { /* the first Analyse reports it */ });
  setAppQueueDefaults({
    createEngine: async () => {
      const replay = await loaded;
      return PoseEngine.create({ backend: 'cpu', createWorker: () => replay.createWorker() });
    },
    openFrameSource: async blob => (await loaded).source(await openFrameSource(blob)),
  });
}
