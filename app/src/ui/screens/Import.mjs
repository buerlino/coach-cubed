// Import, Import a video. A placeholder; the screen itself is a later package's.
import { html } from '../html.mjs';
import { Placeholder } from '../components/placeholder.mjs';

export function Import({ flow }) {
  return html`<${Placeholder} flow=${flow} id="Import" title="Import a video" text="Pick a clip from this phone." steps=${[{ label: 'Pick a video', to: 'mark', primary: true }, { label: 'Back', to: 'home' }]} />`;
}
