// SPDX-License-Identifier: AGPL-3.0-or-later
// The errors of the capture (package c27). One class, with a `code` the screens can
// switch on (R1's "the camera can't be used") and a message fit to show; the browser's
// own error is kept as `cause` and its message in ours.

/**
 * - `insecure`: no `navigator.mediaDevices` (a page not served from https or localhost)
 * - `no-camera`: no camera, or none that meets the constraints (`NotFoundError`, `OverconstrainedError`)
 * - `camera-denied`: the camera permission was refused (`NotAllowedError`)
 * - `camera-busy`: the camera is held by another app, or failed to start (`NotReadableError`)
 * - `no-encoder`: no `VideoEncoder` (or no `MediaStreamTrackProcessor` to feed it), or no H.264 config it supports
 * - `encoder-failed`: the encoder reported an error while recording
 */
export const CAPTURE_ERROR_CODES = Object.freeze(['insecure', 'no-camera', 'camera-denied', 'camera-busy', 'no-encoder', 'encoder-failed']);

export class CaptureError extends Error {
  /**
   * @param {string} code one of CAPTURE_ERROR_CODES
   * @param {string} message
   * @param {{cause?: unknown}} [extra]
   */
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CaptureError';
    this.code = code;
  }
}

/** A browser error as a CaptureError with `code`; its own message is kept in ours. */
export function asCaptureError(e, code, message) {
  if (e instanceof CaptureError) return e;
  const detail = e && e.message ? `${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}` : (e == null ? '' : String(e));
  return new CaptureError(code, `${message}${detail ? ` (${detail})` : ''}`, { cause: e });
}

/** getUserMedia's rejection as a CaptureError: by the DOMException's name. */
export function cameraError(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return asCaptureError(e, 'camera-denied', 'The camera permission was refused.');
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return asCaptureError(e, 'camera-busy', "The camera couldn't be started: another app may be using it.");
  }
  return asCaptureError(e, 'no-camera', 'No camera could be opened.');
}
