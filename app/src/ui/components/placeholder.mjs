// SPDX-License-Identifier: AGPL-3.0-or-later
// What a screen shows until its package builds it: its ID and name, and one
// button per step the flow allows from it, so the whole milestone A walk
// (H, import, mark, queued, result, H) can be clicked through. A screen's
// buttons call the flow and nothing else: screens never call each other.
import { html } from '../html.mjs';

export function Placeholder({ flow, id, title, text, steps = [] }) {
  return html`
    <main class="screen" data-screen=${id}>
      <header class="screen__header">
        <h1 class="wordmark">coach³</h1>
      </header>
      <div class="screen__body">
        <p class="label">${id}</p>
        <h2 class="title">${title}</h2>
        <p class="soft">${text}</p>
        ${steps.map(({ label, to, primary }) => html`
          <button type="button" class=${primary ? 'button--primary' : ''} onClick=${() => flow.go(to)}>${label}</button>
        `)}
      </div>
    </main>
  `;
}
