// R3b, Delayed view (design/mockups/DelayedView.dc.html; package d29b, D2: the delayed view as a setting beside R3's
// replay). The screen shows the camera `delayS` late (media/delayed.mjs: the capture's chunks followed and decoded, each
// frame drawn once its time has come) on a canvas that fills the stage, fitted with its aspect kept, and the camera live
// in a small view in the corner. Nothing to touch until "Keep this lift", which takes the replay's length before the
// frame on screen and everything since (delayed-model.mjs's keepLift) to M. The delay's choices (5, 10, 15, 20 s) save
// the settings' delayS and start the view again at the new delay. End session ends the session and goes home. Leaving
// closes the delayed frames; the recording goes on. Fixed places: nothing moves while the clock or the view changes
// (base.css, "R3b, Delayed view"). A camera lost while recording shows "Camera stopped" with a resume, a failed capture
// d23's problem panel, as on R2.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { CheckIcon, RetryIcon, StopIcon } from '../components/icons.mjs';
import { Problem } from '../components/problem.mjs';
import { createDelayedFrames } from '../../media/delayed.mjs';
import { browserWebCodecs } from '../../media/webcodecs.mjs';
import { delayedView, keepLift, saveDelay } from '../delayed-model.mjs';
import { problemOf } from '../problem-model.mjs';
import { captureProblem, goHome } from '../record-model.mjs';
import { useCapture, useStream } from '../use-capture.mjs';
import { DEFAULT_SETTINGS } from '../../store/settings.mjs';

const MAX_PIXEL_RATIO = 2;
const messageOf = e => (e && e.message ? e.message : 'That didn’t work.');

/** One delayed frame on the canvas: the canvas at its box's size, the frame turned upright and fitted, aspect kept. */
function draw(canvas, { frame, rotation }) {
  const ratio = Math.min(MAX_PIXEL_RATIO, globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * ratio)), h = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  const fw = frame.displayWidth, fh = frame.displayHeight;
  const turned = rotation === 90 || rotation === 270;
  const scale = Math.min(w / (turned ? fh : fw), h / (turned ? fw : fh));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  if (rotation) ctx.rotate(rotation * Math.PI / 180);   // canvas angles run clockwise (y points down)
  ctx.drawImage(frame, -fw * scale / 2, -fh * scale / 2, fw * scale, fh * scale);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export function R3b({ flow, store, session, makeWebCodecs = browserWebCodecs }) {
  const [settings, setSettings] = useState(null);
  const [delayS, setDelayS] = useState(null);
  const [shown, setShown] = useState(false);       // a delayed frame has been drawn
  const [note, setNote] = useState(null);           // the decoder's own words when the view can't run
  const [problem, setProblem] = useState(null);     // Keep this lift that failed
  const [keeping, setKeeping] = useState(false);
  const { status, stream } = useCapture(session);
  const liveRef = useRef(null);
  const canvasRef = useRef(null);
  const framesRef = useRef(null);
  useStream(liveRef, stream);

  useEffect(() => {
    let current = true;
    Promise.resolve().then(() => store.getSettings()).catch(() => null).then(s => {
      if (!current) return;
      const found = s || { ...DEFAULT_SETTINGS };
      setSettings(found);
      setDelayS(found.delayS);
    });
    return () => { current = false; };
  }, [store]);

  // the delayed frames, once the delay is known: drawn at each screen refresh; closed when R3b is left
  const ready = delayS !== null;
  useEffect(() => {
    if (!ready) return undefined;
    const capture = session.capture;
    if (!capture) { setNote('The camera is not recording.'); return undefined; }
    let frames;
    try {
      frames = createDelayedFrames({ source: capture, webcodecs: makeWebCodecs(), delayS });
    } catch (e) {
      setNote(problemOf(e).title);
      return undefined;
    }
    framesRef.current = frames;
    let raf = 0, drawn = 0, failed = false;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const e = frames.take();
      const canvas = canvasRef.current;
      if (e) {
        try {
          if (canvas) {
            draw(canvas, e);
            drawn++;
            // what the page test reads: the frame drawn and the capture's clock then, on the recording's clock (µs)
            canvas.dataset.frames = String(drawn);
            canvas.dataset.frameUs = String(Math.round(e.timestamp));
            canvas.dataset.liveUs = String(Math.round(e.timestamp + e.behindS * 1e6));
          }
        } finally { e.frame.close(); }
        if (drawn === 1) setShown(true);
      }
      if (frames.error && !failed) { failed = true; setNote(messageOf(frames.error)); }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      frames.close();
      framesRef.current = null;
    };
  }, [ready, session, makeWebCodecs]);   // not the delay: its later changes go through setDelay, not a new view

  const view = delayedView({ status, delayS: delayS ?? DEFAULT_SETTINGS.delayS });
  const failure = captureProblem(status);
  const pick = async v => {
    if (v === delayS) return;
    setDelayS(v);
    if (framesRef.current) framesRef.current.setDelay(v);
    try { setSettings(await saveDelay(store, v)); } catch (e) { setNote(messageOf(e)); }
  };
  const keep = async () => {
    if (keeping) return;
    setKeeping(true);
    setProblem(null);
    const s = settings || DEFAULT_SETTINGS;
    const out = await keepLift({ session, flow, replayS: s.replayS, delayS: delayS ?? s.delayS });
    if (!out.ok) { setProblem(out.problem); setKeeping(false); }
  };
  const end = async () => { await session.end(); goHome(flow); };

  return html`
    <main class="screen delayed" data-screen="R3b" data-state=${status.state}>
      <div class="delayed-stage" role="img" aria-label=${`The camera, ${view.behind} live`}>
        <canvas class="delayed-canvas" ref=${canvasRef}></canvas>
        ${!shown && !note ? html`<p class="delayed-note" role="status">Starting: ${view.behind}</p>` : null}
        ${note ? html`<p class="delayed-note error" role="alert">${note}</p>` : null}
      </div>
      <header class="delayed-top">
        <div class="delayed-chips">
          <span class="live-chip live-chip--rec"><span class="live-chip__dot"></span>REC <span class="live-clock" data-delayed="clock">${view.clock}</span></span>
          <span class="delayed-behind" data-delayed="behind" aria-label=${`${view.behind} live`}>
            <span class="delayed-behind__n">${view.delay}</span><span class="delayed-behind__word">behind live</span>
          </span>
        </div>
        <div class="delayed-live" role="img" aria-label="Live camera">
          <video ref=${liveRef} muted playsinline autoplay></video>
          <span class="delayed-live__tag">LIVE</span>
        </div>
      </header>
      <div class="delayed-mid">
        ${failure ? html`<${Problem} problem=${failure} />` : problem ? html`
          <${Problem} problem=${problem}>
            <button type="button" class="button--primary button-big" data-delayed="dismiss" onClick=${() => setProblem(null)}>OK</button>
          <//>` : view.canResume ? html`
          <button type="button" class="chip-button" data-record="resume" onClick=${() => session.capture && session.capture.resume()}><${RetryIcon} /><span>${view.interrupted}</span></button>` : null}
      </div>
      <div class="delayed-controls">
        <div class="delayed-delays" role="group" aria-label="Delay">
          <span class="delayed-delays__label">Delay</span>
          ${view.delays.map(d => html`
            <button type="button" key=${d.value} class="delayed-delay" data-delay=${d.value} aria-pressed=${d.pressed} onClick=${() => pick(d.value)}>${d.label}</button>`)}
        </div>
        <button type="button" class="delayed-keep" data-delayed="keep" disabled=${keeping || status.state === 'failed'} onClick=${keep}>
          <${CheckIcon} />
          <span class="delayed-keep__text"><span class="delayed-keep__name">Keep this lift</span><span class="delayed-keep__sub">then mark start and end</span></span>
        </button>
        <div class="live-foot">
          <button type="button" class="live-end" data-delayed="end" onClick=${end}><${StopIcon} />End session</button>
          <span class="delayed-hands">Nothing to tap until you keep one</span>
        </div>
      </div>
    </main>
  `;
}
