// A2, a cue's detail. A placeholder until d18 builds it; A1's cards open it with the lift's id and the
// cue's id in the flow's params. Back goes to the same result.
import { html } from '../html.mjs';

export function A2({ flow }) {
  const liftId = flow.params.liftId;
  return html`
    <main class="screen" data-screen="A2">
      <header class="screen__header">
        <h1 class="wordmark">coach</h1>
      </header>
      <div class="screen__body">
        <p class="label">A2</p>
        <h2 class="title">Cue detail</h2>
        <p class="soft">Coming in a later version.</p>
        <button type="button" class="button--primary" onClick=${() => flow.go('result', { liftId })}>Back to the result</button>
      </div>
    </main>
  `;
}
