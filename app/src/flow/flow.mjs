// The flow: one small state machine owns which screen shows, so screens never
// call each other (docs/ui-design.md, "Keeping the UI maintainable"). A plain
// module with no UI library and no DOM: it runs in Node, in the tests, as
// written.
//
// A state is a screen of the app. A screen asks the flow to go somewhere
// (`flow.go('mark', { file })`); the shell listens (`flow.subscribe`) and
// draws the screen the state names (SCREEN_OF). What a step carries (the
// picked file, the lift's id) is `flow.params`, replaced by each step.

export const STATES = ['welcome', 'home', 'lift', 'mark', 'queued', 'result', 'detail', 'settings', 'scoring', 'setup', 'live', 'replay'];

// The screen ID (docs/ui-design.md, "The screens") each state shows. "lift" is L1,
// "Which lift?": the picker is the phone's own, opened from a button on H (d53). "setup" is R1,
// "Set up the camera", and "live" is R2 (d28).
export const SCREEN_OF = {
  welcome: 'Welcome',
  home: 'H',
  lift: 'L1',
  mark: 'M',
  queued: 'Q1',
  result: 'A1',
  detail: 'A2',
  settings: 'S1',
  scoring: 'S1b',
  setup: 'R1',
  live: 'R2',
  replay: 'R3',
};

// Where each state may go. Milestone A: H, the picker, lift (L1), mark, queued, result, and
// back to H; open a lift from H (still analysing: queued; done: result);
// leave Q1 without stopping the analysis (home); pick another video after "No person found" (d51: queued → lift)
// or when M can't open the video (mark → lift); re-mark from the result (A3). Every newly picked video passes L1 (d53).
// S1's "How the cues are scored" (d18): settings → scoring and back.
// The first run (d23): the app starts in `welcome` once, which leads to home or the lift step; nothing leads back to it.
// Milestone B: H, setup (R1), live (R2), replay (R3), mark, then back to live with the
// lift queued; a session ends at home. A session starts on R1: home does not lead to live, except
// for H's "Back to the session" while one runs (createFlow's `sessionRunning`, d28).
export const TRANSITIONS = {
  welcome: ['home', 'lift'],
  home: ['lift', 'settings', 'queued', 'result', 'setup'],
  lift: ['mark', 'home'],
  mark: ['queued', 'home', 'lift', 'live'],
  queued: ['result', 'home', 'live', 'lift'],
  result: ['home', 'mark', 'detail'],
  detail: ['result', 'home'],
  settings: ['home', 'scoring'],
  scoring: ['settings'],
  setup: ['live', 'home'],
  live: ['replay', 'home', 'queued'],
  replay: ['live', 'mark'],
};

/**
 * @param {string} [initial]
 * @param {{sessionRunning?: () => boolean}} [options] `sessionRunning`: whether a gym session runs (the app's
 *   session, main.mjs gives it). While one does, home may go to `live` (H's "Back to the session").
 */
export function createFlow(initial = 'home', { sessionRunning = () => false } = {}) {
  if (!STATES.includes(initial)) throw new Error(`unknown state '${initial}'`);
  let state = initial;
  let params = {};
  const listeners = new Set();

  const can = (to) => STATES.includes(to) && (TRANSITIONS[state].includes(to) || (state === 'home' && to === 'live' && sessionRunning() === true));

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
