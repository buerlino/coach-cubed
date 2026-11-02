// A1, Result (design/mockups/Result.dc.html), the player half (package d16): the stored cut with the
// skeleton and the cue drawings over the frame shown, play and pause, one frame back or on, the
// speed, and a timeline with the lift the analysis found and where a cue went wrong; under it (package d17)
// the cards, one per cue of the view model, which open to the cue and to A2. What plays and steps, and why: player.mjs; what to show:
// player-model.mjs; the overlay: draw/. The lift's id comes in the flow's params (H, Q1); the store
// and the diagnostics.js object are injected (main.mjs gives the app's store; tests pass fakes).
// The skeleton and cue switches and the speed are A3's view options (settings.view), kept in the store.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { openFrameSource } from '../../media/frame-source.mjs';
import { getDiagnostics, scoreLift } from '../../scoring/score.mjs';
import { overlayStyle, trackSamples } from '../../draw/index.mjs';
import { fitSize } from '../mark-model.mjs';
import { createPlayer } from '../player.mjs';
import { clockOf, fractionAt, headerOf, momentTitle, nextSpeed, playRequest, speedLabel } from '../player-model.mjs';
import { cardsOf, defaultOpen, provisionalNote, seekTime, summaryOf, timelineOf } from '../result-model.mjs';
import { BackIcon, ChevronIcon, MoreIcon, PauseIcon, PlayIcon, StatusIcon, StepBackIcon, StepForwardIcon } from '../components/icons.mjs';

const pixelRatio = () => (globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1);
const pct = f => `${(f * 100).toFixed(2)}%`;

// What the screen says when it can't show a lift. Not drawn in v1 (ui-design.md): built in its style.
const NO_LIFT = 'There is no lift to show. Open one from home.';
const NOT_READY = 'This lift has no result yet.';
const CANT_SHOW = 'This lift could not be shown.';

export function A1({ flow, store, openSource = openFrameSource, diagnostics = null }) {
  const liftId = flow.params.liftId || null;
  const [data, setData] = useState(null);       // everything the player needs, once loaded
  const [problem, setProblem] = useState(null);
  const [ps, setPs] = useState(null);           // the player's state
  const [skeleton, setSkeleton] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [open, setOpen] = useState(null);       // the cue whose card is open: its phase shows on the timeline
  const parts = useRef({});                     // the open video, its stepper, the object URL and the player: closed when A1 closes
  const flags = useRef({ skeleton: true, cues: true, loop: true });
  const frameBox = useRef(null);
  const videoRef = useRef(null);
  const frameRef = useRef(null);
  const overlayRef = useRef(null);
  const barRef = useRef(null);
  const drag = useRef(false);

  // load: the record, the result, the track and the settings; score the track as the result was;
  // open the cut (the stepper) and a URL for the <video>
  useEffect(() => {
    let current = true;
    const p = parts.current = {};
    (async () => {
      if (!liftId || !store) { setProblem(NO_LIFT); return; }
      const [rec, view, track, settings] = await Promise.all([store.getLift(liftId), store.readResult(liftId), store.readTrack(liftId), store.getSettings()]);
      if (!rec || !view || !track) { if (current) setProblem(NOT_READY); return; }
      const { sigmaMs, keepVelocity } = view.smoothing;
      // computeResults()'s output for the stored track, with the view's own smoothing: what drawCue() takes
      // computed and keypoints are what scoreLift() scored, so the skeleton and the cues sit on the same samples
      const { computed, keypoints } = scoreLift(track, rec.lift, { Diagnostics: diagnostics || getDiagnostics(), sigmaMs, keepVelocity });
      const blob = await store.readVideo(liftId);
      const src = await openSource(blob);
      p.src = src;
      if (!current) { src.close(); return; }
      const box = frameBox.current;
      const size = fitSize(src.info, { width: box ? box.clientWidth : (globalThis.innerWidth || 390), height: box ? box.clientHeight : 360 }, pixelRatio());
      const stepper = await src.stepper(rec.range.t0, size);
      p.stepper = stepper;
      if (!current) { stepper.close(); src.close(); return; }
      p.url = URL.createObjectURL(blob);
      const view_ = settings.view;
      // A2's "Play the rep at ½×" (flow params, read once here): that cue's card open, the phase's start, ½×.
      // The speed is the player's only; the stored view options stay the user's (only the buttons write them).
      const want = playRequest(flow.params, view, rec.range);
      flags.current = { skeleton: view_.skeleton, cues: view_.cues, loop: view_.loop };
      setSkeleton(view_.skeleton);
      setSpeed(want ? want.speed : view_.speed);
      setOpen(want ? want.cue : defaultOpen(cardsOf(view)));   // the ids and statuses only
      setData({ rec, view, computed, diagnostics: diagnostics || getDiagnostics(), meta: track.meta, track: trackSamples(keypoints, track.meta), src, stepper, url: p.url, speed: want ? want.speed : view_.speed, playFrom: want ? want.t : null });
    })().catch(e => { if (current) setProblem(e && e.message ? e.message : CANT_SHOW); });
    return () => {
      current = false;
      if (p.player) p.player.close();
      if (p.stepper) p.stepper.close();
      if (p.src) p.src.close();
      if (p.url) URL.revokeObjectURL(p.url);
      parts.current = {};
    };
  }, [store, liftId]);

  // the player, once the elements exist
  useEffect(() => {
    if (!data) return undefined;
    const p = parts.current;
    const root = globalThis.document ? globalThis.document.documentElement : null;
    const read = n => (root ? globalThis.getComputedStyle(root).getPropertyValue(n) : '');
    let style = null;
    const restyle = () => {
      const w = frameBox.current ? frameBox.current.clientWidth : 0;
      style = overlayStyle(read, w > 0 ? data.meta.width / w : 1);   // frame pixels per CSS pixel
    };
    restyle();
    const player = createPlayer({
      video: videoRef.current, frame: frameRef.current, overlay: overlayRef.current,
      stepper: data.stepper, frameTimes: data.src.frameTimes, range: data.rec.range,
      scene: { track: data.track, meta: data.meta, Diagnostics: data.diagnostics, view: data.view, computed: data.computed },
      style: () => style, flags: () => flags.current, speed: data.speed,
      onChange: setPs, onError: e => setProblem(e.message || CANT_SHOW),
    });
    p.player = player;
    // a request from A2 starts playing at the phase; else the first frame, paused. A refused play() is reported through onError
    if (data.playFrom !== null) player.playFrom(data.playFrom).catch(() => {});
    else player.start();
    let watch = null;
    if (globalThis.ResizeObserver && frameBox.current) {
      watch = new globalThis.ResizeObserver(() => { restyle(); player.repaint(); });
      watch.observe(frameBox.current);
    }
    return () => { if (watch) watch.disconnect(); player.close(); };
  }, [data]);

  const player = () => parts.current.player;
  const keep = view => { if (store && store.saveSettings) Promise.resolve(store.saveSettings({ view })).catch(() => {}); };
  const toggleSkeleton = () => {
    const next = !skeleton;
    flags.current = { ...flags.current, skeleton: next };
    setSkeleton(next);
    if (player()) player().repaint();
    keep({ skeleton: next });
  };
  const cycleSpeed = () => {
    const next = nextSpeed(speed);
    setSpeed(next);
    if (player()) player().setSpeed(next);
    keep({ speed: next });
  };
  // a tap on a worst-moment mark lands on that moment; a drag follows the finger
  const seekTo = (e, moments) => player().seek(seekTime(e.clientX, barRef.current.getBoundingClientRect(), data.rec.range, moments));
  const down = e => { drag.current = true; if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId); seekTo(e, tl.cues.filter(c => c.marked).map(c => c.worst)); };
  const move = e => { if (drag.current) seekTo(e, []); };
  const up = () => { drag.current = false; };
  const key = e => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); player().step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); player().step(1); }
  };

  const head = data ? headerOf(data.rec) : null;
  const range = data ? data.rec.range : null;
  const tl = data ? timelineOf(data.view, range) : null;
  const cards = data ? cardsOf(data.view, id => data.diagnostics.zones(id)) : [];
  const counts = data ? summaryOf(data.view) : [];
  const note = data ? provisionalNote(data.view) : null;
  const opened = tl ? tl.cues.find(c => c.id === open) : null;
  const t = ps ? ps.t : range ? range.t0 : 0;
  const clock = range ? clockOf(t, range) : null;
  const playing = !!(ps && ps.playing);

  return html`
    <main class="screen result" data-screen="A1">
      <header class="bar-header result-header">
        <button type="button" class="icon-button" aria-label="Back" onClick=${() => flow.go('home')}><${BackIcon} /></button>
        <div class="result-header__text">
          <h1 class="bar-header__title">${head ? head.title : 'Result'}</h1>
          ${head ? html`<span class="quiet">${head.meta}</span>` : null}
        </div>
        <button type="button" class="icon-button result-header__more" aria-label="View options" disabled><${MoreIcon} /></button>
      </header>
      ${problem ? html`<p class="error result-problem" role="alert">${problem}</p>` : null}
      ${data ? html`
        <div class="result-stage">
          <div class="result-frame" ref=${frameBox} role="img" aria-label="Video with the pose skeleton" style=${`aspect-ratio: ${data.meta.width} / ${data.meta.height}`}>
            <video class="result-layer" ref=${videoRef} src=${data.url} muted playsinline preload="auto"></video>
            <canvas class="result-layer" ref=${frameRef} hidden=${!!(ps && ps.live)}></canvas>
            <canvas class="result-layer" ref=${overlayRef}></canvas>
          </div>
          <button type="button" class="result-skeleton" aria-pressed=${skeleton} onClick=${toggleSkeleton}>
            <span class=${`result-skeleton__dot${skeleton ? ' result-skeleton__dot--on' : ''}`}></span>Skeleton
          </button>
        </div>
        <div class="result-controls">
          <button type="button" class="result-play" aria-label=${playing ? 'Pause' : 'Play'} onClick=${() => player().toggle()}>${playing ? html`<${PauseIcon} />` : html`<${PlayIcon} />`}</button>
          <button type="button" class="icon-button" aria-label="One frame back" onClick=${() => player().step(-1)}><${StepBackIcon} /></button>
          <button type="button" class="icon-button" aria-label="One frame forward" onClick=${() => player().step(1)}><${StepForwardIcon} /></button>
          <span class="result-clock">${clock.now} / ${clock.total} s</span>
          <button type="button" class="result-speed" aria-label="Playback speed" onClick=${cycleSpeed}>${speedLabel(speed)}</button>
        </div>
        <div class="timeline" ref=${barRef} role="slider" tabindex="0" aria-label="Video position" aria-valuemin="0" aria-valuemax=${clock.total} aria-valuenow=${clock.now} aria-valuetext=${`${clock.now} seconds`}
          onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} onKeyDown=${key}>
          <div class="timeline__bar"></div>
          ${tl.lift && tl.lift.span ? html`<div class="timeline__lift" title="Lift found by the analysis" style=${`left: ${pct(tl.lift.span[0])}; width: ${pct(tl.lift.span[1] - tl.lift.span[0])}`}></div>` : null}
          ${tl.lift && !tl.lift.span ? tl.lift.marks.map(m => html`<div class="timeline__start" title="Lift starts here" style=${`left: ${pct(m)}`}></div>`) : null}
          ${opened && opened.phase ? html`<div class="timeline__phase" title=${`${cards.find(c => c.id === open).title}: where it was scored`} style=${`left: ${pct(opened.phase.from)}; width: ${pct(opened.phase.to - opened.phase.from)}`}></div>` : null}
          ${tl.cues.filter(c => c.marked).map(m => {
            const cue = data.view.cues.find(c => c.id === m.id);
            return html`<div class=${`timeline__moment timeline__moment--${m.status === 'work on' ? 'work-on' : 'watch'}`} title=${momentTitle(cue)} style=${`left: ${pct(m.worst.fraction)}`}></div>`;
          })}
          <div class="timeline__knob" style=${`left: ${pct(fractionAt(t, range))}`}></div>
          ${tl.label ? html`<span class="timeline__label" style=${`left: ${pct(tl.lift ? (tl.lift.span ? tl.lift.span[0] : tl.lift.marks[0]) : 0)}`}>${tl.label}</span>` : null}
        </div>
        <div class="cues">
          ${tl.reason ? html`<p class="cues-window">${tl.reason}</p>` : null}
          <div class="cues-summary">${counts.map(c => html`<span class=${`count--${c.status}`}>${c.text}</span>`)}</div>
          ${note ? html`<p class="cues-note">${note}</p>` : null}
          ${cards.map(c => html`
            <div class="cue-card" data-cue=${c.id}>
              <button type="button" class="cue-card__head" aria-expanded=${open === c.id} aria-label=${`${c.title}: ${c.word}${c.line ? `, ${c.line}` : ''}${c.scored ? `, ${c.value}` : ''}`} onClick=${() => setOpen(open === c.id ? null : c.id)}>
                <span class=${`cue-card__icon status--${c.cls}`}><${StatusIcon} icon=${c.icon} /></span>
                <span class="cue-card__text">
                  <span class="cue-card__title">${c.title}</span>
                  <span class=${`cue-card__line status--${c.cls}${c.scored ? '' : ' cue-card__line--reason'}`}><span class=${`status status--${c.cls}`}></span><span> · ${c.line}</span></span>
                </span>
                <span class="cue-card__value">${c.value}</span>
              </button>
              ${open === c.id ? html`
                <div class="cue-card__body">
                  <p class="cue-card__cue">${c.cue}</p>
                  ${c.notes.map(n => html`<p class="cue-card__note">${n}</p>`)}
                  ${c.rule ? html`<span class="cue-card__rule">${c.rule}</span>` : null}
                  ${c.scored ? html`<button type="button" class="cue-card__more" onClick=${() => flow.go('detail', { liftId, cue: c.id })}>Plot and details<${ChevronIcon} /></button>` : null}
                </div>` : null}
            </div>`)}
          ${data.view.notes.map(n => html`<p class="cues-window">${n}</p>`)}
        </div>` : null}
    </main>
  `;
}
