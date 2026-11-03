// SPDX-License-Identifier: AGPL-3.0-or-later
// node difftrack.mjs NEW.json [SLUG] [SET] [--ref OTHER.json]
// Step 3.0's precondition: a freshly extracted ViTPose-L track (the JSON of
// /api/pose/video/result) against the committed track of the same clip, or
// against another extraction (--ref, e.g. a second run on the same machine).
// Prints the kept person's keypoint distance (mean, max, percentiles, per
// keypoint with its worst frame; pixels), the largest confidence difference,
// how many points cross diagnostics.js's 0.3 confidence gate, the meta fields
// that differ, whether the frame indices and times match, and each cue's
// verdict raw and smoothed (src/track/) on both. SLUG defaults to
// global/example/lateral-raise-cable-1, SET to lateral-raise. Prints numbers
// and labels only.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreTrack } from '../../src/track/lift-window.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { loadDiagnostics } = require(join(REPO, 'tests/loadDiagnostics.js'));
const { trackPathFor } = require(join(REPO, 'tests/fixtures.js'));

const args = process.argv.slice(2);
const at = args.indexOf('--ref'), refFile = at >= 0 ? args.splice(at, 2)[1] : null;
const [newFile, slug = 'global/example/lateral-raise-cable-1', set = 'lateral-raise'] = args;
if (!newFile) { console.error('usage: node difftrack.mjs NEW.json [SLUG] [SET] [--ref OTHER.json]'); process.exit(2); }
const ref = JSON.parse(readFileSync(refFile || trackPathFor(slug), 'utf8'));
const neu = JSON.parse(readFileSync(newFile, 'utf8'));
if (!neu.keypoints) { console.error('no keypoints in', newFile); process.exit(1); }

const NAMES = ['nose', 'l-eye', 'r-eye', 'l-ear', 'r-ear', 'l-shoulder', 'r-shoulder', 'l-elbow', 'r-elbow',
  'l-wrist', 'r-wrist', 'l-hip', 'r-hip', 'l-knee', 'r-knee', 'l-ankle', 'r-ankle'];
const GATE = 0.3;   // diagnostics.js's DIAG_CONF: a point below it isn't scored
const pr = ref.meta.tracks.kept, pn = neu.meta.tracks.kept;
let n = 0, max = 0, sum = 0, cmax = 0, oneSided = 0, frames = 0;
const all = [], gated = [], per = NAMES.map(() => ({ d: [], flips: 0, worst: null }));
for (const f of Object.keys(ref.keypoints)) {
  const a = ref.keypoints[f]?.[pr], b = neu.keypoints[f]?.[pn];
  if (!a || !b) { if (a || b) oneSided++; continue; }
  frames++;
  a.forEach((p, k) => {
    const d = Math.hypot(p[0] - b[k][0], p[1] - b[k][1]);
    max = Math.max(max, d); sum += d; n++;
    cmax = Math.max(cmax, Math.abs(p[2] - b[k][2]));
    all.push(d); per[k].d.push(d);
    if (p[2] >= GATE && b[k][2] >= GATE) gated.push(d);
    else if (p[2] >= GATE || b[k][2] >= GATE) per[k].flips++;
    if (!per[k].worst || d > per[k].worst.d) per[k].worst = { d, f, ca: p[2], cb: b[k][2] };
  });
}
console.log(`frames compared ${frames}, one-sided ${oneSided}; keypoint distance mean ${(sum / n).toFixed(3)} px, ` +
  `max ${max.toFixed(3)} px; confidence max diff ${cmax.toFixed(4)}`);

// Where the distance sits: percentiles, the points diagnostics.js scores
// (confidence ≥ GATE on both sides), and each keypoint's worst frame.
const q = (v, p) => { const s = [...v].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const mean = v => v.reduce((x, y) => x + y, 0) / (v.length || 1);
const px = v => v.toFixed(2);
console.log(`frame ${ref.meta.width}×${ref.meta.height}; all points p50 ${px(q(all, 0.5))}, p95 ${px(q(all, 0.95))}, ` +
  `p99 ${px(q(all, 0.99))} px; scored on both sides (conf ≥ ${GATE}) ${gated.length}/${all.length}: ` +
  `mean ${px(mean(gated))}, p95 ${px(q(gated, 0.95))}, max ${px(Math.max(...gated))} px; ` +
  `gate flips ${per.reduce((x, k) => x + k.flips, 0)}`);
per.forEach((k, i) => console.log(`  ${NAMES[i].padEnd(10)} mean ${px(mean(k.d)).padStart(6)}  p95 ${px(q(k.d, 0.95)).padStart(6)}  ` +
  `max ${px(k.worst.d).padStart(6)} (frame ${k.worst.f}, conf ${k.worst.ca.toFixed(2)} → ${k.worst.cb.toFixed(2)})  gate flips ${k.flips}`));

const strip = m => { const o = { ...m }; for (const k of ['frame_indices', 'frame_times_ms', 'skeleton']) delete o[k]; return o; };
const mr = strip(ref.meta), mn = strip(neu.meta);
for (const k of new Set([...Object.keys(mr), ...Object.keys(mn)])) {
  if (JSON.stringify(mr[k]) !== JSON.stringify(mn[k])) console.log(`meta.${k}: committed ${JSON.stringify(mr[k])} → new ${JSON.stringify(mn[k])}`);
}
console.log('frame_indices same:', JSON.stringify(ref.meta.frame_indices) === JSON.stringify(neu.meta.frame_indices),
  '| frame_times same:', JSON.stringify(ref.meta.frame_times_ms) === JSON.stringify(neu.meta.frame_times_ms));

for (const mode of ['raw', 'smoothed']) {
  const score = t => {
    const D = loadDiagnostics();
    if (mode === 'smoothed') return scoreTrack(D, t, set);
    D.setPage(set);
    return D.computeResults(t.keypoints, t.meta, t.meta.tracks.kept);
  };
  const A = score(ref).results, B = score(neu).results;
  for (const id of Object.keys(A)) {
    const label = r => (!r || r.error ? 'no verdict' : `${r.verdict.status}: ${r.verdict.label}`);
    const va = label(A[id]), vb = label(B[id]);
    console.log(`${mode} ${id}: ${va === vb ? 'same' : 'DIFF'} (${va}${va === vb ? '' : ' → ' + vb})`);
  }
}
