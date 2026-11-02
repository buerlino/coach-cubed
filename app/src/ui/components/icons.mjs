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
