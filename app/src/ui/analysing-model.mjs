// Q1's logic as plain functions (package d15): the view state of the
// Analysing screen from the queue's jobs (contract 2), as the mockup draws it
// (design/mockups/Analysing.dc.html). No Preact and no DOM, so Node runs it as
// written (tests/app/analysing.test.js); screens/Q1.mjs only draws it. The
// view is rebuilt from the jobs at every change, never kept: leaving Q1 and
// coming back (the job goes on in the queue) shows the queue as it is.
import { liftLabel, followQueue, percentOf, STAGES } from './home-model.mjs';
import { isAnalysed } from '../contracts/stored-lift.mjs';
import { estimateCost } from '../analysis/estimate.mjs';
import { problemOf } from './problem-model.mjs';

// The stages and their bands, and a job's percent, are home-model.mjs's: H reads them too.
export { STAGES };

const RUNNING = ['reading', 'pose', 'scoring'];
const ENDED = ['done', 'failed', 'cancelled'];
const pad = n => String(n).padStart(2, '0');
const clock = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const length = range => (range.t1 - range.t0).toFixed(1);

/**
 * The time as round 1 says it ("~38 s"): seconds rounded up, at least
 * one; from two minutes on, whole minutes.
 * @param {number} seconds
 */
export function aboutTime(seconds) {
  if (seconds >= 120) return `~${Math.round(seconds / 60)} min`;
  return `~${Math.max(1, Math.ceil(seconds))} s`;
}

// The stage a job stands in: running (or stopped) at `progress.stage`, done past all of them.
function stageStatuses(job) {
  if (job.state === 'done') return STAGES.map(() => 'done');
  const at = job.progress ? STAGES.findIndex(s => s.key === job.progress.stage) : -1;
  if (RUNNING.includes(job.state)) return STAGES.map((_, i) => (i < at ? 'done' : i === at ? 'now' : 'todo'));
  // failed or cancelled: what was finished stays ticked, nothing is in progress
  return STAGES.map((_, i) => (i < at ? 'done' : 'todo'));
}

function pick(jobs, liftId) {
  if (liftId) return jobs.find(j => j.liftId === liftId) ?? null;
  return jobs.find(j => RUNNING.includes(j.state)) ?? jobs.find(j => j.state === 'queued') ?? null;
}

function queueOf(jobs, mine, rate) {
  const at = jobs.indexOf(mine);
  const items = [];
  jobs.forEach((j, i) => {
    if (j === mine || ENDED.includes(j.state)) return;
    const parts = [liftLabel(j.lift), `${length(j.range)} s`];
    if (rate) parts.push(aboutTime(estimateCost(j.range.t1 - j.range.t0, rate).seconds));
    items.push({ id: j.id, liftId: j.liftId, ahead: i < at, text: parts.join(' · ') });
  });
  if (!items.length) return null;
  return { label: items[0].ahead ? 'Before this' : 'Up next', items, more: items.length - 1 };
}

function leftOf(kind, eta) {
  if (kind === 'done') return 'done';
  if (kind === 'waiting') return 'waiting';
  if (kind === 'paused') return 'paused';
  if (kind !== 'running') return '';
  // never a made-up time: etaS is null until a rate is measured (s12)
  return eta === null ? 'estimating…' : `${aboutTime(eta)} left`;
}

const HEADING = { done: 'Ready', failed: "Couldn't analyse", cancelled: 'Stopped' };

/**
 * What Q1 shows, from the queue's jobs.
 * @param {import('../contracts/analysis-job.mjs').AnalysisJob[]} jobs queue order
 * @param {Object} [ctx]
 * @param {string} [ctx.liftId] the lift Q1 was opened for (the flow's `liftId`); without one, the job running now
 * @param {import('../contracts/stored-lift.mjs').StoredLift|null} [ctx.lift] its record, for "14:32"
 * @param {import('../analysis/estimate.mjs').Rate|null} [ctx.rate] the queue's measured rate, for the other lifts' times
 * @param {boolean} [ctx.visible] false while the app is in the background: a running job is then paused
 * @returns {Object} kind (running, paused, waiting, done, failed, cancelled, idle), heading, lift, percent,
 *   pctLabel, left, eta, stages, reason, problem (d23: problem-model.mjs's, for a failed job), queue, actions {cancel, retry, another, open}, jobId, liftId
 */
export function analysingView(jobs, { liftId, lift = null, rate = null, visible = true } = {}) {
  const job = pick(jobs, liftId);
  const analysed = !job && lift !== null && isAnalysed(lift);
  let kind;
  if (!job) kind = analysed ? 'done' : liftId ? 'cancelled' : 'idle';
  else if (job.state === 'queued') kind = 'waiting';
  else if (RUNNING.includes(job.state)) kind = visible ? 'running' : 'paused';
  else kind = job.state;

  const id = job ? job.liftId : liftId ?? null;
  const range = job ? job.range : lift ? lift.range : null;
  const kindOfLift = job ? job.lift : lift ? lift.lift : null;
  const p = job ? job.progress : null;
  // d55: "14:32 · 13.0 s" (when it was kept, the marked length); without the record, the length
  const meta = range ? [lift ? clock(new Date(lift.created)) : null, `${length(range)} s`].filter(Boolean).join(' · ') : null;
  const eta = kind === 'running' && p && typeof p.etaS === 'number' ? p.etaS : null;
  const percent = !job ? (analysed ? 100 : 0) : percentOf(job);
  const statuses = job ? stageStatuses(job) : STAGES.map(() => (analysed ? 'done' : 'todo'));
  const problem = kind === 'failed' ? problemOf(job.error) : null;
  const ongoing = kind === 'waiting' || kind === 'running' || kind === 'paused';

  return {
    kind,
    heading: HEADING[kind] ?? 'Analysing',
    lift: kindOfLift ? { lift: kindOfLift, title: liftLabel(kindOfLift), meta } : null,
    percent,
    pctLabel: `${percent}%`,
    left: leftOf(kind, eta),
    eta,
    stages: STAGES.map((s, i) => ({
      key: s.key,
      label: s.label,
      status: statuses[i],
      detail: statuses[i] === 'now' && s.key === 'pose' && p ? `${p.done} / ${p.total}` : '',
    })),
    reason: kind === 'failed' ? job.error : null,
    problem,
    queue: job ? queueOf(jobs, job, rate) : null,
    actions: {
      cancel: ongoing,
      retry: (kind === 'failed' && problem.actions.retry) || kind === 'cancelled',
      // d51: only "No person found" offers another video here; the other problems keep their buttons
      another: !!problem && problem.kind === 'no-person',
      open: kind === 'done' && id ? { to: 'result', params: { liftId: id } } : null,
    },
    jobId: job ? job.id : null,
    liftId: id,
  };
}

/**
 * Q1's follow of the queue: fn({jobs, rate}) at every change, but not before the
 * queue has loaded its kept file (home-model.mjs's followQueue). Returns the
 * unsubscribe: Q1 calls it on leaving, and a new follow starts from the queue
 * as it is, so nothing of the old view is carried over.
 * @param {{subscribe: Function, load?: Function, rate?: Function}} queue
 * @param {(state: {jobs: object[], rate: object|null}) => void} fn
 */
export function followAnalysis(queue, fn) {
  return followQueue(queue, jobs => fn({ jobs, rate: typeof queue.rate === 'function' ? queue.rate() : null }));
}
