// H, home (design/mockups/Main.dc.html): start a gym session (disabled until
// milestone B), import a video, today's lifts with their state, earlier
// sessions, and the privacy line. H changes the flow's state only; the queue
// and the store are injected (main.mjs gives the app's), so tests pass fakes.
import { useEffect, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { CameraIcon, ChevronIcon, ImportIcon, LockIcon, SettingsIcon } from '../components/icons.mjs';
import { LiftRow } from '../components/lift-row.mjs';
import { followQueue, homeView } from '../home-model.mjs';

// The store is read again when a job starts, ends or changes state, not at every frame.
const signature = jobs => jobs.map(j => `${j.id}:${j.state}`).join(',');

export function H({ flow, queue, store, updates }) {
  const [jobs, setJobs] = useState(null);   // null until the queue has loaded: no state is shown before
  const [shown, setShown] = useState(null);   // { grouped, results } once the store has answered
  const [problem, setProblem] = useState(null);

  useEffect(() => followQueue(queue, setJobs), [queue]);
  const [update, setUpdate] = useState('current');   // the service worker's state; only 'ready' shows
  useEffect(() => (updates ? updates.subscribe(setUpdate) : undefined), [updates]);

  const sig = jobs ? signature(jobs) : null;
  useEffect(() => {
    if (sig === null) return undefined;
    let current = true;
    (async () => {
      const grouped = await store.listByDay();
      const results = {};
      for (const l of [...grouped.today, ...grouped.earlier]) {
        if (l.result) results[l.id] = await store.readResult(l.id).catch(() => null);
      }
      if (current) { setShown({ grouped, results }); setProblem(null); }
    })().catch(e => { if (current) setProblem(e && e.message ? e.message : 'The lifts could not be read.'); });
    return () => { current = false; };
  }, [store, sig]);

  const view = shown && jobs ? homeView(shown.grouped, jobs, shown.results) : null;

  return html`
    <main class="screen" data-screen="H">
      <header class="screen__header">
        <h1 class="wordmark">coach</h1>
        <button type="button" aria-label="Settings and about" onClick=${() => flow.go('settings')}><${SettingsIcon} /></button>
      </header>
      <div class="screen__body">
        <button type="button" class="card card--row card--primary card--disabled" disabled aria-disabled="true">
          <span class="card__icon"><${CameraIcon} /></span>
          <span class="card__text">
            <span class="card__title card__title--big">Start gym session</span>
            <span>Film non-stop, replay each lift, keep the good ones.</span>
            <span class="tag">Coming in a later version</span>
          </span>
        </button>
        <button type="button" class="card card--row" onClick=${() => flow.go('import')}>
          <span class="card__icon"><${ImportIcon} /></span>
          <span class="card__text">
            <span class="card__title">Import a video</span>
            <span class="soft">Pick a clip from this phone and mark the lift.</span>
          </span>
        </button>
      </div>
      ${update === 'ready' ? html`<p class="update" role="status">Update ready. Reload the app to use the new version.</p>` : null}
      ${problem ? html`<p class="error screen__body" role="alert">${problem}</p>` : null}
      ${view && view.empty ? html`
        <div class="empty">
          <p class="title">No lifts yet</p>
          <p class="soft">Import a video to mark a lift and get its feedback. Your lifts will be listed here.</p>
        </div>` : null}
      ${view && view.today ? html`
        <section class="section" aria-labelledby="today-h">
          <div class="section__head">
            <h2 class="section__title" id="today-h">Today's session</h2>
            <span class="quiet">${view.today.count}</span>
          </div>
          ${view.today.rows.map(row => html`<${LiftRow} key=${row.id} row=${row} flow=${flow} />`)}
        </section>` : null}
      ${view && view.earlier.length ? html`
        <section class="section section--earlier" aria-labelledby="earlier-h">
          <h2 class="section__title" id="earlier-h">Earlier</h2>
          ${view.earlier.map(day => html`
            <details class="session" key=${day.day}>
              <summary>
                <span class="session__title"><span class="session__name">${day.heading}</span><span class="quiet">${day.lifts}</span></span>
                <${ChevronIcon} />
              </summary>
              <div class="session__lifts">${day.rows.map(row => html`<${LiftRow} key=${row.id} row=${row} flow=${flow} />`)}</div>
            </details>`)}
        </section>` : null}
      <p class="screen__footer"><${LockIcon} /><span>Everything stays on this phone. No account, no uploads.</span></p>
    </main>
  `;
}
