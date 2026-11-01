// R3, Replay. A placeholder; the screen itself is a later package's.
import { html } from '../html.mjs';
import { Placeholder } from '../components/placeholder.mjs';

export function R3({ flow }) {
  return html`<${Placeholder} flow=${flow} id="R3" title="Replay" text="Milestone B." steps=${[{ label: 'Keep and mark', to: 'mark', primary: true }, { label: 'Back to live', to: 'live' }]} />`;
}
