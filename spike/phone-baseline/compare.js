// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// compare.js REPO MP_RESULTS: scores each fixture's ViTPose-L track and the
// phone's MediaPipe track with the same diagnostics.js, and prints verdict,
// phase window (in seconds) and summary numbers side by side.
const fs = require('node:fs');
const path = require('node:path');
const [repo, mpFile] = process.argv.slice(2);
const { loadDiagnostics } = require(path.join(repo, 'tests/loadDiagnostics'));
const { loadManifests, trackPathFor } = require(path.join(repo, 'tests/fixtures'));

const manifest = loadManifests();
const mp = Object.fromEntries(JSON.parse(fs.readFileSync(mpFile, 'utf8')).map(c => [c.id, c]));
const round = v => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);

function score(set, track, personId) {
  const D = loadDiagnostics();
  D.setPage(set);
  const out = D.computeResults(track.keypoints, track.meta, personId);
  const times = track.meta.frame_times_ms;
  const tOf = i => (i >= 0 && out.samples[i] ? round(out.samples[i].t) : null);
  const res = {};
  for (const [id, r] of Object.entries(out.results)) {
    if (r.error) { res[id] = { error: r.error }; continue; }
    const summary = Object.fromEntries(Object.entries(r.summary || {})
      .filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, round(v)]));
    res[id] = { verdict: r.verdict && `${r.verdict.status}: ${r.verdict.label}`,
                phase_s: r.phase ? [tOf(r.phase.startIdx), tOf(r.phase.endIdx)] : null, summary };
  }
  return { lift_s: [round(out.lift.t0), round(out.lift.t1)], res };
}

for (const slug of Object.keys(manifest)) {
  const id = slug.startsWith('global/') || slug.startsWith('local/') ? slug : `global/${slug}`;
  if (!mp[id]) continue;
  const set = manifest[slug].diagnostics || 'snatch';
  const vit = JSON.parse(fs.readFileSync(trackPathFor(slug), 'utf8'));
  const a = score(set, vit, vit.meta.tracks.kept);
  const b = score(set, mp[id].track, '0');
  console.log(`\n### ${slug}  (set: ${set})`);
  console.log(`  lift window s   ViTPose-L ${JSON.stringify(a.lift_s)}   MediaPipe ${JSON.stringify(b.lift_s)}`);
  for (const d of Object.keys(a.res)) {
    console.log(`  ${d}`);
    console.log(`    ViTPose-L  ${JSON.stringify(a.res[d])}`);
    console.log(`    MediaPipe  ${JSON.stringify(b.res[d])}`);
  }
}
