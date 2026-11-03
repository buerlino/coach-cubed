// SPDX-License-Identifier: AGPL-3.0-or-later
// The stepper (package s38): M1–M3's one-frame steps from a cache, contract 5's
// `stepper` (app/src/contracts/frame-source.mjs). frameAt decodes again from the
// keyframe before the frame on every call (0.4 s a step on the Fairphone with a
// phone camera's keyframes, app/README.md "On the phone"); the stepper decodes the
// frames around the playhead once, keeps them as bitmaps at the caller's size, and
// refills them in the background, so a step is a lookup in both directions.
//
// The window: the budget's frames, split around the playhead, half each way until
// the first step, then three quarters on the side the steps go. The refill fills
// it nearest frame first, one decode at a time:
//  - ahead, from one decoder that keeps going (`stream`): it is suspended between
//    frames, so stepping on through a keyframe group decodes the group once
//    however long it is; it is fed one chunk at a time and stops while a frame
//    waits (STREAM_QUEUES), so paused it holds at most 2 decoded frames;
//  - behind, a decode from the keyframe of the group before, keeping the frames
//    that fit. It starts once that whole group fits in the window, or when the
//    missing frame is a quarter of the window away, whichever comes first; a
//    group longer than the window is decoded again for each window's worth;
//    a step or seek that moves the window off its frame gives it up.
// Every frame held is pinned to a cost (its distance over its side's size); a
// decoded frame outside the window is closed without a bitmap; a new frame takes
// the place of the costliest one, which is closed; the playhead's frame is never
// dropped, nor the frame on screen before the step's frame is in. A step to a
// frame not held waits for the refill.
//
// Errors: a refill that fails (a decoder error, a stall after stallMs) ends; a
// step waiting then rejects with the MediaError, else the next step does, and the
// step after that starts the refill again.
import { STEPPER_BUDGET } from '../contracts/frame-source.mjs';
import { MediaError, asMediaError } from './media-error.mjs';

const isTime = t => typeof t === 'number' && Number.isFinite(t);
// The forward decoder's queues. It is paused at a yield between steps, and
// decodeFrames' defaults (4 frames waiting, 8 chunks fed) let the chunks already
// fed come out as frames: about 12 full-size VideoFrames held outside the budget,
// as a hardware decoder's output buffers, for as long as the user stays on a
// frame. One chunk fed while no frame waits: paused, it holds at most 2 decoded
// frames (the one waiting and the one its last chunk makes).
export const STREAM_QUEUES = Object.freeze({ maxQueued: 1, maxQueueSize: 1 });
const closeQuietly = x => { try { x.close(); } catch { /* already closed */ } };
const closedError = () => new MediaError('closed', 'The video was closed.');

/**
 * The stepper's frame size: what the caller asks for, a missing side from the
 * upright aspect.
 * @param {{width: number, height: number}} info the source's upright size
 * @param {{width?: number, height?: number}} opts
 */
export function stepperSize(info, { width, height } = {}) {
  const ok = v => v === undefined || (isTime(v) && v >= 1);
  if ((width === undefined && height === undefined) || !ok(width) || !ok(height)) {
    throw new MediaError('range', `A stepper needs a frame width or height in pixels, not ${width} × ${height}.`);
  }
  const w = width === undefined ? Math.max(1, Math.round(height * info.width / info.height)) : Math.round(width);
  const h = height === undefined ? Math.max(1, Math.round(width * info.height / info.width)) : Math.round(height);
  return { width: w, height: h };
}

/**
 * @param {Object} ctx what the frame source gives the stepper
 * @param {ReturnType<import('./sample-table.mjs').buildSampleTable>} ctx.table
 * @param {{width: number, height: number}} ctx.info
 * @param {Object} ctx.webcodecs toBitmap
 * @param {(startDec: number, endDec: number, wants: (us: number) => boolean, signal: AbortSignal, queues?: {maxQueued?: number, maxQueueSize?: number}) => AsyncGenerator<VideoFrame>} ctx.decode
 * @param {(frame: VideoFrame) => Promise<VideoFrame>} ctx.upright the file's rotation applied; the original closed
 * @param {(us: number) => number|undefined} ctx.indexOf a frame's index from its timestamp
 * @param {(s: object) => void} ctx.register
 * @param {(s: object) => void} ctx.unregister
 * @param {number} t seconds
 * @param {import('../contracts/frame-source.mjs').StepperOptions} [options]
 * @returns {Promise<import('../contracts/frame-source.mjs').Stepper>}
 */
export async function openStepper(ctx, t, options = {}) {
  const { table, webcodecs } = ctx;
  const n = table.count;
  if (!isTime(t)) throw new MediaError('range', `A stepper opens at a time in seconds, not ${t}.`);
  const { width, height } = stepperSize(ctx.info, options);
  const maxFrames = options.maxFrames ?? STEPPER_BUDGET.maxFrames;
  const maxBytes = options.maxBytes ?? STEPPER_BUDGET.maxBytes;
  if (!Number.isInteger(maxFrames) || maxFrames < 1) throw new MediaError('range', `A stepper holds at least one frame, not ${maxFrames}.`);
  if (!isTime(maxBytes)) throw new MediaError('range', `A stepper's byte budget is a number, not ${maxBytes}.`);
  const frameBytes = width * height * 4;
  const cap = Math.min(maxFrames, Math.floor(maxBytes / frameBytes));
  if (cap < 1) throw new MediaError('range', `A budget of ${maxBytes} bytes can't hold one ${width} × ${height} frame (${frameBytes} bytes).`);

  const controller = new AbortController();
  const held = new Map();      // frame index → bitmap
  const waiters = new Map();   // frame index → [{resolve, reject}]
  let cur = table.indexAt(t);  // the playhead: where the last step asked to go
  let shown = -1;              // where the last step landed
  let dir = 0;                 // the last step's direction
  let closed = false, stream = null, running = null, pendingError = null, chain = Promise.resolve(), soon = null;

  // a frame's keyframe group: the decode index of its key packet
  const groupOf = i => table.plan(i, i).startDec;
  // the window's frames ahead of and behind the playhead
  const sides = () => {
    const free = cap - 1;
    if (dir === 0) { const behind = free >> 1; return { ahead: free - behind, behind }; }
    const trail = free >> 2, lead = free - trail;
    return dir > 0 ? { ahead: lead, behind: trail } : { ahead: trail, behind: lead };
  };
  // below 1 inside the window, 1 and over outside it
  const cost = (i, s) => (i >= cur ? (i - cur) / (s.ahead + 1) : (cur - i) / (s.behind + 1));

  // the next frame to fetch, nearest first: {side, index}, or null when the window is full
  function need() {
    const s = sides();
    let a = -1, b = -1;
    for (let i = cur, end = Math.min(n - 1, cur + s.ahead); i <= end; i++) if (!held.has(i)) { a = i; break; }
    for (let i = cur - 1, end = Math.max(0, cur - s.behind); i >= end; i--) if (!held.has(i)) { b = i; break; }
    if (b >= 0) {
      const fits = cur - table.presOf(groupOf(b)) <= s.behind;
      const near = cur - b <= Math.max(1, Math.ceil(s.behind / 4));
      if (!fits && !near) b = -1;
    }
    if (a >= 0 && (b < 0 || a - cur <= cur - b)) return { side: 'ahead', index: a };
    return b >= 0 ? { side: 'behind', index: b } : null;
  }

  // room for frame i, when it is worth holding: false when it isn't, else the
  // frame to drop once i's bitmap is in (-1: none). The frame on screen stays
  // until the step's frame is in held, the step's own frame included (contract 5:
  // it stays valid until the next step or seek settles), so the costliest of the
  // others is dropped now; with a budget of one frame there is no other, and the
  // frame on screen is dropped only when the new one takes its place.
  // A frame outside the window (cost 1 and over) is never worth it: the decodes
  // start at a keyframe, and the frames on the way there are closed undrawn
  // instead of each being turned and made into a bitmap that is evicted at once.
  function admit(i) {
    if (held.has(i)) return false;
    const s = sides(), c = cost(i, s);
    if (i !== cur && c >= 1) return false;
    if (held.size < cap) return -1;
    const pinShown = !held.has(cur) && held.has(shown);
    let worst = -1, wc = -1;
    for (const j of held.keys()) {
      if (j === cur || (pinShown && j === shown)) continue;
      const cj = cost(j, s);
      if (cj > wc) { wc = cj; worst = j; }
    }
    if (worst < 0) return pinShown && i === cur ? shown : false;
    if (!(wc > c)) return false;
    closeQuietly(held.get(worst));
    held.delete(worst);
    return -1;
  }

  // a decoded frame: kept as a bitmap at the stepper's size, or closed. Its index.
  async function take(frame) {
    const i = ctx.indexOf(frame.timestamp);
    const drop = closed || i === undefined ? false : admit(i);
    if (drop === false) { closeQuietly(frame); return i; }
    let bitmap;
    const up = await ctx.upright(frame);
    try { bitmap = await webcodecs.toBitmap(up, { width, height }); } finally { closeQuietly(up); }
    if (closed) { closeQuietly(bitmap); return i; }
    if (drop >= 0 && held.has(drop)) { closeQuietly(held.get(drop)); held.delete(drop); }
    held.set(i, bitmap);
    const w = waiters.get(i);
    if (w) { waiters.delete(i); for (const x of w) x.resolve(); }
    return i;
  }

  function dropStream() {
    if (!stream) return;
    const { it } = stream;
    stream = null;
    if (it.return) it.return().catch(() => {});
  }

  // ahead: the next frame from the decoder that keeps going, started (again) at
  // the keyframe of frame `index` when it has passed it or is a group behind it
  async function pull(index) {
    if (stream && (stream.next > index || groupOf(index) > groupOf(stream.next))) dropStream();
    if (!stream) {
      const startDec = groupOf(index), first = table.presOf(startDec);
      const wants = us => { const i = ctx.indexOf(us); return i !== undefined && i >= first; };
      stream = { it: ctx.decode(startDec, n - 1, wants, controller.signal, STREAM_QUEUES)[Symbol.asyncIterator](), next: first };
    }
    const s = stream;
    const r = await s.it.next();
    if (r.done) {
      if (stream === s) stream = null;
      throw new MediaError('decode-failed', `The video decoder gave no frame at ${table.times[index].toFixed(3)} s.`);
    }
    const i = await take(r.value);
    if (stream === s && i !== undefined) s.next = i + 1;
  }

  // behind: the group of frame `index`, from its keyframe to `index`
  async function back(index) {
    const startDec = groupOf(index), first = table.presOf(startDec);
    const { endDec } = table.plan(first, index);
    const wants = us => { const i = ctx.indexOf(us); return i !== undefined && i >= first && i <= index && !held.has(i); };
    for await (const f of ctx.decode(startDec, endDec, wants, controller.signal)) {
      // a step or seek moved the window off the frame: the decode is given up, so
      // the new playhead's frame doesn't wait for the rest of this group
      if (index !== cur && cost(index, sides()) >= 1) { closeQuietly(f); return; }
      if (await take(f) === index) return;
    }
    if (!closed) throw new MediaError('decode-failed', `The video decoder gave no frame at ${table.times[index].toFixed(3)} s.`);
  }

  async function refill() {
    try {
      for (let nd; !closed && (nd = need());) {
        // the stream when it is on its way to the frame; else ahead of the playhead (or
        // at it, unless stepping back) it starts again there, and behind, a decode
        // that ends at the frame (a stream would read on into the group after)
        const onItsWay = stream && stream.next <= nd.index && groupOf(nd.index) === groupOf(stream.next);
        const fromStream = onItsWay || nd.index > cur || (nd.index === cur && dir >= 0);
        if (fromStream) await pull(nd.index); else await back(nd.index);
      }
    } catch (e) {
      if (closed) return;
      dropStream();
      pendingError = asMediaError(e, 'decode-failed', 'The video decoder failed');
    }
  }

  function failWaiters(e) {
    const all = [...waiters.values()].flat();
    waiters.clear();
    for (const x of all) x.reject(e);
  }

  // starts the refill when the window has a gap; when it ends, a step waiting gets
  // the error, or the refill goes on if the playhead moved meanwhile
  function kick() {
    if (running || closed || pendingError || !need()) return;
    running = refill().finally(() => {
      running = null;
      if (closed) return;
      if (pendingError) {
        if (waiters.size) { const e = pendingError; pendingError = null; failWaiters(e); }
        return;
      }
      kick();
    });
  }

  // the refill on the next task: a step to a held frame returns before any refill
  // work (turning a decoded frame into a bitmap can hold the main thread for ms)
  const kickSoon = () => { if (!soon && !closed) soon = setTimeout(() => { soon = null; kick(); }, 0); };

  const snapshot = cached => ({ index: shown, time: table.times[shown], frame: held.get(shown), cached });

  async function goTo(i, seeking = false) {
    if (closed) throw closedError();
    if (pendingError) { const e = pendingError; pendingError = null; throw e; }
    if (seeking) dir = 0;
    else if (shown >= 0 && i !== shown) dir = Math.sign(i - shown);
    cur = i;
    const cached = held.has(i);
    if (cached) kickSoon(); else kick();
    if (!cached) {
      try {
        await new Promise((resolve, reject) => {
          if (!waiters.has(i)) waiters.set(i, []);
          waiters.get(i).push({ resolve, reject });
          kick();
        });
      } catch (e) {
        if (shown >= 0) cur = shown;
        throw e;
      }
    }
    shown = i;
    return snapshot(cached);
  }
  // one step at a time, in the order asked
  const serial = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
  const clamp = i => Math.min(n - 1, Math.max(0, i));

  const stepper = {
    get index() { return shown; },
    get time() { return table.times[shown]; },
    get frame() { return held.get(shown); },
    width, height,
    budget: Object.freeze({ maxFrames, maxBytes, frameBytes, frames: cap }),
    get held() { return held.size; },
    get bytes() { return held.size * frameBytes; },

    step(delta = 1) {
      if (!Number.isInteger(delta)) return Promise.reject(new MediaError('range', `A step is a whole number of frames, not ${delta}.`));
      return serial(() => goTo(clamp(shown + delta)));
    },
    seek(s) {
      if (!isTime(s)) return Promise.reject(new MediaError('range', `seek needs a time in seconds, not ${s}.`));
      return serial(() => goTo(table.indexAt(s), true));
    },
    async settled() { while (running || soon) await (running || new Promise(r => setTimeout(r, 1))); },
    close() {
      if (closed) return;
      closed = true;
      if (soon) { clearTimeout(soon); soon = null; }
      controller.abort();
      dropStream();
      failWaiters(closedError());
      for (const b of held.values()) closeQuietly(b);
      held.clear();
      ctx.unregister(stepper);
    },
  };

  ctx.register(stepper);
  try {
    await serial(() => goTo(cur));
  } catch (e) {
    stepper.close();
    throw e;
  }
  return stepper;
}
