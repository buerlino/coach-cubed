// S1, Settings and about. A placeholder; the screen itself is a later package's.
import { html } from '../html.mjs';
import { Placeholder } from '../components/placeholder.mjs';

export function S1({ flow }) {
  return html`<${Placeholder} flow=${flow} id="S1" title="Settings and about" text="The defaults, storage, the version and the credits." steps=${[{ label: 'Back', to: 'home', primary: true }]} />`;
}
