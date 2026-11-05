// SPDX-License-Identifier: AGPL-3.0-or-later
// The page test's replay engine (package c21): a pose engine that answers the
// k-th frame it is given with the k-th frame of a committed fixture track
// (tests/fixtures/global/…track.json), through contract 1's messages, so the
// real client, queue, job, scoring adapter and screens run on a known pose.
// Test build only (assemble.mjs --test copies this folder as page-test/ into dist/; the
// shipped dist/ never has it). Plain module, no DOM, so Node loads it too.
import { framesFromTrack } from '../src/contracts/track.mjs';
import { createWorkerHandler } from '../src/pose/worker-core.mjs';
import { MediaError } from '../src/media/media-error.mjs';

/** What a stored lift says of the engine that made it. */
export const REPLAY_INFO = Object.freeze({ model: 'replay-fixture', backend: 'cpu', runtime: 'fixture track replay' });

const FPS_SLACK = 0.01;

/** The modes a job can be made to fail in (d57), set on the replay's `control.mode`; null replays the track. */
export const REPLAY_MODES = Object.freeze(['no-person', 'unreadable']);

/**
 * @param {Array<{id: string, lift: string, track: import('../src/contracts/track.mjs').Track}>} tracks
 *   the committed tracks to replay, `lift` the lift each is scored as
 * @param {{mode: string|null}} [control] read when a job opens its clip (`source`), so a change applies to the next job
 *   only. `'no-person'`: the engine finds nobody in any frame, so the job's track keeps no frames and the job fails with
 *   NoPersonError. `'unreadable'`: the clip is refused, a MediaError `unreadable`, as a file the frame source can't read.
 *   boot.mjs shares it as `globalThis.coachReplay`, which the layout check sets from the page.
 */
export function createReplay(tracks, control = { mode: null }) {
  const frames = new Map(tracks.map(t => [t.id, framesFromTrack(t.track)]));
  let current = null;   // the entry being replayed
  let nobody = false;   // the mode when the clip was opened: the engine finds no one
  let k = 0;            // the next frame to answer with

  const engine = {
    info: { ...REPLAY_INFO },
    // the k-th frame asked for is the k-th frame of the track; running past its end is a failed estimate
    async estimate() {
      if (nobody) return null;
      if (!current) throw new Error('replay: no clip was opened, so no track is selected');
      const f = frames.get(current.id)[k];
      if (!f) throw new Error(`replay: frame ${k} was asked for, but the track ${current.id} has ${frames.get(current.id).length}`);
      k++;
      return f.keypoints;
    },
    async reset() { k = 0; },
  };

  /** The entry whose track belongs to a clip of this frame rate and frame count; throws when none does. */
  function match(fps, frameCount) {
    const hit = tracks.find(t => Math.abs(t.track.meta.fps - fps) < FPS_SLACK && t.track.meta.frame_count === frameCount);
    if (!hit) throw new Error(`replay: no fixture track matches a clip of ${fps} fps and ${frameCount} frames (have ${tracks.map(t => `${t.id}: ${t.track.meta.fps} fps, ${t.track.meta.frame_count}`).join('; ')})`);
    return hit;
  }

  return {
    engine,
    control,
    match,
    /** The frame source of a decoded clip, as the job takes it in the test build: the pictures are the clip's, the
     *  fps, width and height the matched fixture's (the keypoints are in the fixture's pixels). Selects the track. */
    source(src) {
      const mode = control.mode;
      if (mode !== null && !REPLAY_MODES.includes(mode)) throw new Error(`replay: unknown mode ${JSON.stringify(mode)} (have ${REPLAY_MODES.join(', ')})`);
      if (mode === 'unreadable') {
        try { src.close(); } catch { /* closed */ }
        throw new MediaError('unreadable', 'replay: this clip is refused (mode unreadable).');
      }
      nobody = mode === 'no-person';
      const hit = match(src.info.fps, src.frameTimes.length);
      current = hit;
      k = 0;
      const { fps, width, height } = hit.track.meta;
      return { ...src, info: { ...src.info, fps, width, height } };
    },
    /** A stand-in for the pose Worker (what PoseEngine.create's `createWorker` gives): contract 1's messages in and out. */
    createWorker() {
      const worker = {
        onmessage: null,
        onerror: null,
        terminated: false,
        postMessage(data) { if (!worker.terminated) handle(data); },
        terminate() { worker.terminated = true; },
      };
      const handle = createWorkerHandler({
        load: async () => engine,
        // the answer arrives on a later task, as a worker's does
        post: msg => setTimeout(() => { if (!worker.terminated && worker.onmessage) worker.onmessage({ data: msg }); }, 0),
      });
      return worker;
    },
  };
}
