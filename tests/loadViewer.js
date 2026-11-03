// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// The 3D viewer is an inline <script type="module"> inside src/app.py's HTML
// template, so unlike diagnostics.js there is no file to require. It is pulled
// out of the template here, written to a temp .mjs, and imported — which means
// the tests run the SHIPPED source rather than a copy that can drift.
//
// Two substitutions make it loadable headless:
//   * `import('three')` goes to a stub that re-exports the vendored three.js
//     with WebGLRenderer replaced. Only the renderer needs a GL context; the
//     projection, picking and drag maths are all plain arithmetic, and stubbing
//     the renderer is what lets them be tested at all on a box with no GPU.
//   * document/window are the small fakes below, not jsdom — the viewer touches
//     four elements and three window events.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_PY = path.join(ROOT, 'src', 'app.py');
const THREE_JS = path.join(ROOT, 'src', 'vendor', 'three.module.js');

function extractViewerSource() {
  const src = fs.readFileSync(APP_PY, 'utf8');
  const blocks = [...src.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
  if (!blocks.length) throw new Error('no <script type="module"> in app.py');
  return blocks[blocks.length - 1][1];
}

// Element stub: enough for getElementById + addEventListener/dispatchEvent, and
// a fixed bounding box so screen-space picking has a canvas to project into.
function makeEl(id, width, height) {
  const handlers = {};
  return {
    id, style: {}, textContent: '',
    clientWidth: width, clientHeight: height,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    dispatchEvent(ev) { (handlers[ev.type] || []).forEach(fn => fn(ev)); return true; },
    fire(type, ev) { (handlers[type] || []).forEach(fn => fn({ type, ...ev })); },
  };
}

async function loadViewer({ width = 640, height = 340 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-viewer-'));
  // Copied in as .mjs: the vendored file is ES module source under a .js name,
  // and node reads .js as CommonJS unless the nearest package.json says
  // otherwise — which the repo's does not, and should not have to.
  const three = path.join(dir, 'three.mjs');
  fs.copyFileSync(THREE_JS, three);
  const stub = path.join(dir, 'three-stub.mjs');
  fs.writeFileSync(stub,
    `export * from './three.mjs';\n` +
    'export class WebGLRenderer {\n' +
    '  constructor(o) { this.domElement = o.canvas; this.frames = 0; }\n' +
    '  setPixelRatio() {} setSize() {} render() { this.frames++; }\n' +
    '}\n');
  const mod = path.join(dir, 'viewer.mjs');
  fs.writeFileSync(mod, extractViewerSource()
    .replace("import('three')", `import(${JSON.stringify(stub)})`));

  const els = {};
  const winHandlers = {};
  global.document = {
    getElementById: id => (els[id] ||= makeEl(id, width, height)),
  };
  global.window = {
    devicePixelRatio: 1,
    addEventListener(type, fn) { (winHandlers[type] ||= []).push(fn); },
  };

  await import('node:url').then(u => import(u.pathToFileURL(mod).href));

  return {
    Viewer: global.window.Viewer,
    error: global.window.__viewerError || null,
    el: id => global.document.getElementById(id),
    // The turntable listens on window for move/up (a drag that leaves the
    // canvas should keep turning), and on the wrapper for down/hover.
    fireWindow(type, ev) { (winHandlers[type] || []).forEach(fn => fn({ type, ...ev })); },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

module.exports = { loadViewer, extractViewerSource };
