// H's logic as plain functions (package d13): what to show from the store's
// lifts and the queue's jobs, and what the import step hands the flow. No
// Preact and no DOM, so Node runs it as written (tests/app/home.test.js); the
// screens (screens/H.mjs, screens/Import.mjs) only draw what these give.
import { LIFTS } from '../contracts/common.mjs';
import { isAnalysed } from '../contracts/stored-lift.mjs';

/** The lifts the import step offers (v1). The snatch is provisional while step 3.6 is open. */
export const LIFT_CHOICES = Object.freeze([
  Object.freeze({ id: 'lateral-raise', label: 'Lateral raise', provisional: false }),
  Object.freeze({ id: 'snatch', label: 'Snatch', provisional: true }),
]);

/** @param {string} lift */
export const liftLabel = lift => LIFT_CHOICES.find(c => c.id === lift)?.label ?? lift;

const ACTIVE = ['reading', 'pose', 'scoring'];
const ENDED = ['done', 'failed', 'cancelled'];

/**
 * A lift's state for H, from the store's record and the queue's jobs:
 * `ready` (the record is analysed), `waiting` (job queued; `ahead` is the
 * number of unfinished jobs before it), `analysing` (reading, pose or scoring;
 * `percent`, `stage`), `failed` (`error`, the job's words), `stopped` (the lift
 * is stored and unanalysed: its job was cancelled, or it has none).
 * Progress: reading is 0 %, pose is frames done over frames, scoring is 99 %;
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
  const p = job.progress;
  const percent = job.state === 'pose' && p && p.total > 0 ? Math.min(99, Math.floor((p.done / p.total) * 100))
    : job.state === 'scoring' ? 99 : 0;
  return { kind: 'analysing', stage: ACTIVE.includes(job.state) ? job.state : 'reading', percent };
}

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
const clock = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayKey = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const dayName = d => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
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

/**
 * The import step: the chosen lift goes into the flow with the file, on the way
 * to marking. Nothing changes for no file, a file that is not a video (a missing
 * type is let through: some Android pickers give none), or a lift v1 doesn't have.
 * @returns {{ok: true}|{ok: false, error: string}}
 */
export function importStep(flow, file, lift) {
  if (!LIFTS.includes(lift)) return { ok: false, error: 'Choose the lift first.' };
  if (!file) return { ok: false, error: 'Pick a video from this phone.' };
  if (file.type && !file.type.startsWith('video/')) return { ok: false, error: 'That file is not a video.' };
  flow.go('mark', { file, lift });
  return { ok: true };
}

/** H's follow of the queue: fn(jobs) now and at every change; returns the unsubscribe. */
export function followQueue(queue, fn) {
  return queue.subscribe(fn);
}
