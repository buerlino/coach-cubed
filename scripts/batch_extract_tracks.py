"""Drive a running coach app through a pile of clips and cache each one's
pose track as a test fixture.

    ./scripts/coach_launch.sh local          # or coach_launch_venv.sh
    python scripts/batch_extract_tracks.py --stance snatch clip1.mp4 clip2.mp4
    python scripts/batch_extract_tracks.py --stance clean --diagnostics clean-and-jerk --dir ~/incoming_clips/

Deliberately a plain HTTP client, not a second process loading the ViTPose/
YOLO weights: the app already exposes everything batch extraction needs
(/api/pose/video/start, /progress, /result), and driving that instead of
importing vitpose_backend directly means only one process ever touches the
GPU, and this script exercises the same code path the browser does rather
than a bypass of it. See parked/report/extract_track.py for the other case (caching
one known clip without a server running at all — what analysis.ipynb uses).

The server's video job is a single global slot (see app.py's _video_job) —
one analysis at a time, "counting"/"running" until "done" or "error" — so
clips are necessarily processed one by one; this script just waits out each
one's progress before starting the next; that's exactly the "let clips be
uploaded and processed one by one" workflow, not a limitation to work around.

Writes, per clip, into tests/fixtures/<scope>/ (or --out-dir):
  <stance>/<clip-stem>.mp4          copy of the source clip
  <stance>/<clip-stem>.track.json   {"keypoints": ..., "meta": ...} — the same
                                     payload /api/pose/video/result returns
and appends one entry per clip to that folder's manifest.json, keyed by
"<stance>/<clip-stem>" so re-running on the same clip overwrites its entry
instead of duplicating it.

--scope picks where a batch lands: "local" (the default) is gitignored — your
own clips, shown in the app's example picker on this machine only; "global"
is committed and ships with the repo. Both have the same layout, so promoting
a clip is a move of its track plus its manifest entry; the clip itself moves
only if it may be published (tests/fixtures/README.md, "Videos").

--diagnostics picks the DIAGNOSTIC_SETS key the fixtures are scored against; it
defaults to --stance, so --stance snatch writes "diagnostics": "snatch". A stance
that is not a set key (clean) needs it spelled out (clean-and-jerk). Without
--diagnostics a re-extract keeps the value already in the clip's manifest entry
(hand-set); with it, the option wins.

A clip that errors (bad upload, no person detected, pose pass raised) is
logged and skipped — one bad file shouldn't cost the rest of the batch.
"""
import argparse
import json
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

VIDEO_EXTENSIONS = (".mp4", ".mov", ".avi", ".webm", ".mkv")
POLL_INTERVAL_S = 1.0
POLL_TIMEOUT_S = 30 * 60   # a single clip taking longer than this means
                           # something is stuck, not just slow


def discover_clips(paths, directory):
    clips = [Path(p) for p in paths]
    if directory:
        clips += sorted(
            p for p in Path(directory).iterdir()
            if p.suffix.lower() in VIDEO_EXTENSIONS
        )
    seen, out = set(), []
    for c in clips:
        c = c.resolve()
        if c not in seen:
            seen.add(c)
            out.append(c)
    return out


def start_job(base_url, clip_path, size, frame_stride):
    with open(clip_path, "rb") as f:
        files = {"video": (clip_path.name, f, "application/octet-stream")}
        data = {"size": size, "frame_stride": str(frame_stride)}
        r = requests.post(f"{base_url}/api/pose/video/start", files=files, data=data)
    if r.status_code != 200:
        raise RuntimeError(f"start failed ({r.status_code}): {r.text}")


def wait_for_result(base_url, clip_path):
    deadline = time.monotonic() + POLL_TIMEOUT_S
    last_status = None
    while True:
        if time.monotonic() > deadline:
            raise RuntimeError(f"timed out after {POLL_TIMEOUT_S}s waiting on {clip_path.name}")
        r = requests.get(f"{base_url}/api/pose/video/progress")
        r.raise_for_status()
        p = r.json()
        status = p.get("status")
        if status != last_status:
            print(f"  [{clip_path.name}] {status}"
                  + (f" ({p['processed']}/{p['total']})" if p.get("total") else ""))
            last_status = status
        if status == "done":
            r = requests.get(f"{base_url}/api/pose/video/result")
            r.raise_for_status()
            return r.json()
        if status == "error":
            raise RuntimeError(p.get("error", "unknown error"))
        time.sleep(POLL_INTERVAL_S)


def load_manifest(out_dir):
    manifest_path = out_dir / "manifest.json"
    if manifest_path.exists():
        return json.loads(manifest_path.read_text())
    return {}


def save_manifest(out_dir, manifest):
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")


def process_clip(base_url, clip_path, stance, size, frame_stride, out_dir, manifest,
                 diagnostics=None):
    slug = f"{stance}/{clip_path.stem}"
    print(f"-> {slug}")
    start_job(base_url, clip_path, size, frame_stride)
    result = wait_for_result(base_url, clip_path)

    stance_dir = out_dir / stance
    stance_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(clip_path, stance_dir / clip_path.name)
    (stance_dir / f"{clip_path.stem}.track.json").write_text(json.dumps(result))

    meta = result.get("meta", {})
    manifest[slug] = {
        "stance": stance,
        "source_file": clip_path.name,
        "model_size": size,
        "frame_stride": frame_stride,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "frame_count": meta.get("frame_count"),
        "frames_processed": meta.get("frames_processed"),
        "kept_person": (meta.get("tracks") or {}).get("kept"),
        # Filled in by hand once a clip's technique has been reviewed — see
        # tests/fixtures/README.md. Absent here: this script only records
        # what the pose pass produced, never a verdict on the lift.
        "labels": manifest.get(slug, {}).get("labels", []),
        "notes": manifest.get(slug, {}).get("notes", ""),
        # Which lift's cues this clip is scored against (a key in
        # DIAGNOSTIC_SETS; the tests fail on a fixture without one). The
        # option if given, else the value already in the entry (hand-set, and
        # carried across a re-extract so re-running the pose pass doesn't
        # quietly re-file a clip under another lift), else the stance.
        "diagnostics": diagnostics or manifest.get(slug, {}).get("diagnostics") or stance,
    }
    print(f"   {meta.get('frames_processed')} frames, kept person {manifest[slug]['kept_person']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("clips", nargs="*", help="video files to process")
    ap.add_argument("--dir", help="also process every video file in this directory")
    ap.add_argument("--stance", required=True,
                     help="label for this batch, e.g. snatch, clean, jerk — "
                          "fixtures land under <out-dir>/<stance>/")
    ap.add_argument("--diagnostics", default=None, metavar="SET",
                     help="DIAGNOSTIC_SETS key the fixtures are scored against, e.g. "
                          "clean-and-jerk (default: --stance; on a re-extract, the "
                          "entry's existing value)")
    ap.add_argument("--host", default="127.0.0.1:8080", help="host:port the app is listening on")
    ap.add_argument("--size", default="l", choices=("l", "h"), help="ViTPose checkpoint size")
    ap.add_argument("--frame-stride", type=int, default=1)
    ap.add_argument("--scope", default="local", choices=("local", "global"),
                     help="local (default): gitignored, this machine only; "
                          "global: committed with the repo")
    ap.add_argument("--out-dir", default=None,
                     help="override the destination folder (default tests/fixtures/<scope>)")
    args = ap.parse_args()

    clips = discover_clips(args.clips, args.dir)
    if not clips:
        ap.error("no clips given — pass paths and/or --dir")

    base_url = f"http://{args.host}"
    try:
        requests.get(f"{base_url}/api/capabilities", timeout=3).raise_for_status()
    except requests.RequestException as e:
        sys.exit(f"can't reach coach at {base_url} — is it running? "
                 f"(./scripts/coach_launch.sh local)\n{e}")

    out_dir = Path(args.out_dir) if args.out_dir else Path("tests/fixtures") / args.scope
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = load_manifest(out_dir)

    failures = []
    for clip in clips:
        try:
            process_clip(base_url, clip, args.stance, args.size, args.frame_stride,
                         out_dir, manifest, diagnostics=args.diagnostics)
            save_manifest(out_dir, manifest)   # after every clip, not just at the end —
                                                # a later failure shouldn't lose earlier work
        except Exception as e:
            print(f"   FAILED: {e}")
            failures.append((clip.name, str(e)))

    print(f"\n{len(clips) - len(failures)}/{len(clips)} clips extracted to {out_dir}/{args.stance}/")
    if failures:
        print("failed:")
        for name, err in failures:
            print(f"  {name}: {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
