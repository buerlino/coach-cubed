// SPDX-License-Identifier: AGPL-3.0-or-later
// L1's logic as plain functions (package d53): the tiles of "Which lift?" and the step to M. The lift is
// chosen here and nowhere else (nordmu, 2026-11-02, checkpoint A's point 5). No Preact and no DOM, so Node
// runs it as written (tests/app/lift.test.js); screens/L1.mjs only draws what these give.
import { isLift } from '../contracts/lifts.mjs';
import { liftChoices, startLift } from './home-model.mjs';

/**
 * L1's tiles: the registry's lifts in its order (a lift registered later is a tile too), each with its
 * label, its `provisional` flag, whether it is S1's default lift (the first lift while the settings load,
 * or when the setting names a lift the registry lacks) and the accessible name of its button.
 * @param {{defaultLift?: string}|null|undefined} settings
 * @returns {Array<{id: string, label: string, provisional: boolean, isDefault: boolean, name: string}>}
 */
export function liftTiles(settings) {
  const start = startLift(settings);
  return liftChoices().map(c => ({
    ...c,
    isDefault: c.id === start,
    name: `${c.label}${c.provisional ? ', provisional' : ''}${c.id === start ? ', default' : ''}`,
  }));
}

/**
 * One tap on a tile: the picked file and the lift go on to M. Nothing changes for a lift the registry
 * doesn't have, or when the flow carries no file.
 * @param {{go: Function, params: {file?: File}}} flow
 * @param {string} lift
 * @returns {{ok: true}|{ok: false, error: string}}
 */
export function chooseLift(flow, lift) {
  const { file } = flow.params;
  if (!isLift(lift)) return { ok: false, error: 'Choose one of the lifts.' };
  if (!file) return { ok: false, error: 'Pick a video first.' };
  flow.go('mark', { file, lift });
  return { ok: true };
}
