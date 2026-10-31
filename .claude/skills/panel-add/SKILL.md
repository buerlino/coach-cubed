---
name: panel-add
description: Add a new lift page (panel/tab) to coach — like snatch, a lift analysed on the shared video machine with its own set of diagnostics. Use when asked to add a lift, a tab, a panel, or a "diagnostic set" (e.g. a jerk, a deadlift, an overhead press), or to change which lifts coach offers or the default one. Covers the PAGES registry in app.py, the per-lift DIAGNOSTIC_SETS in diagnostics.js, the shared central settings block, and the restart-vs-reload split.
---

# Add a lift page

This covers the old page in `src/app.py`, which is frozen as the dev
server's reference viewer while the new UI is built
([docs/decisions.md](../../../docs/decisions.md), "What 0.1.0 is").
`DIAGNOSTIC_SETS` lives in `diagnostics.js` and serves the new UI too. Adding
a lift touches neither `INDEX_HTML` nor anything frozen.

Coach's tabs are **pages**, and each has a **medium**: `"image"` (the still
path), `"train"` (the training data explorer) or `"video"`. Every video page
is a **lift** on one shared video machine (upload or record, pose pass,
overlay, keypoint plot) with one settings block. What makes one lift differ
from another is **which diagnostic set runs**, so adding a lift is two small
edits and no new UI: register the page, name its set.

The pages today, in tab order (`PAGES`):

| Page | Medium | Diagnostic set |
| --- | --- | --- |
| `squat` | video | `squat`, which has no entry in `DIAGNOSTIC_SETS`, so it gets none. The squat's rep review comes from the Movement Lab's engine instead (`src/squat/analysis.mjs`, shown by `src/anatomy/review.mjs` only on this page). |
| `image` | image | none |
| `snatch` | video | 2 cues; the reference page and `DEFAULT_PAGE` |
| `lateral-raise` | video | 5 cues |
| `clean-and-jerk` | video | 1 cue (the snatch's first-pull back angle, with its thresholds) |
| `train-data` | train | none |

## The two files

| File | What you add | Takes effect on |
| --- | --- | --- |
| `src/app.py`, `PAGES` | one dict: the tab's id, label, medium, set name | the full app: `./scripts/restart.sh` (the module is loaded once); the local preview: a reload (`launchers/run_local.py` re-reads `app.py` on every request) |
| `src/diagnostics.js`, `DIAGNOSTIC_SETS` | one key: the set name → an array of diagnostics (may be `[]`) | a browser reload (re-read per request) |

The tabs, the mode switch and the diagnostics panel are all derived from these
two: `render_index()` fills the tabs, the settings blocks and the JS page list
from `PAGES` on every request. The settings block is central
(`VIDEO_SETTINGS_HTML` in `app.py`), so a new lift page shows the same
controls as snatch. Don't reintroduce a hand-written panel per lift.

The one optional extra is a tab colour: `INDEX_HTML` has a
`body[data-page="…"]` accent rule for snatch, lateral-raise, image and
train-data. A page without one uses the default accent, so skip it rather
than edit the frozen page.

## Step 1 — register the page (`src/app.py`, `PAGES`)

Add one entry where you want the tab:

```python
PAGES = [
    ...
    {"id": "clean-and-jerk", "label": "clean & jerk", "media": "video",
     "diagnostics": "clean-and-jerk"},
    # new lift:
    {"id": "jerk", "label": "jerk", "media": "video", "diagnostics": "jerk"},
    {"id": "train-data", "label": "train data", "media": "train"},
]
```

A page entry:

| Key | Meaning |
| --- | --- |
| `id` | Stable slug. Drives `data-page` and the JS `setPage(id)`. Kebab-case, no spaces. |
| `label` | What the tab reads. Free text. |
| `media` | `"video"` for a lift, `"image"` for the still path, `"train"` for the explorer. A lift is always `"video"`. |
| `diagnostics` | The set name: a key in `DIAGNOSTIC_SETS`. Omit it for the image and train pages. |

`DEFAULT_PAGE` (just below `PAGES`) is the tab shown on load. Point it at a
lift; the diagnostics live on the video machine.

Keep `id`, the `diagnostics` set name and the `DIAGNOSTIC_SETS` key equal.
The fixtures and the training data explorer use the page id as the manifest's
`diagnostics` field, and the tests score each fixture with that set. Nothing
enforces the match: a typo just yields an empty panel (an unknown set
resolves to `[]`, the "no diagnostics yet" state, not an error). If a new
lift page comes up blank, check this first.

## Step 2 — declare the set (`src/diagnostics.js`, `DIAGNOSTIC_SETS`)

Add a key. Empty is a legitimate, shippable state: a lift page with the
machine working and no cues yet.

```js
const DIAGNOSTIC_SETS = {
  'snatch': [firstPullBackAngle, secondPullTripleExtension],
  'lateral-raise': [lateralRaiseTopHeight, lateralRaiseTorsoLean, lateralRaiseElbowLead, lateralRaiseTempo, lateralRaiseSymmetry],
  'clean-and-jerk': [cleanFirstPullBackAngle],
  'jerk': [],                   // start empty, fill later
};
```

The array holds the **same diagnostic objects** the `lifting-diagnostic`
skill builds. On a video page, `setPage()` in `app.py` calls
`Diagnostics.setPage(page.diagnostics)`, which swaps this array in and
re-scores whatever clip is loaded. An empty set renders the "No diagnostics
for this lift yet." note; a non-empty one renders one section per entry.

The headless entry point, `computeResults()`, scores whichever set is active
(default `snatch`), and the tests set it per fixture from the manifest's
`diagnostics` field. A new *empty* set changes no existing output.

## Step 3 — add the actual diagnostics (later, optional)

That's a different job: one coaching cue → one number, with its phase and its
visualization. Hand it to the **`lifting-diagnostic`** skill. Write the
objects there, then list them under this lift's key in `DIAGNOSTIC_SETS`.
Keep another lift's diagnostics out of this set unless they really apply (the
clean & jerk reuses the snatch's first-pull cue on purpose): the sets are
per-lift, so a cue that only makes sense for a snatch pull doesn't score a
lateral raise.

## Validate

On the full app (`http://127.0.0.1:8080/`, after `./scripts/restart.sh`) or
the local preview (`http://127.0.0.1:8785/`, after a reload):

1. The new tab appears in registry order with your label.
2. Clicking it shows the same video settings as snatch (shared block).
3. With a clip loaded, switching tabs keeps the clip and re-scores it against
   the tab's set: snatch shows its two sections, an empty lift shows the note.
4. Load an example and switch between lifts; the video, plot and overlay
   persist, only the diagnostics panel changes.

Cheap headless checks before touching the browser:

```bash
# app.py renders all tabs, no stray template tokens
.venv/bin/python - <<'PY'
import sys; sys.path.insert(0, 'src')
import app, re
html = app.render_index()
assert not re.findall(r'{{[A-Z_]+}}', html), 'unfilled template token'
print('tabs:', re.findall(r'<button data-page="([a-z-]+)" class="tab"', html))
PY

# diagnostics.js still parses, and every golden snapshot is unchanged
node -e "global.window={};require('./src/diagnostics.js');console.log('setPage',typeof window.Diagnostics.setPage)"
npm test
```

The Python needs Flask and the backends: the `.venv` from
`setup_no_conda_linux.sh`, or the `coach` conda env (`conda run -n coach
python …`).
