// SPDX-License-Identifier: AGPL-3.0-or-later
// What the error screens say (package d23): an error from anywhere in the app as a problem a screen can
// draw, with what happened, what the user can do and which ways on it offers. Plain module, no Preact, no
// DOM. The errors come from the modules that raise them:
//   s9's frame source   MediaError, by `code` (unreadable, no-video, decode-failed, decode-stalled,
//                       unsupported-codec, no-webcodecs)
//   s12's job and queue a failed job keeps only a string (contract 2, `error`), which starts with a known
//                       phrase (analysis/messages.mjs): no person found, the engine failing, the watchdog
//   c8's store          StoreError `storage-full`, or its message when it reached a job as a string
//   c27's capture       CaptureError, by `code` (camera-denied, no-camera, camera-busy, no-encoder, insecure,
//                       encoder-failed), on R1 and R2 (d28) and R3b (d29b)
// `engine` is the raising module's own words (the frame source's message, diagnostics.js's reason, the
// worker's message, the store's), shown as they are; `title`, `what` and `can` are this screen's. Nothing is
// invented: advice is only what the app can really do (pick another video, analyse again, delete lifts).
import { ENGINE_FAILED, MEDIA_FAILED, NO_PERSON, STALLED, mediaCodeOf } from '../analysis/messages.mjs';
import { STORAGE_FULL } from '../store/index.mjs';
import { SESSION_STATES } from '../flow/flow.mjs';

/** The kinds of problem the screens know. */
export const PROBLEM_KINDS = Object.freeze(['unreadable', 'unsupported-codec', 'no-webcodecs', 'no-person', 'engine-failed', 'storage-full', 'failed',
  'camera-denied', 'no-camera', 'camera-busy', 'no-encoder', 'insecure', 'encoder-failed']);

const KINDS = {
  unreadable: {
    title: "This video can't be read",
    what: "The app couldn't read this file as a video.",
    can: 'Pick another video.',
    actions: { retry: false, another: true },
  },
  'unsupported-codec': {
    title: "This phone can't play this video",
    what: "This phone's video decoder doesn't support the format this video is in.",
    can: 'Pick a video in another format, such as H.264.',
    actions: { retry: false, another: true },
  },
  'no-webcodecs': {
    title: "This app can't read videos here",
    what: 'Reading a video needs WebCodecs, and this runtime has no video decoder.',
    can: 'Go back to the home screen.',
    actions: { retry: false, another: false },
  },
  'no-person': {
    title: 'No person found',
    what: 'The pose engine found no one in the part of the video you marked.',
    can: 'Mark a part where the whole lifter is in view, or pick another video.',
    actions: { retry: false, another: true },
  },
  'engine-failed': {
    title: 'The pose engine stopped',
    what: 'The pose engine stopped before it had read the whole video.',
    can: 'Analyse again. The video and your marks are kept.',
    actions: { retry: true, another: false },
  },
  'storage-full': {
    title: 'Storage is full',
    what: 'There is no room left on this phone to save the lift.',
    can: "Delete lifts you don't need (in a lift's view options, or in Settings) or free space on the phone, then try again.",
    actions: { retry: true, another: false },
  },
  // the camera's (d28): R1, R2 and R3b draw them; trying again is the camera asked afresh: R1's button opens it anew,
  // R2's and R3b's (c61) resume the session's recording into the same ring
  'camera-denied': {
    title: 'Camera not allowed',
    what: 'The camera permission was refused.',
    can: "Allow the camera for coach in the phone's settings, then try again.",
    actions: { retry: true, another: false },
  },
  'no-camera': {
    title: 'No camera found',
    what: 'The phone gave no camera that fits.',
    can: "Pick the other camera in Settings, then try again.",
    actions: { retry: true, another: false },
  },
  'camera-busy': {
    title: 'Camera in use',
    what: 'Another app holds the camera.',
    can: 'Close that app, then try again.',
    actions: { retry: true, another: false },
  },
  'no-encoder': {
    title: "Can't record here",
    what: "This browser has no H.264 video encoder.",
    can: 'Use the coach app on the phone, or a current browser.',
    actions: { retry: false, another: false },
  },
  insecure: {
    title: 'The camera needs https',
    what: 'This page is not served over https or from localhost.',
    can: 'Open coach from its https address, or install the app.',
    actions: { retry: false, another: false },
  },
  'encoder-failed': {
    title: 'Recording stopped',
    what: 'The video encoder failed while recording.',
    can: 'Try again.',
    actions: { retry: true, another: false },
  },
  failed: {
    title: "That didn't work",
    what: 'Something went wrong.',
    can: 'Try again.',
    actions: { retry: true, another: false },
  },
};

const UNREADABLE = new Set(['unreadable', 'no-video', 'decode-failed', 'decode-stalled']);

const messageOf = e => (typeof e === 'string' ? e : e && typeof e.message === 'string' && e.message) || '';

function kindOfMediaCode(code) {
  if (code === 'unsupported-codec') return 'unsupported-codec';
  if (code === 'no-webcodecs') return 'no-webcodecs';
  return UNREADABLE.has(code) ? 'unreadable' : null;
}

const CAPTURE_KINDS = new Set(['camera-denied', 'no-camera', 'camera-busy', 'no-encoder', 'insecure', 'encoder-failed']);

function kindOf(e) {
  if (e && typeof e === 'object') {
    if (e.code === 'storage-full') return 'storage-full';
    if (e.name === 'CaptureError' && CAPTURE_KINDS.has(e.code)) return e.code;
    const media = kindOfMediaCode(e.code);
    if (media) return media;
    if (e.name === 'EngineError' || e.name === 'StallError') return 'engine-failed';
    if (e.name === 'NoPersonError') return 'no-person';
  }
  const m = messageOf(e);
  if (m === STORAGE_FULL) return 'storage-full';
  if (m.startsWith(MEDIA_FAILED)) return kindOfMediaCode(mediaCodeOf(m)) || 'unreadable';   // a MediaError in the job: its code is in the string
  if (m.startsWith(NO_PERSON)) return 'no-person';
  if (m.startsWith(ENGINE_FAILED) || m.startsWith(STALLED)) return 'engine-failed';
  return 'failed';
}

// The raising module's own words, without the phrase this model matched on.
function ownWords(kind, m) {
  if (kind === 'no-person' && m.startsWith(NO_PERSON)) return m.slice(NO_PERSON.length).trim() || null;
  if (kind === 'engine-failed' && m.startsWith(ENGINE_FAILED)) return m.slice(ENGINE_FAILED.length).trim() || null;
  if (m.startsWith(MEDIA_FAILED)) return m.replace(/^[^:]*\([a-z-]+\):\s*/, '') || null;
  return m || null;
}

/**
 * An error as a problem to draw.
 * @param {unknown} error an Error (a MediaError, a StoreError, the queue's), or a failed job's `error` string
 * @returns {{kind: string, title: string, what: string, can: string, engine: string|null,
 *   actions: {retry: boolean, another: boolean}}} `engine` the raising module's words ("The engine says"),
 *   null when it had none; `actions.retry`: trying the same thing again can help; `actions.another`: the way
 *   on is another video
 */
export function problemOf(error) {
  const kind = kindOf(error);
  const k = KINDS[kind];
  return { kind, title: k.title, what: k.what, can: k.can, engine: ownWords(kind, messageOf(error)), actions: { ...k.actions } };
}

/**
 * The buttons M offers for a problem, in order: `retry` and `marks` only at Analyse (the marks are still
 * there), `another` where another video can help (never because of where the problem came up), `home` always.
 * @param {ReturnType<typeof problemOf>} problem
 * @param {boolean} atAnalyse the problem came up at Analyse, not when the video was opened
 * @param {string|null} [from] M's `from` param: `'live'` or `'delayed'` (a lift kept in a session on R3 or R3b, d29, d29b) offers `session`, "Back to the session",
 *   in place of `another`
 * @returns {string[]}
 */
export function waysOn(problem, atAnalyse, from = null) {
  return [
    ...(atAnalyse && problem.actions.retry ? ['retry'] : []),
    ...(atAnalyse ? ['marks'] : []),
    ...(problem.actions.another ? [SESSION_STATES.includes(from) ? 'session' : 'another'] : []),
    'home',
  ];
}
