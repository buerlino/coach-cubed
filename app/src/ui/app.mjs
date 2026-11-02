// The app shell: draws the screen the flow's state names. The only place that
// knows every screen; the screens know the flow and nothing else.
import { html } from './html.mjs';
import { useFlow } from './use-flow.mjs';
import { SCREEN_OF } from '../flow/flow.mjs';
import { H } from './screens/H.mjs';
import { Import } from './screens/Import.mjs';
import { M } from './screens/M.mjs';
import { Q1 } from './screens/Q1.mjs';
import { A1 } from './screens/A1.mjs';
import { A2 } from './screens/A2.mjs';
import { S1 } from './screens/S1.mjs';
import { S1b } from './screens/S1b.mjs';
import { R2 } from './screens/R2.mjs';
import { R3 } from './screens/R3.mjs';

const SCREENS = { H, Import, M, Q1, A1, A2, S1, S1b, R2, R3 };

// `queue`, `store` and `updates` (the service worker's state, src/updates.mjs) are the app's
// (main.mjs); the screens that need them get them injected.
export function App({ flow, queue, store, updates }) {
  const { state } = useFlow(flow);
  const Screen = SCREENS[SCREEN_OF[state]];
  return html`<${Screen} flow=${flow} queue=${queue} store=${store} updates=${updates} />`;
}
