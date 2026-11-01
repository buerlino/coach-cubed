'use strict';
// diagnostics.js's headless API for the new UI (package s4; docs/app-plan.md,
// "The contracts", item 4): each cue's descriptor, its tiles and reference
// line, its worst moment, and its overlay drawn on any canvas, all from
// computeResults()'s output passed in, with no mounted panel, no DOM and no
// module state.
//
// The fixtures are the committed tracks a lateral raise
// (global/example/lateral-raise-cable-1, the clip the mockups show) and a
// snatch (global/snatch/Session14_01_0h18m07s_made). The old page is driven
// through its own mount()/setTrack()/overlay() on small fakes, so "what the
// old panel shows" is read off the old panel itself, never retyped here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadDiagnostics } = require('../loadDiagnostics');
const { loadManifests, trackPathFor, diagnosticsSet } = require('../fixtures');

const LATERAL = 'global/example/lateral-raise-cable-1';
const SNATCH = 'global/snatch/Session14_01_0h18m07s_made';
const manifest = loadManifests();

function loadTrack(slug) {
  return JSON.parse(fs.readFileSync(trackPathFor(slug), 'utf8'));
}

// computeResults() exactly as tests/diagnostics.test.js runs it for the goldens.
function computed(slug) {
  const D = loadDiagnostics();
  D.setPage(diagnosticsSet(manifest, slug, D));
  const track = loadTrack(slug);
  return { D, track, out: D.computeResults(track.keypoints, track.meta, track.meta.tracks.kept) };
}

// --- fakes --------------------------------------------------------------------

// A 2D context that records every call and every property set, in order. Any
// method name is accepted, so the overlays draw on it unchanged.
function recordingContext(width = 1280, height = 720) {
  const calls = [];
  const props = {};
  const canvas = { width, height };
  return new Proxy({}, {
    get(_, k) {
      if (k === 'canvas') return canvas;
      if (k === 'calls') return calls;
      if (typeof k === 'symbol' || k === 'then') return undefined;
      if (Object.prototype.hasOwnProperty.call(props, k)) return props[k];
      if (k === 'measureText') return s => { calls.push(['measureText', s]); return { width: String(s).length * 7 }; };
      return (...args) => { calls.push([k, ...args]); };
    },
    set(_, k, v) { props[k] = v; calls.push(['=' + String(k), v]); return true; },
  });
}

// Just enough DOM for the old page's mount(): elements that hold innerHTML and
// children, canvases that hand out recording contexts.
function fakeElement(tag) {
  const listeners = {};
  const e = {
    tagName: tag, children: [], style: {}, innerHTML: '', className: '', textContent: '', value: null,
    listeners,
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    getBoundingClientRect() { return { left: 0, top: 0, width: this.width || 0, height: this.height || 0 }; },
  };
  if (tag === 'canvas') {
    let ctx = null;
    e.getContext = () => ctx || (ctx = recordingContext(e.width, e.height));
  }
  return e;
}

// The old page mounted on fakes, scoring the fixture's kept person (the one the
// goldens use), as app.py's page would after the lifter is picked.
function oldPage(slug, { smooth = false, cubic, sections = false } = {}) {
  global.document = { createElement: fakeElement };
  try {
    const D = loadDiagnostics();
    D.setPage(diagnosticsSet(manifest, slug, D));
    const el = {
      select: fakeElement('select'),
      wrap: fakeElement('div'),
      video: () => null,
      smoothMotion: smooth ? () => true : undefined,
      cubic,
    };
    if (sections) el.sections = fakeElement('div');
    D.mount(el);
    const track = loadTrack(slug);
    D.setTrack(track.keypoints, track.meta, {});
    el.select.value = track.meta.tracks.kept;
    for (const fn of el.select.listeners.change || []) fn();
    return { D, el };
  } finally {
    delete global.document;
  }
}

// Every sample's time, the midpoints between them (where interpolation shows),
// and a stretch before and after the clip.
function sweep(samples) {
  const ts = [samples[0].t - 0.5];
  samples.forEach((s, i) => {
    ts.push(s.t);
    if (samples[i + 1]) ts.push((s.t + samples[i + 1].t) / 2);
  });
  ts.push(samples[samples.length - 1].t + 0.5);
  return ts;
}

// A deliberately odd interpolator, so a run that ignored the caller's cubic
// would draw somewhere else and show up.
const testCubic = (v0, v1, v2, v3, t0, t1, t2, t3, u) => v1 + (v2 - v1) * u * u;

const MODES = {
  step: {},
  linear: { smooth: true },
  cubic: { smooth: true, cubic: testCubic },
};

function digest(calls) {
  const json = JSON.stringify(calls, (k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v));
  return crypto.createHash('sha256').update(json).digest('hex');
}

// --- the old page's overlay, pinned before the refactor -------------------------
//
// Diagnostics.overlay() on the mounted old page, over every sample time and the
// midpoints between them, in each motion mode. The digests in
// golden/overlay-digests.json were recorded from phase-0's src/diagnostics.js
// (8a4fcdf), before s4 touched it, on the committed tracks above
// (UPDATE_OVERLAY_DIGESTS=1 node --test tests/app/diagnostics-headless.test.js).
// They prove the shared drawing code still draws exactly what it drew.
const DIGESTS = path.join(__dirname, 'golden', 'overlay-digests.json');

function oldOverlayRecord(slug, mode) {
  const { D } = oldPage(slug, MODES[mode]);
  const { out } = computed(slug);
  const ctx = recordingContext();
  const perTime = [];
  for (const t of sweep(out.samples)) {
    const before = ctx.calls.length;
    D.overlay(ctx, t);
    perTime.push(ctx.calls.slice(before));
  }
  return { ctx, perTime, out };
}

test('the old page draws the same overlay as before s4 (digests from phase-0)', () => {
  const now = {};
  for (const slug of [LATERAL, SNATCH]) {
    now[slug] = {};
    for (const mode of Object.keys(MODES)) {
      const { ctx } = oldOverlayRecord(slug, mode);
      assert.ok(ctx.calls.length > 1000, `${slug} ${mode}: the old overlay drew almost nothing`);
      now[slug][mode] = { calls: ctx.calls.length, sha256: digest(ctx.calls) };
    }
  }
  if (process.env.UPDATE_OVERLAY_DIGESTS) {
    fs.mkdirSync(path.dirname(DIGESTS), { recursive: true });
    fs.writeFileSync(DIGESTS, JSON.stringify(now, null, 1) + '\n');
  }
  assert.deepStrictEqual(now, JSON.parse(fs.readFileSync(DIGESTS, 'utf8')));
});
