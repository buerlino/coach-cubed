'use strict';
// The app's flow: one small state machine owns which screen shows
// (docs/ui-design.md, "Keeping the UI maintainable"). app/src/flow/ is a plain
// module with no Preact, so it runs here as written. Built-ins only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP = path.resolve(__dirname, '..', '..', 'app');
const load = () => import(pathToFileURL(path.join(APP, 'src', 'flow', 'flow.mjs')).href);

test('the states: milestone A\'s six and a result\'s detail, plus live and replay for milestone B', async () => {
  const { STATES } = await load();
  assert.deepEqual([...STATES].sort(), ['detail', 'home', 'import', 'live', 'mark', 'queued', 'replay', 'result', 'scoring', 'settings']);
});

test('a flow starts at home and keeps what each step carries', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  assert.equal(flow.state, 'home');
  assert.deepEqual(flow.params, {});
  flow.go('import');
  flow.go('mark', { file: 'clip.mp4' });
  assert.equal(flow.state, 'mark');
  assert.deepEqual(flow.params, { file: 'clip.mp4' });
});

test('milestone A: H, import, mark, queued, result and back to H', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  const seen = [flow.state];
  for (const to of ['import', 'mark', 'queued', 'result', 'home']) { flow.go(to); seen.push(flow.state); }
  assert.deepEqual(seen, ['home', 'import', 'mark', 'queued', 'result', 'home']);
});

test('the other steps milestone A needs: leave and come back to a lift, settings, cancel, re-mark', async () => {
  const { createFlow } = await load();
  const step = (from, to) => { const f = createFlow(from); f.go(to); assert.equal(f.state, to, `${from} -> ${to}`); };
  step('home', 'settings');
  step('settings', 'home');
  step('home', 'queued');   // open a lift that is still analysing
  step('home', 'result');   // open a finished lift
  step('import', 'home');   // the picker cancelled
  step('mark', 'home');     // marking given up
  step('queued', 'home');   // leaving doesn't stop the analysis
  step('result', 'mark');   // re-mark (A3)
});

test('milestone B: H, live, replay, mark, back to live with the lift queued', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  for (const to of ['live', 'replay', 'mark', 'live', 'replay', 'live', 'home']) flow.go(to);
  assert.equal(flow.state, 'home');
});

test('an illegal transition throws, names both states and leaves the state alone', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  assert.throws(() => flow.go('mark'), (e) => e instanceof Error && /\bhome\b.*\bmark\b/.test(e.message));
  assert.throws(() => flow.go('replay'), /home/);
  assert.equal(flow.state, 'home');
  flow.go('import');
  assert.throws(() => flow.go('queued'), /import/);
  assert.throws(() => flow.go('result'), /import/);
  assert.throws(() => flow.go('import'), /import/, 'a state does not lead to itself');
  assert.equal(flow.state, 'import');
});

test('a state the flow doesn\'t know throws, from go() and as the start', async () => {
  const { createFlow } = await load();
  assert.throws(() => createFlow().go('nowhere'), /nowhere/);
  assert.throws(() => createFlow('nowhere'), /nowhere/);
});

test('can() says whether a transition is allowed, without making it', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  assert.equal(flow.can('import'), true);
  assert.equal(flow.can('mark'), false);
  assert.equal(flow.can('nowhere'), false);
  assert.equal(flow.state, 'home');
});

test('listeners hear each change, with the old state, the new one and what it carries', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  const heard = [];
  flow.subscribe((change) => heard.push(change));
  flow.go('import');
  flow.go('mark', { file: 'a.mp4' });
  assert.deepEqual(heard, [
    { from: 'home', to: 'import', params: {} },
    { from: 'import', to: 'mark', params: { file: 'a.mp4' } },
  ]);
});

test('an illegal transition is not heard; an unsubscribed listener hears nothing more', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  let count = 0;
  const off = flow.subscribe(() => { count++; });
  assert.throws(() => flow.go('mark'));
  assert.equal(count, 0);
  flow.go('import');
  assert.equal(count, 1);
  off();
  flow.go('home');
  assert.equal(count, 1);
});

test('the state is already new when listeners are called, and several listeners all hear it', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  const states = [];
  flow.subscribe(() => states.push(['a', flow.state]));
  flow.subscribe(() => states.push(['b', flow.state]));
  flow.go('settings');
  assert.deepEqual(states, [['a', 'settings'], ['b', 'settings']]);
});

test('every state is reachable from home and can lead somewhere', async () => {
  const { STATES, TRANSITIONS } = await load();
  const reached = new Set(['home']);
  const todo = ['home'];
  while (todo.length) for (const to of TRANSITIONS[todo.pop()]) if (!reached.has(to)) { reached.add(to); todo.push(to); }
  assert.deepEqual([...reached].sort(), [...STATES].sort());
  for (const s of STATES) assert.ok(TRANSITIONS[s].length > 0, `${s} is a dead end`);
  for (const s of STATES) for (const to of TRANSITIONS[s]) assert.ok(STATES.includes(to), `${s} -> ${to}`);
});

test('each state has a screen ID, and a screen module of that name in app/src/ui/screens/', async () => {
  const { STATES, SCREEN_OF } = await load();
  const ids = STATES.map((s) => SCREEN_OF[s]);
  assert.equal(new Set(ids).size, STATES.length, 'one screen per state');
  assert.equal(SCREEN_OF.home, 'H');
  assert.equal(SCREEN_OF.settings, 'S1');
  assert.equal(SCREEN_OF.queued, 'Q1');
  assert.equal(SCREEN_OF.result, 'A1');
  for (const id of ids) assert.ok(fs.existsSync(path.join(APP, 'src', 'ui', 'screens', `${id}.mjs`)), `screens/${id}.mjs`);
});

test('screens never import each other, and the flow is a plain module', () => {
  const dir = path.join(APP, 'src', 'ui', 'screens');
  const screens = fs.readdirSync(dir).filter((n) => n.endsWith('.mjs'));
  assert.ok(screens.length >= 8, 'one placeholder per screen');
  for (const f of screens) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      assert.ok(!m[1].startsWith('./'), `${f} imports a sibling screen: ${m[1]}`);
    }
  }
  const flowText = fs.readFileSync(path.join(APP, 'src', 'flow', 'flow.mjs'), 'utf8');
  assert.ok(!/preact|htm|document|window/.test(flowText.replace(/\/\/.*$/gm, '')), 'the flow is a plain module');
});
