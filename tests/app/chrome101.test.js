// SPDX-License-Identifier: AGPL-3.0-or-later
'use strict';
// c65: Chrome 101's fallbacks. The Samsung S8+ (c60) has Chrome 101 as its browser and its WebView, and it stays at 101.
// The Chrome versions named here are from memory and MDN, not measured: c60 checks each one on the phone with the probe
// (app/debug/compat.mjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createFakeWebCodecs } = require('./fake-webcodecs');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'app');
const load = (...p) => import(pathToFileURL(path.join(APP, ...p)).href);

// ---- the decode loop without the decoder's `dequeue` event (Chrome 106) ---------------------------------------------
//
// decode.mjs fed the next chunk when `dequeue` or an output woke the loop. The stepper's stream (STREAM_QUEUES: one
// chunk fed at a time) on a decoder that holds B-frames back waited for an output that never came: 0 frames and
// decode-stalled after stallMs.

const CONFIG = { codec: 'avc1.64001f', codedWidth: 96, codedHeight: 54 };
// 30 chunks, a key one first, 1/30 s apart (the fake outputs them in timestamp order)
async function* thirtyChunks() {
  for (let i = 0; i < 30; i++) yield { type: i === 0 ? 'key' : 'delta', timestamp: Math.round(i * 1e6 / 30), duration: 33333, data: new Uint8Array(4) };
}
async function decodeAll(fakeOptions, queues) {
  const { decodeFrames } = await load('src', 'media', 'decode.mjs');
  const fake = createFakeWebCodecs({ reorder: 3, ...fakeOptions });
  const got = [];
  let error = null;
  try {
    for await (const f of decodeFrames({ webcodecs: fake, config: CONFIG, chunks: thirtyChunks(), wants: () => true, stallMs: 400, ...queues })) {
      got.push(f.timestamp);
      f.close();
    }
  } catch (e) { error = e; }
  return { got, error, fake };
}

test('c65: the fake decoder without dequeue (Chrome before 106) fires no event and has no ondequeue; with it, it has both', () => {
  const plain = createFakeWebCodecs().createDecoder({ output() {}, error() {} });
  assert.ok('ondequeue' in plain, 'Chrome 106+ has VideoDecoder.prototype.ondequeue');
  const old = createFakeWebCodecs({ dequeue: false }).createDecoder({ output() {}, error() {} });
  assert.ok(!('ondequeue' in old));
});

test('c65: the stepper\'s queues (one chunk fed, one frame waiting) get every frame from a decoder with no dequeue event, B-frames held back', { timeout: 10000 }, async () => {
  const { STREAM_QUEUES } = await load('src', 'media', 'stepper.mjs');
  assert.deepEqual({ ...STREAM_QUEUES }, { maxQueued: 1, maxQueueSize: 1 });
  for (const dequeue of [false, true]) {
    const { got, error, fake } = await decodeAll({ dequeue }, STREAM_QUEUES);
    assert.equal(error, null, `dequeue ${dequeue}: ${error && error.code}`);
    assert.deepEqual(got, Array.from({ length: 30 }, (_, i) => Math.round(i * 1e6 / 30)), `dequeue ${dequeue}: all 30 frames in order`);
    assert.ok(fake.log.frames.every(f => f.closed));
  }
  // and the default queues (frameAt, frames(), thumbnails) too
  const { got, error } = await decodeAll({ dequeue: false }, {});
  assert.equal(error, null);
  assert.equal(got.length, 30);
});

test('c65: a stepper on a fake source with no dequeue event steps across the whole clip, no decode-stalled', { timeout: 20000 }, async () => {
  const fs = require('node:fs');
  const { openFrameSource } = await load('src', 'media', 'frame-source.mjs');
  const fake = createFakeWebCodecs({ dequeue: false });
  const blob = new Blob([fs.readFileSync(path.join(__dirname, 'clips', 'testsrc2-h264-30fps.mp4'))], { type: 'video/mp4' });
  const src = await openFrameSource(blob, { webcodecs: fake, stallMs: 400 });
  const st = await src.stepper(0, { height: 36, maxFrames: 20 });
  try {
    await st.settled();
    const seen = [];
    for (let k = 0; k < 89; k++) seen.push((await st.step(1)).index);
    assert.deepEqual(seen, Array.from({ length: 89 }, (_, k) => k + 1), 'frames 1 to 89, across both keyframes');
    for (let k = 0; k < 89; k++) await st.step(-1);
    assert.equal(st.index, 0, 'and back to frame 0');
  } finally { st.close(); src.close(); }
});

test('c65: where the decoder has the dequeue event, the loop runs no timer of its own but the stall\'s; without it, a short re-check while it waits', { timeout: 10000 }, async () => {
  const { DEQUEUE_POLL_MS } = await load('src', 'media', 'decode.mjs');
  assert.ok(DEQUEUE_POLL_MS > 0 && DEQUEUE_POLL_MS <= 10, 'a short re-check, never a busy loop');
  const real = globalThis.setInterval;
  const count = async dequeue => {
    let n = 0;
    globalThis.setInterval = (fn, ms, ...a) => { n++; assert.equal(ms, DEQUEUE_POLL_MS); return real(fn, ms, ...a); };
    try {
      const { got, error } = await decodeAll({ dequeue }, { maxQueued: 1, maxQueueSize: 1 });
      assert.equal(error, null);
      assert.equal(got.length, 30);
    } finally { globalThis.setInterval = real; }
    return n;
  };
  assert.equal(await count(true), 0, 'no re-check where the event exists');
  assert.ok(await count(false) > 0, 'the re-check runs where it does not');
});

// ---- the screen's height without dvh (Chrome 108) ------------------------------------------------------------------
//
// d62 keeps the height of a window-high screen in one token, --screen-h: calc(100dvh - var(--inset-top)). Chrome 101 has
// no dvh, and a 100vh line before a declaration holding var() doesn't help (such a declaration is invalid only when
// computed, and then falls back to `unset`), so the fallback is an @supports block after :root.

const fs = require('node:fs');
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

test('c65: tokens.css gives --screen-h a 100vh fallback where 100dvh is not supported, after the token, and nowhere else', () => {
  const css = stripComments(fs.readFileSync(path.join(APP, 'src', 'styles', 'tokens.css'), 'utf8'));
  const token = css.search(/--screen-h:\s*calc\(100dvh - var\(--inset-top\)\)\s*;/);
  assert.ok(token > 0, 'd62\'s token');
  const fallback = css.match(/@supports not \(height: 100dvh\) \{\s*:root \{\s*--screen-h:\s*calc\(100vh - var\(--inset-top\)\);\s*\}\s*\}/);
  assert.ok(fallback, 'the @supports fallback');
  assert.ok(fallback.index > token, 'after the token, so it wins where it applies');
  assert.equal([...css.matchAll(/@supports/g)].length, 1);
  assert.equal([...css.matchAll(/100vh/g)].length, 1, 'no other vh');
  // base.css keeps no dvh of its own (d62's test pins its var(--screen-h) uses); .licence's 50vh is plain vh, Chrome 20
  assert.doesNotMatch(stripComments(fs.readFileSync(path.join(APP, 'src', 'styles', 'base.css'), 'utf8')), /\d+dvh\b/);
});

// ---- the survey as guards: no syntax, built-in or CSS newer than Chrome 101 in what ships --------------------------
//
// These two pass on phase-0 by design: they keep the survey true, they are not regression tests. The files are
// assemble.mjs's own list (files.json), with --debug, so the check page c60 opens on the phone is covered too and a
// new file is covered without this list changing.

const os = require('node:os');
const assembled = (() => {
  let cache = null;
  return async () => {
    if (cache) return cache;
    const { assemble } = await load('tools', 'assemble.mjs');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'c65-dist-'));
    const { files } = assemble({ out, app: APP, src: path.join(ROOT, 'src'), debug: true, log: () => {} });
    cache = { out, files: files.map(f => ({ f, text: fs.readFileSync(path.join(out, f), 'utf8') })).filter(x => /\.(m?js|css|html)$/.test(x.f)) };
    process.on('exit', () => fs.rmSync(out, { recursive: true, force: true }));
    return cache;
  };
})();

test('c65 guard: every shipped JS and CSS file comes out of esbuild\'s transform the same at chrome101 as at esnext; the TF.js bundle builds at es2020', async () => {
  const esbuild = require(path.join(APP, 'node_modules', 'esbuild'));
  const { files } = await assembled();
  const code = files.filter(x => /\.(m?js|css)$/.test(x.f));
  for (const name of ['src/main.mjs', 'src/media/decode.mjs', 'src/diagnostics.js', 'sw.js', 'vendor/htm/htm.mjs', 'vendor/preact/preact.mjs',
    'vendor/mediabunny/mediabunny.mjs', 'src/styles/tokens.css', 'debug/check.mjs', 'debug/media.mjs']) {
    assert.ok(code.some(x => x.f === name), `${name} is in the list`);
  }
  assert.ok(code.some(x => x.f.startsWith('src/track/')), "src/track/'s files are in the list");
  const differ = [];
  for (const { f, text } of code) {
    const loader = f.endsWith('.css') ? 'css' : 'js';
    const at = target => { try { return esbuild.transformSync(text, { loader, target }).code; } catch (e) { return `error: ${e.message}`; } };
    if (at('chrome101') !== at('esnext')) differ.push(f);
  }
  assert.deepEqual(differ, [], 'files esbuild has to lower (or refuses) for Chrome 101');
  // the TF.js bundle (gitignored, built by tools/build-tfjs.mjs) is built at es2020 (Chrome 80, from memory) or lower
  const build = fs.readFileSync(path.join(APP, 'tools', 'build-tfjs.mjs'), 'utf8');
  const targets = [...build.matchAll(/target: '([^']+)'/g)].map(m => m[1]);
  assert.ok(targets.length > 0 && targets.every(t => /^es20(1\d|20)$|^es[56]$/.test(t)), `build-tfjs targets: ${targets}`);
});

// [what, Chrome version (from memory, MDN: c60 checks), the use, the check that may sit beside it]
const NEWER = [
  ['structuredClone()', 98, /\bstructuredClone\s*\(/, /typeof structuredClone|'structuredClone' in/],
  ['Array findLast()/findLastIndex()', 97, /\.findLast(Index)?\s*\(/, /\.findLast(Index)?\s*\?|'findLast(Index)?' in/],
  ['Array toSorted()/toReversed()/toSpliced()/with()', 110, /\.(toSorted|toReversed|toSpliced)\s*\(/, /'to(Sorted|Reversed|Spliced)' in/],
  ['Promise.withResolvers()', 119, /Promise\.withResolvers/, /typeof Promise\.withResolvers|'withResolvers' in/],
  ['Object.groupBy()/Map.groupBy()', 117, /\b(Object|Map)\.groupBy\b/, /typeof (Object|Map)\.groupBy|'groupBy' in/],
  ['AbortSignal.any()', 116, /AbortSignal\.any\b/, /typeof AbortSignal\.any|'any' in AbortSignal/],
  ['AbortSignal.timeout()', 103, /AbortSignal\.timeout\b/, /typeof AbortSignal\.timeout|'timeout' in AbortSignal/],
  ['Array.fromAsync()', 121, /Array\.fromAsync\b/, /typeof Array\.fromAsync|'fromAsync' in/],
  ['the inert attribute', 102, /\binert\b/, /'inert' in/],
  ['popover', 114, /\bpopover(?=[=\s>])|\.(show|hide|toggle)Popover\s*\(|:popover-open/, /'popover' in|showPopover\s*\?/],
  [':has()', 105, /:has\(/, /@supports selector\(:has|CSS\.supports/],
  ['container queries', 105, /@container\b|container-type\s*:/, /@supports \(container-type/],
  ['color-mix()', 111, /color-mix\(/, /@supports \(color: color-mix|CSS\.supports/],
  ['light-dark()', 123, /light-dark\(/, /@supports \(color: light-dark|CSS\.supports/],
  ['subgrid', 117, /\bsubgrid\b/, /@supports \(grid-template-columns: subgrid|CSS\.supports/],
  ['@scope and @starting-style', 117, /@scope\b|@starting-style\b/, /(?!)/],
  ['text-wrap: balance', 114, /text-wrap\s*:/, /@supports \(text-wrap/],
  // dvh is allowed in tokens.css's --screen-h and its @supports fallback only (step 3); a JS use needs CSS.supports beside it
  ['dvh, svh, lvh', 108, /\d(?:d|s|l)v[hw]\b/, /CSS\.supports\(\s*'height',\s*'100dvh'\s*\)/],
];
const isComment = l => /^\s*(\/\/|\*|\/\*)/.test(l);
const nested = css => {
  // a rule inside a style rule (CSS nesting, Chrome 112); @media, @supports, @keyframes and the like may hold rules
  const out = [];
  const stack = [];
  let prelude = '';
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') { const p = prelude.trim(); if (stack.length && !stack[stack.length - 1].startsWith('@') && !/^(from|to|\d+%)/.test(p)) out.push(p); stack.push(p); prelude = ''; } else if (ch === '}') { stack.pop(); prelude = ''; } else if (ch === ';') prelude = ''; else prelude += ch;
  }
  return out;
};

test('c65 guard: no built-in, attribute or CSS newer than Chrome 101 in what ships, unless a check for it sits beside the use', async () => {
  const { files } = await assembled();
  const found = [];
  for (const { f, text } of files) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (isComment(line)) return;
      for (const [what, version, use, check] of NEWER) {
        if (!use.test(line)) continue;
        if (what.startsWith('dvh') && f === 'src/styles/tokens.css' && /--screen-h:\s*calc\(100dvh|@supports not \(height: 100dvh\)/.test(line)) continue;
        const near = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
        if (!check.test(near)) found.push(`${f}:${i + 1}: ${what} (Chrome ${version}): ${line.trim().slice(0, 120)}`);
      }
    });
    if (f.endsWith('.css')) for (const p of nested(text)) found.push(`${f}: CSS nesting (Chrome 112): ${p}`);
  }
  assert.deepEqual(found, []);
  // the rules themselves catch what they are for
  assert.deepEqual(nested('a { color: red; b { color: blue; } }'), ['b']);
  assert.deepEqual(nested('@media (min-width: 1px) { a { color: red; } } @keyframes k { from { top: 0; } 50% { top: 1px; } }'), []);
  const hit = s => NEWER.filter(([, , use]) => use.test(s)).map(([w]) => w);
  assert.deepEqual(hit('const c = structuredClone(x);'), ['structuredClone()']);
  assert.deepEqual(hit('xs.findLast(f)'), ['Array findLast()/findLastIndex()']);
  assert.deepEqual(hit('var findLast = (arr, p) => {'), [], "mediabunny's own findLast helper is not the built-in");
  assert.deepEqual(hit('"popover"!=t'), [], "preact's attribute list is not a use");
  assert.deepEqual(hit('<div popover>'), ['popover']);
  assert.deepEqual(hit('.a:has(.b) { }'), [':has()']);
  assert.deepEqual(hit('height: 100dvh;'), ['dvh, svh, lvh']);
  assert.deepEqual(hit('min-height: 100vh;'), []);
});

// ---- the probe c60 runs on the phone (app/debug/compat.mjs, the check page's window.c20.compat) --------------------

// a fake OPFS: folders and files in maps; `move` only when asked for
function fakeStorage({ move = true, writable = true } = {}) {
  const made = [];
  const folder = () => {
    const entries = new Map();
    const d = {
      entries,
      async getDirectoryHandle(name, { create } = {}) {
        if (!entries.has(name)) { if (!create) throw new DOMException('missing', 'NotFoundError'); entries.set(name, folder()); made.push(name); }
        return entries.get(name);
      },
      async getFileHandle(name, { create } = {}) {
        if (!entries.has(name)) { if (!create) throw new DOMException('missing', 'NotFoundError'); entries.set(name, file(d, name)); }
        return entries.get(name);
      },
      async removeEntry(name) { entries.delete(name); },
    };
    return d;
  };
  const file = (dir, name) => {
    const h = { text: '', name, async getFile() { return { text: async () => h.text }; } };
    if (writable) h.createWritable = async () => { let t = ''; return { write: async x => { t += x; }, close: async () => { h.text = t; } }; };
    if (move) h.move = async to => { dir.entries.delete(h.name); h.name = to; dir.entries.set(to, h); };
    return h;
  };
  const root = folder();
  return { storage: { getDirectory: async () => root }, root, made };
}
function fakeGlobals({ chrome101 }) {
  const { storage, root, made } = fakeStorage({ move: !chrome101 });
  const asked = { decoder: [], encoder: [] };
  function VideoDecoder() {}
  if (!chrome101) VideoDecoder.prototype.ondequeue = null;
  VideoDecoder.isConfigSupported = async c => { asked.decoder.push(c); return { supported: true }; };
  function VideoEncoder() {}
  // as Chrome before the enum's rename might: 'no-preference' is not one of its values (c60 finds out)
  VideoEncoder.isConfigSupported = async c => {
    asked.encoder.push(c);
    if (chrome101 && c.hardwareAcceleration === 'no-preference') throw new TypeError("The provided value 'no-preference' is not a valid enum value");
    return { supported: true };
  };
  const style = { '--screen-h': chrome101 ? ' calc(100vh - 0px)' : ' calc(100dvh - 0px)' };
  const body = { appendChild() {} };
  function HTMLVideoElement() {}
  if (!chrome101) HTMLVideoElement.prototype.requestVideoFrameCallback = () => {};
  class Worker {
    constructor(url) { this.url = url; setImmediate(() => this.onmessage({ data: { offscreenCanvas: true, webgl2: true, renderer: 'fake' } })); }
    terminate() { this.terminated = true; }
  }
  const g = {
    navigator: { userAgent: chrome101 ? 'Mozilla/5.0 (Linux; Android 9; SM-G955F) Chrome/101.0.4951.61 Mobile' : 'Chrome/140', storage, ...(chrome101 ? {} : { wakeLock: { request() {} } }) },
    VideoDecoder, VideoEncoder, HTMLVideoElement, Worker, Blob,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    CSS: { supports: (p, v) => !(chrome101 && /dvh/.test(v)) },
    document: { documentElement: {}, body, createElement: () => ({ style: {}, getBoundingClientRect: () => ({ height: 800 }), remove() {} }) },
    getComputedStyle: () => ({ getPropertyValue: n => style[n] ?? '' }),
    innerHeight: 800,
    ...(chrome101 ? {} : { MediaStreamTrackProcessor: function MediaStreamTrackProcessor() {} }),
  };
  return { g, root, made, asked };
}

test('c65: the probe on fakes, as Chrome 101 and as a current Chrome: every key, plain JSON, its OPFS folder removed', async () => {
  const { compat, OPFS_FOLDER } = await load('debug', 'compat.mjs');
  const { CODECS, encoderConfig } = await load('src', 'media', 'capture.mjs');
  const keys = ['userAgent', 'decoderDequeue', 'opfs', 'height', 'videoDecoder1080p', 'videoEncoder', 'mediaStreamTrackProcessor', 'wakeLock', 'requestVideoFrameCallback', 'workerWebgl2'];
  const run = async chrome101 => {
    const f = fakeGlobals({ chrome101 });
    const out = await compat(f.g);
    assert.deepEqual(Object.keys(out), keys);
    assert.deepEqual(JSON.parse(JSON.stringify(out)), out, 'plain JSON');
    assert.deepEqual(f.made, [OPFS_FOLDER], 'one folder of its own');
    assert.equal(f.root.entries.size, 0, 'and it is removed');
    return { out, asked: f.asked };
  };
  const old = await run(true);
  assert.deepEqual(old.out.decoderDequeue, { videoDecoder: true, ondequeue: false });
  assert.deepEqual(old.out.opfs, { getDirectory: true, createWritable: true, move: false, moveOverExisting: null, readBack: 'probe' });
  assert.deepEqual(old.out.height, { dvh: false, screenH: 'calc(100vh - 0px)', screenHPx: 800, innerHeight: 800 });
  assert.equal(old.out.mediaStreamTrackProcessor, false);
  assert.equal(old.out.wakeLock, false);
  assert.equal(old.out.requestVideoFrameCallback, false);
  assert.deepEqual(old.out.workerWebgl2, { offscreenCanvas: true, webgl2: true, renderer: 'fake' });
  assert.match(old.out.videoEncoder['avc1.42002A 1920x1080'].error, /TypeError: .*no-preference/, 'a refusal by a throw is its words');
  assert.equal(old.out.videoEncoder.withoutHardwareAcceleration, true, 'and the variant without the key says which key it was');
  // the configs asked are capture.mjs's own, at 1080p30 both ways up
  const want = [[1920, 1080], [1080, 1920]].flatMap(([w, h]) => CODECS.map(c => encoderConfig(c, w, h, 30)));
  assert.deepEqual(old.asked.encoder.slice(0, want.length), want);
  assert.deepEqual(old.asked.decoder.map(c => `${c.codec} ${c.codedWidth}x${c.codedHeight}`), ['avc1.640028', ...CODECS].map(c => `${c} 1920x1080`));
  const now = await run(false);
  assert.deepEqual(now.out.decoderDequeue, { videoDecoder: true, ondequeue: true });
  assert.deepEqual(now.out.opfs, { getDirectory: true, createWritable: true, move: true, moveOverExisting: true, readBack: 'probe' });
  assert.equal(now.out.height.dvh, true);
  assert.equal(now.out.mediaStreamTrackProcessor, true);
  assert.equal(now.out.wakeLock, true);
  assert.equal(now.out.requestVideoFrameCallback, true);
  assert.ok(Object.values(now.out.videoEncoder).every(v => v === true));
  // no VideoDecoder, no storage, no document: answers, never a throw
  const bare = await compat({ navigator: {}, URL, Blob });
  assert.deepEqual(bare.decoderDequeue, { videoDecoder: false, ondequeue: null });
  assert.equal(bare.opfs.getDirectory, false);
  assert.deepEqual(bare.videoDecoder1080p, { videoDecoder: false });
  assert.deepEqual(bare.workerWebgl2, { worker: false });
});

test('c65: the check page runs the probe at load (window.c20.compat), check-apk.mjs prints it, capture.mjs builds its configs once', () => {
  const check = fs.readFileSync(path.join(APP, 'debug', 'check.mjs'), 'utf8');
  assert.match(check, /import \{ compat \} from '\.\/compat\.mjs';/);
  assert.match(check, /window\.c20\.compat = step\('compat', \(\) => compat\(window\)\);/);
  assert.match(fs.readFileSync(path.join(APP, 'tools', 'check-apk.mjs'), 'utf8'), /out\.compat = await c\.evaluate\('window\.c20\.compat'/);
  const capture = fs.readFileSync(path.join(APP, 'src', 'media', 'capture.mjs'), 'utf8');
  assert.equal([...capture.matchAll(/hardwareAcceleration:/g)].length, 1, 'one builder, start() and configure() use it');
  assert.equal([...capture.matchAll(/encoderConfig\(/g)].length, 3);
});

// ---- the phone tools take any coach phone (the S8+ as well as the Fairphone) ----------------------------------------

const { spawnSync } = require('node:child_process');
// A fake adb on PATH: it logs its arguments and runs `shell` commands here, with fake dumpsys and ps beside it, as the
// Fairphone (Android 16) or an Android 9 phone (no `dumpsys gpu`, no HAL temperatures in thermalservice) answers.
function fakePhone(android) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c65-adb-'));
  const log = path.join(dir, 'adb.log');
  const put = (name, body) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  put('adb', `printf '%s %s %s\\n' "$1" "$2" "$3" >> '${log}'\n[ "$1" = -s ] && [ "$3" = shell ] && exec sh -c "$4"\nexit 0`);
  put('ps', "printf '  PID NAME\\n 4242 com.brave.browser\\n'");
  put('dumpsys', android >= 10
    ? `case "$1" in battery) printf '  level: 57\\n  temperature: 301\\n';; gpu) printf 'Memory snapshot\\nProc 4242 total: 1000\\n';;
thermalservice) printf 'Thermal Status: 1\\nCurrent temperatures from HAL:\\n Temperature{mValue=40.5, mType=0, mName=CPU0}\\n Temperature{mValue=38.25, mType=1, mName=GPU0}\\nCurrent cooling devices from HAL:\\n';; esac`
    : `case "$1" in battery) printf '  level: 57\\n  temperature: 301\\n';; gpu) echo "Can't find service: gpu";;
thermalservice) printf 'IsStatusOverride: false\\nThermalEventListeners:\\n';; esac`);
  return { dir, log, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function sample(android, args, env = {}) {
  const phone = fakePhone(android);
  const out = path.join(phone.dir, 'out.csv');
  try {
    const r = spawnSync('bash', [path.join(ROOT, 'spike', 'pose-bench', 'phone-sample.sh'), ...args.map(a => (a === 'OUT' ? out : a))], {
      encoding: 'utf8', timeout: 1500, env: { ...process.env, ANDROID_SERIAL: '', ...env, PATH: `${phone.dir}${path.delimiter}${process.env.PATH}` },
    });
    const rows = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n') : [];
    const calls = fs.existsSync(phone.log) ? fs.readFileSync(phone.log, 'utf8').trim().split('\n') : [];
    return { r, rows, calls };
  } finally { phone.clean(); }
}

test('c65: phone-sample.sh takes the phone\'s serial (-s or ANDROID_SERIAL), the Fairphone when called as before, -s on every adb call', () => {
  for (const [args, env, serial] of [[['OUT', 'com.brave.browser', '0.2'], {}, '4d42e62f'], [['-s', 'ce011711cdc8a10c05', 'OUT', 'com.brave.browser', '0.2'], {}, 'ce011711cdc8a10c05'],
    [['OUT', 'com.brave.browser', '0.2'], { ANDROID_SERIAL: 'ce011711cdc8a10c05' }, 'ce011711cdc8a10c05']]) {
    const { rows, calls } = sample(16, args, env);
    assert.ok(calls.length >= 2, `sampled more than once (${calls.length})`);
    assert.ok(calls.every(c => c === `-s ${serial} shell`), `every call names ${serial}: ${calls}`);
    assert.equal(rows[0], 'epoch_ms,level,battery_dc,rss_kb,gpu_bytes,procs,thermal_status,cpu_max_c,gpu_max_c');
    assert.match(rows[1], /^\d{13},57,301,0,1000,1,1,40\.5,38\.25$/, rows[1]);
  }
});

test('c65: phone-sample.sh on Android 9 (no dumpsys gpu, no HAL temperatures) writes empty columns, not an error or a 0', () => {
  const { rows, r } = sample(9, ['-s', 'ce011711cdc8a10c05', 'OUT', 'com.brave.browser', '0.2']);
  assert.ok(rows.length >= 2, r.stderr);
  for (const row of rows.slice(1)) assert.match(row, /^\d{13},57,301,0,,1,,,$/, row);
  const src = fs.readFileSync(path.join(ROOT, 'spike', 'pose-bench', 'phone-sample.sh'), 'utf8');
  assert.match(src.split('\n').slice(0, 20).join('\n'), /Android 9/, 'the header says so');
  assert.match(fs.readFileSync(path.join(ROOT, 'spike', 'pose-bench', 'README.md'), 'utf8'), /phone-sample\.sh[^\n]*-s/);
});

test('c65: the decoder names found in the app\'s log lines are Codec2\'s and OMX\'s (Android 9), each once', async () => {
  const { codecNames } = await load('tools', 'codec-names.mjs');
  // lines shaped like logcat's (threadtime), from memory of Android's media framework: c60 sees the S8+'s own
  const codec2 = [
    '11-04 20:01:02.345  4242  4300 I CCodec  : state->set(ALLOCATING) [c2.qti.avc.decoder]',
    '11-04 20:01:02.350  4242  4300 I Codec2Client: Creating a Codec2 client to service "default"',
    '11-04 20:01:02.351  4242  4300 I CCodec  : Created component [c2.qti.avc.decoder]',
    '11-04 20:01:09.001  4242  4301 I CCodec  : Created component [c2.android.hevc.decoder]',
  ].join('\n');
  assert.deepEqual(codecNames(codec2), ['c2.qti.avc.decoder', 'c2.android.hevc.decoder']);
  const omx = [
    '11-04 20:01:02.345  4242  4300 I ACodec  : [OMX.Exynos.AVC.Decoder] Now Loaded->Idle',
    '11-04 20:01:02.346  4242  4300 I OMXClient: IOmx service obtained',
    '11-04 20:01:02.360  4242  4300 I ACodec  : setupAVCEncoderParameters with [profile: Baseline] [level: Level42] [OMX.Exynos.AVC.Encoder].',
    '11-04 20:01:03.000  4242  4302 I MediaCodec: [OMX.google.h264.decoder] configured',
  ].join('\n');
  assert.deepEqual(codecNames(omx), ['OMX.Exynos.AVC.Decoder', 'OMX.Exynos.AVC.Encoder', 'OMX.google.h264.decoder']);
  assert.deepEqual(codecNames(`${codec2}\n${omx}`).length, 5);
  assert.deepEqual(codecNames(''), []);
});

test('c65: check-media-apk.mjs counts the idle stepper at the phone\'s M size, 440 × its devicePixelRatio, beside 440 and 1320; its decoders by codecNames', () => {
  const src = fs.readFileSync(path.join(APP, 'tools', 'check-media-apk.mjs'), 'utf8');
  assert.match(src, /\[`idle-\$\{c\}`, 'idleDecoded', c, \(\) => \(\{ height: 440 \}\)\]/);
  assert.match(src, /\[`idle1320-\$\{c\}`, 'idleDecoded', c, \(\) => \(\{ height: 1320 \}\)\]/);
  assert.match(src, /\[`idleM-\$\{c\}`, 'idleDecoded', c, \(\) => \(\{ height: Math\.round\(440 \* pixelRatio\) \}\)\]/);
  assert.match(src, /pixelRatio = Number\(await c\.evaluate\('devicePixelRatio'\)\) \|\| 1;/);
  assert.ok(src.indexOf("evaluate('devicePixelRatio')") < src.indexOf('for (let k = 1; k <= RUNS; k++)'), 'read before the first run');
  assert.match(src, /out\.decoders = codecNames\(lines\);/);
  assert.doesNotMatch(src, /c2\\\./, 'the names in one place, codec-names.mjs');
});
