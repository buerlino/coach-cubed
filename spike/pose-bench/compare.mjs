// node compare.mjs [RESULTS_DIR] [--json OUT.json] [--tag TAG]
// Step 3.6: scores every candidate track in results/ and the ViTPose-L
// reference of the same clip with the same diagnostics.js, the way the old
// page scores (smoothed, src/track/), and raw too for comparison with the
// goldens. Counts only verdicts both sides score (an error such as "only one
// rep" is no verdict) and reports, per clip and cue: same verdict or not, the
// phase window's difference in seconds, and the difference in the value the
// verdict is read from. Then the thresholds of docs/decisions.md ("What
// 0.1.0 is"): agreement ≥ 85% lateral raise / ≥ 80% snatch, ≥ 90% of the
// reference's scored cues scored, ≤ 90 s for a 10 s clip.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreTrack } from '../../src/track/lift-window.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);
const { loadDiagnostics } = require(join(REPO, 'tests/loadDiagnostics.js'));
const { trackPathFor } = require(join(REPO, 'tests/fixtures.js'));

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : null; };
const jsonOut = flag('--json'), onlyTag = flag('--tag');
const dir = resolve(args[0] || join(HERE, 'results'));

// The summary field(s) each cue's verdict() reads (src/diagnostics.js).
const VALUE = {
  'first-pull-back-angle': ['sd'], 'clean-first-pull-back-angle': ['sd'],
  'second-pull-triple-extension': ['hipDeficit', 'kneeDeficit'],
  'lateral-raise-top-height': ['worst'], 'lateral-raise-torso-lean': ['sd'],
  'lateral-raise-elbow-lead': ['worst'], 'lateral-raise-tempo': ['worst'],
  'lateral-raise-symmetry': ['decline'],
};
const THRESHOLD = { 'lateral-raise': 0.85, snatch: 0.80 };
const r2 = v => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

function score(track, set, mode) {
  const D = loadDiagnostics();
  if (mode === 'smoothed') return scoreTrack(D, track, set);
  // raw, as the goldens score: the track's kept person, no smoothing
  D.setPage(set);
  const person = track.meta.tracks?.kept ?? '0';
  return { personId: person, ...D.computeResults(track.keypoints, track.meta, person) };
}

function cueRows(ref, cand) {
  const tOf = (s, i) => (i >= 0 && s.samples[i] ? s.samples[i].t : null);
  return Object.keys(ref.results).map(id => {
    const a = ref.results[id], b = cand.results[id] || { error: 'missing' };
    const row = { cue: id, refScored: !a.error, candScored: !b.error };
    if (a.error) row.refError = a.error;
    if (b.error) row.candError = b.error;
    if (!a.error && !b.error) {
      row.ref = `${a.verdict.status}: ${a.verdict.label}`;
      row.cand = `${b.verdict.status}: ${b.verdict.label}`;
      row.same = row.ref === row.cand;
      const pa = [tOf(ref, a.phase.startIdx), tOf(ref, a.phase.endIdx)];
      const pb = [tOf(cand, b.phase.startIdx), tOf(cand, b.phase.endIdx)];
      row.phase = { ref: pa.map(r2), cand: pb.map(r2),
        dStart: pa[0] != null && pb[0] != null ? r2(pb[0] - pa[0]) : null,
        dEnd: pa[1] != null && pb[1] != null ? r2(pb[1] - pa[1]) : null };
      row.value = Object.fromEntries((VALUE[id] || []).map(k => [k,
        { ref: r2(a.summary[k]), cand: r2(b.summary[k]), d: r2(b.summary[k] - a.summary[k]) }]));
    }
    return row;
  });
}

const files = readdirSync(dir).filter(f => f.endsWith('.json') && f.includes('@') && !f.startsWith('brave-matrix'));
const runs = [];
for (const f of files.sort()) {
  const res = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  if (!res.track || !res.opts?.slug) continue;
  if (onlyTag !== null && (res.opts.tag || '') !== onlyTag) continue;
  if (res.opts.maxFrames) continue;   // smoke tests
  const refPath = trackPathFor(res.opts.slug);
  if (!existsSync(refPath)) { console.error('no reference for', res.opts.slug); continue; }
  const refTrack = JSON.parse(readFileSync(refPath, 'utf8'));
  const set = res.opts.set;
  const out = { file: f, slug: res.opts.slug, set, model: res.opts.model, ep: res.opts.ep, fps: res.opts.fps,
    tag: res.opts.tag || '', clipS: res.clip.durationS, clipTotalMs: res.timings.clipTotalMs, ua: res.ua };
  for (const mode of ['smoothed', 'raw']) {
    const ref = score(refTrack, set, mode), cand = score(res.track, set, mode);
    out[mode] = { rows: cueRows(ref, cand),
      lift: { ref: [r2(ref.lift?.t0), r2(ref.lift?.t1)], cand: [r2(cand.lift?.t0), r2(cand.lift?.t1)] } };
  }
  runs.push(out);
}

// Aggregate per configuration (model × runtime × fps × tag) and lift.
const groups = new Map();
for (const r of runs) {
  const lift = r.set === 'lateral-raise' ? 'lateral-raise' : 'snatch';
  const key = `${r.model} ${r.ep} fps=${r.fps}${r.tag ? ' ' + r.tag : ''}`;
  if (!groups.has(key)) groups.set(key, { key, model: r.model, ep: r.ep, fps: r.fps, tag: r.tag, lifts: {}, secPerVideoS: [] });
  const g = groups.get(key);
  g.secPerVideoS.push(r.clipTotalMs / 1000 / r.clipS);
  for (const mode of ['smoothed', 'raw']) {
    const L = ((g.lifts[lift] ||= {})[mode] ||= { both: 0, same: 0, refScored: 0, covered: 0, clips: 0 });
    L.clips++;
    for (const row of r[mode].rows) {
      if (row.refScored) { L.refScored++; if (row.candScored) L.covered++; }
      if (row.refScored && row.candScored) { L.both++; if (row.same) L.same++; }
    }
  }
}
const pct = (a, b) => (b ? Math.round(100 * a / b) : null);
const summary = [...groups.values()].map(g => {
  const worst = Math.max(...g.secPerVideoS);
  const s = { config: g.key, tenSecondClipS: Math.round(worst * 10), timeOk: worst * 10 <= 90 };
  for (const [lift, modes] of Object.entries(g.lifts)) {
    for (const [mode, L] of Object.entries(modes)) {
      s[`${lift} ${mode}`] = `${L.same}/${L.both} same (${pct(L.same, L.both)}%), covers ${L.covered}/${L.refScored} (${pct(L.covered, L.refScored)}%)`;
    }
    const L = modes.smoothed;
    s[`${lift} passes`] = L.both > 0 && L.same / L.both >= THRESHOLD[lift] && L.covered / L.refScored >= 0.9;
  }
  return s;
});

for (const r of runs) {
  console.log(`\n### ${r.slug} — ${r.model} ${r.ep} fps=${r.fps}${r.tag ? ' ' + r.tag : ''} (${(r.clipTotalMs / 1000).toFixed(1)} s for ${r.clipS.toFixed(1)} s of video)`);
  console.log(`  lift window  ref ${JSON.stringify(r.smoothed.lift.ref)}  cand ${JSON.stringify(r.smoothed.lift.cand)}`);
  for (const row of r.smoothed.rows) {
    if (!row.refScored || !row.candScored) {
      console.log(`  ${row.cue}: not compared (ref ${row.refScored ? 'scored' : 'no verdict'}, cand ${row.candScored ? 'scored' : 'no verdict: ' + (row.candError || '').slice(0, 70)})`);
      continue;
    }
    const raw = r.raw.rows.find(x => x.cue === row.cue);
    console.log(`  ${row.cue}: ${row.same ? 'SAME' : 'DIFF'}  ref "${row.ref}"  cand "${row.cand}"  ` +
      `phase Δ ${row.phase.dStart}/${row.phase.dEnd} s  value ${JSON.stringify(row.value)}` +
      (raw && raw.refScored && raw.candScored ? `  [raw: ${raw.same ? 'same' : 'diff'}]` : ''));
  }
}
console.log('\n## Per configuration (smoothed is what counts; raw for comparison with the goldens)');
for (const s of summary) console.log(JSON.stringify(s));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ runs, summary }, null, 1));
