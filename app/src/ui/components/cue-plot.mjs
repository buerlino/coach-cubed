// A cue's plot over time against its zones (A2's "Over time", A4's panel): one canvas, drawn at its own width
// and again when that changes. `detail` is detail-model's detailOf() for a scored cue; `at` is the time marked
// with the playhead line (the cut's timeline, seconds); `onTap(t)` hears the time under a tap. The drawing is
// draw/plot.mjs's; this only measures the canvas and keeps the geometry the tap needs.
import { useEffect, useRef } from 'preact/hooks';
import { html } from '../html.mjs';
import { drawPlot, plotGeometry, plotStyle, timeAtTap } from '../../draw/index.mjs';
import { valueText } from '../result-model.mjs';

const pixelRatio = () => (globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1);
const readToken = n => (globalThis.document ? globalThis.getComputedStyle(globalThis.document.documentElement).getPropertyValue(n) : '');

export function CuePlot({ detail, at, onTap }) {
  const ref = useRef(null);
  const geomRef = useRef(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !detail.scored) return undefined;
    const draw = () => {
      const ratio = pixelRatio();
      const style = plotStyle(readToken, detail.status);
      const width = cv.clientWidth;
      if (!(width > 0)) return;   // not laid out yet: the ResizeObserver draws it when it is
      const height = parseFloat(globalThis.getComputedStyle(cv).height) || style.height;
      cv.width = Math.round(width * ratio);
      cv.height = Math.round(height * ratio);
      const ctx = cv.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const cue = detail.plot;
      const geom = plotGeometry(cue, detail.zones, {
        width, height, pad: style.pad, origin: detail.origin,
        format: v => valueText({ unit: cue.unit, value: v, worst: cue.worst }),
      });
      geomRef.current = geom;
      drawPlot(ctx, geom, style, { at });
    };
    draw();
    let watch = null;
    if (globalThis.ResizeObserver) { watch = new globalThis.ResizeObserver(draw); watch.observe(cv); }
    return () => { if (watch) watch.disconnect(); };
  }, [detail, at]);

  const tap = e => {
    if (geomRef.current && onTap) onTap(timeAtTap(e.clientX, e.currentTarget.getBoundingClientRect(), geomRef.current));
  };
  return html`<canvas class="detail-plot__canvas" ref=${ref} role="img" aria-label=${`${detail.title} over time, against its zones. Tap to show that moment in the frame.`} onPointerDown=${tap}></canvas>`;
}
