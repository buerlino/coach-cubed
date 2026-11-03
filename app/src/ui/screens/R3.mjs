// R3, Replay (design/mockups/Replay.dc.html; package d29, D2: the last 20 s). The replay plays at once, as the
// session's snapshot (media/capture.mjs, `snapshot(replayS)`) through A1's player (ui/player.mjs, no overlay:
// a replay has no track): REPLAY and how long ago, "Still recording", the bar (a drag scrubs), play/pause, ½×,
// "Keep and mark the lift" (M, which marks and analyses while the recording goes on) and "Not this one: back to
// live" with its countdown. The recording never stops here. All of the logic is lookback-model.mjs's; this draws it.
// Fixed places: nothing moves while the snapshot loads or the countdown runs (base.css, "R3, Replay").
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { openFrameSource } from '../../media/frame-source.mjs';
import { createPlayer } from '../player.mjs';
import { timeAtPointer } from '../player-model.mjs';
import { fitSize } from '../mark-model.mjs';
import { createReplay } from '../lookback-model.mjs';
import { CheckIcon, PauseIcon, PlayIcon, ReplayIcon } from '../components/icons.mjs';
import { Problem } from '../components/problem.mjs';

const pixelRatio = () => (globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1);
const TICK_MS = 100;
const MAX_STEP_S = 1;   // a tick that came late (a hidden page) counts for one second at most
const NO_STYLE = {};
const NO_OVERLAY = { skeleton: false, cues: false, unsure: false, loop: true };   // a replay has no track; it loops until the countdown ends

export function R3({ flow, store, session, openSource = openFrameSource }) {
  const [, redraw] = useState(0);
  const [data, setData] = useState(null);       // { src, stepper, url, range } once the snapshot is open
  const [note, setNote] = useState(null);       // the player's or the decoder's own words when they fail
  const [ps, setPs] = useState(null);           // the player's state
  const replayRef = useRef(null);
  const stageRef = useRef(null);
  const videoRef = useRef(null);
  const frameRef = useRef(null);
  const overlayRef = useRef(null);
  const barRef = useRef(null);
  const parts = useRef({});
  const drag = useRef(false);

  // the replay's logic, once; the snapshot of the last replayS seconds (the settings' length), opened for the player
  useEffect(() => {
    let current = true;
    const p = parts.current = {};
    (async () => {
      const settings = await Promise.resolve().then(() => store.getSettings()).catch(() => null);
      const replayS = settings && settings.replayS > 0 ? settings.replayS : 20;
      const replay = createReplay({ session, flow, replayS });
      replayRef.current = replay;
      p.replay = replay;
      const off = replay.subscribe(() => { if (current) redraw(n => n + 1); });
      p.off = off;
      redraw(n => n + 1);
      await replay.load();
      if (!current || replay.view().phase !== 'ready') return;
      const blob = replay.snapshot;
      const src = await openSource(blob);
      p.src = src;
      if (!current) { src.close(); return; }
      const box = stageRef.current;
      const size = fitSize(src.info, { width: box ? box.clientWidth : (globalThis.innerWidth || 390), height: box ? box.clientHeight : 640 }, pixelRatio());
      const stepper = await src.stepper(src.frameTimes[0], size);
      p.stepper = stepper;
      if (!current) { stepper.close(); src.close(); return; }
      p.url = URL.createObjectURL(blob);
      setData({ src, stepper, url: p.url, range: { t0: src.frameTimes[0], t1: src.frameTimes[src.frameTimes.length - 1] } });
    })().catch(e => { if (current) setNote(e && e.message ? e.message : 'The replay could not be shown.'); });
    return () => {
      current = false;
      if (p.off) p.off();
      if (p.replay) p.replay.close();   // closes the player and drops the snapshot (a no-op after Keep or Back)
      if (p.stepper) p.stepper.close();
      if (p.src) p.src.close();
      if (p.url) URL.revokeObjectURL(p.url);
      parts.current = {};
      replayRef.current = null;
    };
  }, [store, session, flow]);

  // the player, once the elements exist: it plays from the snapshot's start at once
  useEffect(() => {
    if (!data) return undefined;
    const replay = replayRef.current;
    const { info, frameTimes } = data.src;
    const player = createPlayer({
      video: videoRef.current, frame: frameRef.current, overlay: overlayRef.current,
      stepper: data.stepper, frameTimes, range: data.range,
      scene: { track: null, meta: { width: info.width, height: info.height }, Diagnostics: null, view: null, computed: null },
      style: () => NO_STYLE, flags: () => NO_OVERLAY, speed: 1,
      onChange: s => { setPs(s); replay.report(s); },
      onError: e => setNote(e.message || 'The replay could not be shown.'),
    });
    replay.attach(player, data.range);
    return () => player.close();
  }, [data]);

  // the countdown: the wall clock, in ticks
  useEffect(() => {
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(MAX_STEP_S, (now - last) / 1000);
      last = now;
      if (replayRef.current) replayRef.current.tick(dt);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const replay = replayRef.current;
  const v = replay ? replay.view() : null;
  const ready = !!v && v.phase === 'ready' && !!data;
  const playing = !!(v && v.playing);

  const at = e => timeAtPointer(e.clientX, barRef.current.getBoundingClientRect(), data.range);
  const down = e => { if (!ready) return; drag.current = true; if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId); replay.scrubStart(at(e)); };
  const move = e => { if (drag.current && ready) replay.scrubMove(at(e)); };
  const up = () => { if (!drag.current) return; drag.current = false; replay.scrubEnd(); };
  const key = e => {
    if (!ready || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const t = (ps ? ps.t : data.range.t0) + (e.key === 'ArrowLeft' ? -1 : 1);
    replay.scrubStart(Math.max(data.range.t0, Math.min(data.range.t1, t)));
    replay.scrubEnd();
  };

  if (v && v.phase === 'problem') {
    return html`
      <main class="screen replay" data-screen="R3" data-phase="problem">
        <div class="replay-problem">
          <${Problem} problem=${v.problem}>
            <button type="button" class="button--primary button-big" data-replay="live" onClick=${() => replay.back()}>Back to live</button>
          <//>
        </div>
      </main>`;
  }

  return html`
    <main class="screen replay" data-screen="R3" data-phase=${v ? v.phase : 'loading'}>
      <div class="replay-stage" ref=${stageRef} role="img" aria-label=${`Replay of the last ${v ? v.totalS : 20} seconds`}>
        <video class="replay-layer" ref=${videoRef} src=${data ? data.url : undefined} muted playsinline preload="auto"></video>
        <canvas class="replay-layer" ref=${frameRef} hidden=${!!(ps && ps.live)}></canvas>
        <canvas class="replay-layer" ref=${overlayRef} hidden></canvas>
        ${!data && !note ? html`<p class="replay-note" role="status">Opening the replay…</p>` : null}
        ${note ? html`<p class="replay-note error" role="alert">${note}</p>` : null}
      </div>
      <header class="replay-top">
        <span class="replay-chip replay-chip--name"><${ReplayIcon} />REPLAY</span>
        <span class="replay-ago" data-replay="ago">${v ? v.ago : ''}</span>
        <span class="replay-chip replay-chip--rec"><span class="replay-chip__dot"></span>Still recording</span>
      </header>
      <div class="replay-controls">
        <div class="replay-bar-row">
          <button type="button" class="replay-play" data-replay="play" aria-label=${playing ? 'Pause' : 'Play'} disabled=${!ready} onClick=${() => replay.togglePlay()}>${playing ? html`<${PauseIcon} />` : html`<${PlayIcon} />`}</button>
          <div class="replay-bar" ref=${barRef} role="slider" tabindex="0" aria-label="Replay position" aria-valuemin="0" aria-valuemax=${v ? v.totalS : 20}
            aria-valuenow=${v ? v.positionS : 0} aria-valuetext=${v ? `${v.position} of ${v.total}` : ''}
            onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} onKeyDown=${key}>
            <div class="replay-bar__track"></div>
            <div class="replay-bar__fill" style=${`width: ${v ? (v.fraction * 100).toFixed(2) : 0}%`}></div>
            <div class="replay-bar__knob" style=${`left: ${v ? (v.fraction * 100).toFixed(2) : 0}%`}></div>
          </div>
          <span class="replay-pos" data-replay="position">${v ? v.position : '0:00'} / ${v ? v.total : '0:20'}</span>
          <button type="button" class="replay-speed" data-replay="speed" aria-label="Playback speed" disabled=${!ready} onClick=${() => replay.toggleSpeed()}>${v ? v.speedLabel : '1×'}</button>
        </div>
        <button type="button" class="replay-keep" data-replay="keep" disabled=${!ready} onClick=${() => replay.keep()}><${CheckIcon} />Keep and mark the lift</button>
        <button type="button" class="replay-live" data-replay="live" onClick=${() => (replay ? replay.back() : flow.go('live'))}>
          Not this one: back to live <span class="replay-live__in">in <span data-replay="countdown">${v ? v.countdown : '0:25'}</span></span>
        </button>
      </div>
    </main>
  `;
}
