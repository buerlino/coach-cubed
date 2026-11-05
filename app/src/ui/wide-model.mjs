// SPDX-License-Identifier: AGPL-3.0-or-later
// A4, the wide result (package d25, design/mockups/Desktop.dc.html), as plain functions: what the wide layout
// says that the stacked one does not. No Preact, no DOM, so Node runs them as written (tests/app/wide.test.js).
// A4 is not a screen of its own: A1 draws it when the window is wide, the same elements in the same place of the
// tree (the player's canvases are never remade), arranged by CSS; what is added is the selected cue's panel and
// the header's breadcrumb.
import { liftLabel, clock, dayKey } from './home-model.mjs';
import { ruleSentence } from './rule-model.mjs';

/**
 * The window width from which the result is drawn wide, in CSS pixels. The mockup's main column needs 560 px, the
 * cue sidebar 340 px, the gap between them 24 px and the page 24 px of padding at each side: 972 px. 980 is the
 * next round number, so a landscape phone (800 px, the widest we check) and a portrait tablet (768 px) stack, and
 * a laptop window does not. base.css's `@media` repeats this number (a media query cannot read a token);
 * tests/app/wide.test.js checks that the two agree.
 */
export const WIDE_MIN_PX = 980;
export const WIDE_QUERY = `(min-width: ${WIDE_MIN_PX}px)`;

/** The mockup's string under the selected cue: its thresholds are provisional. */
export const PROVISIONAL_FOOT = 'Provisional: not yet checked on real lifts.';

/** The sidebar's heading: "5 cues". */
export const cuesHeading = n => `${n} ${n === 1 ? 'cue' : 'cues'}`;

/**
 * The header's breadcrumb: where the lift is from and its name with the time and the length ("Lateral raise ·
 * 14:27 · 3.0 s"). The parent is "Today" for a lift of today, else "Earlier".
 * @param {import('../contracts/stored-lift.mjs').StoredLift} lift
 * @param {Date} [now]
 */
export function crumbOf(lift, now = new Date()) {
  const created = new Date(lift.created);
  return {
    parent: dayKey(created) === dayKey(now) ? 'Today' : 'Earlier',
    current: `${liftLabel(lift.lift)} · ${clock(created)} · ${(lift.range.t1 - lift.range.t0).toFixed(1)} s`,
  };
}

/** The cue shown in the panel: the one chosen, else the first to work on or watch, else the first. null with no cues. */
export function selectedOf(cards, open) {
  if (!cards.length) return null;
  return cards.find(c => c.id === open) || cards.find(c => c.status === 'work on') || cards.find(c => c.status === 'watch') || cards[0];
}

/**
 * The line under the selected cue's plot: the rule's sentence ("Good from +5%, work on below −5%.") and, while the
 * cue's thresholds are provisional, the mockup's sentence on that. null when neither.
 * @param {import('../contracts/cue-view.mjs').CueView} cue
 * @param {Array|null} zones diagnostics.js's zones(id)
 * @param {Object|null} rule diagnostics.js's rule(id)
 */
export function footOf(cue, zones, rule) {
  const sentence = cue.reason === null ? ruleSentence(cue.unit, zones, rule) : null;
  const parts = [sentence, cue.provisional ? PROVISIONAL_FOOT : null].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

/** The video's label: "Video with the pose skeleton, at 2.24 s" (seconds into the marked range). */
export const frameLabel = (t, range) => `Video with the pose skeleton, at ${Math.max(0, t - range.t0).toFixed(2)} s`;
