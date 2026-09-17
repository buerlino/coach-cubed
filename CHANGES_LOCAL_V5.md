# Version 5

## Original UI and launchers

Fixed the legacy `run_squat.py` path which opened `/squat/` in both packages.
Generic launchers now respect `ui-config.mjs`. New explicit `run_original.py`
and `run_anatomy.py` entry points and named Windows/macOS launchers open the
correct real page with distinct ports 8785 / 8784 and visible version labels.
The original page's embedded CSS is byte-identical to the uploaded source.
Shared anatomy controls use additional scoped CSS. Versioned ZIPs also contain
versioned root folders, so they coexist with earlier downloads.

## View controls

Both pages expose Video + model, Model only, and Side by side as visible buttons.
Model-only hides the video presentation, retains the video clock and has usable
transport controls. The original playback scheduler uses animation frames and
video time in this mode so it does not depend on a hidden video's compositor
callback. The original diagnostic engine and scoring are unchanged.
Disabling anatomy restores video. Separate model modes use full canvas opacity.

## Hand stability

`src/anatomy/grip.mjs` computes a display-only grip reference from the sequence.
It smooths bar centre/direction over a short symmetric window, maintains consistent
axis signs and fixed spacing, and solves elbow placement for each reachable hand
contact. Hand orientation is referenced to the bar to reduce wrist/hand flips.
Contact points and limb dimensions are estimated. A manual reference frame and
width adjustment are available. Locking can be disabled for release/re-gripping;
unreachable contacts release rather than stretching arms.

The raw sequence is unchanged, and constrained coordinates never reach the
original diagnostic engine, squat measurements, activation rules or feedback
ranking. Independent finger articulation is not implemented; the atlas hand
surfaces retain their static finger arrangement.
