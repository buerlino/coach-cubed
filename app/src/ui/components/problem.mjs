// An error as a screen's body (package d23): what happened, the raising module's own words, what the user can
// do, and the buttons (children) that lead on. The words are problem-model.mjs's; this only lays them out, in
// v1's tokens: the "work on" colour and its triangle, so it is never colour alone.
import { html } from '../html.mjs';
import { StatusIcon } from './icons.mjs';

/** @param {{problem: ReturnType<import('../problem-model.mjs').problemOf>, children?: any}} props */
export function Problem({ problem, children }) {
  return html`
    <section class="problem" role="alert" data-problem=${problem.kind}>
      <span class="problem__icon"><${StatusIcon} icon="work" /></span>
      <h2 class="problem__title">${problem.title}</h2>
      <p class="problem__what">${problem.what}</p>
      ${problem.engine ? html`<p class="problem__engine"><span class="label">Details</span><span>${problem.engine}</span></p>` : null}
      <p class="problem__can">${problem.can}</p>
      ${children ? html`<div class="problem__actions">${children}</div>` : null}
    </section>`;
}
