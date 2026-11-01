// A1, Result. A placeholder; the screen itself is a later package's.
import { html } from '../html.mjs';
import { Placeholder } from '../components/placeholder.mjs';

export function A1({ flow }) {
  return html`<${Placeholder} flow=${flow} id="A1" title="Result" text="The video, the timeline and a card per cue." steps=${[{ label: 'Home', to: 'home', primary: true }, { label: 'Mark again', to: 'mark' }]} />`;
}
