// The icons H draws, from the mockups (design/mockups/Main.dc.html): inline
// SVG in currentColor, so a colour comes from the CSS around it.
import { html } from '../html.mjs';

const line = 'fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round';
const lineThick = 'fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round';

export const SettingsIcon = () => html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" style=${line}><path d="M4 7h9M17 7h3M4 17h3M11 17h9"></path><circle cx="15" cy="7" r="2"></circle><circle cx="9" cy="17" r="2"></circle></svg>`;
export const CameraIcon = () => html`<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" style=${line}><rect x="2.5" y="6.5" width="13" height="11" rx="2.5"></rect><path d="M15.5 10.5l6-3.5v10l-6-3.5z"></path></svg>`;
export const ImportIcon = () => html`<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" style=${line}><path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5M4.5 19.5h15"></path></svg>`;
export const ChevronIcon = () => html`<svg class="lift-row__chevron" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" style=${line}><path d="M9 5l7 7-7 7"></path></svg>`;
export const LockIcon = () => html`<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" style="flex: none; ${line}"><rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>`;

const RAISE = html`<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true" style=${lineThick}><circle cx="24" cy="11" r="4"></circle><path d="M24 17v15M24 19H10M24 19h14M10 15.5v7M38 15.5v7M24 32l-5 12M24 32l5 12"></path></svg>`;
const SNATCH = html`<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true" style=${lineThick}><circle cx="24" cy="17" r="4"></circle><path d="M5 7h38M8 3v8M40 3v8M24 23l-8-16M24 23l8-16M24 21v13M24 34l-8 4 2 6M24 34l8 4-2 6"></path></svg>`;

/** The lifter drawn for a lift, as the mockup's row thumbnails. */
export const LiftIcon = ({ lift }) => (lift === 'snatch' ? SNATCH : RAISE);

export const BackIcon = () => html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" style="fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round"><path d="M15 5l-7 7 7 7"></path></svg>`;

// M's (design/mockups/Mark.dc.html): close, the lift menu's chevron, the frame steps
const thick = 'fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round';
export const CloseIcon = () => html`<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" style=${thick}><path d="M6 6l12 12M18 6L6 18"></path></svg>`;
export const ChevronDownIcon = () => html`<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" style=${thick}><path d="M6 9l6 6 6-6"></path></svg>`;
export const StepBackIcon = () => html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" style=${thick}><path d="M16 6l-6 6 6 6M8 6v12"></path></svg>`;
export const StepForwardIcon = () => html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" style=${thick}><path d="M8 6l6 6-6 6M16 6v12"></path></svg>`;

// A1's (design/mockups/Result.dc.html): play, pause, the options menu
const solid = 'fill: currentColor';
export const PlayIcon = () => html`<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" style=${solid}><path d="M8 5v14l11-7z"></path></svg>`;
export const PauseIcon = () => html`<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" style=${solid}><rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect></svg>`;
export const MoreIcon = () => html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" style=${solid}><circle cx="5" cy="12" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="19" cy="12" r="2"></circle></svg>`;

// A1's cue cards (design/mockups/Result.dc.html): a status's icon, drawn before its word. The mockup draws
// good (a circle with a tick), work on (a triangle with a mark) and can't score (a dashed circle with a
// dash); watch has no card in the mockups, so it is built in their style: a circle with a mark.
const statusLine = 'fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round';
const STATUS_ICONS = {
  good: () => html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" style=${statusLine}><circle cx="12" cy="12" r="9.5"></circle><path d="M7.5 12.5l3 3 6-6.5"></path></svg>`,
  watch: () => html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" style=${statusLine}><circle cx="12" cy="12" r="9.5"></circle><path d="M12 7.5v5.5M12 16.5h.01"></path></svg>`,
  work: () => html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" style=${statusLine}><path d="M12 3l9.5 17h-19z"></path><path d="M12 10v4.5M12 17.5h.01"></path></svg>`,
  cant: () => html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" style=${statusLine}><circle cx="12" cy="12" r="9.5" style="stroke-dasharray: 3 3"></circle><path d="M8 12h8"></path></svg>`,
};
/** @param {{icon: 'good'|'watch'|'work'|'cant'}} props result-model.mjs's `icon` */
export const StatusIcon = ({ icon }) => STATUS_ICONS[icon]();
