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

test('the states: milestone A\'s six and a result\'s detail, plus setup (R1), live (R2), replay (R3) and delayed (R3b) for milestone B', async () => {
  const { STATES } = await load();
  assert.deepEqual([...STATES].sort(), ['delayed', 'detail', 'home', 'lift', 'live', 'mark', 'queued', 'replay', 'result', 'scoring', 'settings', 'setup', 'welcome']);
});

test('a flow starts at home and keeps what each step carries', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  assert.equal(flow.state, 'home');
  assert.deepEqual(flow.params, {});
  flow.go('lift', { file: 'clip.mp4' });
  flow.go('mark', { file: 'clip.mp4', lift: 'snatch' });
  assert.equal(flow.state, 'mark');
  assert.deepEqual(flow.params, { file: 'clip.mp4', lift: 'snatch' });
});

test('milestone A: H, the lift step, mark, queued, result and back to H', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  const seen = [flow.state];
  for (const to of ['lift', 'mark', 'queued', 'result', 'home']) { flow.go(to); seen.push(flow.state); }
  assert.deepEqual(seen, ['home', 'lift', 'mark', 'queued', 'result', 'home']);
});

test('the other steps milestone A needs: leave and come back to a lift, settings, cancel, re-mark', async () => {
  const { createFlow } = await load();
  const step = (from, to) => { const f = createFlow(from); f.go(to); assert.equal(f.state, to, `${from} -> ${to}`); };
  step('home', 'settings');
  step('settings', 'home');
  step('home', 'queued');   // open a lift that is still analysing
  step('home', 'result');   // open a finished lift
  step('lift', 'home');     // ‹ back from L1 drops the file
  step('lift', 'mark');     // one tap on a lift
  step('welcome', 'lift');  // the first run's picker
  step('mark', 'lift');     // d23: "Pick another video" on M's problem screen
  step('mark', 'home');     // marking given up
  step('queued', 'home');   // leaving doesn't stop the analysis
  step('queued', 'lift');   // d51: "Pick another video" on Q1's "No person found"
  step('result', 'mark');   // re-mark (A3)
});

test('milestone B: H, setup (R1), live, replay, mark, back to live with the lift queued', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  for (const to of ['setup', 'live', 'replay', 'mark', 'live', 'replay', 'live', 'home']) flow.go(to);
  assert.equal(flow.state, 'home');
});

test('d28: a session starts on R1: setup is the screen R1, home -> setup -> live, and home -> live is not a step', async () => {
  const { SCREEN_OF, TRANSITIONS, createFlow } = await load();
  assert.equal(SCREEN_OF.setup, 'R1');
  assert.equal(SCREEN_OF.live, 'R2');
  for (const [from, to] of [['home', 'setup'], ['setup', 'live'], ['setup', 'home'], ['live', 'replay'], ['live', 'home'], ['live', 'queued'], ['queued', 'live']]) {
    assert.ok(TRANSITIONS[from].includes(to), `${from} -> ${to}`);
    const f = createFlow(from); f.go(to); assert.equal(f.state, to);
  }
  assert.ok(!TRANSITIONS.home.includes('live'), 'home -> live is not a transition');
  assert.throws(() => createFlow().go('live'), /home.*live/);
  assert.equal(createFlow().can('live'), false);
  assert.deepEqual([...TRANSITIONS.setup].sort(), ['delayed', 'home', 'live'], 'd29b: or delayed, by the replay mode');
});

test('d28: H\'s "Back to the session" is the one way home reaches live, and only while a session runs', async () => {
  const { createFlow } = await load();
  let running = false;
  const flow = createFlow('home', { sessionRunning: () => running });
  assert.equal(flow.can('live'), false);
  assert.throws(() => flow.go('live'), /home.*live/);
  running = true;
  assert.equal(flow.can('live'), true);
  flow.go('live');
  assert.equal(flow.state, 'live');
  const other = createFlow('lift', { sessionRunning: () => true });
  assert.equal(other.can('live'), false, 'the exception is for home only');
  assert.equal(createFlow('home', { sessionRunning: () => false }).can('live'), false);
});

test('an illegal transition throws, names both states and leaves the state alone', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  assert.throws(() => flow.go('mark'), (e) => e instanceof Error && /\bhome\b.*\bmark\b/.test(e.message));
  assert.throws(() => flow.go('replay'), /home/);
  assert.equal(flow.state, 'home');
  flow.go('lift');
  assert.throws(() => flow.go('queued'), /lift/);
  assert.throws(() => flow.go('result'), /lift/);
  assert.throws(() => flow.go('lift'), /lift/, 'a state does not lead to itself');
  assert.equal(flow.state, 'lift');
});

test('a state the flow doesn\'t know throws, from go() and as the start', async () => {
  const { createFlow } = await load();
  assert.throws(() => createFlow().go('nowhere'), /nowhere/);
  assert.throws(() => createFlow('nowhere'), /nowhere/);
});

test('can() says whether a transition is allowed, without making it', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  assert.equal(flow.can('lift'), true);
  assert.equal(flow.can('mark'), false);
  assert.equal(flow.can('nowhere'), false);
  assert.equal(flow.state, 'home');
});

test('listeners hear each change, with the old state, the new one and what it carries', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  const heard = [];
  flow.subscribe((change) => heard.push(change));
  flow.go('lift');
  flow.go('mark', { file: 'a.mp4' });
  assert.deepEqual(heard, [
    { from: 'home', to: 'lift', params: {} },
    { from: 'lift', to: 'mark', params: { file: 'a.mp4' } },
  ]);
});

test('an illegal transition is not heard; an unsubscribed listener hears nothing more', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  let count = 0;
  const off = flow.subscribe(() => { count++; });
  assert.throws(() => flow.go('mark'));
  assert.equal(count, 0);
  flow.go('lift');
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

test('every state is reachable from home (or the first run, d23) and can lead somewhere', async () => {
  const { STATES, TRANSITIONS } = await load();
  const reached = new Set(['home', 'welcome']);   // the app starts in one of the two
  const todo = ['home', 'welcome'];
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
  assert.equal(SCREEN_OF.lift, 'L1');
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

test('d53: the lift step replaces import; the legal moves round it, and home -> mark stays illegal', async () => {
  const { STATES, SCREEN_OF, TRANSITIONS, createFlow } = await load();
  assert.ok(!STATES.includes("import") && !("import" in SCREEN_OF) && !("import" in TRANSITIONS));
  for (const [from, to] of [['home', 'lift'], ['welcome', 'lift'], ['lift', 'mark'], ['lift', 'home'], ['mark', 'lift'], ['queued', 'lift']]) {
    assert.ok(TRANSITIONS[from].includes(to), `${from} -> ${to}`);
  }
  for (const s of STATES) assert.ok(!TRANSITIONS[s].includes("import"), `${s} -> import`);
  assert.equal(createFlow().can('mark'), false);
  assert.deepEqual([...TRANSITIONS.lift].sort(), ['home', 'mark']);
});

// ---- d29b: R3b, the delayed view ----

test('d29b: the state delayed is the screen R3b; setup, mark and queued lead to it, and it leads to mark, home and queued', async () => {
  const { SCREEN_OF, TRANSITIONS, createFlow } = await load();
  assert.equal(SCREEN_OF.delayed, 'R3b');
  assert.ok(fs.existsSync(path.join(APP, 'src', 'ui', 'screens', 'R3b.mjs')), 'screens/R3b.mjs');
  for (const [from, to] of [['setup', 'delayed'], ['delayed', 'mark'], ['delayed', 'home'], ['delayed', 'queued'], ['mark', 'delayed'], ['queued', 'delayed']]) {
    assert.ok(TRANSITIONS[from].includes(to), `${from} -> ${to}`);
    const f = createFlow(from); f.go(to); assert.equal(f.state, to);
  }
  assert.deepEqual([...TRANSITIONS.delayed].sort(), ['home', 'mark', 'queued']);
  assert.ok(!TRANSITIONS.delayed.includes('replay') && !TRANSITIONS.delayed.includes('live'), 'R3b has no replay and no R2');
  assert.ok(!TRANSITIONS.replay.includes('delayed'), 'R3 belongs to the replay mode');
  assert.throws(() => createFlow().go('delayed'), /home.*delayed/, 'a session starts on R1');
});

test('d29b: a delayed session in milestone B: H, setup, delayed, mark, back to delayed, queued, back to delayed, home', async () => {
  const { createFlow } = await load();
  const flow = createFlow();
  for (const to of ['setup', 'delayed', 'mark', 'delayed', 'queued', 'delayed', 'home']) flow.go(to);
  assert.equal(flow.state, 'home');
});

test('d29b: H\'s "Back to the session" reaches delayed too, and only while a session runs', async () => {
  const { createFlow } = await load();
  let running = false;
  const flow = createFlow('home', { sessionRunning: () => running });
  assert.equal(flow.can('delayed'), false);
  running = true;
  assert.equal(flow.can('delayed'), true);
  flow.go('delayed');
  assert.equal(flow.state, 'delayed');
  assert.equal(createFlow('lift', { sessionRunning: () => true }).can('delayed'), false, 'the exception is for home only');
});

test('d29b: a session\'s live state comes from its replay mode; the way back to a running session is that state, never live by name', async () => {
  const { SESSION_STATES, liveStateOf, sessionReturn } = await load();
  assert.deepEqual([...SESSION_STATES], ['live', 'delayed']);
  assert.equal(liveStateOf('replay'), 'live');
  assert.equal(liveStateOf('delayed'), 'delayed');
  assert.equal(liveStateOf(undefined), 'live', 'no mode: the replay, the default');
  const delayed = { active: true, liveState: 'delayed' };
  const live = { active: true, liveState: 'live' };
  assert.equal(sessionReturn('delayed', delayed), 'delayed');
  assert.equal(sessionReturn('live', delayed), 'delayed', 'the session\'s state wins over where the screen was opened from');
  assert.equal(sessionReturn('live', live), 'live');
  assert.equal(sessionReturn('delayed', { active: false, liveState: null }), 'home', 'no session runs: home');
  assert.equal(sessionReturn(null, delayed), 'home', 'not opened from a session: home');
  assert.equal(sessionReturn('result', delayed), 'home');
  assert.equal(sessionReturn('delayed'), 'delayed', 'without the session: where it was opened from');
});
