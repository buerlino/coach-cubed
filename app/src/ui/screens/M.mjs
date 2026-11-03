// SPDX-License-Identifier: AGPL-3.0-or-later
// M, Mark the lift (design/mockups/Mark.dc.html, MarkEnd, MarkReady; reworked by
// d54 after checkpoint A's round 1, design/checkpoint-a/round-1.html): one screen
// in three states. The filmstrip of thumbnails moves under a fixed playhead; the
// frame under it is decoded off the input path (mark-model.mjs's createPlayhead:
// a drag only says where it is); one frame back or on (s38's stepper) beside the
// one text line (the hint, the marked length and its time); the steps are the
// buttons, 1 Start, 2 End, 3 Analyse, with ↶ left of them. Every row has a fixed
// height and is drawn before the video opens: only the stage takes what is left,
// so nothing moves when a mark is set. The file and the lift
// come in the flow's params from L1 (the lift is chosen there and only shown here); the queue is injected (main.mjs
// gives the app's one), so tests pass a fake. What to show and what Analyse does
// is mark-model.mjs's; this draws it and holds the video open while M is up.
// A3's re-mark (d22) comes with `range` too: the stored cut and the lift's old range, which M turns back
// into marks (M3, the playhead on the start) so the lift can be marked again from them, and `replaces`, the
// old lift's id, which Analyse hands to the queue: the new lift replaces the old one once analysed (s50).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { openFrameSource } from '../../media/frame-source.mjs';
import { liftLabel } from '../../contracts/lifts.mjs';
import {
  MARK_TEXT, PX_PER_SECOND, THUMB, analyse, analyseCost, clearError, closeTarget, createLatest, createPlayhead, createThumbPlanner, playheadNote, dragTarget, dropFarThumbs,
  fitSize, markView, marksFromRange, newMarks, pressStep, stripLeft, thumbSeconds, thumbTime, undo,
} from '../mark-model.mjs';
import { PickVideo } from '../components/PickVideo.mjs';
import { Problem } from '../components/problem.mjs';
import { isProvisional } from '../home-model.mjs';
import { problemOf, waysOn } from '../problem-model.mjs';
import { CloseIcon, LiftIcon, StepBackIcon, StepForwardIcon, UndoIcon } from '../components/icons.mjs';

const THUMB_MARGIN = 3;       // seconds of thumbnails made beyond the strip's edges
const THUMB_KEEP = 12;        // seconds of thumbnails kept beyond them
const THUMB_BATCH = 6;        // thumbnails made per decode request
const pixelRatio = () => (globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1);

// An ImageBitmap on a canvas of its own size; CSS fits it into its box.
function Picture({ bitmap }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !bitmap || !bitmap.width) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
  }, [bitmap]);
  return html`<canvas ref=${ref} aria-hidden="true"></canvas>`;
}

const clockLabel = s => (s % 2 ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

export function M({ flow, queue, session, openSource = openFrameSource }) {
  const { file = null, lift = null, range = null, from = null, replaces = null } = flow.params;   // the lift is L1's choice; none: the no video state. from 'live' or 'delayed': R3 or R3b kept it in a session (d29, d29b)
  const leave = () => flow.go(closeTarget(from, session));   // ✕: home, or back to the session's live state (R2 or R3b)
  const [source, setSource] = useState(null);     // { frameTimes, info } once the video is open
  const [problem, setProblem] = useState(null);   // the video could not be opened, or a frame could not be decoded
  const [marks, setMarks] = useState(newMarks);
  const [index, setIndex] = useState(0);          // the playhead's frame
  const [cost, setCost] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);   // what Analyse said when it couldn't go on: on the text line
  const [failure, setFailure] = useState(null);   // d23: a problem that takes the screen: { problem, atAnalyse }
  const [width, setWidth] = useState(0);          // the strip's width in px: the playhead is at its middle
  const [thumbVersion, setThumbVersion] = useState(0);
  const parts = useRef({});                       // the open video, its stepper and playhead: closed when M closes
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const stripRef = useRef(null);
  const drag = useRef(null);
  const thumbs = useRef(new Map());               // second → ImageBitmap
  const making = useRef(false);
  const planner = useRef(null);                   // what to ask the frame source for, and what it failed on
  if (!planner.current) planner.current = createThumbPlanner({ batch: THUMB_BATCH });
  const latest = useRef(null);                    // orders the answers that may move the playhead's index
  if (!latest.current) latest.current = createLatest();

  // the video, its stepper and the playhead; all closed when M closes
  useEffect(() => {
    if (!file || !lift) return undefined;
    let current = true;
    const p = parts.current = {};
    (async () => {
      const src = await openSource(file);
      p.src = src;
      if (!current) { src.close(); return; }
      const box = stageRef.current;
      const size = fitSize(src.info, { width: box ? box.clientWidth : 390, height: box ? box.clientHeight : 440 }, pixelRatio());
      const old = marksFromRange(range, src.frameTimes);   // a re-mark starts where the old marks were
      const stepper = await src.stepper(old.start === null ? 0 : src.frameTimes[old.start], size);
      p.stepper = stepper;
      if (!current) { stepper.close(); src.close(); return; }
      p.head = createPlayhead({
        stepper,
        draw: r => { if (current) setProblem(playheadNote()); paint(r.frame); },
        fail: e => { if (current) setProblem(playheadNote({ error: e })); },
      });
      paint(stepper.frame);
      if (old.start !== null) { setMarks(old); setIndex(old.start); }
      setSource({ frameTimes: src.frameTimes, info: src.info });
    })().catch(e => {
      if (!current) return;
      setProblem(e && e.message ? e.message : 'This video could not be opened.');
      setFailure({ problem: problemOf(e), atAnalyse: false });   // the video could not be opened: the screen says why and where to go
    });
    return () => {
      current = false;
      if (p.head) p.head.close();
      if (p.stepper) p.stepper.close();
      if (p.src) p.src.close();
      for (const b of thumbs.current.values()) { try { b.close(); } catch { /* closed */ } }
      thumbs.current.clear();
      planner.current.reset();
    };
  }, [file, lift, openSource]);

  function paint(frame) {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    if (canvas.width !== frame.width || canvas.height !== frame.height) { canvas.width = frame.width; canvas.height = frame.height; }
    canvas.getContext('2d').drawImage(frame, 0, 0);
  }

  // the strip's width, to put the playhead at its middle
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof globalThis.ResizeObserver !== 'function') return undefined;
    const ro = new globalThis.ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [source]);

  const frameTimes = source ? source.frameTimes : null;
  const time = frameTimes ? frameTimes[index] : 0;
  const duration = source ? source.info.duration : 0;
  const seconds = source && width ? thumbSeconds({ time, width, duration, margin: THUMB_MARGIN }) : [];

  // thumbnails for the strip's window, the nearest first, a batch at a time
  const need = seconds.join(',');
  useEffect(() => {
    const src = parts.current.src;
    if (!src || !seconds.length || making.current) return undefined;
    dropFarThumbs(thumbs.current, thumbSeconds({ time, width, duration, margin: THUMB_KEEP }));
    const missing = planner.current.next(seconds, thumbs.current, time);
    if (!missing.length) return undefined;
    making.current = true;
    src.thumbnails(missing.map(s => thumbTime(s, frameTimes)), { height: THUMB.height * Math.min(2, pixelRatio()) })
      .then(bitmaps => {
        if (!parts.current.src || parts.current.src !== src) { bitmaps.forEach(b => b.close()); return; }
        missing.forEach((s, k) => { if (thumbs.current.has(s)) bitmaps[k].close(); else thumbs.current.set(s, bitmaps[k]); });
      })
      // a failed batch is asked again second by second; a second that fails alone stays empty and is not asked again
      .catch(() => { planner.current.failure(missing); })
      .finally(() => { making.current = false; setThumbVersion(v => v + 1); });
    return undefined;
  }, [need, source, thumbVersion]);   // eslint-disable-line react-hooks/exhaustive-deps

  // the time to analyse the marked range: the queue's estimate
  const ready = source && marks.start !== null && marks.end !== null;
  useEffect(() => {
    if (!ready) { setCost(null); return undefined; }
    let current = true;
    Promise.resolve(analyseCost(queue, marks, frameTimes, source.info.fps)).then(c => { if (current) setCost(c); }, () => { if (current) setCost(null); });
    return () => { current = false; };
  }, [queue, ready, marks, source]);   // eslint-disable-line react-hooks/exhaustive-deps

  // the playhead moved on: a refusal's words are old news
  const moved = () => { setMarks(clearError); setRefused(null); };

  const move = (to) => {
    const head = parts.current.head;
    if (!head) return;
    setProblem(null);
    moved();
    const token = latest.current.issue();
    // a step that lands after a newer step or a drag began says nothing about the playhead now
    to.catch(() => { /* the playhead reports it */ }).then(r => { if (r && latest.current.fresh(token)) setIndex(r.index); });
  };
  const stepBy = delta => { if (parts.current.head) move(parts.current.head.step(delta)); };

  const onPointerDown = e => {
    if (!source) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, time };
  };
  const onPointerMove = e => {
    const d = drag.current;
    if (!d || !parts.current.head) return;
    const target = dragTarget(frameTimes, { time: d.time, dx: e.clientX - d.x });
    latest.current.issue();
    if (target.index !== index) moved();
    setIndex(target.index);
    parts.current.head.request(target.time);   // returns at once: the frame follows
  };
  const onPointerEnd = () => { drag.current = null; };
  const onKeyDown = e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    stepBy(e.key === 'ArrowLeft' ? -1 : 1);
  };

  const onAnalyse = async () => {
    setBusy(true);
    setRefused(null);
    const out = await analyse({ flow, queue, lift, file, marks, frameTimes, replaces, from, session });
    if (!out.ok) {
      setBusy(false);
      setRefused(out.error);
      if (out.problem) setFailure({ problem: out.problem, atAnalyse: true });   // the store's or the cutter's error: its own screen
    }
  };

  // 1 and 2 set or move their mark at the playhead; 3 analyses; ↶ takes back the last change of a mark
  const onStep = key => {
    if (key === 'analyse') { onAnalyse(); return; }
    setRefused(null);
    setMarks(pressStep(marks, key, index, frameTimes));
  };
  const onUndo = () => { setRefused(null); setMarks(undo); };

  // before the video opens the rows are drawn all the same (nothing to press), so nothing moves when it does
  const view = markView(marks, { index, frameTimes, cost, busy, refused });
  const left = stripLeft(time, width);
  const px = t => (t * PX_PER_SECOND).toFixed(1);

  if (file && lift && failure) {
    const { problem: p, atAnalyse } = failure;
    const ways = waysOn(p, atAnalyse, from);
    return html`
      <main class="screen" data-screen="M" data-step="problem">
        <header class="mark-header">
          <button type="button" class="icon-button" aria-label="Close" onClick=${leave}><${CloseIcon} /></button>
          <h1 class="mark-header__title">Mark the lift</h1>
        </header>
        <div class="screen__body">
          <${Problem} problem=${p}>
            ${ways.includes('retry') ? html`<button type="button" class="button--primary button-big" onClick=${() => { setFailure(null); onAnalyse(); }}>Try again</button>` : null}
            ${ways.includes('marks') ? html`<button type="button" class="button--raised button-wide" onClick=${() => { setFailure(null); setRefused(null); }}>Back to the marks</button>` : null}
            ${ways.includes('session') ? html`<button type="button" class="button--primary button-big" data-way="session" onClick=${leave}>Back to the session</button>` : null}
            ${ways.includes('another') ? html`<${PickVideo} flow=${flow} class=${atAnalyse ? 'button-wide' : 'button--primary button-big'}>Pick another video</${PickVideo}>` : null}
            <button type="button" class="button--raised button-wide" onClick=${() => flow.go('home')}>Back to home</button>
          <//>
        </div>
      </main>`;
  }

  if (!file || !lift) {
    return html`
      <main class="screen" data-screen="M">
        <header class="mark-header">
          <button type="button" class="icon-button" aria-label="Close" onClick=${leave}><${CloseIcon} /></button>
          <h1 class="mark-header__title">Mark the lift</h1>
        </header>
        <div class="screen__body">
          <p class="soft">${MARK_TEXT.noVideo}</p>
          <button type="button" onClick=${() => flow.go('home')}>Back</button>
        </div>
      </main>`;
  }

  return html`
    <main class="screen mark" data-screen="M" data-step=${view.step}>
      <header class="mark-header">
        <button type="button" class="icon-button" aria-label="Close" onClick=${leave}><${CloseIcon} /></button>
        <h1 class="mark-header__lift" aria-label=${`Mark the lift: ${liftLabel(lift)}`}>
          <${LiftIcon} lift=${lift} />
          <span>${liftLabel(lift)}</span>
          ${isProvisional(lift) ? html`<span class="tag">provisional</span>` : null}
        </h1>
      </header>

      <div class="mark-stage" ref=${stageRef}>
        <canvas ref=${canvasRef} role="img" aria-label="The video at the playhead" style=${source ? '' : 'display: none'}></canvas>
        ${!source && !problem ? html`<p class="mark-stage__note" role="status">${MARK_TEXT.opening}</p>` : null}
        ${problem ? html`<p class="mark-stage__note error" role="alert">${problem}</p>` : null}
        ${source ? html`<span class="mark-clock">${view.clock}</span>` : null}
      </div>

      <div class="strip" ref=${stripRef} role="slider" tabindex="0" aria-label="Playhead position, drag the filmstrip"
        aria-valuemin="0" aria-valuemax=${duration.toFixed(1)} aria-valuenow=${time.toFixed(1)} aria-valuetext=${view.clock ?? ''}
        onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerEnd} onPointerCancel=${onPointerEnd} onKeyDown=${onKeyDown}>
        ${source ? html`
        <div class="strip__track" style=${`left: ${left.toFixed(1)}px`}>
          ${seconds.map(s => html`
            <div class="strip__tick" key=${`t${s}`} style=${`left: ${px(s)}px; height: ${s % 2 ? 6 : 10}px`}></div>
            <span class="strip__label" key=${`l${s}`} style=${`left: ${px(s)}px`}>${clockLabel(s)}</span>`)}
          ${seconds.map(s => html`
            <div class="strip__thumb" key=${`i${s}`} style=${`left: ${px(s)}px`}>${thumbs.current.has(s) ? html`<${Picture} bitmap=${thumbs.current.get(s)} />` : null}</div>`)}
          ${view.region ? html`<div class="strip__region" style=${`left: ${px(view.region.from)}px; width: ${px(view.region.to - view.region.from)}px`}></div>` : null}
          ${view.startAt !== null ? html`
            <div class="strip__pole" style=${`left: ${px(view.startAt)}px`}></div>
            <span class="strip__flag" style=${`left: ${px(view.startAt)}px`}>S</span>` : null}
          ${view.endAt !== null ? html`
            <div class="strip__pole" style=${`left: ${px(view.endAt)}px`}></div>
            <span class="strip__flag" style=${`left: ${px(view.endAt)}px`}>E</span>` : null}
        </div>` : null}
        <div class="strip__playhead" aria-hidden="true"></div>
        <div class="strip__knob" aria-hidden="true"></div>
      </div>

      <div class="mark-read">
        <button type="button" class="mark-fine" aria-label="One frame back" disabled=${!source} onClick=${() => stepBy(-1)}><${StepBackIcon} /></button>
        <p class=${`mark-text${view.textTone ? ` mark-text--${view.textTone}` : ''}`} role="status"><span class="mark-text__line">${view.text}</span></p>
        <button type="button" class="mark-fine" aria-label="One frame forward" disabled=${!source} onClick=${() => stepBy(1)}><${StepForwardIcon} /></button>
      </div>

      <div class="mark-steps" role="group" aria-label="Marks">
        <button type="button" class="mark-undo" data-mark="undo" aria-label="Undo the last mark" disabled=${!view.canUndo} onClick=${onUndo}><${UndoIcon} /></button>
        ${view.steps.map(s => html`
          <button type="button" key=${s.key} class=${`mark-tile mark-tile--${s.state}`} data-mark=${s.key} aria-label=${s.name}
            disabled=${!s.pressable} onClick=${() => onStep(s.key)}>
            <span class="mark-tile__disc" aria-hidden="true">${s.num}</span><span class="mark-tile__label" aria-hidden="true">${s.label}</span>
          </button>`)}
      </div>
    </main>
  `;
}
