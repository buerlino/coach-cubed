// Contract 2, an analysis job: one stored lift's way through the queue
// (app/src/analysis/, s12): read the stored cut, pose every frame, build the
// track, score it. Q1 and H show its state and progress; the store keeps the
// queue. A job names only stored files, the cut by its path, never a File, a
// Blob or a URL, and its range is in the cut's own timeline, so a queued job
// read back after a restart is the same job. A re-mark's job (A3, d22) names
// the lift it replaces (s50): the queue deletes that one once this one is done.
// Plain module, no DOM.
import {
  checkFields, checkId, checkInteger, checkLift, checkRange, checkStorePath, isNumber, isObject, isString,
} from './common.mjs';
import { STORED_LIFT_EXAMPLE, liftPaths } from './stored-lift.mjs';

/** A job's states, in the order a job goes through them; the last three end it. */
export const JOB_STATES = Object.freeze(['queued', 'reading', 'pose', 'scoring', 'done', 'failed', 'cancelled']);
/** The stages a running job reports progress on: Q1's three steps. */
export const JOB_STAGES = Object.freeze(['reading', 'pose', 'scoring']);

/**
 * @typedef {Object} AnalysisJob
 * @property {string} id the job's id (ID_RE)
 * @property {string} liftId the stored lift it analyses
 * @property {'lateral-raise'|'snatch'} lift the lift's kind, as stored
 * @property {string} source the stored cut's path: the lift's `video` (D6, s32)
 * @property {{t0: number, t1: number}} range seconds in the cut's timeline: the lift's `range`
 * @property {'queued'|'reading'|'pose'|'scoring'|'done'|'failed'|'cancelled'} state
 * @property {JobProgress|null} progress null until the job starts; while it
 *   runs, the stage it is in (state === progress.stage); after it ends, the last one, or null
 * @property {string|null} error why it failed, in the engine's words; null unless failed
 * @property {string|null} replaces the stored lift this job's lift replaces once
 *   the job is done (s50: A3's re-mark, through M); never the job's own lift. The old
 *   lift is deleted in the step that completes the new one, so a job that fails, is
 *   cancelled or is still waiting leaves it as it was. null for any other job
 */

/**
 * @typedef {Object} JobProgress
 * @property {'reading'|'pose'|'scoring'} stage
 * @property {number} done units done in this stage: reading 0 or 1 (one unit, the
 *   stored cut read and opened), pose the frames posed, scoring 0 or 1
 * @property {number} total units in this stage: 1 for reading and scoring, the
 *   range's frames for pose
 * @property {number|null} etaS the time left for the whole job in seconds,
 *   from the measured ms per frame; null until there is a measurement
 */

/**
 * @param {unknown} job
 * @param {{lift?: import('./stored-lift.mjs').StoredLift}} [opts] with `lift`,
 *   the job is also checked against the stored lift it names
 * @returns {string[]} the errors, empty when valid
 */
export function validateAnalysisJob(job, { lift } = {}) {
  if (!isObject(job)) return ['job: must be an object'];
  const errors = [];
  checkFields(errors, '', job, ['id', 'liftId', 'lift', 'source', 'range', 'state', 'progress', 'error', 'replaces']);
  checkId(errors, 'id', job.id);
  checkId(errors, 'liftId', job.liftId);
  checkLift(errors, 'lift', job.lift);
  const folder = typeof job.liftId === 'string' ? liftPaths(job.liftId).folder : null;
  checkStorePath(errors, 'source', job.source, { folder, suffix: '.mp4' });
  checkRange(errors, 'range', job.range);
  if (job.replaces !== null && job.replaces !== undefined) {
    checkId(errors, 'replaces', job.replaces);
    if (job.replaces === job.liftId) errors.push('replaces: a lift never replaces itself');
  }
  if (!JOB_STATES.includes(job.state)) errors.push(`state: must be one of ${JOB_STATES.join(', ')}`);

  const running = JOB_STAGES.includes(job.state);
  const p = job.progress;
  if (p === null) {
    if (running) errors.push(`progress: must be set while the job is in ${job.state}`);
  } else if (job.state === 'queued') {
    errors.push('progress: must be null while the job is queued');
  } else if (p !== undefined && checkFields(errors, 'progress', p, ['stage', 'done', 'total', 'etaS'])) {
    if (!JOB_STAGES.includes(p.stage)) errors.push(`progress.stage: must be one of ${JOB_STAGES.join(', ')}`);
    else if (running && p.stage !== job.state) errors.push(`progress.stage: is ${p.stage}, but the job is in ${job.state}`);
    checkInteger(errors, 'progress.total', p.total, 0);
    checkInteger(errors, 'progress.done', p.done, 0);
    if (Number.isInteger(p.done) && Number.isInteger(p.total) && p.total >= 0 && p.done > p.total) {
      errors.push('progress.done: must not exceed progress.total');
    }
    if (p.etaS !== null && (!isNumber(p.etaS) || p.etaS < 0)) errors.push('progress.etaS: must be seconds (0 or more) or null');
  }

  if (job.state === 'failed') {
    if (!isString(job.error)) errors.push('error: a failed job says why (a non-empty string)');
  } else if (job.error !== null && job.error !== undefined) {
    errors.push(`error: must be null unless the job failed (it is ${job.state})`);
  }

  if (lift !== undefined) {
    if (job.liftId !== lift.id) errors.push(`liftId: is ${job.liftId}, the lift is ${lift.id}`);
    if (job.lift !== lift.lift) errors.push(`lift: is ${job.lift}, the stored lift is ${lift.lift}`);
    if (job.source !== lift.video) errors.push(`source: must be the stored lift's video, ${lift.video}`);
    if (!isObject(job.range) || !isObject(lift.range) || job.range.t0 !== lift.range.t0 || job.range.t1 !== lift.range.t1) {
      errors.push('range: must be the stored lift\'s range');
    }
  }
  return errors;
}

/**
 * A new, queued job for a stored lift: its kind, its cut and its range.
 * @param {string} id
 * @param {import('./stored-lift.mjs').StoredLift} lift
 * @param {{replaces?: string|null}} [opts] the lift a re-mark replaces (s50)
 * @returns {AnalysisJob}
 */
export function createJob(id, lift, { replaces = null } = {}) {
  return {
    id, liftId: lift.id, lift: lift.lift, source: lift.video,
    range: { t0: lift.range.t0, t1: lift.range.t1 },
    state: 'queued', progress: null, error: null, replaces,
  };
}

/** A queued job for STORED_LIFT_EXAMPLE. @type {AnalysisJob} */
export const ANALYSIS_JOB_EXAMPLE = createJob('job-20261101-174205', STORED_LIFT_EXAMPLE);
