// Boot: the flow, the app's one queue and store, then the shell. The engine
// (4.35 s cold on the Fairphone, c20) is warmed after the first screen draws,
// so it is ready by Analyse (s12).
import { render } from 'preact';
import { html } from './ui/html.mjs';
import { App } from './ui/app.mjs';
import { createFlow } from './flow/flow.mjs';
import { createStore } from './store/index.mjs';
import { appQueue } from './analysis/index.mjs';
import { createUpdates } from './updates.mjs';

const flow = createFlow();
const store = createStore();
const queue = appQueue({ store });   // one queue per app: it outlives the screens, H and Q1 subscribe to it
const updates = createUpdates({ queue });   // the service worker (c19): offline, and an update that waits for the queue to be idle
render(html`<${App} flow=${flow} queue=${queue} store=${store} updates=${updates} />`, document.getElementById('app'));
// After the browser has painted the first screen, not before: warmUp() starts a worker and a model.
// The service worker registers once the engine is up (or has failed), so its precache of the
// weights doesn't compete with the warm-up's own load of them.
requestAnimationFrame(() => setTimeout(() => {
  queue.warmUp().catch(() => { /* the first Analyse reports it */ }).then(() => updates.register());
}, 0));
