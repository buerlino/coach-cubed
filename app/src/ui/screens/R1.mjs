// R1, Set up the camera (design/mockups/RecordSetup.dc.html; package d28): the camera's live preview with the framing
// guide over it, the lift (one button per lift of the registry, S1's default ringed, the chosen one pressed), the lift's
// framing tip, the line under the preview, and Start, which starts the session and goes to R2. ‹ closes the camera and
// goes home. The camera opens when this screen first shows, never at boot (the session does it: src/session.mjs). The
// replay-mode choice of the mockup comes with d29b: its place (.setup-mode) is kept free. The camera's errors are d23's
// problem panel (captureProblem). All of the logic is record-model.mjs's; the capture is the session's, injected.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { BackIcon, InfoIcon, LiftIcon, RetryIcon } from '../components/icons.mjs';
import { Problem } from '../components/problem.mjs';
import { captureProblem, goHome, setupView } from '../record-model.mjs';
import { useCapture, useStream } from '../use-capture.mjs';
import { DEFAULT_SETTINGS } from '../../store/settings.mjs';

export function R1({ flow, store, session }) {
  const [settings, setSettings] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState(null);
  const { status, stream } = useCapture(session);
  const videoRef = useRef(null);
  useStream(videoRef, stream);

  // The settings first (the camera and the buffer are theirs), then the camera: the first time R1 shows.
  useEffect(() => {
    let current = true;
    Promise.resolve().then(() => store.getSettings()).catch(() => null).then(s => {
      if (!current) return undefined;
      const found = s || { ...DEFAULT_SETTINGS };
      setSettings(found);
      return session.open(found);
    });
    // left for R2: the session runs and keeps the camera; left any other way: the camera closes
    return () => { current = false; if (!session.active) session.end(); };
  }, [store, session]);

  const view = setupView({ settings, status, chosen });
  const problem = captureProblem(status);
  const again = () => session.open(settings || { ...DEFAULT_SETTINGS });
  const back = async () => { await session.end(); goHome(flow); };
  const start = async () => {
    if (!view.canStart || starting) return;
    setStarting(true); setRefused(null);
    try { await session.start(view.lift); flow.go('live'); } catch (e) { setStarting(false); if (!(e && e.name === 'CaptureError')) setRefused(e && e.message ? e.message : 'That didn’t work.'); }
  };

  return html`
    <main class="screen setup" data-screen="R1" data-state=${status.state}>
      <div class="camera-stage"><video ref=${videoRef} muted playsinline autoplay></video></div>
      <header class="setup-top">
        <button type="button" class="chip-button" aria-label="Back" onClick=${back}><${BackIcon} /></button>
      </header>
      <div class="setup-lifts" role="group" aria-label="Lift">
        ${view.lifts.map(l => html`
          <button type="button" key=${l.id} data-lift=${l.id} aria-label=${l.name} aria-pressed=${l.pressed}
            class=${`setup-lift${l.isDefault ? ' setup-lift--default' : ''}`} onClick=${() => setChosen(l.id)}>
            <span class="setup-lift__figure"><${LiftIcon} lift=${l.id} /></span>
            <span class="setup-lift__text">
              <span>${l.label}</span>
              ${l.provisional ? html`<span class="tag">provisional</span>` : null}
            </span>
          </button>`)}
      </div>
      <p class="setup-tip"><${InfoIcon} /><span>${view.tip || view.guide}</span></p>
      <div class="setup-mid">
        ${problem ? html`
          <${Problem} problem=${problem}>
            ${problem.actions.retry ? html`<button type="button" class="button--primary button-big" data-record="retry" onClick=${again}>Try again</button>` : null}
          <//>` : status.state === 'interrupted' ? html`
          <button type="button" class="chip-button" data-record="resume" onClick=${() => session.capture && session.capture.resume()}><${RetryIcon} /><span>Camera stopped</span></button>` : html`
          <div class="setup-guide" aria-hidden="true">${view.tip ? html`<span>${view.guide}</span>` : null}</div>`}
        ${refused ? html`<p class="error" role="alert">${refused}</p>` : null}
      </div>
      <div class="setup-mode"></div>
      <div class="setup-bar">
        <span class="setup-line">${view.line}</span>
        <button type="button" class="record-disc" data-record="start" aria-label="Start session" disabled=${!view.canStart || starting} onClick=${start}><span class="record-disc__dot"></span></button>
      </div>
    </main>
  `;
}
