// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// Pulls named top-level declarations out of the frozen old page (INDEX_HTML in
// src/app.py) or out of src/diagnostics.js, and evaluates them, so a port can
// be pinned to the code the old page actually runs (restructure-plan step
// 3.2; 5.5 does the same). Reads the files, never edits them.
//
// A declaration is found by its name at the start of a line: a function runs
// to the first line that is just `}`, a const is its one line. That holds for
// the page's inline script and for diagnostics.js, whose top level isn't
// indented. INDEX_HTML is a plain (not raw) Python string, so a backslash in
// the JS would mean Python rewrote it: those are refused, not guessed at.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');

function indexHtml() {
  const src = fs.readFileSync(path.join(SRC, 'app.py'), 'utf8');
  const start = src.indexOf('INDEX_HTML = """');
  if (start < 0) throw new Error('no INDEX_HTML in src/app.py');
  const end = src.indexOf('"""', start + 16);
  return src.slice(start + 16, end);
}

function declaration(src, name, where) {
  const fn = new RegExp(`^function ${name}\\(`, 'm').exec(src);
  if (fn) {
    const end = src.indexOf('\n}\n', fn.index);
    if (end < 0) throw new Error(`${where}: function ${name} has no closing brace at column 0`);
    return src.slice(fn.index, end + 2);
  }
  const c = new RegExp(`^const ${name}\\b[^\\n]*`, 'm').exec(src);
  if (c) return c[0];
  throw new Error(`${where}: no top-level function or const named ${name}`);
}

function load(src, names, where) {
  const code = names.map(n => declaration(src, n, where)).join('\n');
  if (code.includes('\\')) throw new Error(`${where}: a backslash in ${names.join(', ')}; extract it by hand`);
  // runInThisContext, not a new context: objects built in another realm have
  // other prototypes, and assert.deepStrictEqual would tell them apart.
  return vm.runInThisContext(`(function () {\n${code}\nreturn { ${names.join(', ')} };\n})`)();
}

// The old page's declarations, e.g. oldPage(['smoothKeypoints', ...]); every
// name a function uses has to be in the list.
function oldPage(names) {
  return load(indexHtml(), names, 'INDEX_HTML');
}

// The same, out of src/diagnostics.js's IIFE body.
function oldDiagnostics(names) {
  return load(fs.readFileSync(path.join(SRC, 'diagnostics.js'), 'utf8'), names, 'diagnostics.js');
}

// One statement out of diagnostics.js, as a function of the names it reads:
// for logic that lives inside a method rather than a top-level declaration.
function diagnosticsLine(startsWith, args, result) {
  const src = fs.readFileSync(path.join(SRC, 'diagnostics.js'), 'utf8');
  const lines = src.split('\n').filter(l => l.trim().startsWith(startsWith));
  if (lines.length !== 1) throw new Error(`diagnostics.js: ${lines.length} lines start with "${startsWith}"`);
  return vm.runInThisContext(`(function (${args.join(', ')}) {\n${lines[0]}\nreturn ${result};\n})`);
}

module.exports = { oldPage, oldDiagnostics, diagnosticsLine };
