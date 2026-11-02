// The flow: one small state machine owns which screen shows, so screens never
// call each other (docs/ui-design.md, "Keeping the UI maintainable"). A plain
// module with no UI library and no DOM: it runs in Node, in the tests, as
// written.
//
// A state is a screen of the app. A screen asks the flow to go somewhere
// (`flow.go('mark', { file })`); the shell listens (`flow.subscribe`) and
// draws the screen the state names (SCREEN_OF). What a step carries (the
// picked file, the lift's id) is `flow.params`, replaced by each step.

export const STATES = ['home', 'import', 'mark', 'queued', 'result', 'detail', 'settings', 'scoring', 'live', 'replay'];

// The screen ID (docs/ui-design.md, "The screens") each state shows. "import"
// is H's picker, which v1's mockups don't draw as a screen of its own.
export const SCREEN_OF = {
  home: 'H',
  import: 'Import',
  mark: 'M',
  queued: 'Q1',
  result: 'A1',
  detail: 'A2',
  settings: 'S1',
  scoring: 'S1b',
  live: 'R2',
  replay: 'R3',
};

// Where each state may go. Milestone A: H, import, mark, queued, result, and
// back to H; open a lift from H (still analysing: queued; done: result);
// leave Q1 without stopping the analysis (home); re-mark from the result (A3).
// S1's "How the cues are scored" (d18): settings → scoring and back.
// Milestone B: H, live (R2), replay (R3), mark, then back to live with the
// lift queued; a session ends at home.
export const TRANSITIONS = {
  home: ['import', 'settings', 'queued', 'result', 'live'],
  import: ['mark', 'home'],
  mark: ['queued', 'home', 'import', 'live'],
  queued: ['result', 'home', 'live'],
  result: ['home', 'mark', 'detail'],
  detail: ['result', 'home'],
  settings: ['home', 'scoring'],
  scoring: ['settings'],
  live: ['replay', 'home', 'queued'],
  replay: ['live', 'mark'],
};

export function createFlow(initial = 'home') {
  if (!STATES.includes(initial)) throw new Error(`unknown state '${initial}'`);
  let state = initial;
  let params = {};
  const listeners = new Set();

  const can = (to) => STATES.includes(to) && TRANSITIONS[state].includes(to);

  function go(to, next = {}) {
    if (!STATES.includes(to)) throw new Error(`unknown state '${to}'`);
    if (!can(to)) throw new Error(`illegal transition ${state} -> ${to} (from ${state}: ${TRANSITIONS[state].join(', ')})`);
    const from = state;
    state = to;
    params = { ...next };
    const change = { from, to, params };
    for (const fn of [...listeners]) fn(change);
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }

  return {
    get state() { return state; },
    get params() { return params; },
    can,
    go,
    subscribe,
  };
}
