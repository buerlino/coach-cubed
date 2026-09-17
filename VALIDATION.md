# Verification — version 5

Completed on the final source:

- **57/57 Node tests pass** (`npm test`), including unchanged original diagnostic
  golden snapshots and original viewer interaction tests. Seven new grip tests
  cover moving-bar contact and spacing, raw-data preservation, deterministic
  seeking, off/no-equipment behavior, back-rack squat contact, impossible targets,
  manual width/reference changes, and a hidden wrist retaining estimated contact.
- **3/3 Python launcher tests pass** (`python -m unittest discover -s tests -p
  'test_*.py'`): package defaults, explicit UI overrides, and every named/legacy
  Python entry point. These tests intercept server startup and inspect the URL.
- DOM harnesses execute the actual teal and original application modules with
  actual Three.js geometry/math. Both pass view-button selection, model-only
  video hiding, transport/scrubbing, comparison and overlay restoration, automatic
  anatomy enable, grip controls, original diagnostics and 3D handoff, manual spine
  correction, and squat feedback/activation gates. WebGLRenderer, video playback
  and network responses are mocked; these are not end-to-end browser tests.
- Actual skinned atlas geometry and the bar were inspected using a CPU rasterizer
  on the synthetic squat. All 337 surfaces remain present and transforms are
  finite. The atlas fingers are static; no finger-level grasp solve is claimed.
- HTTP smoke checks cover both pages, modules/model assets, methods/profiles,
  full-sequence geometric reconstruction (75 cached frames), and video byte ranges.
- Authored JavaScript and Python syntax checks pass. The original page's embedded
  CSS, `diagnostics.js`, `depth_backend.py` and original Three.js vendor module
  remain byte-identical to the uploaded project. Existing diagnostic goldens
  and anatomical model files were not regenerated.

Limits:

- Live WebGL, browser media decoding/performance and inference on the user's
  machine remain unverified. The available browser previously refused the local
  server. DOM and CPU verification do not establish browser playback quality.
- The problematic user video was not supplied, so its particular alignment,
  wrist accuracy and re-grips have not been validated. Grip locking imposes a
  display assumption; it cannot verify a hidden hand's actual movement.
- Grip contact is approximate. The user must release the lock during real release
  or repositioning. A coarse equipment box may locate the bar incorrectly;
  manual upper-back/hand-held modes and width calibration are available.
- Fingers do not articulate into a fist. Regional atlas skinning and soft tissue
  motion remain simplified. Normal occlusion can still hide surfaces from view.
- Medical/physiological activation, causal failure analysis, calibrated limb lengths
  and individual vertebral motion are not validated. Display constraints do not
  change diagnostic inputs.
- The complete Flask/ViTPose installation and current GitHub HEAD were not verified.
  This build integrates the uploaded snapshot. No GitHub writes were made.
