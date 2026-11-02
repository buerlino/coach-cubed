// Import, H's picker: the lift first, then the video. The chosen lift goes into
// the flow with the file, on the way to marking (home-model.mjs's importStep).
import { useEffect, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { importStep, liftChoices, startLift } from '../home-model.mjs';

export function Import({ flow, store }) {
  // The lift starts on S1's default once the settings arrive (the first choice until then, or if
  // they can't be read); a choice made before that is kept.
  const [settings, setSettings] = useState(null);
  const [chosen, setChosen] = useState(null);
  const lift = chosen ?? startLift(settings);
  useEffect(() => {
    let current = true;
    Promise.resolve().then(() => store.getSettings()).then(s => { if (current) setSettings(s); }, () => {});
    return () => { current = false; };
  }, [store]);
  const [error, setError] = useState(null);

  const picked = (event) => {
    const input = event.target;
    const step = importStep(flow, input.files && input.files[0], lift);
    if (!step.ok) { setError(step.error); input.value = ''; }
  };

  return html`
    <main class="screen" data-screen="Import">
      <header class="screen__header">
        <h1 class="wordmark">coach</h1>
      </header>
      <div class="screen__body">
        <h2 class="title">Import a video</h2>
        <p class="soft">Choose the lift first, then pick a clip from this phone.</p>
        <fieldset class="choice">
          <legend class="label">Which lift?</legend>
          ${liftChoices().map(c => html`
            <label class="choice__option" key=${c.id}>
              <input type="radio" name="lift" value=${c.id} checked=${lift === c.id} onChange=${() => setChosen(c.id)} />
              <span>${c.label}</span>
              ${c.provisional ? html`<span class="quiet">provisional</span>` : null}
            </label>`)}
        </fieldset>
        <label class="picker button--primary">
          <span>Pick a video</span>
          <input type="file" accept="video/*" onChange=${picked} />
        </label>
        ${error ? html`<p class="error" role="alert">${error}</p>` : null}
        <button type="button" onClick=${() => flow.go('home')}>Back</button>
      </div>
      <p class="screen__footer">Everything stays on this phone. No account, no uploads.</p>
    </main>
  `;
}
