// Q1, Analysing. A placeholder; the screen itself is a later package's.
import { html } from '../html.mjs';
import { Placeholder } from '../components/placeholder.mjs';

export function Q1({ flow }) {
  return html`<${Placeholder} flow=${flow} id="Q1" title="Analysing" text="Leaving doesn't stop it." steps=${[{ label: 'Show the result', to: 'result', primary: true }, { label: 'Home', to: 'home' }]} />`;
}
