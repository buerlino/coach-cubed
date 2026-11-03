// Contract 3, a stored lift: the store's record of one lift (app/src/store/,
// c8), written at Analyse and completed when its job is done. Its files sit
// in one folder per lift: the cut video (D6: the marked range cut to MP4 at
// Analyse, s32), track.json (track.mjs, the fixture format) and result.json
// (a ResultView, cue-view.mjs). Plain module, no DOM.
import {
  LIFTS_DIR, checkFields, checkId, checkLift, checkRange, checkStorePath, checkString, isObject,
} from './common.mjs';
import { BACKENDS } from './pose-messages.mjs';

/**
 * @typedef {Object} StoredLift
 * @property {string} id the lift's id (ID_RE), also its folder's name
 * @property {string} created when it was stored: ISO 8601 in UTC, e.g. '2026-11-01T17:42:05.120Z'
 * @property {import('./lifts.mjs').LiftId} lift which lift, and so which diagnostic set scores it
 * @property {string} video the cut's path in the store: an .mp4 in the lift's folder (liftPaths)
 * @property {{t0: number, t1: number}} range the marked range in seconds, in the
 *   cut's own timeline (0 is the cut's first frame, the keyframe at or before the mark)
 * @property {string|null} track track.json's path in the lift's folder; null until analysed
 * @property {string|null} result result.json's path in the lift's folder; null until analysed
 * @property {string} appVersion the app's version that stored it
 * @property {{model: string, backend: string, runtime: string}|null} engine the engine that
 *   made the track, as the pose worker's ready message names it; null until analysed
 */

/**
 * The folder and the files of lift `id`, as the store lays them out.
 * @param {string} id
 * @returns {{folder: string, video: string, track: string, result: string}}
 */
export function liftPaths(id) {
  const folder = `${LIFTS_DIR}/${id}/`;
  return { folder, video: `${folder}cut.mp4`, track: `${folder}track.json`, result: `${folder}result.json` };
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * @param {unknown} lift
 * @returns {string[]} the errors, empty when valid
 */
export function validateStoredLift(lift) {
  const errors = [];
  const FIELDS = ['id', 'created', 'lift', 'video', 'range', 'track', 'result', 'appVersion', 'engine'];
  if (!isObject(lift)) return ['lift: must be an object'];
  checkFields(errors, '', lift, FIELDS);
  checkId(errors, 'id', lift.id);
  if (typeof lift.created !== 'string' || !ISO_UTC.test(lift.created) || Number.isNaN(Date.parse(lift.created))) {
    errors.push('created: must be an ISO 8601 time in UTC (Date.prototype.toISOString())');
  }
  checkLift(errors, 'lift', lift.lift);
  const folder = typeof lift.id === 'string' ? liftPaths(lift.id).folder : null;
  checkStorePath(errors, 'video', lift.video, { folder, suffix: '.mp4' });
  checkRange(errors, 'range', lift.range);
  checkString(errors, 'appVersion', lift.appVersion);
  // Analysed or not: the track, the result and the engine come together.
  const analysed = lift.track !== null || lift.result !== null || lift.engine !== null;
  if (analysed) {
    checkStorePath(errors, 'track', lift.track, { folder, suffix: '.json' });
    checkStorePath(errors, 'result', lift.result, { folder, suffix: '.json' });
    if (lift.engine === null) errors.push('engine: must be set once the lift has a track and a result');
    else if (checkFields(errors, 'engine', lift.engine, ['model', 'backend', 'runtime'])) {
      if ('model' in lift.engine) checkString(errors, 'engine.model', lift.engine.model);
      if (!BACKENDS.includes(lift.engine.backend)) errors.push(`engine.backend: must be one of ${BACKENDS.join(', ')}`);
      if ('runtime' in lift.engine) checkString(errors, 'engine.runtime', lift.engine.runtime);
    }
  }
  return errors;
}

/** True once a lift has its track, its result and its engine. */
export const isAnalysed = lift => isObject(lift) && lift.track !== null && lift.result !== null && lift.engine !== null;

/**
 * An analysed lateral raise. Sample values: the id, the time, the range and
 * the version are made up; the engine is POSE_MESSAGE_EXAMPLES' ready message.
 * @type {StoredLift}
 */
export const STORED_LIFT_EXAMPLE = {
  id: '20261101-174205-lr',
  created: '2026-11-01T17:42:05.120Z',
  lift: 'lateral-raise',
  video: 'lifts/20261101-174205-lr/cut.mp4',
  range: { t0: 0.4, t1: 3.2 },
  track: 'lifts/20261101-174205-lr/track.json',
  result: 'lifts/20261101-174205-lr/result.json',
  appVersion: '0.1.0',
  engine: { model: 'movenet-thunder', backend: 'webgl', runtime: 'tfjs 4.22.0' },
};
