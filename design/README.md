# Design sources

Design work that isn't app code. What it shows, what is decided and what is
open: [docs/ui-design.md](../docs/ui-design.md).

- `mockups/`: a copy of the UI mockups' canvas (plan step 5.2), v1 of
  2026-11-01. The canvas itself is a claude.ai Design artifact,
  <https://claude.ai/artifact/UXtAPva2iUi5m4FWJKxnC5>, private to nordmu's
  account until nordmu shares it. The files are the canvas's own: each
  `.dc.html` is one screen and needs the canvas's runtime (`support.js`, not
  here) to render, and `canvas.json` holds the layout and the notes. Open the
  canvas to see them; this copy is the record. Whenever the canvas changes,
  re-read its files and refresh this copy in the same commit as the doc.
- `checkpoint-a/round-1.html`: checkpoint A's first revision, approved by
  nordmu on 2026-11-02. It's a self-contained page in the canvas's look:
  H, the new L1, an M1–M3 you can drag and press, and the wording pass's
  before/after tables. It was published as
  <https://claude.ai/code/artifact/c1156e32-cab3-4bed-962d-f785be185294>,
  because that session couldn't write the canvas's files. Open it in a
  browser; it loads Barlow from Google Fonts. The canvas doesn't show this
  round yet. A session that can write the canvas ports it there, and
  `mockups/` gets refreshed in the same commit.
- Later, the logo's source files, once the name is fixed
  ([docs/branding.md](../docs/branding.md#the-logo)).
