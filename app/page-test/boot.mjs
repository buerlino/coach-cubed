// The page test's boot (package c21), test build only: assemble.mjs --test puts
// it before main.mjs in index.html. It makes the app's one queue, with the
// replay engine in place of MoveNet and the fixture's size and rate on the job's
// source (replay.mjs). With `?real` in the page's URL it makes nothing: main.mjs's own
// appQueue() then makes the app's, with the real engine (the page test's --real mode: MoveNet
// on TF.js's WebGL backend, which headless Brave runs in software, on the CPU: the only backend the
// app has). main.mjs's appQueue() finds the queue made here, if any.
import { appQueue } from '../src/analysis/index.mjs';
import { PoseEngine } from '../src/pose/pose-client.mjs';
import { openFrameSource } from '../src/media/frame-source.mjs';
import { createReplay } from './replay.mjs';

const real = new URLSearchParams(globalThis.location.search).has('real');

if (!real) {
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
    return createReplay(tracks);
  });
  loaded.catch(() => { /* the first Analyse reports it */ });
  appQueue({
    createEngine: async () => {
      const replay = await loaded;
      return PoseEngine.create({ backend: 'cpu', createWorker: () => replay.createWorker() });
    },
    openFrameSource: async blob => (await loaded).source(await openFrameSource(blob)),
  });
}
