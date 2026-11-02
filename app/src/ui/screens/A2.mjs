// A2, a cue's detail (design/mockups/CueDetail.dc.html, package d18): the frame at the cue's worst moment with
// the cue drawn over the skeleton, the cue's plot over time against its zones (a tap on it shows that moment),
// its tiles, the cue and how it's scored. A1's "Plot and details" opens it with the lift's id and the cue's id
// in the flow's params; Back returns to the result. What to show, and why: detail-model.mjs (every word and
// number is the view's or diagnostics.js's); the drawing: draw/plot.mjs and draw/overlay.mjs.
// The store and the diagnostics.js object are injected (main.mjs gives the app's store; tests pass fakes).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { openFrameSource } from '../../media/frame-source.mjs';
import { getDiagnostics, scoreLift } from '../../scoring/score.mjs';
import { drawPlot, overlayStyle, paintCue, plotGeometry, plotStyle, timeAtTap, trackSamples } from '../../draw/index.mjs';
import { detailOf } from '../detail-model.mjs';
import { valueText } from '../result-model.mjs';
import { BackIcon, StatusIcon } from '../components/icons.mjs';

const NO_LIFT = 'There is no lift to show. Open one from home.';
const NOT_READY = 'This lift has no result yet.';
const NO_CUE = 'This lift has no such cue.';
const CANT_SHOW = 'This cue could not be shown.';

const pixelRatio = () => (globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1);
const root = () => (globalThis.document ? globalThis.document.documentElement : null);
const readToken = n => (root() ? globalThis.getComputedStyle(root()).getPropertyValue(n) : '');

export function A2({ flow, store, openSource = openFrameSource, diagnostics = null }) {
  const liftId = flow.params.liftId || null;
  const cueId = flow.params.cue || null;
  const [data, setData] = useState(null);
  const [problem, setProblem] = useState(null);
  const [t, setT] = useState(null);              // the time of the frame shown (the cut's timeline, seconds)
  const parts = useRef({});
  const frameRef = useRef(null);
  const overlayRef = useRef(null);
  const plotRef = useRef(null);
  const geomRef = useRef(null);
  const seq = useRef(0);

  // load: the record, the result, the track; score the track as the result was; open the cut
  useEffect(() => {
    let current = true;
    const p = parts.current = {};
    (async () => {
      if (!liftId || !store || !cueId) { setProblem(NO_LIFT); return; }
      const [rec, view, track] = await Promise.all([store.getLift(liftId), store.readResult(liftId), store.readTrack(liftId)]);
      if (!rec || !view || !track) { if (current) setProblem(NOT_READY); return; }
      if (!view.cues.some(c => c.id === cueId)) { if (current) setProblem(NO_CUE); return; }
      const D = diagnostics || getDiagnostics();
      const { sigmaMs, keepVelocity } = view.smoothing;
      // computed and keypoints are what scoreLift() scored, so the skeleton and the cues sit on the same samples
      const { computed, keypoints } = scoreLift(track, rec.lift, { Diagnostics: D, sigmaMs, keepVelocity });
      const detail = detailOf({ Diagnostics: D, view, computed, cueId, range: rec.range });
      let src = null;
      if (detail.scored) {
        src = await openSource(await store.readVideo(liftId));
        p.src = src;
        if (!current) { src.close(); return; }
      }
      if (!current) return;
      setData({ rec, view, computed, D, detail, src, meta: track.meta, track: trackSamples(keypoints, track.meta) });
      setT(detail.worst ? detail.worst.t : rec.range.t0);
    })().catch(e => { if (current) setProblem(e && e.message ? e.message : CANT_SHOW); });
    return () => { current = false; seq.current++; if (p.src) p.src.close(); parts.current = {}; };
  }, [store, liftId, cueId]);

  // the frame at t with the cue over the skeleton; the latest request wins
  useEffect(() => {
    if (!data || !data.src || t === null || !frameRef.current || !overlayRef.current) return undefined;
    const mine = ++seq.current;
    (async () => {
      const f = await data.src.frameAt(t);
      try {
        if (mine !== seq.current) return;
        const { width, height } = data.meta;
        const fc = frameRef.current, oc = overlayRef.current;
        if (fc.width !== width || fc.height !== height) { fc.width = width; fc.height = height; }
        oc.width = width; oc.height = height;
        fc.getContext('2d').drawImage(f, 0, 0, width, height);
        const box = fc.parentElement;
        const style = overlayStyle(readToken, box && box.clientWidth > 0 ? width / box.clientWidth : 1);
        paintCue(oc.getContext('2d'), { track: data.track, meta: data.meta, Diagnostics: data.D, view: data.view, computed: data.computed }, f.timestamp / 1e6, { cue: data.detail.id, style });
      } finally { f.close(); }
    })().catch(e => setProblem(e && e.message ? e.message : CANT_SHOW));
    return undefined;
  }, [data, t]);

  // the plot, at the canvas's own width; again when the frame shown or the width changes
  useEffect(() => {
    const cv = plotRef.current;
    if (!data || !cv || !data.detail.scored) return undefined;
    const draw = () => {
      const ratio = pixelRatio();
      const style = plotStyle(readToken, data.detail.status);
      const width = cv.clientWidth;
      if (!(width > 0)) return;   // not laid out yet: the ResizeObserver draws it when it is
      const height = parseFloat(globalThis.getComputedStyle(cv).height) || style.height;
      cv.width = Math.round(width * ratio);
      cv.height = Math.round(height * ratio);
      const ctx = cv.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const cue = data.detail.plot;
      const geom = plotGeometry(cue, data.detail.zones, {
        width, height, pad: style.pad, origin: data.detail.origin,
        format: v => valueText({ unit: cue.unit, value: v, worst: cue.worst }),
      });
      geomRef.current = geom;
      drawPlot(ctx, geom, style, { at: t });
    };
    draw();
    let watch = null;
    if (globalThis.ResizeObserver) { watch = new globalThis.ResizeObserver(draw); watch.observe(cv); }
    return () => { if (watch) watch.disconnect(); };
  }, [data, t]);

  const tap = e => {
    if (!geomRef.current) return;
    setT(timeAtTap(e.clientX, e.currentTarget.getBoundingClientRect(), geomRef.current));
  };

  const d = data ? data.detail : null;
  const atWorst = d && d.worst && t !== null && Math.abs(t - d.worst.t) < 1e-3;
  const shown = d && t !== null ? (t - d.origin).toFixed(2) : null;
  const plot = d ? d.plot : null;
  const sub = plot ? [plot.unit, plot.phaseLabel, plot.series.some(s => s.lo != null && s.hi != null) ? 'band: the two sides' : null].filter(Boolean).join(' · ') : '';

  return html`
    <main class="screen detail" data-screen="A2">
      <header class="bar-header detail-header">
        <button type="button" class="icon-button" aria-label="Back to the result" onClick=${() => flow.go('result', { liftId })}><${BackIcon} /></button>
        <h1 class="bar-header__title">${d ? d.title : 'Cue detail'}</h1>
        ${d ? html`<span class=${`detail-badge status--${d.cls}`}><${StatusIcon} icon=${d.icon} /><span class=${`status status--${d.cls}`}></span></span>` : null}
      </header>
      ${problem ? html`<p class="error detail-problem" role="alert">${problem}</p>` : null}
      ${d ? html`
        <div class="detail-body">
          ${d.scored ? html`
            <div class="detail-stage">
              <div class="detail-frame" role="img" aria-label=${`${atWorst ? d.moment.label : 'The frame'} at ${shown} s${d.verdict ? `: ${d.verdict}` : ''}`} style=${`aspect-ratio: ${data.meta.width} / ${data.meta.height}`}>
                <canvas class="result-layer" ref=${frameRef}></canvas>
                <canvas class="result-layer" ref=${overlayRef}></canvas>
              </div>
              <span class="detail-chip detail-chip--when">${atWorst ? d.moment.label : 'At'}<br /><strong>${shown} s</strong></span>
              <span class=${`detail-chip detail-chip--verdict status--${d.cls}`}>${d.verdict}</span>
            </div>` : null}
          <div class="detail-content">
            ${d.scored ? null : html`<p class="detail-reason">${d.reason}</p>`}
            ${d.scored ? html`
              <section class="detail-plot" aria-labelledby="plot-h">
                <h2 id="plot-h">Over time</h2>
                <p class="quiet">${sub}</p>
                <canvas class="detail-plot__canvas" ref=${plotRef} role="img" aria-label=${`${d.title} over time, against its zones. Tap to show that moment in the frame.`} onPointerDown=${tap}></canvas>
              </section>
              <div class="detail-tiles">
                ${d.tiles.map(k => html`
                  <div class="detail-tile">
                    <span class="detail-tile__label">${k.label}</span>
                    <span class=${`detail-tile__value${k.cls ? ` status--${k.cls}` : ''}`}>${k.value}</span>
                    ${k.sub ? html`<span class="detail-tile__sub">${k.sub}</span>` : null}
                  </div>`)}
              </div>` : null}
            <section aria-labelledby="cue-h">
              <h2 class="section__title" id="cue-h">The cue</h2>
              <p class="detail-cue">${d.cue}</p>
            </section>
            ${d.notes.map(n => html`<p class="cue-card__note">${n}</p>`)}
            ${d.scored ? html`
              <section class="detail-rule" aria-labelledby="rule-h">
                <h2 id="rule-h">How it's scored${d.provisional ? ' · provisional' : ''}</h2>
                ${d.rule ? html`<p class="detail-rule__sentence">${d.rule}</p>` : null}
                <dl class="detail-lines">
                  ${d.lines.map(l => html`<div class="detail-line"><dt>${l.label}</dt><dd>${l.text}</dd></div>`)}
                </dl>
              </section>` : null}
          </div>
        </div>` : null}
    </main>
  `;
}
