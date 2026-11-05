// SPDX-License-Identifier: AGPL-3.0-or-later
// S1, Settings and about (design/mockups/Settings.dc.html): the default lift (its own group, "Lifts": L1 rings
// it), the gym session behind a preview switch that is off in 0.1.0 (d66) and, with it on, the replay mode and
// lengths, camera and quality (d28, d29b: all enabled but the quality, one
// value), storage, and about: the version, the privacy
// text, the credits and licences. "Keep the video of each analysed lift" is
// not drawn in 0.1.0 (nordmu, 2026-11-02): contract 3 needs every lift's cut,
// so videos are always kept; `keepVideos` stays in the store. The logic is in
// settings-model.mjs; this draws it. The store and the queue are injected.
import { useEffect, useState } from 'preact/hooks';
import { html } from '../html.mjs';
import { BackIcon, ChevronIcon } from '../components/icons.mjs';
import { followQueue } from '../home-model.mjs';
import { APP_VERSION } from '../../store/index.mjs';
import { CREDITS, creditUrl, thirdPartyUrl } from '../../credits.mjs';
import { PRIVACY, deleteAllLifts, loadStorage, queueBusy, recordingView, storageView } from '../settings-model.mjs';

const messageOf = e => (e && e.message ? e.message : 'That didn’t work.');

/** A licence text, read from the app's own files when its details open: works offline. */
function LicenceText({ url }) {
  const [text, setText] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    fetch(url).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
      .then(t => { if (current) setText(t); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [url]);
  if (failed) return html`<p class="quiet" role="status">Couldn’t load this licence.</p>`;
  if (text === null) return html`<p class="quiet" role="status">Loading…</p>`;
  return html`<pre class="licence">${text}</pre>`;
}

function Disclosure({ title, meta, children }) {
  const [open, setOpen] = useState(false);
  return html`
    <details class="credit" onToggle=${e => setOpen(e.currentTarget.open)}>
      <summary>
        <span class="credit__title"><span class="credit__name">${title}</span><span class="quiet">${meta}</span></span>
        <${ChevronIcon} />
      </summary>
      ${open ? children : null}
    </details>`;
}

function Credits({ onBack }) {
  return html`
    <main class="screen" data-screen="S1" data-view="credits">
      <header class="bar-header">
        <button type="button" class="icon-button" aria-label="Back to settings" onClick=${onBack}><${BackIcon} /></button>
        <h1 class="bar-header__title">Credits and licences</h1>
      </header>
      <div class="settings">
        <p class="soft">coach is built with these. Their licences are in the app, readable offline.</p>
        <div class="group">
          ${CREDITS.map(c => html`
            <${Disclosure} key=${c.row} title=${c.name} meta=${`${c.version} · ${c.licence}${c.shipped ? '' : ' · build only'}`}>
              <div class="credit__body">
                <p class="soft">${c.notice}</p>
                <${LicenceText} url=${creditUrl(c)} />
              </div>
            <//>`)}
          <${Disclosure} title="The full list" meta="THIRD_PARTY.md, the new app">
            <div class="credit__body"><${LicenceText} url=${thirdPartyUrl()} /></div>
          <//>
        </div>
      </div>
    </main>`;
}

function Choice({ row, onPick }) {
  return html`
    <label class=${`row${row.disabled ? ' row--disabled' : ''}`}>
      <span class="row__label">${row.label}</span>
      <span class="row__value">
        <select value=${row.value} disabled=${row.disabled} onChange=${e => onPick(row.field, e.currentTarget.value)}>
          ${row.options.map(o => html`<option key=${o.value} value=${o.value} selected=${o.value === row.value}>${o.label}</option>`)}
        </select>
        <${ChevronIcon} />
      </span>
    </label>`;
}

export function S1({ flow, store, queue, session }) {
  const [settings, setSettings] = useState(null);
  const [storage, setStorage] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [view, setView] = useState('main');
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState(null);

  const refreshStorage = () => loadStorage(store).then(setStorage);
  useEffect(() => {
    let current = true;
    store.getSettings().then(s => { if (current) setSettings(s); }, e => { if (current) setProblem(messageOf(e)); });
    refreshStorage();
    return () => { current = false; };
  }, [store]);
  useEffect(() => (queue ? followQueue(queue, setJobs) : undefined), [queue]);

  const pick = async (field, raw) => {
    const value = ['defaultLift', 'camera', 'quality', 'replayMode'].includes(field) ? raw : Number(raw);
    try { setSettings(await store.saveSettings({ [field]: value })); setProblem(null); } catch (e) { setProblem(messageOf(e)); }
  };
  // d66: the preview switch is saved, and the app's session (read synchronously by H and the flow) follows the saved value
  const toggleGym = async () => {
    try {
      const saved = await store.saveSettings({ gymSession: !(settings && settings.gymSession === true) });
      setSettings(saved);
      if (session) session.setEnabled(saved.gymSession === true);
      setProblem(null);
    } catch (e) { setProblem(messageOf(e)); }
  };
  const deleteAll = async () => {
    try { await deleteAllLifts(store); setProblem(null); } catch (e) { setProblem(messageOf(e)); }
    setAsking(false);
    refreshStorage();
  };

  if (view === 'credits') return html`<${Credits} onBack=${() => setView('main')} />`;

  const rec = settings ? recordingView(settings) : null;
  const stor = storage ? storageView(storage) : null;
  const busy = queueBusy(jobs);

  return html`
    <main class="screen" data-screen="S1" data-view="main">
      <header class="bar-header">
        <button type="button" class="icon-button" aria-label="Back to home" onClick=${() => flow.go('home')}><${BackIcon} /></button>
        <h1 class="bar-header__title">Settings and about</h1>
      </header>
      <div class="settings">
        ${problem ? html`<p class="error" role="alert">${problem}</p>` : null}
        <section class="settings__section" aria-labelledby="lifts-h">
          <h2 class="section__title" id="lifts-h">Lifts</h2>
          ${rec ? html`<div class="group">${rec.liftRows.map(r => html`<${Choice} key=${r.field} row=${r} onPick=${pick} />`)}</div>` : null}
        </section>
        <section class="settings__section" aria-label="Gym session">
          ${rec ? html`
            <button type="button" class="vo-switch" role="switch" data-setting="gymSession" aria-checked=${rec.gym.on} onClick=${toggleGym}>
              <span class="vo-switch__text">
                <span class="vo-switch__name">${rec.gym.label}</span>
                <span class="vo-switch__sub">${rec.gym.note}</span>
              </span>
              <span class="vo-switch__track" aria-hidden="true"><span class="vo-switch__knob"></span></span>
            </button>
            ${rec.gym.on ? html`
              <div class="segmented" role="group" aria-label="How the replay shows up">
                ${rec.modes.map(m => html`<button type="button" key=${m.id} aria-pressed=${m.on} disabled=${rec.modesDisabled} class=${m.on ? 'segmented__on' : ''} onClick=${() => pick('replayMode', m.id)}>${m.label}</button>`)}
              </div>
              <div class="group">${rec.rows.map(r => html`<${Choice} key=${r.field} row=${r} onPick=${pick} />`)}</div>
              <p class="quiet">${rec.note}</p>` : null}` : null}
        </section>
        <section class="settings__section" aria-labelledby="st-h">
          <h2 class="section__title" id="st-h">Storage</h2>
          ${stor ? html`
            <div class="group">
              <div class="row"><span>On this phone</span><span class="row__value">${stor.lifts}</span></div>
              <div class="row"><span>Used by the app</span><span class="row__value">${stor.used}</span></div>
              <div class="row"><span>Free for the app</span><span class="row__value">${stor.free}</span></div>
              <div class="row"><span>Kept when space is low</span><span class="row__value">${stor.persisted}</span></div>
              ${asking ? html`
                <div class="row row--stack" role="group" aria-label="Delete all lifts">
                  <p>Delete ${stor.count === 1 ? 'the lift' : `all ${stor.count} lifts`} and ${stor.count === 1 ? 'its' : 'their'} videos? This can't be undone.</p>
                  <div class="row__actions">
                    <button type="button" class="button--quiet" onClick=${deleteAll}>Delete</button>
                    <button type="button" onClick=${() => setAsking(false)}>Cancel</button>
                  </div>
                </div>` : html`
                <button type="button" class="row row--action row--danger" disabled=${!stor.canDelete || busy} onClick=${() => setAsking(true)}>Delete all lifts…</button>`}
            </div>
            ${stor.persistedNote ? html`<p class="quiet">${stor.persistedNote}</p>` : null}
            ${busy ? html`<p class="quiet">Can’t delete while lifts are being analysed.</p>` : null}` : null}
        </section>
        <section class="settings__section" aria-labelledby="ab-h">
          <h2 class="section__title" id="ab-h">About</h2>
          <div class="about">
            <div class="about__head"><span class="about__name">coach³</span><span class="soft">${APP_VERSION}</span></div>
            <p><strong>${PRIVACY.lead}</strong> ${PRIVACY.body}</p>
          </div>
          <div class="group">
            <button type="button" class="row row--action" onClick=${() => setView('credits')}>
              <span>Credits and licences</span><${ChevronIcon} />
            </button>
            <button type="button" class="row row--action" onClick=${() => flow.go('scoring')}>
              <span>How the cues are scored</span><${ChevronIcon} />
            </button>
            <div class="row"><span>Source code</span><span class="row__value">AGPL-3.0-or-later</span></div>
          </div>
        </section>
      </div>
    </main>`;
}
