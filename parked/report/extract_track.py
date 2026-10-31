"""Run coach's pose pipeline over a clip and cache the track as JSON.

    python extract_track.py examples/athlete-a-trim.mp4 [size]

Writes <clip>.track.json next to the clip: {"keypoints": {frame: {pid: Nx3}},
"meta": {...}} — exactly what /api/pose/video returns, so analysis.ipynb sees
the same payload the browser does. Needs the `coach` conda env (torch/ROCm +
easy_ViTPose); the notebook itself only needs numpy/matplotlib and calls this
through the coach interpreter when the cache is missing.
"""
import json
import sys
from pathlib import Path

# parked/report/extract_track.py: the repo root is three levels up.
ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "src"))    # vitpose_backend lives in src/

import vitpose_backend  # noqa: E402

clip = Path(sys.argv[1])
size = sys.argv[2] if len(sys.argv) > 2 else "l"
out = clip.with_suffix(".track.json")

keypoints, meta = vitpose_backend.infer_video(
    clip.read_bytes(), size=size, frame_stride=1, suffix=clip.suffix)
out.write_text(json.dumps({"keypoints": keypoints, "meta": meta}))
print(f"{out}: {meta['frames_processed']} frames, kept person {meta['tracks']['kept']}, "
      f"dropped {[d['id'] for d in meta['tracks']['dropped']]}")
