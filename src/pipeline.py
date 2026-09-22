#!/usr/bin/env python3
"""Run the full detect-and-cut pipeline on one session video.
usage: pipeline.py VIDEO --outdir DIR --session NAME --templates DIR [options]
"""
import argparse, os, sys, json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze import analyze
from finalize import run as finalize_run
from cut import cut_clips

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('video')
    ap.add_argument('--outdir', required=True, help='root output directory')
    ap.add_argument('--session', required=True, help='name used for this session\'s clip folder/filenames')
    ap.add_argument('--templates', required=True, help='directory with the scoreboard templates')
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--review', action='store_true', help='also save contact-sheet PNGs for a visual QA pass')
    ap.add_argument('--start', type=float, default=0.0, help='(debug) only analyze from this time')
    ap.add_argument('--duration', type=float, default=None, help='(debug) only analyze this many seconds')
    args = ap.parse_args()

    work = os.path.join(args.outdir, '.clipper_work', args.session)
    os.makedirs(work, exist_ok=True)
    npz_path = os.path.join(work, 'signals.npz')
    json_path = os.path.join(work, 'clips.json')

    print(f'[{args.session}] analyzing {os.path.basename(args.video)} ...', flush=True)
    analyze(args.video, npz_path, args.start, args.duration, args.templates)

    print(f'[{args.session}] detecting attempts ...', flush=True)
    clips = finalize_run(npz_path, json_path)
    made = sum(1 for c in clips if c['result'] == 'made')
    print(f'[{args.session}] {len(clips)} attempts found ({made} made / {len(clips)-made} miss)', flush=True)

    if not clips:
        print(f'[{args.session}] nothing to cut, skipping.', flush=True)
        return

    outdir = os.path.join(args.outdir, 'Clips', args.session)
    print(f'[{args.session}] cutting {len(clips)} clips into {outdir} ...', flush=True)
    cut_clips(args.video, clips, outdir, args.session, workers=args.workers)

    if args.review:
        from vsheet import build_sheets
        review_dir = os.path.join(work, 'review')
        build_sheets(args.video, clips, review_dir)
        print(f'[{args.session}] review contact sheets in {review_dir}', flush=True)

    print(f'[{args.session}] done.', flush=True)

if __name__ == '__main__':
    main()
