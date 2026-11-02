// The page test's fixtures, one per lift (s49): the committed track the replay
// engine answers with (tests/fixtures/global/example/) and the clip it is
// matched to (tests/app/clips/, the same frame count and fps). assemble.mjs
// --test copies the tracks (TEST_TRACKS), page-test.mjs walks one lift per
// entry. Test-only paths, so not in the registry (app/src/contracts/lifts.mjs),
// which ships. A lift with no entry here isn't walked by the page test, and
// the page test lists it (fixtureCoverage().untested). How to make one:
// docs/lifts.md, "Adding a lift".
import { LIFTS } from '../src/contracts/lifts.mjs';

/**
 * @type {ReadonlyArray<{lift: string, track: {id: string, file: string}, clip: string}>}
 *   lift: a registry id; track.id: the fixture's manifest id under global/; track.file: its track in
 *   tests/fixtures/global/example/; clip: tests/app/clips/'s clip with the track's frame count and fps
 */
export const LIFT_FIXTURES = Object.freeze([
  Object.freeze({
    lift: 'lateral-raise',
    track: Object.freeze({ id: 'example/lateral-raise-cable-1', file: 'lateral-raise-cable-1.track.json' }),
    clip: 'testsrc2-lateral-raise-25fps-75f.mp4',
  }),
  Object.freeze({
    lift: 'snatch',
    track: Object.freeze({ id: 'example/athlete-a-trim', file: 'athlete-a-trim.track.json' }),
    clip: 'testsrc2-snatch-30fps-107f.mp4',
  }),
]);

/**
 * Which of the app's lifts the page test walks, and which it can't.
 * @param {readonly string[]} [lifts] the registry's ids, in order (default: LIFTS, read when called)
 * @returns {{walked: typeof LIFT_FIXTURES, untested: string[]}} walked: the fixtures of those lifts,
 *   in the lifts' order; untested: the lifts with no fixture
 */
export function fixtureCoverage(lifts = LIFTS) {
  const walked = [];
  const untested = [];
  for (const id of lifts) {
    const f = LIFT_FIXTURES.find(x => x.lift === id);
    if (f) walked.push(f); else untested.push(id);
  }
  return { walked, untested };
}
