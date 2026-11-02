// H's logic as plain functions (package d13): what to show from the store's
// lifts and the queue's jobs, and what the pick step hands the flow. No
// Preact and no DOM, so Node runs it as written (tests/app/home.test.js); the
// screens (screens/H.mjs, components/PickVideo.mjs) only draw what these give.
import { isAnalysed } from '../contracts/stored-lift.mjs';
import { isProvisionalLift, liftEntries, liftLabel } from '../contracts/lifts.mjs';

/**
 * The lifts L1 offers, in the registry's order (contracts/lifts.mjs): each one's id, label and
 * whether it is provisional as a whole (the snatch, while step 3.6 is open). A function, so a lift registered
 * after this module loaded is offered too.
 * @returns {Array<{id: string, label: string, provisional: boolean}>}
 */
export const liftChoices = () => liftEntries().map(({ id, label, provisional }) => ({ id, label, provisional }));

/** A lift's label (the registry's); an unknown id as it is. */
export { liftLabel };

/** Whether a lift's thresholds are still provisional as a whole (the snatch, while step 3.6 is open; d23). */
export const isProvisional = isProvisionalLift;

/**
 * The stages a running job passes through, and the share of the bar each one
 * has: the mockup's bands (reading to 10 %, the pose to 95 %, scoring to 100 %).
 * H and Q1 both read a job's percent through these (percentOf).
 */
export const STAGES = Object.freeze([
  Object.freeze({ key: 'reading', label: 'Read the video', from: 0, to: 10 }),
  Object.freeze({ key: 'pose', label: 'Find the pose', from: 10, to: 95 }),
  Object.freeze({ key: 'scoring', label: 'Score the cues', from: 95, to: 100 }),
]);

/**
 * A job's percent, the one rule H and Q1 share (d41): a done job is 100; a job
 * with no progress is 0; otherwise the share of its stage's band, floored, and
 * never 100 while the job runs.
 * @param {import('../contracts/analysis-job.mjs').AnalysisJob} job
 */
export function percentOf(job) {
  if (job.state === 'done') return 100;
  const p = job.progress;
  if (!p) return 0;
  const band = STAGES.find(s => s.key === p.stage);
  if (!band) return 0;
  const frac = p.total > 0 ? Math.min(1, p.done / p.total) : 0;
  return Math.min(99, Math.floor(band.from + (band.to - band.from) * frac));
}

/**
 * S1's default lift, which L1 rings: the settings' default lift, or the first choice
 * while the settings load (`null`) or when the setting names a lift the registry lacks.
 * @param {{defaultLift?: string}|null|undefined} settings
 */
export function startLift(settings) {
  const id = settings && settings.defaultLift;
  const choices = liftChoices();
  return (choices.find(c => c.id === id) ?? choices[0]).id;
}

const ACTIVE = ['reading', 'pose', 'scoring'];
const ENDED = ['done', 'failed', 'cancelled'];

/**
 * A lift's state for H, from the store's record and the queue's jobs:
 * `ready` (the record is analysed), `waiting` (job queued; `ahead` is the
 * number of unfinished jobs before it), `analysing` (reading, pose or scoring;
 * `percent`, `stage`), `failed` (`error`, the job's words), `stopped` (the lift
 * is stored and unanalysed: its job was cancelled, or it has none).
 * Progress is Q1's (percentOf: reading 0-10 %, pose 10-95 %, scoring 95-100 %);
 * 100 % is the lift becoming ready. A done job whose lift the store hasn't
 * shown as analysed yet is still analysing (scoring), never ready.
 * @param {import('../contracts/stored-lift.mjs').StoredLift} lift
 * @param {import('../contracts/analysis-job.mjs').AnalysisJob[]} jobs queue order
 */
export function liftState(lift, jobs) {
  if (isAnalysed(lift)) return { kind: 'ready' };
  const at = jobs.findIndex(j => j.liftId === lift.id);
  const job = at < 0 ? null : jobs[at];
  if (!job) return { kind: 'stopped' };
  if (job.state === 'queued') return { kind: 'waiting', ahead: jobs.slice(0, at).filter(j => !ENDED.includes(j.state)).length };
  if (job.state === 'failed') return { kind: 'failed', error: job.error };
  if (job.state === 'cancelled') return { kind: 'stopped' };
  if (job.state === 'done') return { kind: 'analysing', stage: 'scoring', percent: 99 };
  return { kind: 'analysing', stage: ACTIVE.includes(job.state) ? job.state : 'reading', percent: percentOf(job) };
}

/**
 * The words for a waiting lift: the mockup's "starts after the one above" when
 * one job is ahead, the plural for more, nothing more when none is.
 * @param {number} ahead
 */
export const waitingText = ahead => (ahead === 1 ? 'Waiting · starts after the one above'
  : ahead > 1 ? 'Waiting · starts after the ones ahead' : 'Waiting');

// Mockup order: the worst first.
const SUMMARY = [['work on', 'work-on'], ['watch', 'watch'], ['good', 'good'], ["can't score", 'cant-score']];

/**
 * A result's cues counted by status word: [{status, count, text}], worst
 * first, a status with no cue left out. `status` is the CSS modifier of
 * base.css's `.status--…`.
 * @param {{cues: Array<{status: string}>}|null} result
 */
export function summariseResult(result) {
  const cues = result && Array.isArray(result.cues) ? result.cues : [];
  return SUMMARY
    .map(([word, status]) => ({ status, count: cues.filter(c => c.status === word).length, word }))
    .filter(s => s.count > 0)
    .map(({ status, count, word }) => ({ status, count, text: `${count} ${word}` }));
}

const pad = n => String(n).padStart(2, '0');
export const clock = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayKey = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
export const dayName = d => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
const lifts = n => `${n} ${n === 1 ? 'lift' : 'lifts'}`;

/**
 * One lift's row: its title, "14:32 · 13.0 s" (local clock, marked length),
 * its state, the result's counts when ready, and the flow step opening it: a
 * ready lift its result (A1), every other the queue screen (Q1), where a failed
 * or stopped job can be retried.
 * @param {import('../contracts/stored-lift.mjs').StoredLift} lift
 * @param {import('../contracts/analysis-job.mjs').AnalysisJob[]} jobs
 * @param {{result?: object|null}} [extra] the lift's result.json, for the counts
 */
export function rowOf(lift, jobs, { result = null } = {}) {
  const state = liftState(lift, jobs);
  return {
    id: lift.id,
    lift: lift.lift,
    title: liftLabel(lift.lift),
    meta: `${clock(new Date(lift.created))} · ${(lift.range.t1 - lift.range.t0).toFixed(1)} s`,
    state,
    summary: state.kind === 'ready' ? summariseResult(result) : [],
    open: { to: state.kind === 'ready' ? 'result' : 'queued', params: { liftId: lift.id } },
  };
}

/**
 * The whole of H below the actions.
 * @param {{today: object[], earlier: object[]}} grouped the store's `listByDay()`
 * @param {object[]} jobs the queue's jobs
 * @param {Object<string, object>} [results] result.json by lift id
 * @returns {{empty: boolean, today: {count: string, rows: object[]}|null, earlier: Array<{day: string, heading: string, lifts: string, rows: object[]}>}}
 */
export function homeView(grouped, jobs, results = {}) {
  const row = l => rowOf(l, jobs, { result: results[l.id] ?? null });
  const days = [];
  for (const l of grouped.earlier) {
    const d = new Date(l.created);
    let day = days.find(x => x.day === dayKey(d));
    if (!day) days.push(day = { day: dayKey(d), name: dayName(d), kinds: [], rows: [] });
    if (!day.kinds.includes(l.lift)) day.kinds.push(l.lift);
    day.rows.push(row(l));
  }
  return {
    empty: grouped.today.length === 0 && grouped.earlier.length === 0,
    today: grouped.today.length ? { count: `${lifts(grouped.today.length)} kept`, rows: grouped.today.map(row) } : null,
    earlier: days.map(d => ({
      day: d.day,
      heading: `${d.name} · ${lifts(d.rows.length)}`,
      lifts: d.kinds.map((k, i) => (i === 0 ? liftLabel(k) : liftLabel(k).toLowerCase())).join(', '),
      rows: d.rows,
    })),
  };
}

/** What the phone's picker answers when the file isn't a video. */
export const NOT_A_VIDEO = 'That’s not a video.';

/**
 * Whether a picked file may go on: no file (the picker cancelled) is refused without words; a file whose
 * type is set and isn't video/* is refused with them (a missing type is let through: some Android pickers
 * give none).
 * @returns {{ok: true}|{ok: false, error: string|null}}
 */
export function pickCheck(file) {
  if (!file) return { ok: false, error: null };
  if (file.type && !file.type.startsWith('video/')) return { ok: false, error: NOT_A_VIDEO };
  return { ok: true };
}

/**
 * The pick step: a picked video goes into the flow as `{ file }`, on the way to L1 (the lift step). Nothing
 * changes for a cancelled picker (no words) or a file that is not a video (`error` says so).
 * @returns {{ok: true}|{ok: false, error: string|null}}
 */
export function pickStep(flow, file) {
  const check = pickCheck(file);
  if (check.ok) flow.go('lift', { file });
  return check;
}

/**
 * H's follow of the queue: fn(jobs) at every change, but not before the queue
 * has read its kept file. `subscribe` calls the listener at once with `[]`, and
 * after a restart that is not the queue yet: a queued or failed lift would show
 * as stopped until `load()` emits. So nothing is passed on until `load()` has
 * answered (a failed load, say no store, passes on what the queue has). A queue
 * with no `load` is followed from its first call. Returns the unsubscribe.
 * @param {{subscribe: Function, load?: Function}} queue
 * @param {(jobs: object[]) => void} fn
 */
export function followQueue(queue, fn) {
  let live = true;
  let ready = typeof queue.load !== 'function';
  let latest = [];
  const off = queue.subscribe(jobs => {
    latest = jobs;
    if (ready && live) fn(jobs);
  });
  if (!ready) {
    Promise.resolve().then(() => queue.load()).then(
      snapshot => (Array.isArray(snapshot) ? snapshot : latest),
      () => latest,
    ).then(jobs => {
      ready = true;
      if (live) fn(jobs);
    });
  }
  return () => { live = false; off(); };
}
