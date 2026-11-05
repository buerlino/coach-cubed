// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// src/diagnostics.js is a browser script — an IIFE that attaches itself to
// `window` and is otherwise silent about exports. The only thing it needs at
// load time (not just inside mount()/setTrack(), which tests never call) is
// `window` existing, so a bare stub is enough to load it headless; no jsdom.
const path = require('node:path');

const DIAGNOSTICS_JS = path.join(__dirname, '..', 'src', 'diagnostics.js');

function loadDiagnostics() {
  global.window = {};
  delete require.cache[require.resolve(DIAGNOSTICS_JS)];
  require(DIAGNOSTICS_JS);
  return global.window.Diagnostics;
}

module.exports = { loadDiagnostics };
