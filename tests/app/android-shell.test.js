'use strict';
// The Capacitor shell (package c20): app/capacitor.config.json, the committed
// app/android/ project, the pinned Capacitor packages and tools/build-apk.sh.
// Static checks only: the APK itself is built and run on the phone
// (build-apk.sh, check-apk.mjs), never in a test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..', '..', 'app');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
const PLACEHOLDER_ID = 'org.coach.placeholder';

test('capacitor.config.json: webDir dist, the name coach, the placeholder app ID, https scheme', () => {
  const cfg = JSON.parse(read('capacitor.config.json'));
  assert.equal(cfg.webDir, 'dist');
  assert.equal(cfg.appName, 'coach');
  assert.equal(cfg.appId, PLACEHOLDER_ID);
  assert.equal(cfg.server?.androidScheme, 'https', 'a secure origin: OPFS and WebCodecs need it');
  assert.ok(!cfg.server?.url, 'the app is served from the APK, never from a server');
  assert.ok(read('README.md').includes(PLACEHOLDER_ID), 'app/README.md names the placeholder app ID');
});

test('Capacitor 8.5.3 is pinned exactly, in package.json and its lock file', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  for (const name of ['@capacitor/core', '@capacitor/cli', '@capacitor/android']) {
    assert.equal(pkg.dependencies?.[name], '8.5.3', name);
    assert.equal(lock.packages[`node_modules/${name}`]?.version, '8.5.3', `${name} in the lock file`);
  }
});

test('the committed Android project: the placeholder ID, no camera permission, no release signing', () => {
  const gradle = read('android/app/build.gradle');
  assert.match(gradle, new RegExp(`applicationId "${PLACEHOLDER_ID.replace(/\./g, '\\.')}"`));
  assert.match(gradle, /noCompress \+= \['bin', 'mp4'\]/, 'the weights are stored, not deflated');
  assert.doesNotMatch(gradle, /signingConfig/, 'debug builds only: no release signing until c33');
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.doesNotMatch(manifest, /CAMERA/, 'no camera permission before milestone B');
  const perms = [...manifest.matchAll(/uses-permission android:name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(perms, ['android.permission.INTERNET'], 'Capacitor\'s local server needs INTERNET; nothing else');
  const activity = `android/app/src/main/java/${PLACEHOLDER_ID.replace(/\./g, '/')}/MainActivity.java`;
  assert.ok(fs.existsSync(path.join(APP, activity)), activity);
  assert.ok(fs.existsSync(path.join(APP, 'android/gradlew')));
  // Generated at build time, never committed.
  const ignore = read('android/.gitignore');
  for (const p of ['app/src/main/assets/public', 'capacitor-cordova-android-plugins', 'build/', 'local.properties']) {
    assert.ok(ignore.includes(p), `android/.gitignore keeps out ${p}`);
  }
});

test('build-apk.sh: the bundle and the weights first, assemble --debug, cap sync, Gradle niced to one worker, debug only', () => {
  const sh = read('tools/build-apk.sh');
  const order = ['tools/build-tfjs.mjs', 'tools/fetch-models.sh', 'tools/assemble.mjs --debug', 'cap sync android', 'assembleDebug'];
  const at = order.map((s) => sh.lastIndexOf(s));   // the commands, not the header's words
  for (const [i, s] of order.entries()) assert.ok(at[i] > 0, `build-apk.sh runs ${s}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in that order');
  assert.match(sh, /nice -n 19 \.\/gradlew[^\n]*--max-workers=1/);
  assert.match(sh, /--no-daemon/);
  assert.doesNotMatch(sh, /assembleRelease|bundleRelease|signingConfig|apksigner/);
  assert.ok(fs.statSync(path.join(APP, 'tools/build-apk.sh')).mode & 0o100, 'executable');
});

test('the check page lives in app/debug/ and is reachable only in the debug build', () => {
  for (const f of ['debug/check.html', 'debug/check.mjs']) assert.ok(fs.existsSync(path.join(APP, f)), f);
  const page = read('debug/check.mjs');
  assert.match(page, /\.\.\/src\/pose\/pose-client\.mjs/);
  assert.match(page, /\.\.\/src\/media\/frame-source\.mjs/);
  // The app links nowhere into debug/.
  for (const f of ['index.html', 'src/main.mjs']) assert.doesNotMatch(read(f), /debug\//, f);
});
