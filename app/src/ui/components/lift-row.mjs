// One lift in H's lists: the lifter, the lift, the clock and length, and its
// state in words (design/mockups/Main.dc.html). `row` is home-model.mjs's rowOf.
// A lift that can be opened is a button that asks the flow for `row.open`.
import { html } from '../html.mjs';
import { ChevronIcon, LiftIcon } from './icons.mjs';

function State({ row }) {
  const s = row.state;
  if (s.kind === 'analysing') {
    return html`<span class="lift-row__progress">
      <span class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${s.percent}><span class="bar__fill" style=${`width: ${s.percent}%`}></span></span>
      <span>Analysing ${s.percent}%</span>
    </span>`;
  }
  if (s.kind === 'waiting') {
    return html`<span class="lift-row__state">${s.ahead > 0 ? 'Waiting · starts after the ones ahead' : 'Waiting'}</span>`;
  }
  if (s.kind === 'failed') return html`<span class="lift-row__state">Couldn't analyse · ${s.error}</span>`;
  if (s.kind === 'stopped') return html`<span class="lift-row__state">Not analysed · stopped</span>`;
  if (row.summary.length === 0) return html`<span class="lift-row__state">Ready</span>`;
  return html`<span class="lift-row__state">${row.summary.map(c => html`<span class=${`count--${c.status}`}>${c.text}</span>`)}</span>`;
}

export function LiftRow({ row, flow }) {
  return html`
    <button type="button" class="lift-row" data-lift=${row.id} data-state=${row.state.kind} onClick=${() => flow.go(row.open.to, row.open.params)}>
      <span class="lift-row__thumb"><${LiftIcon} lift=${row.lift} /></span>
      <span class="lift-row__body">
        <span class="lift-row__top"><span class="lift-row__title">${row.title}</span><span class="lift-row__meta">${row.meta}</span></span>
        <${State} row=${row} />
      </span>
      ${row.state.kind === 'ready' ? html`<${ChevronIcon} />` : null}
    </button>
  `;
}
