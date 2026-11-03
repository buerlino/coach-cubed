// SPDX-License-Identifier: AGPL-3.0-or-later
// Welcome, the first run (package d23, built in v1's style; not drawn in the mockups): what the app does, that
// everything stays on this phone, and the way to import. Shown once before home (welcome-model.mjs); both buttons
// keep that it was shown and go on. The store is injected (main.mjs gives the app's).
import { html } from '../html.mjs';
import { ImportIcon, LockIcon } from '../components/icons.mjs';
import { PickVideo } from '../components/PickVideo.mjs';
import { pickCheck } from '../home-model.mjs';
import { WELCOME, finishWelcome } from '../welcome-model.mjs';

// The picker's file goes on to L1 once the intro is kept as shown (a file that is no video stays here, with its words).
const picked = (store, flow) => file => {
  const check = pickCheck(file);
  if (check.ok) finishWelcome(store, flow, 'lift', { file });
  return check;
};

export function Welcome({ flow, store }) {
  return html`
    <main class="screen" data-screen="Welcome">
      <header class="screen__header">
        <h1 class="wordmark">coach</h1>
      </header>
      <div class="screen__body welcome">
        <h2 class="title">${WELCOME.title}</h2>
        <ul class="welcome__points">${WELCOME.points.map(t => html`<li key=${t} class="soft">${t}</li>`)}</ul>
        <${PickVideo} flow=${flow} pick=${picked(store, flow)} class="card card--row">
          <span class="card__icon"><${ImportIcon} /></span>
          <span class="card__text"><span class="card__title">${WELCOME.importLabel}</span></span>
        <//>
        <button type="button" class="welcome__skip" onClick=${() => finishWelcome(store, flow, 'home')}>${WELCOME.skipLabel}</button>
      </div>
      <p class="screen__footer"><${LockIcon} /><span>Nothing leaves this phone.</span></p>
    </main>
  `;
}
