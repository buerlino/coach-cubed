// SPDX-License-Identifier: AGPL-3.0-or-later
// The words a failed job starts with, so a screen can tell what failed from the job's `error`
// (contract 2 keeps one string, "in the engine's words"; d23). The raising modules (job.mjs, queue.mjs) use
// these, and ui/problem-model.mjs reads them back; the rest of each message is the engine's own.

/** A job whose track has nobody in it: followed by diagnostics.js's reason for a track with no person. */
export const NO_PERSON = 'No person was found in the marked part of the video.';

/** The pose engine refused a frame or the worker went: followed by the engine's message. */
export const ENGINE_FAILED = 'The pose engine failed:';

/** The watchdog's message (queue.mjs's StallError) starts with this. */
export const STALLED = 'The analysis stopped responding';

/**
 * The frame source failed during the job (a MediaError: decode-failed, unreadable, decode-stalled once its
 * restarts ran out, …): the job keeps `MEDIA_FAILED (code): message`, so a screen can tell the video from the
 * engine and read the code back with `mediaCodeOf`.
 */
export const MEDIA_FAILED = 'The video could not be read';

/** A MediaError as the job's error string: the phrase, the code, the frame source's own message. */
export const mediaFailure = e => `${MEDIA_FAILED} (${e.code}): ${e.message}`;

/** The MediaError code in a job's error string, or null when it isn't one of ours. */
export function mediaCodeOf(message) {
  const m = typeof message === 'string' && message.startsWith(MEDIA_FAILED) ? /^\(([a-z-]+)\):/.exec(message.slice(MEDIA_FAILED.length).trimStart()) : null;
  return m ? m[1] : null;
}
