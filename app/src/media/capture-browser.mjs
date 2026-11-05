// SPDX-License-Identifier: AGPL-3.0-or-later
// The browser's side of the capture (package c27): the camera, the frames' reader, the
// H.264 encoder, the wake lock and the page's visibility. Everything createCapture()
// needs from the browser comes through the object this returns, so Node tests hand it a
// fake instead (tests/app/fake-webcodecs.js, createFakeCapture). A part the browser lacks
// is null; the capture turns that into its CaptureError. Nothing else in app/src touches
// the camera or the encoder (tests/app/capture.test.js checks it).

/**
 * @param {typeof globalThis} [g]
 * @returns {{
 *   getUserMedia: ((constraints: MediaStreamConstraints) => Promise<MediaStream>)|null,
 *   readFrames: ((track: MediaStreamTrack) => ReadableStreamDefaultReader<VideoFrame>)|null,
 *   isEncoderConfigSupported: ((config: object) => Promise<{supported: boolean}>)|null,
 *   createEncoder: ((init: {output: Function, error: Function}) => VideoEncoder)|null,
 *   requestWakeLock: (() => Promise<WakeLockSentinel>)|null,
 *   isVisible: () => boolean,
 *   onVisibilityChange: (fn: () => void) => () => void,
 * }}
 */
export function browserCaptureApi(g = globalThis) {
  const nav = g.navigator;
  const media = nav && nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function' ? nav.mediaDevices : null;
  const Encoder = typeof g.VideoEncoder === 'function' ? g.VideoEncoder : null;
  const Processor = typeof g.MediaStreamTrackProcessor === 'function' ? g.MediaStreamTrackProcessor : null;
  const wakeLock = nav && nav.wakeLock && typeof nav.wakeLock.request === 'function' ? nav.wakeLock : null;
  const doc = g.document;
  return {
    getUserMedia: media && (async constraints => media.getUserMedia(constraints)),
    // the camera's frames as VideoFrames, with the camera's own timestamps (µs)
    readFrames: Processor && (track => new Processor({ track }).readable.getReader()),
    isEncoderConfigSupported: Encoder && (async config => Encoder.isConfigSupported(config)),
    createEncoder: Encoder && (init => new Encoder(init)),
    requestWakeLock: wakeLock && (async () => wakeLock.request('screen')),
    isVisible: () => !doc || doc.visibilityState !== 'hidden',
    onVisibilityChange(fn) {
      if (!doc || typeof doc.addEventListener !== 'function') return () => {};
      doc.addEventListener('visibilitychange', fn);
      return () => doc.removeEventListener('visibilitychange', fn);
    },
  };
}
