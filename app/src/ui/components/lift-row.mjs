// One lift in H's lists: the lifter, the lift, the clock and length, and its
// state in words (design/mockups/Main.dc.html). `row` is home-model.mjs's rowOf.
// A lift that can be opened is a button that asks the flow for `row.open`.
import { html } from '../html.mjs';
import { ChevronIcon, LiftIcon, StatusIcon } from './icons.mjs';
import { waitingText } from '../home-model.mjs';

function State({ row }) {
  const s = row.state;
  if (s.kind === 'analysing') {
    return html`<span class="lift-row__progress">
      <span class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${s.percent}><span class="bar__fill" style=${`width: ${s.percent}%`}></span></span>
      <span>${s.percent} %</span>
    </span>`;
  }
  if (s.kind === 'waiting') {
    return html`<span class="lift-row__state">${waitingText(s.ahead)}</span>`;
  }
  // the reason a job failed is on Q1 (Problem), not on the row
  if (s.kind === 'failed') return html`<span class="lift-row__state count--work-on"><${StatusIcon} icon="work" />Couldn’t analyse</span>`;
  if (s.kind === 'stopped') return html`<span class="lift-row__state">Stopped</span>`;
  if (row.summary.length === 0) return html`<span class="lift-row__state">Ready</span>`;
  // one status icon and its count per status, worst first; the words are for screen readers (row.summaryLabel)
  return html`<span class="lift-row__state lift-row__counts" role="img" aria-label=${row.summaryLabel}>${row.summary.map(c => html`<span key=${c.status} class=${`lift-row__count count--${c.status}`} aria-hidden="true"><${StatusIcon} icon=${c.icon} />${c.count}</span>`)}</span>`;
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
