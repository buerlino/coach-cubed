// SPDX-License-Identifier: AGPL-3.0-or-later
// Renders every icon the app ships from the logo's two layers,
// logo/coach-cubed_back.svg (the ground) and logo/coach-cubed_front.svg (the
// symbol). Both are drawn on Android's adaptive-icon grid: 108 × 108 units, of
// which a launcher shows the middle 72 and crops it further to its own shape;
// the symbol stays inside the safe circle (diameter 66) in the middle.
//
// Writes (docs/branding.md, "Generated from them"):
//   app/icons/            the PWA: icon-192/512 (any), icon-maskable-512,
//                         apple-touch-icon (180), favicon.svg, favicon-32
//   app/android/.../res/  mipmap-*: the adaptive icon's foreground and its
//                         one-colour layer (themed icons, Android 13+), the
//                         legacy square and round icons (Android 7 and 7.1);
//                         drawable-*: splash_icon, the pre-Android-12 splash
//   logo/coach-cubed-512.png   for F-Droid and GitHub releases
//
// Needs rsvg-convert (librsvg; Fedora: librsvg2-tools, Debian: librsvg2-bin).
// The outputs are committed, so only whoever changes the logo runs this.
// Usage: node app/tools/make-icon.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOGO = join(ROOT, 'logo');
const ICONS = join(ROOT, 'app', 'icons');
const RES = join(ROOT, 'app', 'android', 'app', 'src', 'main', 'res');

// A layer's <svg> root, placed on the 108-unit grid so layers can be stacked.
function layer(name, { mono = false } = {}) {
  let svg = readFileSync(join(LOGO, `coach-cubed_${name}.svg`), 'utf8');
  svg = svg.slice(svg.indexOf('<svg'));
  svg = svg.replace(/<svg\b[^>]*?\swidth="[^"]*"\s+height="[^"]*"/, m =>
    m.replace(/\swidth="[^"]*"\s+height="[^"]*"/, ' x="0" y="0" width="108" height="108"'));
  // The one-colour layer: everything the symbol draws, in one opaque colour.
  // Android uses only its alpha and tints it with the wallpaper's colours.
  if (mono) svg = svg.replace(/\b(fill|stroke):#[0-9a-fA-F]{3,6}/g, '$1:#000');
  return svg;
}

const SHAPES = {
  square: () => '',
  circle: ([x, y, w]) => `<circle cx="${x + w / 2}" cy="${y + w / 2}" r="${w / 2}"/>`,
  // Android's legacy launcher square and the browser-tab icon: corners of 1/6.
  rounded: ([x, y, w]) => `<rect x="${x}" y="${y}" width="${w}" height="${w}" rx="${w / 6}"/>`,
};

// One icon as SVG: the layers stacked, the view cropped to `view` (x, y, side
// on the 108-unit grid), clipped to `shape`.
function iconSvg({ layers, view = [0, 0, 108], shape = 'square', mono = false }) {
  const [x, y, w] = view;
  const clip = SHAPES[shape](view);
  const body = layers.map(l => layer(l, { mono })).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${w}">
${clip ? `<clipPath id="shape">${clip}</clipPath><g clip-path="url(#shape)">` : '<g>'}
${body}
</g></svg>
`;
}

function png(svg, size, file) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-f', 'png'], { input: svg }));
}

// What a launcher shows of the adaptive icon: the middle 72 units.
const SHOWN = [18, 18, 72];
// Tighter, for the browser tab, where every pixel counts: the symbol's own box.
const TAB = [25, 26, 60];

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

export function makeIcons() {
  const full = { layers: ['back', 'front'] };

  // The PWA.
  png(iconSvg({ ...full, view: SHOWN, shape: 'rounded' }), 192, join(ICONS, 'icon-192.png'));
  png(iconSvg({ ...full, view: SHOWN, shape: 'rounded' }), 512, join(ICONS, 'icon-512.png'));
  png(iconSvg(full), 512, join(ICONS, 'icon-maskable-512.png'));   // the whole grid: the browser masks it
  png(iconSvg({ ...full, view: SHOWN }), 180, join(ICONS, 'apple-touch-icon.png'));   // iOS rounds it itself
  const tab = iconSvg({ ...full, view: TAB, shape: 'rounded' });
  writeFileSync(join(ICONS, 'favicon.svg'), tab);
  png(tab, 32, join(ICONS, 'favicon-32.png'));

  // Android: launcher icons are 48 dp, the adaptive layers 108 dp, the
  // pre-Android-12 splash icon 160 dp (the size Android 12's own splash masks
  // the launcher icon to).
  for (const [d, k] of Object.entries(DENSITIES)) {
    const mip = join(RES, `mipmap-${d}`);
    png(iconSvg({ layers: ['front'] }), 108 * k, join(mip, 'ic_launcher_foreground.png'));
    png(iconSvg({ layers: ['front'], mono: true }), 108 * k, join(mip, 'ic_launcher_monochrome.png'));
    png(iconSvg({ ...full, view: SHOWN, shape: 'rounded' }), 48 * k, join(mip, 'ic_launcher.png'));
    png(iconSvg({ ...full, view: SHOWN, shape: 'circle' }), 48 * k, join(mip, 'ic_launcher_round.png'));
    png(iconSvg({ ...full, view: SHOWN, shape: 'circle' }), 160 * k, join(RES, `drawable-${d}`, 'splash_icon.png'));
  }

  // F-Droid, GitHub releases.
  png(iconSvg({ ...full, view: SHOWN }), 512, join(LOGO, 'coach-cubed-512.png'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) makeIcons();
