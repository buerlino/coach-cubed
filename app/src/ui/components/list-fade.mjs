// SPDX-License-Identifier: AGPL-3.0-or-later
// A fade at the bottom edge of a list that scrolls inside its screen (package d58: A1's cue list, in the stacked layout
// where A1 is as high as the window and the page itself does not scroll). It is the page cue's rule (more-below-model.mjs's
// moreBelow, d55) on the list's own scroller: shown while the list has more than 8 px to go below, hidden at its end or when nothing
// scrolls. Put it last in the scrolling element; it reads its parent. Decoration only: no button (a finger is on the list
// already), taps pass through (CSS: .list-fade).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { moreBelow } from '../more-below-model.mjs';

export function ListFade() {
  const self = useRef(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const scroller = self.current ? self.current.parentElement : null;
    if (!scroller) return undefined;
    const update = () => setShown(moreBelow(scroller));
    const watch = [];
    if (typeof ResizeObserver === 'function') {          // the window or the screen changes size
      const resize = new ResizeObserver(update);
      resize.observe(scroller);
      watch.push(() => resize.disconnect());
    }
    if (typeof MutationObserver === 'function') {        // a card opens or closes, the cues are scored again: the list grows or shrinks
      const mutate = new MutationObserver(update);
      mutate.observe(scroller, { childList: true, subtree: true, characterData: true });
      watch.push(() => mutate.disconnect());
    }
    scroller.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
    return () => {
      scroller.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      watch.forEach(stop => stop());
    };
  }, []);
  return html`<div class="list-fade" ref=${self} hidden=${!shown} aria-hidden="true"></div>`;
}
