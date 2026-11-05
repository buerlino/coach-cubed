// SPDX-License-Identifier: AGPL-3.0-or-later
// The page's side of the service worker (package c19): registers app/sw.js in
// a browser, and lets a new version take over only when the analysis queue is
// idle. A plain module, no DOM of its own: the navigator and window are
// injected, so tests run it on fakes.
//
//   const updates = createUpdates({ queue });
//   updates.subscribe(state => …);   // now, and at each change
//   await updates.register();        // main.mjs, after the first screen is drawn
//
// States: 'off' (no service worker here: the APK, or a browser without one),
// 'current' (registered, nothing newer), 'waiting' (a newer version is
// installed and waits for the queue to be idle), 'ready' (it has taken over;
// H says so in a plain line, and the page reloads when the user next opens
// the app: a page already running keeps the modules it loaded).
//
// Not in the APK (c20's choice, app/README.md, "The Android shell"): there the
// files come from the APK, the app is offline already, and a worker would keep
// a second copy of the 12.6 MB weights. Capacitor puts window.Capacitor into
// the page, so a web page it hosts says isNativePlatform() true.

export function createUpdates({
  queue, navigator = globalThis.navigator, window = globalThis, url = './sw.js',
} = {}) {
  let state = 'off';
  const listeners = new Set();
  const set = next => {
    if (next === state) return;
    state = next;
    for (const fn of [...listeners]) { try { fn(state); } catch { /* a listener's own error */ } }
  };

  // The queue has no job running or waiting; a job that starts between the answer and the
  // message is the queue's to run on whichever version is then active.
  async function untilIdle() {
    if (!queue || typeof queue.idle !== 'function') return;
    do await queue.idle(); while (queue.busy());   // idle() loads the kept queue first
  }

  async function takeOver(worker) {
    set('waiting');
    try { await untilIdle(); } catch { /* a queue that fails to load: take over anyway */ }
    worker.postMessage({ type: 'skip-waiting' });
  }

  async function register() {
    const sw = navigator && navigator.serviceWorker;
    if (!sw || typeof sw.register !== 'function') return state;
    if (window && window.Capacitor?.isNativePlatform?.()) return state;
    let reg;
    try { reg = await sw.register(url, { scope: './' }); } catch { return state; }
    set('current');

    // An update is a new worker while another controls the page. The first install is not one.
    let controlled = !!sw.controller;
    const consider = worker => { if (worker && controlled) takeOver(worker); };
    consider(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => { if (worker.state === 'installed') consider(worker); });
    });
    sw.addEventListener('controllerchange', () => {
      if (controlled) set('ready');
      controlled = true;   // the first worker claiming a page that had none
    });

    // The browser looks for a new sw.js when the app is opened and about once a day; also when it comes back to the front.
    const doc = window && window.document;
    if (doc && typeof doc.addEventListener === 'function' && typeof reg.update === 'function') {
      doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'visible') Promise.resolve(reg.update()).catch(() => { /* offline: nothing to look for */ });
      });
    }
    return state;
  }

  return {
    register,
    state: () => state,
    /** fn(state) now and at every change; returns the unsubscribe. */
    subscribe(fn) {
      listeners.add(fn);
      try { fn(state); } catch { /* the listener's own error */ }
      return () => listeners.delete(fn);
    },
  };
}
