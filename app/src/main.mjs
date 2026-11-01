// Boot: the flow, then the shell. Later packages add the engine's warm-up
// here, before the first screen needs it.
import { render } from 'preact';
import { html } from './ui/html.mjs';
import { App } from './ui/app.mjs';
import { createFlow } from './flow/flow.mjs';

const flow = createFlow();
render(html`<${App} flow=${flow} />`, document.getElementById('app'));
