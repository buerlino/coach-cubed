// SPDX-License-Identifier: AGPL-3.0-or-later
// The app shell: draws the screen the flow's state names. The only place that
// knows every screen; the screens know the flow and nothing else.
import { html } from './html.mjs';
import { useFlow } from './use-flow.mjs';
import { SCREEN_OF } from '../flow/flow.mjs';
import { Welcome } from './screens/Welcome.mjs';
import { H } from './screens/H.mjs';
import { L1 } from './screens/L1.mjs';
import { M } from './screens/M.mjs';
import { Q1 } from './screens/Q1.mjs';
import { A1 } from './screens/A1.mjs';
import { A2 } from './screens/A2.mjs';
import { S1 } from './screens/S1.mjs';
import { S1b } from './screens/S1b.mjs';
import { R1 } from './screens/R1.mjs';
import { R2 } from './screens/R2.mjs';
import { R3 } from './screens/R3.mjs';
import { R3b } from './screens/R3b.mjs';
import { MoreBelow } from './components/more-below.mjs';

const SCREENS = { Welcome, H, L1, M, Q1, A1, A2, S1, S1b, R1, R2, R3, R3b };

// `queue`, `store`, `updates` (the service worker's state, src/updates.mjs) and `session` (the gym session,
// src/session.mjs) are the app's (main.mjs); the screens that need them get them injected.
export function App({ flow, queue, store, updates, session }) {
  const { state } = useFlow(flow);
  const Screen = SCREENS[SCREEN_OF[state]];
  return html`<${Screen} flow=${flow} queue=${queue} store=${store} updates=${updates} session=${session} /><${MoreBelow} />`;
}
