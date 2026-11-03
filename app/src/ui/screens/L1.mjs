// L1, Which lift? (round 1: design/checkpoint-a/round-1.html; package d53): after the phone's picker, the
// lift is chosen here and nowhere else. One big tile per lift from the registry (lift-model.mjs's liftTiles),
// S1's default lift ringed in the accent; one tap goes on to M with the file and the lift. ‹ goes back to H
// and drops the file. The settings come from the injected store; until they arrive (or if they can't be
// read) the first lift is the default.
import { useEffect, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { BackIcon, FilmIcon, LiftIcon, LockIcon } from '../components/icons.mjs';
import { chooseLift, liftTiles } from '../lift-model.mjs';

export function L1({ flow, store }) {
  const [settings, setSettings] = useState(null);
  const [refused, setRefused] = useState(null);
  useEffect(() => {
    let current = true;
    Promise.resolve().then(() => store.getSettings()).then(s => { if (current) setSettings(s); }, () => {});
    return () => { current = false; };
  }, [store]);
  const file = flow.params.file;

  return html`
    <main class="screen" data-screen="L1">
      <header class="bar-header">
        <button type="button" class="icon-button" aria-label="Back" onClick=${() => flow.go('home')}><${BackIcon} /></button>
      </header>
      <div class="lift-step">
        <h1 class="lift-step__title">Which lift?</h1>
        ${file && file.name ? html`<p class="lift-step__clip"><${FilmIcon} /><span>${file.name}</span></p>` : null}
        ${liftTiles(settings).map(t => html`
          <button type="button" key=${t.id} data-lift=${t.id} aria-label=${t.name}
            class=${`lift-tile${t.isDefault ? ' lift-tile--default' : ''}`}
            onClick=${() => { const out = chooseLift(flow, t.id); if (!out.ok) setRefused(out.error); }}>
            <span class="lift-tile__icon"><${LiftIcon} lift=${t.id} /></span>
            <span class="lift-tile__text">
              <span class="lift-tile__name">${t.label}</span>
              ${t.provisional ? html`<span class="tag">provisional</span>` : null}
            </span>
          </button>`)}
        ${refused ? html`<p class="error" role="alert">${refused}</p>` : null}
      </div>
      <p class="screen__footer"><${LockIcon} /><span>Nothing leaves this phone.</span></p>
    </main>
  `;
}
