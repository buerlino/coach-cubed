// The first run (package d23): one screen, shown once, before home. What it says is data here; the flow's
// `welcome` state draws it (screens/Welcome.mjs). That it was shown is `introSeen` in the store's settings. Plain
// module, no Preact, no DOM. The words are the app's own and add no claim: what the app does is H's import card
// and the goal (docs/rules-core.md), "everything stays on this phone" is H's footer, the privacy text in S1.

export const WELCOME = Object.freeze({
  title: 'Feedback on your lift, cue by cue',
  points: Object.freeze([
    'Pick a video of a lift from this phone and mark where the lift starts and ends.',
    'The app finds the lifter in the video and scores each technique cue.',
    'Everything stays on this phone. No account, no uploads.',
  ]),
  importLabel: 'Import a video',
  skipLabel: 'Go to home',
});

/**
 * The state the app starts in: `welcome` until the intro has been left once, else `home`. A store that
 * can't be read never holds the app up: it starts at home.
 * @param {{getSettings: () => Promise<{introSeen?: boolean}>}} store
 * @returns {Promise<'welcome'|'home'>}
 */
export async function startState(store) {
  try {
    const s = await store.getSettings();
    return s && s.introSeen === true ? 'home' : 'welcome';
  } catch {
    return 'home';
  }
}

/**
 * Leaves the intro for `to` (`home`, or `lift` with the picked file as `{ file }`) and keeps that it was shown.
 * The app goes on even when the choice can't be saved (the intro then shows again next time).
 * @param {{saveSettings: (patch: object) => Promise<unknown>}} store
 * @param {{go: (to: string, params?: object) => void}} flow
 * @param {'home'|'lift'} to
 * @param {{file?: File}} [params] what the step carries
 */
export async function finishWelcome(store, flow, to, params) {
  try { await store.saveSettings({ introSeen: true }); } catch { /* shown again next time */ }
  flow.go(to, params);
}
