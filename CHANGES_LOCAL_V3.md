# Local revision 3

Source: `coach-main (1)(1).zip`, supplied in this conversation.
SHA-256: `199328bc7981ba18108263fda36322cfcba5c56d7afa1510e6c87928b153c6ca`.
This is not a verified pull of GitHub HEAD. The connector still returned 404.
No GitHub write, remote branch, commit or pull request was created.

## Integration

The uploaded snapshot adds clip-wide torso/bone scaling, trunk-width fitting,
limb/depth-direction profiles, optimization controls and new diagnostics/viewer
regressions. Its `depth_backend.py`, `diagnostics.js` and original Three.js
module remain byte-identical. The existing page renderer and controls are
shared by both UI packages. Original documentation, fixtures and tests are
retained. The 337 anatomical source surfaces are unchanged from revision 2.

The lightweight local server now executes the same geometric depth/profile
routes as the full application, through a small AST adapter that avoids loading
ViTPose. NumPy and OpenCV are required for those routes. Profile saves affect
only the local project. Browser pose is still used for new clips in this
launcher; full Flask inference remains available through the original scripts.

## Pose and visibility fixes

- Register reconstructed depth to image-space joints; use image positions and
  original frame times to keep the model over the person in the video.
- Hand the original per-frame reconstruction directly to the anatomy renderer.
  Explicit keypoint-lift selection now requests a whole sequence too.
- Keep body thickness and orbit framing fixed across a clip. Replace the old
  per-frame guessed depth-side flip with clip-level registration/prior.
- Keep inferred elbow/wrist/knee/ankle chains when confidence is lost, using
  parent-relative temporal continuity. Never-observed limbs use an atlas prior.
  Keep independently visible distal joints on their observed positions.
- Tint inferred limb meshes blue-grey. Missing tracking no longer hides an
  entire arm just because one skinning attachment is absent. Fully missing
  body tracking still hides the model. Depth and hidden motion remain uncertain.
- Preserve all raw diagnostic inputs: display fills and manual spine points
  are not measurements and cannot support squat failure hypotheses.

## Two presentations

`coach-anatomy-ui.zip` defaults to our movement-lab presentation, with the
original diagnostics, 3D methods, profiles and optimizer inside its cards.
`coach-original-ui.zip` defaults to the original exercise layout with the
anatomy toolbar and squat review added. Only `ui-config.mjs` and the package
label differ; the implementation and features are shared. Header selection
can also switch presentation (reloads the page).

Both offer default-off anatomy, video overlay or side-by-side comparison,
matched-camera/orbit inspection, layer/opacity switches, hip/spine points,
manual corrections and the original exercise tabs. The dedicated squat lab
uses the same improved anatomy renderer and display sequence.

Squat rep review and the per-rep feedback dialog are now also available in the
shared exercise workspace. Activation colours use squat movement rules only;
other exercises keep neutral colours. Feedback remains a bounded secondary
input and never changes activation. These rules are not physiologically
validated and cannot establish a causal muscle failure from video.

## Review focus

Test a short clip with an arm passing behind the torso; scrub both ways and
compare the tracked overlay, blue-grey inference and video. Check the same
clip in both layouts. Inspect the original 3D view before trusting any depth
assumption; a wrong limb profile or depth direction also affects anatomy.
The upstream optimizer's documented bias remains (`TODO.md`). Individual
spinal motion, atlas skinning and extreme joint poses need anatomical review.
