// The errors of the media module. One class, with a `code` the UI can switch on
// (d23's "a video that can't be read") and a message that is fit to show.
// A frame source never hangs: every failure ends as one of these.

/**
 * - `no-webcodecs`: this runtime has no WebCodecs decoder at all
 * - `unreadable`: not a video file the demuxer knows, or damaged
 * - `no-video`: a file with no video track
 * - `unsupported-codec`: a video this device's decoder can't decode (HEVC on a
 *   WebView without it); `error.codec` has the codec string
 * - `decode-failed`: the decoder reported an error, or gave no frame
 * - `decode-stalled`: the decoder stopped answering for `stallMs`
 * - `range`: a time or size that is not a number
 * - `closed`: the source was closed
 */
export const MEDIA_ERROR_CODES = Object.freeze([
  'no-webcodecs', 'unreadable', 'no-video', 'unsupported-codec', 'decode-failed', 'decode-stalled', 'range', 'closed',
]);

export class MediaError extends Error {
  /**
   * @param {string} code one of MEDIA_ERROR_CODES
   * @param {string} message
   * @param {{cause?: unknown, codec?: string}} [extra]
   */
  constructor(code, message, { cause, codec } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MediaError';
    this.code = code;
    if (codec !== undefined) this.codec = codec;
  }
}

/** An error from anywhere as a MediaError: a MediaError stays, anything else becomes `code`. */
export function asMediaError(e, code, message) {
  if (e instanceof MediaError) return e;
  const detail = e && e.message ? e.message : String(e);
  return new MediaError(code, `${message}${detail ? ` (${detail})` : ''}`, { cause: e });
}
