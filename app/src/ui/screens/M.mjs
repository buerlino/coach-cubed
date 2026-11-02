// M, Mark the lift (design/mockups/Mark.dc.html, MarkEnd, MarkReady): one screen
// in three states. The filmstrip of thumbnails moves under a fixed playhead; the
// frame under it is decoded off the input path (mark-model.mjs's createPlayhead:
// a drag only says where it is); Set start, Set end, one frame back or on (s38's
// stepper), the marked length and its time, Analyse, Redo. The file and the lift
// come in the flow's params from H's import; the queue is injected (main.mjs
// gives the app's one), so tests pass a fake. What to show and what Analyse does
// is mark-model.mjs's; this draws it and holds the video open while M is up.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { openFrameSource } from '../../media/frame-source.mjs';
import {
  PX_PER_SECOND, THUMB, analyse, analyseCost, createPlayhead, dragTarget, dropFarThumbs, fitSize, liftLabelOf, markView,
  newMarks, otherLift, redo, setMark, stripLeft, thumbSeconds, thumbTime,
} from '../mark-model.mjs';
import { ChevronDownIcon, CloseIcon, StepBackIcon, StepForwardIcon } from '../components/icons.mjs';

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

export function M({ flow, queue, openSource = openFrameSource }) {
  const { file = null } = flow.params;
  const [lift, setLift] = useState(flow.params.lift || 'lateral-raise');
  const [source, setSource] = useState(null);     // { frameTimes, info } once the video is open
  const [problem, setProblem] = useState(null);   // the video could not be opened, or a frame could not be decoded
  const [marks, setMarks] = useState(newMarks);
  const [index, setIndex] = useState(0);          // the playhead's frame
  const [cost, setCost] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);   // what Analyse said when it couldn't go on
  const [width, setWidth] = useState(0);          // the strip's width in px: the playhead is at its middle
  const [thumbVersion, setThumbVersion] = useState(0);
  const parts = useRef({});                       // the open video, its stepper and playhead: closed when M closes
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const stripRef = useRef(null);
  const drag = useRef(null);
  const thumbs = useRef(new Map());               // second → ImageBitmap
  const making = useRef(false);

  // the video, its stepper and the playhead; all closed when M closes
  useEffect(() => {
    if (!file) return undefined;
    let current = true;
    const p = parts.current = {};
    (async () => {
      const src = await openSource(file);
      p.src = src;
      if (!current) { src.close(); return; }
      const box = stageRef.current;
      const size = fitSize(src.info, { width: box ? box.clientWidth : 390, height: box ? box.clientHeight : 440 }, pixelRatio());
      const stepper = await src.stepper(0, size);
      p.stepper = stepper;
      if (!current) { stepper.close(); src.close(); return; }
      p.head = createPlayhead({
        stepper,
        draw: r => paint(r.frame),
        fail: e => { if (current) setProblem(e && e.message ? e.message : 'The video could not be decoded.'); },
      });
      paint(stepper.frame);
      setSource({ frameTimes: src.frameTimes, info: src.info });
    })().catch(e => { if (current) setProblem(e && e.message ? e.message : 'This video could not be opened.'); });
    return () => {
      current = false;
      if (p.head) p.head.close();
      if (p.stepper) p.stepper.close();
      if (p.src) p.src.close();
      for (const b of thumbs.current.values()) { try { b.close(); } catch { /* closed */ } }
      thumbs.current.clear();
    };
  }, [file, openSource]);

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
    const missing = seconds.filter(s => !thumbs.current.has(s)).sort((a, b) => Math.abs(a + 0.5 - time) - Math.abs(b + 0.5 - time)).slice(0, THUMB_BATCH);
    if (!missing.length) return undefined;
    making.current = true;
    src.thumbnails(missing.map(s => thumbTime(s, frameTimes)), { height: THUMB.height * Math.min(2, pixelRatio()) })
      .then(bitmaps => {
        if (!parts.current.src || parts.current.src !== src) { bitmaps.forEach(b => b.close()); return; }
        missing.forEach((s, k) => { if (thumbs.current.has(s)) bitmaps[k].close(); else thumbs.current.set(s, bitmaps[k]); });
      })
      .catch(() => { /* a thumbnail that can't be made leaves its box empty */ })
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

  const move = (to) => {
    const head = parts.current.head;
    if (!head) return;
    setProblem(null);
    to.catch(() => { /* the playhead reports it */ }).then(r => { if (r) setIndex(r.index); });
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
    const out = await analyse({ flow, queue, lift, file, marks, frameTimes });
    if (!out.ok) { setBusy(false); setRefused(out.error); }
  };

  const view = source ? markView(marks, { index, frameTimes, cost }) : null;
  const left = stripLeft(time, width);
  const px = t => (t * PX_PER_SECOND).toFixed(1);

  if (!file) {
    return html`
      <main class="screen" data-screen="M">
        <header class="mark-header">
          <button type="button" class="icon-button" aria-label="Close" onClick=${() => flow.go('home')}><${CloseIcon} /></button>
          <h1 class="mark-header__title">Mark the lift</h1>
        </header>
        <div class="screen__body">
          <p class="soft">There is no video to mark. Pick one from the home screen.</p>
          <button type="button" onClick=${() => flow.go('home')}>Back</button>
        </div>
      </main>`;
  }

  return html`
    <main class="screen mark" data-screen="M" data-step=${view ? view.step : 'loading'}>
      <header class="mark-header">
        <button type="button" class="icon-button" aria-label="Close" onClick=${() => flow.go('home')}><${CloseIcon} /></button>
        <h1 class="mark-header__title">Mark the lift</h1>
        <button type="button" class="mark-lift" aria-label=${`Lift: ${liftLabelOf(lift)}. Tap to change.`} onClick=${() => setLift(otherLift(lift))}>
          ${liftLabelOf(lift)}<${ChevronDownIcon} />
        </button>
      </header>

      <div class="mark-stage" ref=${stageRef} role="img" aria-label="The video at the playhead">
        <canvas ref=${canvasRef} style=${source ? '' : 'display: none'}></canvas>
        ${!source && !problem ? html`<p class="mark-stage__note" role="status">Opening the video…</p>` : null}
        ${problem ? html`<p class="mark-stage__note error" role="alert">${problem}</p>` : null}
        ${view ? html`<span class="mark-clock">${view.clock}</span>` : null}
      </div>

      ${view ? html`
      <ol class="mark-steps" aria-label="Steps">
        ${view.steps.map(s => html`
          <li key=${s.label} class=${`mark-step mark-step--${s.state}`} aria-current=${s.state === 'now' ? 'step' : null}>
            <span class="mark-step__num">${s.num}</span>${s.label}
          </li>`)}
      </ol>` : null}

      <div class="strip" ref=${stripRef} role="slider" tabindex="0" aria-label="Playhead position, drag the filmstrip"
        aria-valuemin="0" aria-valuemax=${duration.toFixed(1)} aria-valuenow=${time.toFixed(1)} aria-valuetext=${view ? view.clock : ''}
        onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerEnd} onPointerCancel=${onPointerEnd} onKeyDown=${onKeyDown}>
        ${view ? html`
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

      <div class="mark-hints">
        ${view ? html`
          <p class=${`mark-hint${view.hintIsError ? ' mark-hint--error' : ''}`} role="status">${view.hint}</p>
          <p class="mark-subhint">${view.subHint}</p>
          ${view.estimateNote ? html`<p class="mark-subhint">${view.estimateNote}</p>` : null}
          ${refused ? html`<p class="error" role="alert">${refused}</p>` : null}
          ${view.canRedo ? html`<button type="button" class="mark-redo" onClick=${() => setMarks(redo())}>Redo the marks</button>` : null}` : null}
      </div>

      <div class="mark-actions">
        <button type="button" class="mark-step-button" aria-label="One frame back" disabled=${!source} onClick=${() => stepBy(-1)}><${StepBackIcon} /></button>
        ${view && view.canAnalyse
          ? html`<button type="button" class="button--primary mark-main" disabled=${busy} onClick=${onAnalyse}>${busy ? 'Keeping the video…' : view.analyseLabel}</button>`
          : html`<button type="button" class="mark-main mark-main--set" disabled=${!source} onClick=${() => setMarks(setMark(marks, index, frameTimes))}>${view ? view.setLabel : 'Set start'}</button>`}
        <button type="button" class="mark-step-button" aria-label="One frame forward" disabled=${!source} onClick=${() => stepBy(1)}><${StepForwardIcon} /></button>
      </div>
    </main>
  `;
}
