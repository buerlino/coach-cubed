// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot: the app's one session, the flow, the app's one queue and store, then the shell. The engine
// (4.35 s cold on the Fairphone, c20) is warmed after the first screen draws,
// so it is ready by Analyse (s12).
import { render } from 'preact';
import { html } from './ui/html.mjs';
import { App } from './ui/app.mjs';
import { createFlow } from './flow/flow.mjs';
import { createStore } from './store/index.mjs';
import { createSession } from './session.mjs';
import { createCapture } from './media/capture.mjs';
import { appQueue } from './analysis/index.mjs';
import { createUpdates } from './updates.mjs';
import { startState } from './ui/welcome-model.mjs';

const store = createStore();
// The gym session (d28): made here, once, so it outlives the screens. It has no capture and opens no camera until R1 asks
// (no permission prompt before the user wants one); the flow lets H go back to it while it runs.
const session = createSession({ makeCapture: settings => createCapture(settings), enabled: false });
// The gym session's preview switch (d66, off in 0.1.0): read once, before the first draw, so that H's top never changes
// after it draws; S1 keeps the session's copy in step with the saved one. A record that can't be read means off.
session.setEnabled(await store.getSettings().then(s => s.gymSession === true, () => false));
const flow = createFlow(await startState(store), { sessionRunning: () => session.active, gymSession: () => session.enabled });   // the first run starts at the intro, once (d23)
const queue = appQueue({ store });   // one queue per app: it outlives the screens, H and Q1 subscribe to it
const updates = createUpdates({ queue });   // the service worker (c19): offline, and an update that waits for the queue to be idle
render(html`<${App} flow=${flow} queue=${queue} store=${store} updates=${updates} session=${session} />`, document.getElementById('app'));
// After the browser has painted the first screen, not before: warmUp() starts a worker and a model.
// The service worker registers once the engine is up (or has failed), so its precache of the
// weights doesn't compete with the warm-up's own load of them.
requestAnimationFrame(() => setTimeout(() => {
  queue.warmUp().catch(() => { /* the first Analyse reports it */ }).then(() => updates.register());
}, 0));
