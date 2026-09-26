# coach · Version 5

Extract the complete ZIP into its new, versioned folder. Older versions remain
separate. Both packages contain both real pages and the same features.

| Package | Intended interface | Windows launcher | Default address |
| --- | --- | --- | --- |
| coach-original-ui-v5.zip | Your friends' original layout, with added anatomy / squat tools | launchers/OPEN_ORIGINAL_UI_WINDOWS.bat | http://127.0.0.1:8785/original/ |
| coach-anatomy-ui-v5.zip | Our teal Movement Lab, with original exercise diagnostics / 3D tools | launchers/OPEN_ANATOMY_UI_WINDOWS.bat | http://127.0.0.1:8784/squat/ |

On macOS use the matching `launchers/OPEN_ORIGINAL_UI_MACOS.command` or
`launchers/OPEN_ANATOMY_UI_MACOS.command`. First-time setup remains
`launchers/setup-local-windows.bat` / `launchers/setup-local-macos.command` (Python 3.10+ recommended).
All of the above live in the `launchers/` folder; double-click them from there
(or run them from the repo root) — they find `.venv` and `src/` by walking up
from their own location, so moving just one file out of `launchers/` breaks it.
The header must say **Original UI · Version 5** or **VERSION 5 · ANATOMY UI**.

The earlier `start-squat` launcher forced the teal page even in the original-UI
package. That mistake is fixed: all generic/legacy launchers now respect the
package default. The explicitly named launchers above select their stated UI
regardless of which package they are in. Original layout, colours and diagnostic
sections are preserved. Header links also switch between the pages; export the
session first because switching pages reloads it.

## Three display buttons

Both interfaces now show these buttons directly above the video/model:

- **3D pane + model**: composite the anatomy model into the existing 3D
  reconstruction pane ("Inspect original 3D reconstruction", below the video)
  instead of drawing it over the video image itself — it's a real, orbit-able
  3D object there, draggable independently of whatever size video produced it.
- **Model only**: hide the video and show a full-size model, with rotation/zoom.
  The same clip keeps driving the model. Play, pause, speed and scrubbing remain
  available; hiding the video does not discard or replace it.
- **Side by side**: display the video and model in two synchronized panels.

Clicking one of these buttons enables anatomy if needed. **Show anatomy** still
switches the entire feature off and restores the video. **Match video camera**
returns the model to the recorded viewpoint. Overlay opacity applies only to
3D pane + model; the model is opaque in the other two modes.

## Stabilize the hands against a bar

1. Select the actual placement under **Barbell**. For a back squat choose
   **Present · across upper back**. For a held bar choose **Present · held in hands**.
   **Detected equipment only** needs equipment detections in the loaded track;
   browser MediaPipe does not detect a bar automatically.
2. Leave **Keep hands on bar** enabled. The display uses a smoothed bar trajectory,
   fixed grip spacing and an elbow solution to keep the hands attached. Hidden
   wrists remain estimated rather than disappearing.
3. If spacing is wrong, pause at a representative gripping frame and choose
   **Set grip from this frame**, then adjust **Grip width** if necessary. Video
   foreshortening makes this a visual estimate, not a measured hand separation.
4. Turn **Keep hands on bar** off when a lift includes a release, re-grip or a
   different hand position that the lock should not enforce. The model does not
   automatically recognize a released grip. An unreachable target releases its
   constraint instead of stretching an arm; status text reports this.

Grip constraints affect only the displayed model. They never alter detector
landmarks, diagnostic findings, squat failure hypotheses or activation estimates.
The atlas fingers are not individually articulated into a closed fist: this
stabilizes the hand/palm pose, not finger-level grasp mechanics.

Motion stabilization, conditional stationary-foot contact, whole-body retention,
manual hip/spine points, original exercise diagnostics and 3D profiles/optimizer
from version 4 remain available. All anatomical additions start off. The body
stays geometrically complete through tracking gaps; estimated regions are blue-grey.
Normal 3D occlusion and the video crop still apply.

## Launch from a terminal

Run from the repo root (not from inside `launchers/`):

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-preview.txt
.venv/bin/python launchers/run_original.py
# or: .venv/bin/python launchers/run_anatomy.py
```

Windows uses `.venv\Scripts\python.exe`. Pass `--port 8786` for an occupied port.
Keep the terminal open; Ctrl+C stops the server. Do not double-click HTML files.
Use a browser with WebGL and WebAssembly, such as Chrome or Edge.

Video inference runs locally in the browser; geometric reconstruction uses pose
coordinates on the local loopback server. Use the anatomy attribution files for
the bundled model's source information.
