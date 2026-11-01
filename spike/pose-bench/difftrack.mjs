// node difftrack.mjs NEW.json [SLUG] [SET]
// Step 3.0's precondition: a freshly extracted ViTPose-L track (the JSON of
// /api/pose/video/result) against the committed track of the same clip.
// Prints the kept person's per-keypoint distance (mean and max, pixels), the
// largest confidence difference, the meta fields that differ, whether the
// frame indices and times match, and each cue's verdict raw and smoothed
// (src/track/) on both. SLUG defaults to global/example/lateral-raise-cable-1,
// SET to lateral-raise. Prints numbers and labels only.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreTrack } from '../../src/track/lift-window.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { loadDiagnostics } = require(join(REPO, 'tests/loadDiagnostics.js'));
const { trackPathFor } = require(join(REPO, 'tests/fixtures.js'));

const [newFile, slug = 'global/example/lateral-raise-cable-1', set = 'lateral-raise'] = process.argv.slice(2);
if (!newFile) { console.error('usage: node difftrack.mjs NEW.json [SLUG] [SET]'); process.exit(2); }
const ref = JSON.parse(readFileSync(trackPathFor(slug), 'utf8'));
const neu = JSON.parse(readFileSync(newFile, 'utf8'));
if (!neu.keypoints) { console.error('no keypoints in', newFile); process.exit(1); }

const pr = ref.meta.tracks.kept, pn = neu.meta.tracks.kept;
let n = 0, max = 0, sum = 0, cmax = 0, oneSided = 0, frames = 0;
for (const f of Object.keys(ref.keypoints)) {
  const a = ref.keypoints[f]?.[pr], b = neu.keypoints[f]?.[pn];
  if (!a || !b) { if (a || b) oneSided++; continue; }
  frames++;
  a.forEach((p, k) => {
    const d = Math.hypot(p[0] - b[k][0], p[1] - b[k][1]);
    max = Math.max(max, d); sum += d; n++;
    cmax = Math.max(cmax, Math.abs(p[2] - b[k][2]));
  });
}
console.log(`frames compared ${frames}, one-sided ${oneSided}; keypoint distance mean ${(sum / n).toFixed(3)} px, ` +
  `max ${max.toFixed(3)} px; confidence max diff ${cmax.toFixed(4)}`);

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
