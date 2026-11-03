// Q1, Analysing (design/mockups/Analysing.dc.html): the progress by stage, the
// time left, the next lifts in the queue, cancel, back to H while it runs, and
// the way on to the result when it is done. Leaving doesn't stop the job: the
// queue is the app's one, injected (main.mjs gives it; tests pass a fake), and
// this screen only follows it and calls cancel and retry. What to show is
// analysing-model.mjs's: the view is rebuilt from the queue at every change.
import { useEffect, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { BackIcon, LiftIcon, LockIcon } from '../components/icons.mjs';
import { PickVideo } from '../components/PickVideo.mjs';
import { Problem } from '../components/problem.mjs';
import { analysingView, followAnalysis } from '../analysing-model.mjs';

const isVisible = () => !globalThis.document || globalThis.document.visibilityState !== 'hidden';

function Stage({ stage }) {
  return html`
    <li class=${`stage stage--${stage.status}`} data-stage=${stage.key} aria-current=${stage.status === 'now' ? 'step' : null}>
      <span class="stage__mark">${stage.status === 'done' ? '✓' : ''}</span>
      <span class="stage__label">${stage.label}</span>
      <span class="stage__detail">${stage.detail}</span>
    </li>`;
}

export function Q1({ flow, queue, store }) {
  const [pinned, setPinned] = useState(null);   // a screen opened without a lift keeps the one it first showed, so its end doesn't blank it
  const liftId = flow.params.liftId ?? pinned;
  const fromSession = flow.params.from === 'live';
  const [state, setState] = useState(null);   // { jobs, rate } once the queue has loaded: no state is shown before
  const [lift, setLift] = useState(null);
  const [visible, setVisible] = useState(isVisible);
  const [problem, setProblem] = useState(null);

  useEffect(() => followAnalysis(queue, setState), [queue]);
  useEffect(() => {
    const doc = globalThis.document;
    if (!doc || typeof doc.addEventListener !== 'function') return undefined;
    const follow = () => setVisible(isVisible());
    doc.addEventListener('visibilitychange', follow);
    return () => doc.removeEventListener('visibilitychange', follow);
  }, []);

  const view = state ? analysingView(state.jobs, { liftId, lift, rate: state.rate, visible }) : null;

  // The lift's record (when it was kept; whether it is analysed): read again when the job changes state.
  const id = view ? view.liftId : null;
  useEffect(() => { if (!flow.params.liftId && id) setPinned(id); }, [flow, id]);
  const kind = view ? view.kind : null;
  useEffect(() => {
    if (!id || !store) return undefined;
    let current = true;
    Promise.resolve(store.getLift(id)).then(l => { if (current) setLift(l || null); }, () => { if (current) setLift(null); });
    return () => { current = false; };
  }, [store, id, kind]);

  const act = async fn => {
    setProblem(null);
    try { await fn(); } catch (e) { setProblem(e && e.message ? e.message : 'That didn’t work.'); }
  };
  const back = fromSession ? { to: 'live', label: 'Back to the session' } : { to: 'home', label: 'Home' };

  return html`
    <main class="screen" data-screen="Q1" data-kind=${kind}>
      <header class="bar-header">
        <button type="button" class="icon-button" aria-label="Back to home" onClick=${() => flow.go('home')}><${BackIcon} /></button>
        <h1 class="bar-header__title">${view ? view.heading : 'Analysing'}</h1>
      </header>
      ${view ? html`
      <div class="q1">
        ${view.lift ? html`
          <div class="q1-lift">
            <span class="q1-lift__thumb"><${LiftIcon} lift=${view.lift.lift} /></span>
            <span class="q1-lift__text">
              <span class="q1-lift__title">${view.lift.title}</span>
              <span class="quiet">${view.lift.meta}</span>
            </span>
          </div>` : html`<p class="soft">Nothing to analyse.</p>`}
        ${view.kind !== 'idle' ? html`
          <div class="q1-progress" role="progressbar" aria-label="Analysis progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${view.percent}>
            <div class="q1-progress__top">
              <span class="q1-progress__pct">${view.pctLabel}</span>
              <span class="q1-progress__left">${view.left}</span>
            </div>
            <span class="bar bar--big"><span class="bar__fill" style=${`width: ${view.percent}%`}></span></span>
            <ol class="stages">${view.stages.map(s => html`<${Stage} key=${s.key} stage=${s} />`)}</ol>
          </div>` : null}
        ${view.problem ? html`<${Problem} problem=${view.problem} />` : null}
        ${problem ? html`<p class="error" role="alert">${problem}</p>` : null}
        ${view.actions.cancel ? html`<p class="q1-note"><${LockIcon} /><span>Keeps going if you leave.</span></p>` : null}
        ${view.queue ? html`
          <div class="q1-queue">
            <span class="q1-queue__label">${view.queue.label}</span>
            <span class="q1-queue__item">${view.queue.items[0].text}${view.queue.more > 0 ? html`<br /><span class="quiet">+${view.queue.more} more</span>` : null}</span>
          </div>` : null}
        <div class="q1-actions">
          ${view.actions.open ? html`<button type="button" class="button--primary button-big" onClick=${() => flow.go(view.actions.open.to, view.actions.open.params)}>Open the result</button>` : null}
          ${view.actions.retry ? html`<button type="button" class="button--primary button-big" disabled=${!view.jobId && !lift} onClick=${() => act(() => (view.jobId ? queue.retry(view.jobId) : queue.enqueue(lift)))}>Analyse again</button>` : null}
          ${view.actions.another ? html`<${PickVideo} flow=${flow} class="button--primary button-big">Pick another video</${PickVideo}>` : null}
          <button type="button" class=${`button-wide ${view.kind === 'done' || view.actions.retry ? 'button--raised' : 'button--light'}`} onClick=${() => flow.go(back.to)}>${back.label}</button>
          ${view.actions.cancel ? html`<button type="button" class="button--quiet" onClick=${() => act(() => queue.cancel(view.jobId))}>Cancel</button>` : null}
        </div>
      </div>` : null}
    </main>
  `;
}
