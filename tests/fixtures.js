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

// The diagnostics set a fixture is scored against: its manifest entry's own
// "diagnostics" field, a DIAGNOSTIC_SETS key. No default: a fixture without the
// field, or with a name diagnostics.js doesn't know, throws, naming the slug,
// instead of being scored as another lift. setPage(name) accepts an unknown
// name silently (an empty set), so "known" means the set has at least one cue:
// scoring an empty track lists its cue ids (the trick scoreTrack uses).
function diagnosticsSet(manifest, slug, Diagnostics) {
  const entry = manifest[slug];
  if (!entry) throw new Error(`fixture "${slug}" is not in the manifest`);
  const name = entry.diagnostics;
  if (typeof name !== 'string' || !name) {
    throw new Error(`fixture "${slug}" has no "diagnostics" field in its manifest entry — ` +
      `set it to the DIAGNOSTIC_SETS key it is scored against`);
  }
  Diagnostics.setPage(name);
  if (Object.keys(Diagnostics.computeResults({}, { fps: 30 }, '0').results).length === 0) {
    throw new Error(`fixture "${slug}" names diagnostics set "${name}", which diagnostics.js does not know`);
  }
  return name;
}

// Temp folders for tests (c48): made under os.tmpdir() and removed when the test process exits,
// whether its tests passed or failed. A test that wants its folder gone sooner removes it itself.
const tempMade = [];
function tempDir(prefix) {
  if (!tempMade.length) {
    process.on('exit', () => { for (const d of tempMade) fs.rmSync(d, { recursive: true, force: true }); });
  }
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), prefix));
  tempMade.push(dir);
  return dir;
}

module.exports = { FIXTURES_DIR, GOLDEN_DIR, SCOPES, loadManifests, splitSlug, trackPathFor, goldenPathFor, diagnosticsSet, tempDir };
