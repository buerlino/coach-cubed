---
name: panel-add
description: Add a new lift page (panel/tab) to coach — like snatch, a lift analysed on the shared video machine with its own set of diagnostics. Use when asked to add a lift, a tab, a panel, or a "diagnostic set" (e.g. lateral raise, clean, jerk, squat), or to change which lifts coach offers or the default one. Covers the PAGES registry in app.py, the per-page DIAGNOSTIC_SETS in diagnostics.js, the shared central settings block, and the restart-vs-reload split.
---

# Add a lift page

Coach's tabs are **pages**. A page is either the image path or a **lift** on the
shared video machine. Every lift page reuses one video machine (upload / record,
pose pass, overlay, keypoint plot) and one settings block — the *only* thing that
makes one lift differ from another is **which diagnostic set runs**. So adding a
lift is two small edits and no new UI: register the page, name its set.

`snatch` is the reference page; `lateral-raise` is the worked example of a lift
with **no diagnostics yet** — a fully working page (upload, pose, plot) whose
diagnostics panel just says so.

## The two files

| File | What you add | Takes effect on |
| --- | --- | --- |
| `src/app.py` — `PAGES` | one dict: the tab's id, label, medium, set name | `./scripts/restart.sh` (it's in `INDEX_HTML`) |
| `src/diagnostics.js` — `DIAGNOSTIC_SETS` | one key: the set name → an array of diagnostics (may be `[]`) | a browser reload (re-read per request) |

Nothing else. The tabs, the mode switch and the diagnostics panel are all
derived from these two. There is **no per-page markup** to write — the settings
block is central (`VIDEO_SETTINGS_HTML` in `app.py`), so a new lift page shows
the same controls as snatch for free. That is the whole point of the split;
don't reintroduce a hand-written panel per lift.

## Step 1 — register the page (`src/app.py`, `PAGES`)

Append one entry, in the tab order you want:

```python
PAGES = [
    {"id": "image", "label": "image", "media": "image"},
    {"id": "snatch", "label": "snatch", "media": "video", "diagnostics": "snatch"},
    {"id": "lateral-raise", "label": "lateral raise", "media": "video",
     "diagnostics": "lateral-raise"},
    # new lift:
    {"id": "clean", "label": "clean", "media": "video", "diagnostics": "clean"},
]
```

A page entry:

| Key | Meaning |
| --- | --- |
| `id` | Stable slug. Drives `data-page`, the JS `setPage(id)`, and must equal the `DIAGNOSTIC_SETS` key. Kebab-case, no spaces. |
| `label` | What the tab reads. Free text. |
| `media` | `"video"` for a lift (shared video machine) or `"image"` (the still path). A lift is always `"video"`. |
| `diagnostics` | The set name — a key in `DIAGNOSTIC_SETS`. Omit only for `media: "image"`. |

`DEFAULT_PAGE` (just below `PAGES`) is the tab shown on load. Point it at a lift;
the diagnostics live on the video machine and the image path is the side trip.

`id` == the `diagnostics` set name == the `DIAGNOSTIC_SETS` key is the one
invariant to keep. Nothing enforces it — a typo just yields an empty page (an
unknown set resolves to `[]`, which is the "no diagnostics yet" state, not an
error). If a new lift page comes up blank, check this match first.

## Step 2 — declare the set (`src/diagnostics.js`, `DIAGNOSTIC_SETS`)

Add a key. Empty is a legitimate, shippable state — a lift page with the machine
working and no cues yet:

```js
const DIAGNOSTIC_SETS = {
  'snatch': [firstPullBackAngle, secondPullTripleExtension],
  'lateral-raise': [],          // worked example: a page, no cues
  'clean': [],                  // start empty, fill later
};
```

The array holds the **same diagnostic objects** the `lifting-diagnostic` skill
builds — nothing new to learn about their shape. `app.py`'s `setPage()` calls
`Diagnostics.setPage(name)` on every tab click, which swaps this array in and
re-scores whatever clip is loaded against it. An empty set renders the
"No diagnostics for this lift yet." note; a non-empty one renders one section per
entry, exactly as snatch does.

Which set `computeResults()` iterates is module state (default `snatch`), so the
headless test entry point and the golden snapshots are unaffected by adding a
page — a new *empty* set changes no existing output.

## Step 3 — add the actual diagnostics (later, optional)

That's a different job: one coaching cue → one number, with its phase and its
visualization. Hand it to the **`lifting-diagnostic`** skill. Write the objects
there, then list them under this lift's key in `DIAGNOSTIC_SETS`. Keep another
lift's diagnostics out of this set — the sets are per-lift on purpose, so the
back-angle cue that only makes sense for a snatch pull doesn't score a lateral
raise.

## Validate

`src/app.py` change ⇒ **`./scripts/restart.sh`** (PAGES is baked into the HTML).
`src/diagnostics.js` change ⇒ **browser reload** (re-read per request).

Then, on `http://127.0.0.1:8080/`:

1. The new tab appears in registry order with your label.
2. Clicking it shows the same video settings as snatch (shared block).
3. With a clip loaded, switching tabs keeps the clip and re-scores it against the
   tab's set — snatch shows its two sections, an empty lift shows the note.
4. Load an example and switch between lifts; the video, plot and overlay persist,
   only the diagnostics panel changes.

Cheap headless checks before touching the browser:

```bash
# app.py renders all tabs, no stray template tokens
python - <<'PY'
import sys; sys.path.insert(0, 'src')
import app, re
html = app.render_index()
assert not re.findall(r'{{[A-Z_]+}}', html), 'unfilled template token'
print('tabs:', re.findall(r'data-page="([a-z-]+)"', html))
PY

# diagnostics.js still parses and the golden snapshot (snatch) is unchanged
node -e "global.window={};require('./src/diagnostics.js');console.log('setPage',typeof window.Diagnostics.setPage)"
npm test
```

(Run Python with the `coach` conda env — `conda run -n coach python …` — it has
Flask and the backends.)
