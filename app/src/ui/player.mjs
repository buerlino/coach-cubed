// A1's player (package d16): the stored cut played with the skeleton over the frame shown.
//
// What plays and what steps, and why:
//  - PLAY runs through a <video> element on the stored cut, with the overlay painted from
//    requestVideoFrameCallback: its mediaTime is the presentation time of the frame the
//    compositor shows, so the skeleton lands on that frame (rAF reading currentTime is the
//    fallback where the callback is missing, and can be a frame off). A <video> plays; seeking
//    one is what the frame source was written to avoid (README, "The frame source").
//  - PAUSE and the ONE-FRAME STEPS go through s38's stepper: the frames around the playhead
//    decoded once and kept, so a step to a held frame is a lookup, in both directions (a <video>
//    cannot step back). A bitmap on a canvas covers the <video> while paused or stepping; the
//    overlay is painted from the stepped frame's own time. Pausing takes the last frame the
//    video presented and shows that same frame from the stepper.
//  - The marked range is the whole timeline: playing wraps at its end (loop) or stops on its last
//    frame, and steps stop at its first and last frame (the frames the job posed).
// The overlay is painted by draw/overlay.mjs on a canvas the size of the track's frame, so the
// keypoints (in the frame's pixels) need no scaling. A plain module: the elements are given,
// the tests pass fakes.
import { paintOverlay } from '../draw/overlay.mjs';
import { framesOfRange, stepTarget } from './player-model.mjs';

const EPS = 1e-3;   // a frame time read back from a video is rounded: a millisecond is far under a frame

/**
 * @typedef {Object} PlayerState
 * @property {number} t the frame shown, seconds in the cut's timeline
 * @property {number} index its place in frameTimes
 * @property {boolean} playing
 * @property {boolean} live the <video> shows the moving picture (its first frame came); until then, and whenever it is not playing, the stepped frame is shown
 * @property {number} speed
 */

/**
 * @param {Object} o
 * @param {{play(): Promise<void>|void, pause(): void, currentTime: number, playbackRate: number,
 *   requestVideoFrameCallback?: Function, cancelVideoFrameCallback?: Function,
 *   addEventListener: Function, removeEventListener: Function}} o.video the <video> with the cut
 * @param {{width: number, height: number, getContext: Function}} o.frame the canvas for stepped frames
 * @param {{width: number, height: number, getContext: Function}} o.overlay the overlay canvas
 * @param {import('../contracts/frame-source.mjs').Stepper} o.stepper opened on the cut
 * @param {readonly number[]} o.frameTimes the source's
 * @param {{t0: number, t1: number}} o.range the marked range
 * @param {import('../draw/overlay.mjs').OverlayScene} o.scene
 * @param {() => object} o.style the overlay's look (draw/skeleton.mjs overlayStyle), read when painting
 * @param {() => {skeleton: boolean, cues: boolean, loop?: boolean}} o.flags the view options, read when painting
 * @param {number} [o.speed]
 * @param {(s: PlayerState) => void} [o.onChange] after every move of the playhead or switch of playing
 * @param {(e: Error) => void} [o.onError]
 * @param {(fn: Function) => number} [o.raf] requestAnimationFrame (the fallback clock)
 * @param {(id: number) => void} [o.caf]
 */
export function createPlayer(o) {
  const { video, frame, overlay, stepper, frameTimes, range, scene } = o;
  const onChange = o.onChange || (() => {});
  const onError = o.onError || (() => {});
  const raf = o.raf || (fn => globalThis.requestAnimationFrame(fn));
  const caf = o.caf || (id => globalThis.cancelAnimationFrame(id));
  const bounds = framesOfRange(frameTimes, range);
  const firstT = frameTimes[bounds.first], lastT = frameTimes[bounds.last];
  const frameCtx = frame.getContext('2d');
  const overlayCtx = overlay.getContext('2d');
  overlay.width = scene.meta.width;
  overlay.height = scene.meta.height;

  const state = { t: firstT, index: bounds.first, playing: false, live: false, speed: o.speed || 1 };
  let closed = false;
  let chain = Promise.resolve();       // steps, seeks and pauses run one at a time
  let latest = 0;                      // a newer request makes an older one's answer stale
  let loopId = null;                   // the pending rVFC or rAF
  let lastMedia = firstT;              // mediaTime of the last frame the video presented

  const indexAtTime = t => {
    let lo = bounds.first, hi = bounds.last;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (frameTimes[mid] <= t + EPS) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const emit = () => onChange({ ...state });
  const fail = e => { if (!closed) onError(e instanceof Error ? e : new Error(String(e))); };
  const flags = () => o.flags();
  const paint = t => paintOverlay(overlayCtx, scene, t, { skeleton: flags().skeleton, cues: flags().cues, style: o.style() });

  // A frame from the stepper onto the canvas, and the overlay for its time.
  function show(r) {
    const b = r.frame;
    if (frame.width !== b.width || frame.height !== b.height) { frame.width = b.width; frame.height = b.height; }
    frameCtx.drawImage(b, 0, 0);
    state.t = r.time;
    state.index = r.index;
    paint(r.time);
    emit();
  }

  const enqueue = fn => { chain = chain.then(fn).catch(fail); return chain; };

  function stopLoop() {
    if (loopId === null) return;
    if (video.requestVideoFrameCallback && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(loopId);
    else caf(loopId);
    loopId = null;
  }

  function onFrame(mediaTime) {
    if (closed || !state.playing) return;
    lastMedia = mediaTime;
    if (!state.live) state.live = true;   // the video now shows the moving frame: the screen hides the stepped one
    if (mediaTime > lastT + EPS) { ended(); return; }
    const t = Math.max(firstT, mediaTime);
    state.t = t;
    state.index = indexAtTime(t);
    paint(t);
    emit();
    schedule();
  }

  function schedule() {
    if (closed || !state.playing || loopId !== null) return;
    if (video.requestVideoFrameCallback) loopId = video.requestVideoFrameCallback((now, meta) => { loopId = null; onFrame(meta.mediaTime); });
    else loopId = raf(() => { loopId = null; onFrame(video.currentTime); });
  }

  function ended() {
    stopLoop();
    if (flags().loop !== false) {
      video.currentTime = firstT;
      lastMedia = firstT;
      if (video.paused) Promise.resolve(video.play()).catch(fail);   // an ended video has stopped by itself
      schedule();
      return;
    }
    enqueue(() => settleOn(lastT));
  }

  // Playing stops and the stepper shows the frame the video presented last.
  async function settleOn(t) {
    stopLoop();
    video.pause();
    state.playing = false;
    state.live = false;
    const token = ++latest;
    const r = await stepper.seek(Math.min(lastT, Math.max(firstT, t)));
    if (token === latest && !closed) show(r); else emit();
  }

  const onEnded = () => { if (state.playing && !closed) ended(); };
  video.addEventListener('ended', onEnded);

  const api = {
    get state() { return { ...state }; },
    /** Plays from the playhead (from the start when it is on the last frame). */
    play() {
      return enqueue(async () => {
        if (state.playing || closed) return;
        ++latest;
        if (state.t >= lastT - EPS) { state.t = firstT; state.index = bounds.first; }
        video.currentTime = state.t;
        lastMedia = state.t;
        video.playbackRate = state.speed;
        state.live = false;
        state.playing = true;
        emit();
        await video.play();
        schedule();
      });
    },
    pause() {
      return enqueue(async () => { if (state.playing && !closed) await settleOn(lastMedia); });
    },
    toggle() { return state.playing ? api.pause() : api.play(); },
    /** One frame on (+1) or back (-1), held at the range's first and last frame; stops playing first. */
    step(delta) {
      return enqueue(async () => {
        if (closed) return;
        if (state.playing) await settleOn(lastMedia);
        const target = stepTarget(stepper.index, delta, bounds);
        if (target === stepper.index) return;
        const token = ++latest;
        const r = await stepper.step(target - stepper.index);
        if (token === latest && !closed) show(r);
      });
    },
    /** The frame shown at t (a drag on the timeline); the newest request wins. */
    seek(t) {
      const token = ++latest;
      return enqueue(async () => {
        if (closed || token !== latest) return;
        if (state.playing) { stopLoop(); video.pause(); state.playing = false; state.live = false; }
        const r = await stepper.seek(Math.min(lastT, Math.max(firstT, t)));
        if (token === latest && !closed) show(r);
      });
    },
    setSpeed(v) { state.speed = v; video.playbackRate = v; emit(); },
    /** Paints the overlay again on the frame shown: a view option or the look changed. */
    repaint() { if (!closed) paint(state.t); },
    /** Shows the range's first frame. */
    start() { return api.seek(firstT); },
    close() { closed = true; stopLoop(); video.removeEventListener('ended', onEnded); try { video.pause(); } catch { /* the element is going */ } },
    bounds,
  };
  return api;
}
