// M, Mark the lift. A placeholder; the screen itself is a later package's.
import { html } from '../html.mjs';
import { Placeholder } from '../components/placeholder.mjs';

export function M({ flow }) {
  return html`<${Placeholder} flow=${flow} id="M" title="Mark the lift" text="Set the start and the end of the lift." steps=${[{ label: 'Analyse', to: 'queued', primary: true }, { label: 'Back', to: 'home' }]} />`;
}
