// The button that opens the phone's picker (package d53): a real button, and a hidden file input it clicks.
// The pick step (home-model.mjs's pickStep) takes the file to L1; a refused file's words show right under the
// button, where the picker was. Used by H's and the first run's import cards and by the problem screens'
// "Pick another video" (M, Q1). `pick(file)` is the screen's own step when it has one (the first run saves
// that it was shown first); it answers { ok, error }.
import { useRef, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { pickStep } from '../home-model.mjs';

/** @param {{flow: object, pick?: (file: File|undefined) => {ok: boolean, error?: string|null}, class?: string, children?: any}} props */
export function PickVideo({ flow, pick = file => pickStep(flow, file), class: className, children }) {
  const input = useRef(null);
  const [error, setError] = useState(null);
  const picked = event => {
    const el = event.target;
    const file = el.files && el.files[0];
    el.value = '';   // the same file can be picked again after a refusal
    const step = pick(file);
    setError(step.ok ? null : step.error ?? null);
  };
  return html`
    <button type="button" class=${className} onClick=${() => input.current && input.current.click()}>${children}</button>
    <input type="file" accept="video/*" hidden ref=${input} onChange=${picked} />
    ${error ? html`<p class="error" role="alert">${error}</p>` : null}
  `;
}
