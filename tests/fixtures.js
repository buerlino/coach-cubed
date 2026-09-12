'use strict';
// Where fixtures and their golden snapshots live, shared by the test and the
// golden updater so the two can never disagree about a path.
//
//   tests/fixtures/<scope>/manifest.json            one manifest per scope
//   tests/fixtures/<scope>/<stance>/<clip>.track.json
//   tests/golden/<scope>/<stance>-<clip>.json
//
// scope is "global" (committed) or "local" (gitignored, this machine only).
// A slug everywhere in the tests is the full "<scope>/<stance>/<clip-stem>".
const fs = require('node:fs');
const path = require('node:path');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const GOLDEN_DIR = path.join(__dirname, 'golden');
const SCOPES = ['global', 'local'];

// Both scopes' manifests merged, keyed by full slug. A scope with no manifest
// (local/ on a fresh checkout) simply contributes nothing.
function loadManifests() {
  const merged = {};
  for (const scope of SCOPES) {
    const file = path.join(FIXTURES_DIR, scope, 'manifest.json');
    if (!fs.existsSync(file)) continue;
    const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [key, entry] of Object.entries(entries)) {
      merged[`${scope}/${key}`] = { ...entry, scope };
    }
  }
  return merged;
}

function splitSlug(slug) {
  const i = slug.indexOf('/');
  if (i < 0 || !SCOPES.includes(slug.slice(0, i))) {
    throw new Error(`fixture slug must start with one of ${SCOPES.join('|')}/ — got "${slug}"`);
  }
  return { scope: slug.slice(0, i), rest: slug.slice(i + 1) };
}

function trackPathFor(slug) {
  return path.join(FIXTURES_DIR, `${slug}.track.json`);
}

function goldenPathFor(slug) {
  const { scope, rest } = splitSlug(slug);
  return path.join(GOLDEN_DIR, scope, rest.replace(/\//g, '-') + '.json');
}

module.exports = { FIXTURES_DIR, GOLDEN_DIR, SCOPES, loadManifests, splitSlug, trackPathFor, goldenPathFor };
