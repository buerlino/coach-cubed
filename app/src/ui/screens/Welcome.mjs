// Welcome, the first run (package d23, built in v1's style; not drawn in the mockups): what the app does, that
// everything stays on this phone, and the way to import. Shown once before home (welcome-model.mjs); both buttons
// keep that it was shown and go on. The store is injected (main.mjs gives the app's).
import { html } from '../html.mjs';
import { ImportIcon, LockIcon } from '../components/icons.mjs';
import { WELCOME, finishWelcome } from '../welcome-model.mjs';

export function Welcome({ flow, store }) {
  return html`
    <main class="screen" data-screen="Welcome">
      <header class="screen__header">
        <h1 class="wordmark">coach</h1>
      </header>
      <div class="screen__body welcome">
        <h2 class="title">${WELCOME.title}</h2>
        <ul class="welcome__points">${WELCOME.points.map(t => html`<li key=${t} class="soft">${t}</li>`)}</ul>
        <button type="button" class="card card--row" onClick=${() => finishWelcome(store, flow, 'import')}>
          <span class="card__icon"><${ImportIcon} /></span>
          <span class="card__text"><span class="card__title">${WELCOME.importLabel}</span></span>
        </button>
        <button type="button" class="welcome__skip" onClick=${() => finishWelcome(store, flow, 'home')}>${WELCOME.skipLabel}</button>
      </div>
      <p class="screen__footer"><${LockIcon} /><span>Everything stays on this phone. No account, no uploads.</span></p>
    </main>
  `;
}
