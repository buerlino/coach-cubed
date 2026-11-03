// SPDX-License-Identifier: AGPL-3.0-or-later
// Whether the window is wide (A4): the media query's answer now, and again when it changes. The hook A1 asks; the
// pure part is wide-model.mjs.
import { useEffect, useState } from 'preact/hooks';
import { WIDE_QUERY } from './wide-model.mjs';

const query = () => (globalThis.matchMedia ? globalThis.matchMedia(WIDE_QUERY) : null);

export function useWide() {
  const [wide, setWide] = useState(() => { const m = query(); return !!(m && m.matches); });
  useEffect(() => {
    const m = query();
    if (!m) return undefined;
    const on = () => setWide(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}
