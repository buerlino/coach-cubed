// SPDX-License-Identifier: AGPL-3.0-or-later
// The capture's snapshot writer (c27): encoded packets in, an MP4 Blob out, through
// mediabunny, as s32's cut.mjs writes its cut (the same Output, format and track
// options; cut.mjs keeps its own copy, because its test pins the packet source in its
// own module). No decoder, no encoder: the packets are written byte for byte, the first
// one with the decoder configuration, the track with the rotation given.
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from '../../vendor/mediabunny/mediabunny.mjs';

/** mediabunny's codec name for a WebCodecs codec string ('avc1.42002A' → 'avc'). */
export function codecOf(codecString) {
  const c = String(codecString);
  if (c.startsWith('avc1') || c.startsWith('avc3')) return 'avc';
  if (c.startsWith('hvc1') || c.startsWith('hev1')) return 'hevc';
  if (c.startsWith('vp09')) return 'vp9';
  if (c.startsWith('av01')) return 'av1';
  if (c === 'vp8') return 'vp8';
  throw new TypeError(`no MP4 codec for ${c}`);
}

/** A packet for the writer: data, 'key' or 'delta', and times in seconds. */
export const packetOf = (data, type, timestamp, duration) => new EncodedPacket(data, type, timestamp, duration);

/**
 * @param {{codec: string, rotation?: number}} o codec: mediabunny's name ('avc', 'hevc', …); rotation: 0, 90, 180 or 270
 * @returns {Promise<{add: (packet: EncodedPacket, decoderConfig?: object) => Promise<void>, finish: () => Promise<Blob>}>}
 *   add() gives the decoder config to the first packet only; finish() writes the index and returns the MP4
 */
export async function createMp4Writer({ codec, rotation = 0 }) {
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new EncodedVideoPacketSource(codec);
  output.addVideoTrack(source, { rotation });
  await output.start();
  let written = 0;
  return {
    add: (packet, decoderConfig) => source.add(packet, written++ === 0 && decoderConfig ? { decoderConfig } : undefined),
    async finish() {
      await output.finalize();
      return new Blob([target.buffer], { type: 'video/mp4' });
    },
  };
}
