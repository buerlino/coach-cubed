// SPDX-License-Identifier: AGPL-3.0-or-later
// The "more below" cue (package d55): drawn once by the app's shell, for every screen. While the page can scroll
// further down, a fade at the bottom edge of the window with a ⌄ button that scrolls down by most of a window.
// It goes at the bottom, with nothing to scroll, and while a sheet (A3, aria-modal) is open. It follows
// scrolling, resizing and content that grows (a ResizeObserver on the app), and the sheet opening or closing.
import { useEffect, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { moreBelow, scrollBehavior, scrollStep } from '../more-below-model.mjs';

const MOTION = '(prefers-reduced-motion: reduce)';
const reduced = () => typeof matchMedia === 'function' && matchMedia(MOTION).matches;
const sheetOpen = () => document.querySelector('[aria-modal="true"]') !== null;
const wanted = () => !sheetOpen() && moreBelow(document.scrollingElement || document.documentElement);

export function MoreBelow() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const update = () => setShown(wanted());
    const app = document.getElementById('app');
    const watch = [];
    if (typeof ResizeObserver === 'function') {
      const resize = new ResizeObserver(update);
      resize.observe(document.documentElement);
      if (app) resize.observe(app);
      watch.push(() => resize.disconnect());
    }
    if (typeof MutationObserver === 'function' && app) {   // a sheet opens or closes; a screen changes
      const mutate = new MutationObserver(update);
      mutate.observe(app, { childList: true, subtree: true });
      watch.push(() => mutate.disconnect());
    }
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      watch.forEach(stop => stop());
    };
  }, []);
  const down = () => window.scrollBy({ top: scrollStep(window.innerHeight), behavior: scrollBehavior(reduced()) });
  return html`<div class="more-below" hidden=${!shown}><button type="button" aria-label="More below" onClick=${down}><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" style="fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round"><path d="M6 9l6 6 6-6"></path></svg></button></div>`;
}
