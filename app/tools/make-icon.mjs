// SPDX-License-Identifier: AGPL-3.0-or-later
// Writes the placeholder icons (app/icons/icon-192.png and icon-512.png): the
// ground colour with an accent disc, plain, drawn here with no dependency. A
// stand-in until the name and the logo exist (docs/branding.md, question 10).
// Usage: node app/tools/make-icon.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GROUND = [0x0E, 0x0F, 0x11];
const ACCENT = [0xC8, 0xF0, 0x4A];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

// A disc of 30% of the side (inside a maskable icon's safe zone), 4x supersampled.
export function iconPng(size) {
  const rows = [];
  const r = size * 0.30;
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      let inside = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const dx = x + (sx + 0.5) / 4 - c, dy = y + (sy + 0.5) / 4 - c;
        if (dx * dx + dy * dy <= r * r) inside++;
      }
      const t = inside / 16;
      for (let k = 0; k < 3; k++) row[1 + x * 3 + k] = Math.round(GROUND[k] + (ACCENT[k] - GROUND[k]) * t);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2;   // 8 bits, RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
  mkdirSync(dir, { recursive: true });
  for (const size of [192, 512]) writeFileSync(join(dir, `icon-${size}.png`), iconPng(size));
}
