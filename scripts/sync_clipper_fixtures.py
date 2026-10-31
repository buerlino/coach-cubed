"""Pull newly-cut clips out of clipper's output and turn them
into coach test fixtures, end to end — no manual clips_inbox/ copying.

    ./scripts/coach_launch.sh local          # or coach_launch_venv.sh
    python scripts/sync_clipper_fixtures.py
    python scripts/sync_clipper_fixtures.py --clipper-dir /path/to/clipper/downloads
    python scripts/sync_clipper_fixtures.py --dry-run     # classify, don't persist fixtures

clipper (its own repo, weightlifting-clipper; it lived in coach as clipper/
from 2026-09-23 to 2026-10-31) writes one folder per source video, named after the video
and sitting beside it, and puts that video's cut attempts in <that
folder>/clips/, named
"<session>_NN_HhMMmSSs_<made|miss>.mp4" (see its README/src/cut.py). It knows
order, timestamp and referee decision, but never lift type: coach needs a
--stance (snatch vs clean-and-jerk) to know which diagnostics to score a clip
against, and clipper has no way to tell us that.

Stance is decided in this order:
  1. an explicit --stance-override (substring in the session name)
  2. scripts/pose_stance.py, reading the wrist/bar height trajectory out of
     the pose track this script extracts anyway — see that module's
     docstring for the method and, importantly, its validation status. This
     replaced an earlier attempt at guessing from clip duration, which
     turned out to not track lift type at all on real footage (clip length
     is dominated by post-lockout walk-off/celebration time, not the lift's
     own motion structure).
A clip the classifier can't confidently read — including a track that's
gone obviously wrong, or a clip cut before the lift visibly settles — is
left for manual review rather than guessed: a wrong stance silently scores
it against the wrong lift's cues and nothing downstream would ever notice.

Because stance now depends on the extracted track, every new (non-dedup)
clip is pose-extracted before it's classified — there's no more free,
zero-cost dry run; --dry-run here means "extract and classify, but don't
write fixture files/manifest/golden/dedup state", not "don't touch the GPU".

Dedup is by content hash, not filename: re-running clipper after a template
or logic change can renumber an already-seen attempt (a new NN for the same
physical clip), which would otherwise look like a brand-new fixture and burn
a GPU pass for nothing. Hashes of already-extracted clips are cached in
tests/fixtures/local/.clipper_sync_state.json (gitignored along with
everything else under fixtures/local/ — this is sync bookkeeping, not a
fixture, so it never ships). A clip held for review is NOT cached — it costs
a re-extraction if you re-run after fixing it (e.g. via --stance-override),
which is a one-time, acceptable cost for keeping this simple.

The pose extraction call itself is scripts/batch_extract_tracks.py's own
start_job/wait_for_result, reused as-is; the file/manifest write-out here is
a separate small block (not process_clip) because that function bakes stance
in as an upfront parameter, and here stance isn't known until after
extraction. New fixtures land in tests/fixtures/local/ by default, same as
the manual clips_inbox/ workflow; promoting one to global/ is still the
manual step documented in tests/fixtures/README.md.
"""
import argparse
import hashlib
import json
import random
import re
import shutil
import subprocess
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch_extract_tracks as bet
from pose_stance import classify_stance_from_track

REPO_ROOT = Path(__file__).resolve().parent.parent
# Where clipper put its output. $CLIPPER_OUT is the same variable clip.sh reads
# for its own -o default, so moving the downloads off this box's 288G SSD onto
# bulk storage needs setting it once, not passing a path to two tools that must
# agree. clipper is its own repo again since 2026-10-31, so there is no in-repo
# fallback any more: set CLIPPER_OUT or pass --clipper-dir.
DEFAULT_CLIPPER_DIR = Path(os.environ["CLIPPER_OUT"]) if os.environ.get("CLIPPER_OUT") else None
STATE_FILE = REPO_ROOT / "tests" / "fixtures" / "local" / ".clipper_sync_state.json"

# session_NN_HhMMmSSs_result.mp4 — see src/cut.py in the clipper repo. "unknown" is a real
# verdict here, not a parse failure: some productions show no referee lights at
# all, and clipper labels those attempts honestly rather than guessing.
CLIP_NAME_RE = re.compile(r"^(?P<session>.+)_(?P<idx>\d{2})_(?P<hh>\d+)h(?P<mm>\d{2})m(?P<ss>\d{2})s_(?P<result>made|miss|unknown)\.mp4$")


def discover_clips(clipper_dir):
    # Searched at any depth rather than at a fixed one: the per-video folder
    # sits wherever its video does, which is one level down for a playlist and
    # at the top level for a single video or a --local run.
    return sorted(clipper_dir.rglob("clips/*.mp4"))


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")


def write_fixture(out_dir, manifest, clip, stance, result, attempt_result, args, note):
    """Same file/manifest shape as batch_extract_tracks.py's process_clip,
    but stance is a parameter decided from `result` rather than baked in
    before extraction."""
    slug = f"{stance}/{clip.stem}"
    stance_dir = out_dir / stance
    stance_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(clip, stance_dir / clip.name)
    (stance_dir / f"{clip.stem}.track.json").write_text(json.dumps(result))

    meta = result.get("meta", {})
    existing = manifest.get(slug, {})
    manifest[slug] = {
        "stance": stance,
        "source_file": clip.name,
        "model_size": args.size,
        "frame_stride": args.frame_stride,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "frame_count": meta.get("frame_count"),
        "frames_processed": meta.get("frames_processed"),
        "kept_person": (meta.get("tracks") or {}).get("kept"),
        "labels": existing.get("labels", []),
        "notes": existing.get("notes") or note,
        # DIAGNOSTIC_SETS key this fixture is scored against — our stance
        # names match those keys exactly. batch_extract_tracks.py only ever
        # preserves an existing value here; a brand new fixture needs it set
        # explicitly or every test/golden falls back to "snatch".
        "diagnostics": stance,
        "attempt_result": attempt_result,
    }
    return slug


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--clipper-dir", type=Path, default=DEFAULT_CLIPPER_DIR,
                     help=f"clipper's downloads/ dir (default: $CLIPPER_OUT, now {DEFAULT_CLIPPER_DIR or 'unset'})")
    ap.add_argument("--host", default="127.0.0.1:8080", help="host:port the coach app is listening on")
    ap.add_argument("--scope", default="local", choices=("local", "global"),
                     help="local (default): gitignored, this machine only; "
                          "global: committed — use deliberately, not for a routine sync")
    ap.add_argument("--size", default="l", choices=("l", "h"), help="ViTPose checkpoint size")
    ap.add_argument("--frame-stride", type=int, default=1)
    ap.add_argument("--stance-override", action="append", default=[], metavar="SUBSTRING=STANCE",
                     help="force this stance for any session name containing SUBSTRING "
                          "(case-insensitive); repeatable, checked before the pose classifier")
    ap.add_argument("--shuffle", nargs="?", type=int, const=0, default=None, metavar="SEED",
                     help="extract in random rather than path order. A full pass over a "
                          "large clipper output is many GPU-hours, and in path order any "
                          "prefix of it is the first playlists only -- stop it early and "
                          "you have 2019 Arafura in depth and nothing from 2025. Shuffled, "
                          "every prefix is a representative sample of all the footage. "
                          "Seeded (default 0) so a resumed run is reproducible")
    ap.add_argument("--dry-run", action="store_true",
                     help="extract and classify, but write nothing (still uses the GPU — see module docstring)")
    args = ap.parse_args()

    overrides = []
    for spec in args.stance_override:
        if "=" not in spec:
            ap.error(f"--stance-override must be SUBSTRING=STANCE, got {spec!r}")
        substr, stance = spec.split("=", 1)
        overrides.append((substr, stance))

    if args.clipper_dir is None:
        ap.error("set CLIPPER_OUT or pass --clipper-dir: clipper's output lives outside this repo")
    if not args.clipper_dir.is_dir():
        sys.exit(f"no such directory: {args.clipper_dir}\n"
                 f"(pass --clipper-dir, or set CLIPPER_OUT)")

    clips = discover_clips(args.clipper_dir)
    if args.shuffle is not None:
        # Shuffle the list, not the loop: dedup is by content hash against
        # STATE_FILE, so a run stopped and resumed picks up exactly the clips
        # it had not reached, in the same order, and never re-extracts one.
        random.Random(args.shuffle).shuffle(clips)
    if not clips:
        print(f"no clips found under {args.clipper_dir}/**/clips/*.mp4")
        return

    base_url = f"http://{args.host}"
    try:
        import requests
        requests.get(f"{base_url}/api/capabilities", timeout=3).raise_for_status()
    except Exception as e:
        sys.exit(f"can't reach coach at {base_url} — is it running? "
                 f"(./scripts/coach_launch.sh local)\n{e}")

    state = load_state()
    out_dir = REPO_ROOT / "tests" / "fixtures" / args.scope
    manifest = {}
    if not args.dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
        manifest = bet.load_manifest(out_dir)

    new_slugs = []
    n_dup = n_unparsed = n_review = n_new = 0

    for clip in clips:
        m = CLIP_NAME_RE.match(clip.name)
        if not m:
            print(f"SKIP  (unrecognized filename) {clip}")
            n_unparsed += 1
            continue

        digest = sha256_file(clip)
        if digest in state:
            n_dup += 1
            continue

        override_stance = next((stance for substr, stance in overrides
                                 if substr.lower() in m["session"].lower()), None)

        try:
            bet.start_job(base_url, clip, args.size, args.frame_stride)
            result = bet.wait_for_result(base_url, clip)
        except Exception as e:
            print(f"FAILED {clip.relative_to(args.clipper_dir)}: {e}")
            n_unparsed += 1
            continue

        if override_stance:
            stance = override_stance
            note = f"stance forced by --stance-override ({m['session']!r})"
        else:
            stance, reason = classify_stance_from_track(result["keypoints"], result["meta"])
            note = reason if stance is None else f"stance auto-detected from pose trajectory: {reason}"

        if stance is None:
            print(f"REVIEW {clip.relative_to(args.clipper_dir)} — {note}")
            n_review += 1
            continue

        print(f"{'DRY-RUN' if args.dry_run else 'NEW'}    {clip.relative_to(args.clipper_dir)} "
              f"-> {stance} ({note})")
        if args.dry_run:
            n_new += 1
            continue

        # Re-read before each write: the app's training data explorer links
        # fixtures into the same manifest while this runs, and saving a stale
        # in-memory copy would silently drop them.
        manifest = bet.load_manifest(out_dir)
        slug = write_fixture(out_dir, manifest, clip, stance, result, m["result"], args, note)
        bet.save_manifest(out_dir, manifest)

        state[digest] = f"{args.scope}/{slug}"
        save_state(state)   # after every clip, not just at the end
        new_slugs.append(f"{args.scope}/{slug}")
        n_new += 1

    print(f"\n{n_new} new, {n_dup} already known, {n_review} held for review, "
          f"{n_unparsed} unparsed/errored, out of {len(clips)} clips seen.")

    if new_slugs:
        print(f"\nregenerating goldens for {len(new_slugs)} new fixture(s) ...")
        subprocess.run(["node", str(REPO_ROOT / "tests" / "update_golden.js"), *new_slugs],
                        check=True, cwd=REPO_ROOT)
        print("done — run `npm test` to verify.")
    elif n_review:
        print("\nunresolved clips need a --stance-override, or investigation (see scripts/pose_stance.py), "
              "then re-run (already-classified clips are skipped via the dedup cache).")


if __name__ == "__main__":
    main()
