// SPDX-License-Identifier: AGPL-3.0-or-later
// A resolve hook that gives Node app/index.html's import map, so a test can
// import a module that draws with Preact (html.mjs: 'preact', 'htm') as the
// browser does. Read from index.html itself, so the two can't drift.
//   require('node:module').register(pathToFileURL('tests/app/import-map.mjs'))
import { readFileSync } from 'node:fs';

const INDEX = new URL('../../app/index.html', import.meta.url);
const html = readFileSync(INDEX, 'utf8');
const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
if (!m) throw new Error('app/index.html has no import map');
const IMPORTS = JSON.parse(m[1]).imports;

export async function resolve(specifier, context, next) {
  if (Object.prototype.hasOwnProperty.call(IMPORTS, specifier)) {
    return { url: new URL(IMPORTS[specifier], INDEX).href, shortCircuit: true };
  }
  return next(specifier, context);
}
