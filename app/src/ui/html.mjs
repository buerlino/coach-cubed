// SPDX-License-Identifier: AGPL-3.0-or-later
// htm bound to Preact's h: `html` is the tagged template every screen writes
// its markup with. 'preact' and 'htm' are bare names that index.html's import
// map points at the pinned, vendored files (app/README.md says why).
import { h } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);
