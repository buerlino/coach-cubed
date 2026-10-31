'use strict';
// The docs' own checks (docs/decisions.md, "Rules and docs"): the
// always-loaded agent files stay lean, the big docs stay within a byte
// budget, every relative link in a tracked Markdown file resolves (anchors
// included), and every repo path docs/README.md names still exists.
// Built-ins only; the model is pascaline's tools/docs-check.mjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// Budgets (nordmu, 2026-10-31). kB is 1000 bytes, as in `wc -c`. AGENTS.md
// and CLAUDE.md are loaded into every agent session, so they get pascaline's
// hard limits. The three living docs get about 1.25× their size when the
// budgets were set (in brackets), restructure-plan.md a loose 1.5× because it
// goes away at the end of the window. Raising a number is a decision: record
// it in docs/decisions.md in the same commit.
const BUDGETS = [
  { file: 'AGENTS.md', maxLines: 40, maxBytes: 6000 },
  { file: 'CLAUDE.md', maxLines: 10 },
  { file: 'docs/decisions.md', maxBytes: 12000 }, // [9685]
  { file: 'docs/backlog.md', maxBytes: 4000 }, // [3140]
  { file: 'docs/rules-core.md', maxBytes: 8500 }, // [6946]
  { file: 'docs/restructure-plan.md', maxBytes: 38000 }, // [25369]
];

// Links that point outside the repo on purpose, as { file, target, reason }.
// None today: server.md names `../new-service.md` on Noah's machine as a code
// span, not a link, so it isn't checked.
const EXTERNAL_LINKS = [
];

// Tracked files plus untracked ones that aren't ignored (so a new doc can be
// checked before `git add`). Ignored files don't count: a fresh clone lacks them.
function repoFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT });
  return out.toString('utf8').split('\0').filter((f) => f && fs.existsSync(path.join(ROOT, f)));
}
const FILES = new Set(repoFiles());
const DIRS = new Set();
for (const f of FILES) {
  for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) DIRS.add(d);
}
const MD_FILES = execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f && FILES.has(f));

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
const stripFences = (text) => text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
// Code spans go too, so a link written as an example isn't read as a link.
const stripCode = (text) => stripFences(text).replace(/`[^`\n]*`/g, '');
const LINK = /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

// GitHub's heading anchors (github-slugger): the rendered text, lowercased,
// with everything but letters, marks, digits, `_`, `-` and spaces removed,
// spaces turned into `-`, and `-1`, `-2`, ... appended to repeats.
function slug(heading) {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}
const anchorCache = new Map();
function anchors(file) {
  if (!anchorCache.has(file)) {
    const seen = new Map();
    const set = new Set();
    for (const m of stripFences(read(file)).matchAll(/^#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/gm)) {
      const base = slug(m[1]);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      set.add(n === 0 ? base : `${base}-${n}`);
    }
    anchorCache.set(file, set);
  }
  return anchorCache.get(file);
}

// Resolves `target` (as written in `from`) to a repo-relative path, or null
// when it leaves the repo.
function resolveLink(from, target) {
  const base = target.startsWith('/') ? '.' : path.posix.dirname(from);
  const rel = path.posix.normalize(path.posix.join(base, target.replace(/^\//, '')));
  return rel === '..' || rel.startsWith('../') ? null : rel.replace(/\/$/, '') || '.';
}
const exists = (rel) => rel === '.' || FILES.has(rel) || DIRS.has(rel);

test('the always-loaded agent files and the big docs stay within budget', () => {
  const over = [];
  for (const b of BUDGETS) {
    const text = read(b.file);
    const lines = lineCount(text);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (b.maxLines !== undefined && lines > b.maxLines) over.push(`${b.file} has ${lines} lines, over its limit of ${b.maxLines}`);
    if (b.maxBytes !== undefined && bytes > b.maxBytes) over.push(`${b.file} is ${bytes} bytes, over its limit of ${b.maxBytes}`);
  }
  assert.deepEqual(over, [], `docs over budget (limits at the top of tests/docs.test.js):\n${over.join('\n')}`);
});

test('every relative link in a tracked Markdown file resolves, anchors included', () => {
  const broken = [];
  const allowed = new Set(EXTERNAL_LINKS.map((l) => `${l.file} -> ${l.target}`));
  const usedAllowance = new Set();
  for (const file of MD_FILES) {
    for (const m of stripCode(read(file)).matchAll(LINK)) {
      const target = m[1].replace(/^<|>$/g, '');
      if (/^(https?:|mailto:)/i.test(target)) continue;
      const key = `${file} -> ${target}`;
      if (allowed.has(key)) { usedAllowance.add(key); continue; }
      const hash = target.indexOf('#');
      const pathPart = decodeURI(hash === -1 ? target : target.slice(0, hash));
      const anchor = hash === -1 ? '' : decodeURIComponent(target.slice(hash + 1));
      const rel = pathPart ? resolveLink(file, pathPart) : file;
      if (rel === null) { broken.push(`${file}: ${target} leaves the repo (allow it in EXTERNAL_LINKS with a reason if that's on purpose)`); continue; }
      if (!exists(rel)) { broken.push(`${file}: ${target} (no ${rel})`); continue; }
      // Anchors are checked in Markdown targets only (`app.py#L42` is GitHub's own).
      if (anchor && rel.endsWith('.md') && !anchors(rel).has(anchor)) broken.push(`${file}: ${target} (no heading #${anchor} in ${rel})`);
    }
  }
  for (const key of allowed) if (!usedAllowance.has(key)) broken.push(`EXTERNAL_LINKS lists ${key}, which no longer exists: remove it`);
  assert.deepEqual(broken, [], `broken links:\n${broken.join('\n')}`);
});

test('every repo path docs/README.md names exists', () => {
  const index = 'docs/README.md';
  const text = stripFences(read(index));
  const missing = [];
  for (const m of text.replace(/`[^`\n]*`/g, '').matchAll(LINK)) {
    const target = m[1].replace(/^<|>$/g, '').replace(/#.*$/, '');
    if (!target || /^(https?:|mailto:)/i.test(target)) continue;
    const rel = resolveLink(index, decodeURI(target));
    if (rel === null || !exists(rel)) missing.push(`${index} links ${target}, which doesn't exist`);
  }
  // A backticked name counts as a path when it has an inner `/` and no spaces
  // (`scripts/sync_clipper_fixtures.py`, not `track.json` or `/coach/`). It
  // may be written from the repo root or from docs/.
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const name = m[1];
    if (!/^[\w.-]+(\/[\w.-]+)+\/?$/.test(name)) continue;
    const fromRoot = path.posix.normalize(name).replace(/\/$/, '');
    const fromDocs = resolveLink(index, name);
    if (!exists(fromRoot) && !(fromDocs && exists(fromDocs))) missing.push(`${index} names \`${name}\`, which doesn't exist`);
  }
  assert.deepEqual(missing, [], `paths named in docs/README.md that are gone:\n${missing.join('\n')}`);
});
