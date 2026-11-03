// SPDX-License-Identifier: AGPL-3.0-or-later
// S1b, "How the cues are scored" (S1's row, package d18; nordmu 2026-11-02): a short text on how each cue
// of a lift is scored, built from diagnostics.js through the same API as A2's "How it's scored" block:
// each cue's words, the rule from zones(id) and, from the newest lift that was analysed, scoringLines
// (the measurement and the caveats of that lift's own result). With no analysed lift it says so and shows
// the default lift's cues and rules, which need no result. S1 opens it through the flow (settings → scoring).
// The store and the diagnostics.js object are injected (main.mjs gives the app's store; tests pass fakes).
import { useEffect, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { getDiagnostics, scoreLift } from '../../scoring/score.mjs';
import { isAnalysed } from '../../contracts/stored-lift.mjs';
import { scoringText } from '../detail-model.mjs';
import { BackIcon } from '../components/icons.mjs';

const CANT_SHOW = 'The scoring text could not be read.';
// the lines under each cue: the lift's own numbers (frames, bar axis, notes) stay in A2; here the method
const SHOWN = ['Measurement', 'Time smoothing', 'Caveat'];

export function S1b({ flow, store, diagnostics = null }) {
  const [text, setText] = useState(null);
  const [problem, setProblem] = useState(null);

  useEffect(() => {
    let current = true;
    (async () => {
      const D = diagnostics || getDiagnostics();
      const [settings, lifts] = await Promise.all([store.getSettings(), store.listLifts()]);
      const rec = lifts.find(isAnalysed) || null;
      let view = null, computed = null;
      if (rec) {
        const [v, track] = await Promise.all([store.readResult(rec.id), store.readTrack(rec.id)]);
        if (v && track) {
          view = v;
          computed = scoreLift(track, rec.lift, { Diagnostics: D, sigmaMs: v.smoothing.sigmaMs, keepVelocity: v.smoothing.keepVelocity }).computed;
        }
      }
      const lift = view ? rec.lift : settings.defaultLift;
      if (current) setText(scoringText({ Diagnostics: D, lift, view, computed }));
    })().catch(e => { if (current) setProblem(e && e.message ? e.message : CANT_SHOW); });
    return () => { current = false; };
  }, [store]);

  return html`
    <main class="screen" data-screen="S1b">
      <header class="bar-header">
        <button type="button" class="icon-button" aria-label="Back to settings" onClick=${() => flow.go('settings')}><${BackIcon} /></button>
        <h1 class="bar-header__title">How the cues are scored</h1>
      </header>
      <div class="settings">
        ${problem ? html`<p class="error" role="alert">${problem}</p>` : null}
        ${text ? html`
          ${text.measured ? null : html`<p class="soft">No lift has been analysed yet, so these are the cues' rules only. Once a lift is analysed, what was measured and how shows here.</p>`}
          ${text.cues.map(c => html`
            <section class="scoring-cue" aria-label=${c.title}>
              <h2 class="scoring-cue__title">${c.title}${c.provisional ? ' · provisional' : ''}</h2>
              <p class="soft">${c.cue}</p>
              ${c.rule ? html`<p class="scoring-cue__rule">${c.rule}</p>` : null}
              <dl class="detail-lines">
                ${c.lines.filter(l => SHOWN.includes(l.label)).map(l => html`<div class="detail-line"><dt>${l.label}</dt><dd>${l.text}</dd></div>`)}
              </dl>
            </section>`)}` : null}
      </div>
    </main>`;
}
