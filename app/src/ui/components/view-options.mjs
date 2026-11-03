// SPDX-License-Identifier: AGPL-3.0-or-later
// A3, View options (design/mockups/ViewOptions.dc.html): the sheet that opens over A1. Four switches (the
// skeleton, the cue drawings, the unsure joints, loop the lift only), the playback speed, smoothing under
// "Advanced", then re-mark and delete. The lifter choice of the mockup is left out: MoveNet SinglePose tracks
// one person (docs/app-plan.md, "The pieces"). What each control does is view-options-model.mjs's controller;
// this draws its state and calls it. The words are the model's TEXT, the look is base.css's, from the tokens.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { SMOOTHING, SPEED_BUTTONS, SWITCHES, TEXT, smoothingLabel } from '../view-options-model.mjs';

/**
 * @param {Object} props
 * @param {Object} props.options the controller's state (createViewOptions().state)
 * @param {Object} props.controller createViewOptions()'s object
 * @param {() => void} props.onClose Done, the backdrop or Escape
 */
export function ViewOptions({ options, controller, onClose }) {
  const [draft, setDraft] = useState(null);     // the slider's value while the finger is on it
  const sheet = useRef(null);
  useEffect(() => { if (sheet.current) sheet.current.focus(); }, []);
  const sigma = draft === null ? options.sigmaMs : draft;
  const key = e => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
  const commit = e => { const v = Number(e.currentTarget.value); setDraft(null); controller.setSigma(v); };

  return html`
    <div class="vo" onKeyDown=${key}>
      <button type="button" class="vo-backdrop" aria-label=${TEXT.close} onClick=${onClose}></button>
      <section class="vo-sheet" role="dialog" aria-modal="true" aria-labelledby="vo-h" tabindex="-1" ref=${sheet}>
        <div class="vo-head">
          <div class="vo-grabber" aria-hidden="true"></div>
          <div class="vo-headrow">
            <h2 class="vo-title" id="vo-h">${TEXT.title}</h2>
            <button type="button" class="vo-done" onClick=${onClose}>${TEXT.done}</button>
          </div>
        </div>
        <div class="vo-body">
          <div class="vo-group vo-group--switches" role="group" aria-labelledby="vo-video">
            <h3 class="vo-label" id="vo-video">${TEXT.video}</h3>
            ${SWITCHES.map(w => html`
              <button type="button" class="vo-switch" role="switch" aria-checked=${!!options[w.key]} onClick=${() => controller.setSwitch(w.key, !options[w.key])}>
                <span class="vo-switch__text">
                  <span class="vo-switch__name">${w.label}</span>
                  ${w.sub ? html`<span class="vo-switch__sub">${w.sub}</span>` : null}
                </span>
                <span class="vo-switch__track" aria-hidden="true"><span class="vo-switch__knob"></span></span>
              </button>`)}
          </div>

          <div class="vo-group" role="group" aria-labelledby="vo-speed">
            <h3 class="vo-label" id="vo-speed">${TEXT.speed}</h3>
            <div class="vo-segments">
              ${SPEED_BUTTONS.map(p => html`
                <button type="button" class="vo-segment" aria-pressed=${options.speed === p.value} onClick=${() => controller.setSpeed(p.value)}>${p.label}</button>`)}
            </div>
          </div>

          <div class="vo-group" role="group" aria-labelledby="vo-advanced">
            <h3 class="vo-label" id="vo-advanced">${TEXT.advanced}</h3>
            <label class="vo-sigma" for="vo-sigma">${TEXT.smoothing} <span class="vo-sigma__value">${smoothingLabel(sigma)}</span></label>
            <input id="vo-sigma" class="vo-slider" type="range" min=${SMOOTHING.min} max=${SMOOTHING.max} step=${SMOOTHING.step} value=${sigma}
              aria-describedby="vo-sigma-note" disabled=${options.scoring}
              onInput=${e => setDraft(Number(e.currentTarget.value))} onChange=${commit} />
            <span class="vo-note" id="vo-sigma-note" role="status">${options.scoring ? TEXT.scoring : TEXT.smoothingNote}</span>
          </div>

          ${options.error ? html`<p class="error vo-error" role="alert">${options.error}</p>` : null}

          <div class="vo-actions">
            ${options.asking ? html`
              <div class="vo-ask" role="group" aria-label=${TEXT.delete}>
                <p>${TEXT.deleteAsk}</p>
                <div class="vo-ask__buttons">
                  <button type="button" class="button--quiet" onClick=${() => controller.confirmDelete()}>${TEXT.deleteYes}</button>
                  <button type="button" onClick=${() => controller.cancelDelete()}>${TEXT.deleteNo}</button>
                </div>
              </div>` : html`
              <button type="button" class="vo-action" onClick=${() => controller.remark()}>${TEXT.remark}</button>
              <button type="button" class="vo-action vo-action--danger" onClick=${() => controller.askDelete()}>${TEXT.delete}</button>`}
          </div>
        </div>
      </section>
    </div>
  `;
}
