// The "more below" cue's rule (package d55) as plain functions, so Node runs it as written (tests/app/more-below.test.js);
// components/more-below.mjs draws the cue. The cue is a fade and a ⌄ button at the bottom edge of the window,
// shown while the page can scroll further down (design/checkpoint-a/round-1.html, H).

/** The page counts as at its bottom within this many CSS pixels (fractional scroll positions, rounding). */
export const BOTTOM_SLACK_PX = 8;

/**
 * Whether the page can scroll more than 8 px further down.
 * @param {{scrollTop: number, clientHeight: number, scrollHeight: number}} page the document's scrolling element
 */
export const moreBelow = ({ scrollTop, clientHeight, scrollHeight }) => scrollHeight - (scrollTop + clientHeight) > BOTTOM_SLACK_PX;

/** How far the button scrolls: most of a window. */
export const scrollStep = clientHeight => Math.round(clientHeight * 0.8);

/** The button scrolls without animation for someone who asked the system for less motion. */
export const scrollBehavior = reducedMotion => (reducedMotion ? 'auto' : 'smooth');
