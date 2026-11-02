// The words a failed job starts with, so a screen can tell what failed from the job's `error`
// (contract 2 keeps one string, "in the engine's words"; d23). The raising modules (job.mjs, queue.mjs) use
// these, and ui/problem-model.mjs reads them back; the rest of each message is the engine's own.

/** A job whose track has nobody in it: followed by diagnostics.js's reason for a track with no person. */
export const NO_PERSON = 'No person was found in the marked part of the video.';

/** The pose engine refused a frame or the worker went: followed by the engine's message. */
export const ENGINE_FAILED = 'The pose engine failed:';

/** The watchdog's message (queue.mjs's StallError) starts with this. */
export const STALLED = 'The analysis stopped responding';
