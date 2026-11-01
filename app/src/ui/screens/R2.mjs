// R2, Recording. A placeholder; the screen itself is a later package's.
import { html } from '../html.mjs';
import { Placeholder } from '../components/placeholder.mjs';

export function R2({ flow }) {
  return html`<${Placeholder} flow=${flow} id="R2" title="Recording" text="Milestone B." steps=${[{ label: 'Replay', to: 'replay', primary: true }, { label: 'End session', to: 'home' }]} />`;
}
