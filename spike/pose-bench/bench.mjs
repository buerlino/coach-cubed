// SPDX-License-Identifier: AGPL-3.0-or-later
// One run: a clip through demux, WebCodecs decode, the pose engine (worker),
// then smoothing and diagnostics.js the way the old page scores
// (src/track/), timed end to end. Writes a track.json in the fixture format
// (docs/fixture-data-contract.md) and posts everything to results/.
import { demuxMp4, decodeAll } from './lib/decode.mjs';
import { PoseEngine } from './lib/pose-client.mjs';
import { scoreTrack } from '../../src/track/lift-window.mjs';

export async function listClips() {
  return (await fetch('clips.json')).json();
}

// opts: { clip (an entry of clips.json), model, ep: 'webgpu'|'wasm',
//         fps: number|'full', detector, detEvery, threads?, set?, post: true,
//         decode?: WebCodecs' hardwareAcceleration ('prefer-software', ...),
//         maxFrames?: a smoke test's cap on processed frames }
export async function run(opts, log = () => {}) {
  const clip = opts.clip;
  const set = opts.set || clip.set || 'snatch';
  const t = { };

  const startedAt = Date.now();   // phone clock, to line up with phone-sample.sh
  let t0 = performance.now();
  const engine = await PoseEngine.create({ model: opts.model, ep: opts.ep, detector: opts.detector || 'yolox-nano',
    detEvery: opts.detEvery || 1, threads: opts.threads });
  t.engineLoadMs = performance.now() - t0;
  log(`engine ${opts.model}/${opts.ep} ready in ${t.engineLoadMs.toFixed(0)} ms`);

  // The clip's own timing starts here: what a user waits for after import.
  const start = performance.now();
  const buf = await (await fetch(clip.url)).arrayBuffer();
  t.fetchMs = performance.now() - start;
  t0 = performance.now();
  const media = await demuxMp4(buf);
  t.demuxMs = performance.now() - t0;
  const { width: W, height: H, fps: srcFps } = media.info;

  // Frames sampled on a grid of 1/fps from the first one; 'full' keeps all.
  const step = opts.fps === 'full' ? 0 : 1 / opts.fps;
  const half = 0.5 / srcFps;
  let next = 0;
  const keypoints = {}, indices = [], times = [], perFrame = [];
  let decodeWait = 0, lastDone = performance.now(), modelMs = 0, boxes = 0;
  const loopStart = performance.now();
  const total = await decodeAll(media, async (frame, i) => {
    const ts = frame.timestamp / 1e6;
    decodeWait += performance.now() - lastDone;
    if ((step && ts < next - half) || (opts.maxFrames && indices.length >= opts.maxFrames)) {
      frame.close(); lastDone = performance.now(); return;
    }
    if (step) while (next <= ts + half) next += step;
    const r = await engine.estimate(frame, ts * 1000);
    modelMs += r.ms.total;
    perFrame.push(r.ms);
    keypoints[String(i)] = r.keypoints ? { '0': r.keypoints } : {};
    if (r.keypoints) boxes++;
    indices.push(i); times.push(ts * 1000);
    lastDone = performance.now();
  }, { hardware: opts.decode || 'no-preference' });
  t.loopMs = performance.now() - loopStart;
  t.decodeWaitMs = decodeWait;   // time the loop spent waiting on the decoder
  t.modelMs = modelMs;
  engine.close();

  const track = { keypoints, meta: {
    fps: srcFps, frame_count: total, frames_processed: indices.length,
    frame_stride: step ? Math.max(1, Math.round(srcFps * step)) : 1,
    width: W, height: H, frame_indices: indices, frame_times_ms: times,
    skeleton: [[15, 13], [13, 11], [16, 14], [14, 12], [11, 12], [5, 11], [6, 12], [5, 6], [5, 7], [6, 8],
      [7, 9], [8, 10], [1, 2], [0, 1], [0, 2], [1, 3], [2, 4], [3, 5], [4, 6]],
    tracks: { kept: '0', kept_frames: boxes, dropped: [] },
    source: `pose-bench ${opts.model} ${opts.ep} ${opts.detector || 'yolox-nano'} fps=${opts.fps}`,
  } };

  t0 = performance.now();
  const scored = scoreTrack(window.Diagnostics, track, set);
  t.scoreMs = performance.now() - t0;
  t.clipTotalMs = performance.now() - start;

  const ms = k => perFrame.map(m => m[k]).filter(v => v != null);
  const stat = v => v.length ? { mean: v.reduce((a, b) => a + b, 0) / v.length,
    p50: [...v].sort((a, b) => a - b)[v.length >> 1], max: Math.max(...v), n: v.length } : null;
  const result = {
    opts: { ...opts, clip: clip.path, slug: clip.slug, set },
    when: new Date().toISOString(), startedAt, endedAt: Date.now(), ua: navigator.userAgent,
    engine: engine.info, clip: media.info, frames: { decoded: total, processed: indices.length, withPerson: boxes },
    timings: t, perFrame: { total: stat(ms('total')), det: stat(ms('det')), pose: stat(ms('pose')),
      pre: stat(ms('pre')), post: stat(ms('post')) },
    memory: performance.memory ? { usedJSHeap: performance.memory.usedJSHeapSize } : null,
    scores: { personId: scored.personId, lift: scored.lift && { t0: scored.lift.t0, t1: scored.lift.t1, error: scored.lift.error },
      results: Object.fromEntries(Object.entries(scored.results).map(([id, r]) => [id, r.error ? { error: r.error }
        : { verdict: r.verdict, summary: r.summary }])) },
    track,
  };
  if (opts.post !== false) {
    const name = `${(clip.slug || clip.path).replace(/[^\w.-]+/g, '_')}@${opts.model}@${opts.ep}@${opts.fps}${opts.tag ? '@' + opts.tag : ''}.json`;
    await fetch('results/' + name, { method: 'POST', body: JSON.stringify(result) });
    result.savedAs = name;
  }
  log(`${clip.path}: ${indices.length}/${total} frames, ${(t.clipTotalMs / 1000).toFixed(1)} s total, ` +
    `${(modelMs / indices.length).toFixed(0)} ms/frame in the engine`);
  return result;
}
