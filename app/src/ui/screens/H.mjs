// H, home. A placeholder with H's frame: the wordmark, the settings button
// and the privacy line from the mockup (design/mockups/Main.dc.html); the
// rest is d13.
import { html } from '../html.mjs';

export function H({ flow }) {
  return html`
    <main class="screen" data-screen="H">
      <header class="screen__header">
        <h1 class="wordmark">coach</h1>
        <button type="button" aria-label="Settings and about" onClick=${() => flow.go('settings')}>
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" style="fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"></path><circle cx="15" cy="7" r="2"></circle><circle cx="9" cy="17" r="2"></circle></svg>
        </button>
      </header>
      <div class="screen__body">
        <button type="button" class="card" onClick=${() => flow.go('import')}>
          <span class="card__title">Import a video</span>
          <span class="soft">Pick a clip from this phone and mark the lift.</span>
        </button>
      </div>
      <p class="screen__footer">Everything stays on this phone. No account, no uploads.</p>
    </main>
  `;
}
