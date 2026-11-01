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
import { S1 } from './screens/S1.mjs';
import { R2 } from './screens/R2.mjs';
import { R3 } from './screens/R3.mjs';

const SCREENS = { H, Import, M, Q1, A1, S1, R2, R3 };

export function App({ flow }) {
  const { state } = useFlow(flow);
  const Screen = SCREENS[SCREEN_OF[state]];
  return html`<${Screen} flow=${flow} />`;
}
