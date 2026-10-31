// node summarize.mjs RUNS.json SAMPLES.csv [--md]
// One row per configuration (model × runtime × fps × tag) of a run-cdp.mjs
// output, with what phone-sample.sh saw inside each run's window: engine
// ms/frame (p50, mean over clips), the time the loop waited on the decoder,
// the seconds per second of video (worst clip; ×10 is a 10 s clip), peak
// memory above the idle level just before the run (the browser's RSS plus its
// GPU memory), the hottest CPU sensor and thermal status, the download (the
// runtime's wasm plus the weights) and the first load (engine ready).
import { readFileSync } from 'node:fs';

const [runsFile, samplesFile] = process.argv.slice(2);
const md = process.argv.includes('--md');
const runs = JSON.parse(readFileSync(runsFile, 'utf8')).filter(r => !r.error && r.timings);
const rows = readFileSync(samplesFile, 'utf8').trim().split('\n');
const head = rows.shift().split(',');
const S = rows.map(l => Object.fromEntries(l.split(',').map((v, i) => [head[i], Number(v)])))
  .filter(s => s.procs > 0).map(s => ({ ...s, mem: s.rss_kb * 1024 + s.gpu_bytes }));

// The runtime each configuration downloads, as THIRD_PARTY.md lists it (MB).
const RUNTIME = { webgpu: { onnx: 26.8, mediapipe: 13.5 }, wasm: { onnx: 14.2, mediapipe: 13.5 } };
const MB = b => b / 1e6;

const groups = new Map();
for (const r of runs) {
  const e = r.entry;
  const key = `${e.model} ${e.ep} fps=${e.fps}${e.tag ? ' ' + e.tag : ''}`;
  if (!groups.has(key)) groups.set(key, []);
  const before = S.filter(s => s.epoch_ms < r.startedAt).at(-1);
  const inside = S.filter(s => s.epoch_ms >= r.startedAt && s.epoch_ms <= r.endedAt + 1500);
  const peak = inside.length ? Math.max(...inside.map(s => s.mem)) : null;
  groups.get(key).push({
    clip: e.clip, msFrame: r.perFrame.total?.p50, frames: r.frames.processed,
    decodeWaitMs: r.timings.decodeWaitMs / r.frames.processed,
    secPerSec: r.timings.clipTotalMs / 1000 / r.clip.durationS,
    peakDeltaMB: peak != null && before ? MB(peak - before.mem) : null, peakMB: peak != null ? MB(peak) : null,
    cpuMax: inside.length ? Math.max(...inside.map(s => s.cpu_max_c)) : null,
    thermal: inside.length ? Math.max(...inside.map(s => s.thermal_status)) : null,
    weightsMB: MB(r.engine.load.reduce((a, l) => a + l.bytes, 0)),
    runtimeMB: RUNTIME[e.ep][e.model.startsWith('mediapipe') ? 'mediapipe' : 'onnx'],
    loadS: r.timings.engineLoadMs / 1000, threads: r.engine.threads, isolated: r.engine.isolated,
  });
}

const avg = v => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const max = v => (v.length ? Math.max(...v) : null);
const f = (v, d = 0) => (v == null ? '–' : v.toFixed(d));
const out = [...groups.entries()].map(([key, g]) => ({
  config: key, clips: g.length,
  msFrame: avg(g.map(x => x.msFrame)), decodeWaitMs: avg(g.map(x => x.decodeWaitMs)),
  tenSecondClipS: 10 * max(g.map(x => x.secPerSec)),
  peakDeltaMB: max(g.map(x => x.peakDeltaMB).filter(v => v != null)),
  peakMB: max(g.map(x => x.peakMB).filter(v => v != null)),
  cpuMax: max(g.map(x => x.cpuMax).filter(v => v != null)), thermal: max(g.map(x => x.thermal).filter(v => v != null)),
  downloadMB: g[0].weightsMB + g[0].runtimeMB, loadS: avg(g.map(x => x.loadS)),
  threads: g[0].threads, isolated: g[0].isolated,
}));

if (md) {
  console.log('| Configuration | Clips | ms/frame (p50) | Decoder wait, ms/frame | 10 s clip, s | Peak memory above idle, MB | Download, MB | First load, s | CPU max, °C |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const o of out) console.log(`| ${o.config} | ${o.clips} | ${f(o.msFrame)} | ${f(o.decodeWaitMs, 1)} | ${f(o.tenSecondClipS)} | ` +
    `${f(o.peakDeltaMB)} | ${f(o.downloadMB)} | ${f(o.loadS, 1)} | ${f(o.cpuMax)} |`);
} else for (const o of out) console.log(JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)));
