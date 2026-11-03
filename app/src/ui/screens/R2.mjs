// SPDX-License-Identifier: AGPL-3.0-or-later
// R2, Recording (design/mockups/RecordLive.dc.html; package d28): the camera fills the stage, with REC and the clock, the
// camera's real rate and the queue line (a tap opens Q1, whose "Back to the session" comes back here) over it, the lift
// and the buffer, the large Replay button (R3 is d29's), End session and the wake-lock line. The session is the app's
// (src/session.mjs), injected; the capture is read through it. A camera lost while recording shows "Camera stopped" with a
// resume; a capture that failed shows d23's problem panel. Fixed places: nothing moves when the queue, the rate or the
// wake lock changes (base.css, "R2, Recording"). All of the logic is record-model.mjs's.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { ReplayIcon, RetryIcon, StopIcon } from '../components/icons.mjs';
import { Problem } from '../components/problem.mjs';
import { followQueue } from '../home-model.mjs';
import { captureProblem, goHome, liveView } from '../record-model.mjs';
import { useCapture, useStream } from '../use-capture.mjs';

export function R2({ flow, store, queue, session }) {
  const [settings, setSettings] = useState(null);
  const [jobs, setJobs] = useState([]);
  const { status, stream } = useCapture(session);
  const videoRef = useRef(null);
  useStream(videoRef, stream);

  useEffect(() => {
    let current = true;
    Promise.resolve().then(() => store.getSettings()).then(s => { if (current) setSettings(s); }, () => {});
    return () => { current = false; };
  }, [store]);
  useEffect(() => (queue ? followQueue(queue, setJobs) : undefined), [queue]);

  // The buffer that runs is the one the camera was opened with; the replay's length is the settings' now.
  const running = session.settings || settings;
  const view = liveView({ status, jobs, lift: session.lift, settings: { ...(running || {}), ...(settings ? { replayS: settings.replayS } : {}) } });
  const problem = captureProblem(status);
  const end = async () => { await session.end(); goHome(flow); };

  return html`
    <main class="screen live" data-screen="R2" data-state=${status.state}>
      <div class="camera-stage"><video ref=${videoRef} muted playsinline autoplay></video></div>
      <header class="live-top">
        <div class="live-row">
          <span class="live-chip live-chip--rec"><span class="live-chip__dot"></span>REC <span class="live-clock" data-live="clock">${view.clock}</span></span>
          <span class="live-chip live-fps" data-live="fps">${view.fps}</span>
        </div>
        <span class="live-chip" data-live="lift">${view.liftLine}</span>
        <div class="live-row">
          ${view.queue ? html`
            <button type="button" class="chip-button live-queue" data-live="queue" onClick=${() => flow.go('queued', { from: 'live' })}>
              <span class="live-queue__spinner"></span>${view.queue}
            </button>` : null}
        </div>
      </header>
      <div class="live-mid">
        ${problem ? html`<${Problem} problem=${problem} />` : view.canResume ? html`
          <button type="button" class="chip-button" data-record="resume" onClick=${() => session.capture && session.capture.resume()}><${RetryIcon} /><span>${view.interrupted}</span></button>` : null}
      </div>
      <div class="live-controls">
        <button type="button" class="live-replay" data-record="replay" aria-label=${`Replay, the last ${view.replay}`} disabled=${status.state === 'failed'} onClick=${() => flow.go('replay')}>
          <${ReplayIcon} />
          <span class="live-replay__text"><span class="live-replay__name">Replay</span><span class="live-replay__length">${view.replay}</span></span>
        </button>
        <div class="live-foot">
          <button type="button" class="live-end" data-record="end" onClick=${end}><${StopIcon} />End session</button>
          <span class="live-wake" data-live="wake">${view.wake}</span>
        </div>
      </div>
    </main>
  `;
}
