// SPDX-License-Identifier: AGPL-3.0-or-later
// A2's plot: a cue's measurement over time against its verdict's zones (design/mockups/CueDetail.dc.html),
// the app's own, mobile-first and on a plain canvas (the old panel's mount() and drawChart are not reused).
// What it shows, from the view model (contract 4) and diagnostics.js's zones(id): the zones as washes,
// the two sides' band, the phase the cue is scored in, the dashed reference line, the trace and the
// worst moment's dot. A tap on it seeks (timeAtTap). The geometry is plain functions, the painting
// takes any 2D context; colours, type and sizes are read from the tokens (plotStyle), never typed here.
// Plain module, no DOM.

const px = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const unquote = s => String(s || '').trim().replace(/^["']|["']$/g, '');
const WORD_TOKEN = { good: 'good', watch: 'watch', 'work on': 'work-on', "can't score": 'cant-score' };

/** The least a value axis spans, by unit: a flat trace is not magnified into apparent wobble (the old chart's 10). */
export const MIN_SPAN = Object.freeze({ x: 1 });
const MIN_SPAN_DEFAULT = 10;
const MARGIN = 0.08;      // value axis, a share of the span above and below the data
const TIME_MARGIN = 0.04; // time axis, a share of the span either side

const finite = v => typeof v === 'number' && Number.isFinite(v);

function niceTicks(a, b, n) {
  const span = b - a;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map(k => k * mag).find(s => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

/**
 * The plot's geometry for one cue, in the canvas's CSS pixels (the caller scales the context).
 * @param {Object} cue contract 4's CueView: series (t in seconds, value, lo, hi), phase, referenceLine, worst, unit
 * @param {Array<{status: string, from: number|null, to: number|null}>|null} zones diagnostics.js's zones(id); null draws no bands
 * @param {Object} o
 * @param {number} o.width the canvas box
 * @param {number} o.height
 * @param {{left: number, right: number, top: number, bottom: number}} o.pad
 * @param {number} [o.origin] the time the axis counts from (the marked range's start), as A1's clock
 * @param {(v: number) => string} [o.format] the worst moment's label
 */
export function plotGeometry(cue, zones, { width, height, pad, origin = 0, format = v => String(v) }) {
  const box = { left: pad.left, top: pad.top, width: width - pad.left - pad.right, height: height - pad.top - pad.bottom };
  const series = cue.series || [];

  // time: the series and the phase, with a margin; one sample still gets an axis
  const times = series.map(s => s.t);
  if (cue.phase) times.push(cue.phase.t0, cue.phase.t1);
  let t0 = Math.min(...times), t1 = Math.max(...times);
  if (!(t1 - t0 > 1e-9)) { t0 -= 0.5; t1 += 0.5; } else { const m = (t1 - t0) * TIME_MARGIN; t0 -= m; t1 += m; }

  // value: the trace, its band, the reference line, the worst moment and the zones' own edges
  const vals = [];
  for (const s of series) { vals.push(s.value); if (finite(s.lo)) vals.push(s.lo); if (finite(s.hi)) vals.push(s.hi); }
  if (cue.referenceLine) vals.push(cue.referenceLine.value);
  if (cue.worst) vals.push(cue.worst.value);
  const zs = Array.isArray(zones) ? zones : [];
  for (const z of zs) for (const e of [z.from, z.to]) if (finite(e)) vals.push(e);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const minSpan = MIN_SPAN[cue.unit] ?? MIN_SPAN_DEFAULT;
  const mid = (lo + hi) / 2;
  const span = Math.max(hi - lo, minSpan);
  lo = mid - span / 2 - span * MARGIN;
  hi = mid + span / 2 + span * MARGIN;

  const x = t => box.left + ((t - t0) / (t1 - t0)) * box.width;
  const y = v => box.top + (1 - (v - lo) / (hi - lo)) * box.height;
  const domain = { t0, t1, v0: lo, v1: hi };
  const bottom = box.top + box.height;

  // the zones, lowest first (the API's order), clipped to the plot; an open end runs to the plot's edge
  const bands = [];
  const clamp = n => Math.max(box.top, Math.min(bottom, n));
  for (const z of zs) {
    const upper = z.to === null ? box.top : y(z.to), lower = z.from === null ? bottom : y(z.from);
    if (upper >= bottom || lower <= box.top) continue;   // wholly off the plot
    bands.push({ status: z.status, top: clamp(upper), bottom: clamp(lower) });
  }
  // the edges between bands that lie inside the plot, with their values (the thresholds)
  const edges = [];
  const seen = new Set();
  for (const z of zs) for (const e of [z.from, z.to]) {
    if (finite(e) && e > lo && e < hi && !seen.has(e)) { seen.add(e); edges.push({ v: e, y: y(e) }); }
  }

  const phase = cue.phase
    ? { left: Math.max(box.left, x(cue.phase.t0)), right: Math.min(box.left + box.width, x(cue.phase.t1)) }
    : null;
  const reference = cue.referenceLine
    ? { y: y(cue.referenceLine.value), label: cue.referenceLine.label, left: box.left, right: box.left + box.width }
    : null;
  const line = series.map(s => [x(s.t), y(s.value)]);
  const sided = series.length > 0 && series.every(s => finite(s.lo) && finite(s.hi));
  const band = sided ? [...series.map(s => [x(s.t), y(s.hi)]), ...series.slice().reverse().map(s => [x(s.t), y(s.lo)])] : null;
  const worst = cue.worst ? { x: x(cue.worst.t), y: y(cue.worst.value), t: cue.worst.t, label: format(cue.worst.value) } : null;

  const ticks = {
    time: niceTicks(t0, t1, 4).map(t => ({ t, x: x(t), label: `${(t - origin).toFixed(1)} s` })),
    value: niceTicks(lo, hi, 4).map(v => ({ v, y: y(v), label: String(+v.toFixed(2)) })),
  };
  return { size: { width, height }, box, domain, x, y, zones: bands, edges, phase, reference, line, band, worst, ticks };
}

/**
 * The time a tap on the canvas seeks to: the pointer's place on the plot's time axis, clamped to it.
 * @param {number} clientX the pointer
 * @param {{left: number, width: number}} rect the canvas's box on the page (it may be shown at another size than the geometry's)
 * @param {ReturnType<typeof plotGeometry>} geom
 */
export function timeAtTap(clientX, rect, geom) {
  const { t0, t1 } = geom.domain;
  if (!(rect.width > 0)) return t0;
  const cx = ((clientX - rect.left) / rect.width) * geom.size.width;
  const f = (cx - geom.box.left) / geom.box.width;
  return t0 + Math.max(0, Math.min(1, f)) * (t1 - t0);
}

/**
 * The plot's look, read from the tokens. `read(name)` is a custom property's value.
 * @param {(name: string) => string} read
 * @param {string} status the cue's status word: the colour of the trace's worst-moment dot
 */
export function plotStyle(read, status) {
  const v = name => String(read(name) || '').trim();
  const statuses = Object.keys(WORD_TOKEN);
  const statusColour = {
    good: v('--status-good'), watch: v('--status-watch'), 'work on': v('--status-work-on'), "can't score": v('--status-cant-score'),
  };
  const zoneColour = { good: v('--zone-good'), watch: v('--zone-watch'), 'work on': v('--zone-work-on') };
  return {
    pad: { left: px(v('--plot-pad-left')), right: px(v('--plot-pad-right')), top: px(v('--plot-pad-top')), bottom: px(v('--plot-pad-bottom')) },
    font: `${px(v('--size-mark'))}px ${v('--font-text')}`,
    fontStrong: `600 ${px(v('--size-mark'))}px ${v('--font-text')}`,
    text: v('--text-quiet'),
    textSoft: v('--text-soft'),
    trace: v('--text'),
    line: v('--line'),
    ground: v('--ground'),
    band: v('--plot-band'),
    phase: v('--plot-phase'),
    reference: v('--text-soft'),
    playhead: v('--text'),
    status: { good: statusColour.good, watch: statusColour.watch, 'work on': statusColour['work on'] },
    zone: zoneColour,
    words: Object.fromEntries(statuses.map(s => [s, unquote(v(`--status-${WORD_TOKEN[s]}-word`))])),
    marker: statusColour[status in statusColour ? status : "can't score"],
    markerRadius: px(v('--plot-marker')),
    traceWidth: px(v('--plot-trace')),
    hairline: px(v('--plot-hairline')),
    dash: px(v('--plot-dash')),
    height: px(v('--plot-height')),
    labelGap: px(v('--plot-label-gap')),
    labelDrop: px(v('--plot-label-drop')),
    labelRise: px(v('--plot-label-rise')),
    labelInset: px(v('--plot-label-inset')),
    zoneLabelTop: px(v('--plot-zone-label-top')),
    timeGap: px(v('--plot-time-gap')),
    markerGap: px(v('--plot-marker-gap')),
    markerBelow: px(v('--plot-marker-below')),
    markerTop: px(v('--plot-marker-top')),
    flipMargin: px(v('--plot-flip-margin')),
    playheadWidth: px(v('--plot-playhead')),
    ring: px(v('--plot-ring')),
  };
}

/**
 * Paints the plot on a 2D context already scaled to CSS pixels.
 * @param {CanvasRenderingContext2D} ctx
 * @param {ReturnType<typeof plotGeometry>} g
 * @param {ReturnType<typeof plotStyle>} s
 * @param {{at?: number|null}} [o] at: the time shown in the frame, a playhead line on the plot
 */
export function drawPlot(ctx, g, s, { at = null } = {}) {
  const { box } = g;
  const right = box.left + box.width, bottom = box.top + box.height;
  ctx.clearRect(0, 0, g.size.width, g.size.height);
  ctx.setLineDash([]);

  // the zones, behind everything, each with its word at the right edge
  for (const b of g.zones) {
    ctx.fillStyle = s.zone[b.status];
    ctx.fillRect(box.left, b.top, box.width, b.bottom - b.top);
  }
  if (g.phase && g.phase.right > g.phase.left) {
    ctx.fillStyle = s.phase;
    ctx.fillRect(g.phase.left, box.top, g.phase.right - g.phase.left, box.height);
  }

  // the thresholds between the zones, dashed, with their values
  ctx.font = s.font;
  ctx.textAlign = 'right';
  ctx.lineWidth = s.hairline;
  ctx.setLineDash([s.dash, s.dash - s.hairline]);
  for (const e of g.edges) {
    ctx.strokeStyle = s.line;
    ctx.beginPath(); ctx.moveTo(box.left, e.y); ctx.lineTo(right, e.y); ctx.stroke();
    ctx.fillStyle = s.text;
    ctx.fillText(String(+e.v.toFixed(2)), box.left - s.labelGap, e.y + s.labelDrop);
  }
  ctx.setLineDash([]);
  ctx.font = s.fontStrong;
  for (const b of g.zones) {
    ctx.fillStyle = s.status[b.status];
    ctx.fillText(s.words[b.status], right - s.labelGap, b.top + s.zoneLabelTop > b.bottom ? b.bottom - s.labelRise : b.top + s.zoneLabelTop);
  }

  // time axis labels
  ctx.font = s.font;
  ctx.textAlign = 'center';
  ctx.fillStyle = s.text;
  for (const k of g.ticks.time) ctx.fillText(k.label, k.x, g.size.height - s.timeGap);

  // the two sides' band, behind the trace
  if (g.band && g.band.length) {
    ctx.fillStyle = s.band;
    ctx.beginPath();
    g.band.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
  }

  // the reference line, dashed and named
  if (g.reference) {
    ctx.strokeStyle = s.reference;
    ctx.lineWidth = s.hairline;
    ctx.setLineDash([s.dash, s.dash - s.hairline]);
    ctx.beginPath(); ctx.moveTo(g.reference.left, g.reference.y); ctx.lineTo(g.reference.right, g.reference.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = s.textSoft;
    ctx.textAlign = 'left';
    ctx.fillText(g.reference.label, box.left + s.labelInset, g.reference.y - s.labelRise);
  }

  // the trace
  if (g.line.length > 1) {
    ctx.strokeStyle = s.trace;
    ctx.lineWidth = s.traceWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    g.line.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }

  // the frame shown, as a vertical line
  if (at !== null && at >= g.domain.t0 && at <= g.domain.t1) {
    const x = g.x(at);
    ctx.strokeStyle = s.playhead;
    ctx.lineWidth = s.playheadWidth;
    ctx.beginPath(); ctx.moveTo(x, box.top); ctx.lineTo(x, bottom); ctx.stroke();
  }

  // the worst moment: a dot in the cue's status colour, ringed in the ground colour, with its value
  if (g.worst) {
    ctx.fillStyle = s.marker;
    ctx.strokeStyle = s.ground;
    ctx.lineWidth = s.ring;
    ctx.beginPath(); ctx.arc(g.worst.x, g.worst.y, s.markerRadius, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.font = s.fontStrong;
    ctx.fillStyle = s.marker;
    const flip = g.worst.x > right - s.flipMargin;
    ctx.textAlign = flip ? 'right' : 'left';
    ctx.fillText(g.worst.label, g.worst.x + (flip ? -s.markerGap : s.markerGap), g.worst.y - s.markerGap < box.top + s.markerTop ? g.worst.y + s.markerBelow : g.worst.y - s.markerGap);
  }
}
