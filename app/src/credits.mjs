// SPDX-License-Identifier: AGPL-3.0-or-later
// S1's credits: every component THIRD_PARTY.md lists in "In the new app (app/)",
// in the table's order, with its licence and where the licence text is in the
// assembled app (a path from the app's root, so the service worker caches it
// and it reads offline). Plain data; tests/app/settings.test.js compares it
// with the table, so a row added there must be added here.
//
// `row`: how the table's first cell starts. `shipped`: false for what only the
// build uses (it is listed all the same). `built`: the text is copied by the
// TF.js build (tools/build-tfjs.mjs) into the gitignored app/vendor/tfjs/, so
// it is in the shipped app, not in a fresh checkout.

/**
 * @typedef {Object} Credit
 * @property {string} row
 * @property {string} name
 * @property {string} version
 * @property {string} licence an SPDX identifier
 * @property {string} notice the copyright holder, or what to say instead
 * @property {string} text the licence text, from the app's root
 * @property {boolean} shipped
 * @property {boolean} [built]
 */

/** @type {readonly Credit[]} */
export const CREDITS = Object.freeze([
  { row: 'Preact', name: 'Preact, with its hooks', version: '11.1.1', licence: 'MIT', notice: '© 2015-present Jason Miller', text: 'vendor/preact/LICENSE', shipped: true },
  { row: 'htm', name: 'htm', version: '3.1.1', licence: 'Apache-2.0', notice: '© 2018 Google Inc.', text: 'vendor/htm/LICENSE', shipped: true },
  { row: 'Barlow (', name: 'Barlow (font)', version: '5.3.0', licence: 'OFL-1.1', notice: '© 2017 The Barlow Project Authors', text: 'vendor/fonts/barlow/OFL.txt', shipped: true },
  { row: 'Barlow Condensed', name: 'Barlow Condensed (font)', version: '5.3.0', licence: 'OFL-1.1', notice: '© 2017 The Barlow Project Authors', text: 'vendor/fonts/barlow-condensed/OFL.txt', shipped: true },
  { row: 'TensorFlow.js:', name: 'TensorFlow.js', version: '4.22.0', licence: 'Apache-2.0', notice: 'The TensorFlow.js authors', text: 'vendor/tfjs/LICENSE-tfjs.txt', shipped: true, built: true },
  { row: 'TF.js pose-detection', name: 'TensorFlow.js pose-detection (MoveNet only)', version: '2.1.3', licence: 'Apache-2.0', notice: 'The TensorFlow.js models authors', text: 'vendor/tfjs/LICENSE-tfjs-models.txt', shipped: true, built: true },
  { row: 'long', name: 'long', version: '4.0.0', licence: 'Apache-2.0', notice: 'The long.js authors', text: 'vendor/tfjs/LICENSE-long.txt', shipped: true, built: true },
  { row: 'seedrandom', name: 'seedrandom', version: '3.0.5', licence: 'MIT', notice: '© 2019 David Bau, and alea.js © 2010 Johannes Baagøe', text: 'vendor/tfjs/LICENSE-seedrandom.txt', shipped: true, built: true },
  { row: 'MoveNet SinglePose Thunder', name: 'MoveNet SinglePose Thunder v4 (the pose model)', version: '4', licence: 'Apache-2.0', notice: 'Google', text: 'licences/Apache-2.0.txt', shipped: true },
  { row: 'mediabunny', name: 'mediabunny', version: '1.61.6', licence: 'MPL-2.0', notice: '© 2026-present Vanilagy and contributors. Unmodified: its source is the file in the app', text: 'vendor/mediabunny/LICENSE', shipped: true },
  { row: 'Capacitor', name: 'Capacitor (the Android shell)', version: '8.5.3', licence: 'MIT', notice: '© 2017-present Drifty Co.', text: 'licences/MIT-capacitor.txt', shipped: true },
  { row: "The APK's Android libraries", name: "The APK's Android libraries (AndroidX, Apache Cordova, Kotlin, Guava's listenablefuture, JetBrains annotations, JSpecify)", version: 'as THIRD_PARTY.md lists', licence: 'Apache-2.0', notice: 'Their authors', text: 'licences/Apache-2.0.txt', shipped: true },
  { row: 'The coach³ logo', name: 'The coach³ logo and its icons', version: '2026-11-03', licence: 'CC-BY-SA-4.0', notice: '© 2026 nordmu', text: 'licences/CC-BY-SA-4.0.txt', shipped: true },
  { row: 'esbuild', name: 'esbuild (builds the TF.js bundles; not in the app)', version: '0.28.2', licence: 'MIT', notice: '© 2020 Evan Wallace', text: 'licences/MIT-esbuild.txt', shipped: false },
  { row: 'TF.js from npm', name: "TensorFlow.js from npm (the build's parity check; not in the app)", version: '4.22.0, pose-detection 2.1.3', licence: 'Apache-2.0', notice: 'The TensorFlow.js authors', text: 'licences/Apache-2.0.txt', shipped: false },
]);

/** The licence text's URL: next to this module's app, so it works from the page, the service worker's cache and Node. */
export const creditUrl = credit => new URL(`../${credit.text}`, import.meta.url);

/** Where THIRD_PARTY.md's section for the new app is in the assembled app (assemble.mjs cuts it out), and its URL. */
export const THIRD_PARTY_TEXT = 'licences/THIRD_PARTY.md';
export const thirdPartyUrl = () => new URL(`../${THIRD_PARTY_TEXT}`, import.meta.url);
