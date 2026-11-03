'use strict';
// Package d55: the words of Q1, A1, A2, A3 and S1 after round 1's wording pass (design/checkpoint-a/round-1.html,
// window.WORDING; nordmu approved it in full). Each "after" is in the code and each "before" is gone; strings that
// are not in the table (Noah's cue texts, S1's privacy text, d23's problem panels) are pinned by their own tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP = path.resolve(__dirname, '..', '..', 'app');
const ui = (...p) => fs.readFileSync(path.join(APP, 'src', 'ui', ...p), 'utf8');
const load = rel => import(pathToFileURL(path.join(APP, 'src', rel)).href);

const check = (name, src, after, before) => test(`d55 wording: ${name}`, () => {
  for (const s of after) assert.ok(src().includes(s), `has: ${s}`);
  for (const s of before) assert.ok(!src().includes(s), `lost: ${s}`);
});

check('Q1 says less', () => ui('screens', 'Q1.mjs'),
  ['Keeps going if you leave.', '+${view.queue.more} more', 'Nothing to analyse.', "label: 'Home'", '>Cancel<', 'That didn’t work.'],
  ['Runs on this phone', 'and ${view.queue.more} more', 'Nothing is being analysed.', "label: 'Back to home' }", 'Cancel this analysis', 'That did not work.']);

check('the pipeline view says less', () => ui('analysing-model.mjs'),
  ['`~${Math.round(seconds / 60)} min`', "'Up next'", "'Before this'", "'estimating…'", '${p.done} / ${p.total}'],
  ['about ', 'Ahead in the queue', 'Next in the queue', 'measuring the speed', 'frame ${p.done}', 'Kept ${']);

check('A1', () => ui('screens', 'A1.mjs'),
  ["'No lift to show.'", "'No result yet.'", 'Couldn’t show this lift.', '>Details<'],
  ['There is no lift to show', 'This lift has no result yet.', 'could not be shown', 'Plot and details']);

check('A2', () => ui('screens', 'A2.mjs'),
  ["'No lift to show.'", "'No result yet.'", "'No such cue.'", 'Couldn’t show this cue.', 'band: both sides'],
  ['There is no lift to show', 'This lift has no result yet.', 'This lift has no such cue.', 'could not be shown', 'the two sides']);

check('the breadcrumb', () => ui('wide-model.mjs'), ["'Today'", "'Earlier'"], ["Today's session", 'Earlier sessions']);

check('A3', () => ui('view-options-model.mjs'),
  ['The lines each cue measures', 'Under 30 % sure', 'Skips walking in and out', "speed: 'Speed'", 'Changes the scores. Thresholds assume 50 ms.',
    'Delete this lift and its video? This can’t be undone.', 'Couldn’t save this: ', 'Couldn’t change the smoothing: ', 'Couldn’t open this lift: ', 'Couldn’t delete this lift: ', 'That didn’t work.'],
  ['joint by joint', 'like the elbow line', 'less than 30%', 'walk-in', 'Playback speed', 'assume the default', 'its video and result are removed', 'could not be kept', 'could not be changed', 'could not be opened for marking', 'could not be deleted', 'That did not work.']);

check('S1', () => ui('settings-model.mjs') + ui('screens', 'S1.mjs'),
  ['Up to 30 fps; less in dim light.', 'The delay comes later.', 'Free for the app', 'If the phone runs very low on space, the system may remove them.',
    'Can’t delete while lifts are being analysed.', 'coach is built with these. Their licences are in the app, readable offline.', 'Loading…', 'Couldn’t load this licence.', 'That didn’t work.'],
  ['camera gives up to 30 fps', 'come with the camera', 'These come with the gym session, later.', 'Room left for the app', "hasn't promised", "can't be deleted. Wait", 'made with the components', 'Reading the licence text', "couldn't be read from the app's files", 'Something went wrong.']);

test('d55 wording: aboutTime is written once and the queue line and the time left share it', async () => {
  const { aboutTime } = await load('ui/analysing-model.mjs');
  assert.equal(aboutTime(37.2), '~38 s');
  assert.equal(aboutTime(150), '~3 min');
  assert.equal(aboutTime(0), '~1 s');
});

test('d55 wording: the strings that are not in the table stay (the privacy text, the problem panels, the cue to play at ½×)', async () => {
  const { PRIVACY } = await load('ui/settings-model.mjs');
  assert.equal(PRIVACY.lead, 'Nothing leaves this phone.');
  assert.match(PRIVACY.body, /^The app keeps your analysed lifts/);
  const det = await load('ui/detail-model.mjs');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'design', 'mockups', 'CueDetail.dc.html'), 'utf8').includes(det.PLAY_HALF_LABEL));
  assert.equal(det.PLAY_HALF_LABEL, 'Play the rep at ½×');
});
