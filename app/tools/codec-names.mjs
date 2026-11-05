// SPDX-License-Identifier: AGPL-3.0-or-later
// Which video codecs Android gave the WebView, from the app's own processes'
// log lines (tools/check-media-apk.mjs, c34; OMX's names since c65): Codec2's
// component names (c2.qti.avc.decoder, c2.android.hevc.decoder, Android 10 and
// later) and OpenMAX IL's (OMX.Exynos.AVC.Decoder, OMX.google.h264.decoder: the
// codecs of Android 9 and older, such as the Samsung S8+'s). The name forms are
// from memory of Android's media framework; c60 sees the S8+'s.

const CODEC2 = /\bc2\.[A-Za-z0-9_.]+\.(?:decoder|encoder)[A-Za-z0-9_.]*/g;
const OMX = /\bOMX\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+/g;

/**
 * @param {string} text log lines
 * @returns {string[]} the component names, each once, in the order first seen
 */
export function codecNames(text) {
  const found = [];
  for (const line of String(text).split('\n')) {
    const hits = [...line.matchAll(CODEC2), ...line.matchAll(OMX)].sort((a, b) => a.index - b.index);
    for (const m of hits) {
      const name = m[0].replace(/\.+$/, '');
      if (!found.includes(name)) found.push(name);
    }
  }
  return found;
}
