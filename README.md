# weightlifting-clipper

Downloads a YouTube video or playlist of a weightlifting session and cuts out
one clip per lift attempt — from the lifter taking the bar through the
top/lockout position — using the on-screen scoreboard and platform motion.
No manual scrubbing through hours of footage.

## Quick start

```
./clip.sh "https://www.youtube.com/playlist?list=..."
```

First run creates a local Python virtual environment (`.venv/`) and installs
`requirements.txt` into it automatically — nothing to set up by hand beyond
having `ffmpeg` on your system (see Requirements below). Every run after that
reuses the same environment and only reinstalls if `requirements.txt` changes.

Output lands in `./downloads/`:

```
downloads/
  <playlist or video title>/         # the downloaded source video(s)
  Clips/
    <session name>/
      <session>_01_0h20m35s_made.mp4
      <session>_02_0h21m29s_miss.mp4
      ...
  .clipper_work/<session>/           # intermediate analysis files (kept for
                                      # debugging / re-cutting without re-analyzing)
```

Each clip filename encodes: order within the session, the timestamp in the
source video, and the referee decision (`made` / `miss`).

## Requirements

- **ffmpeg / ffprobe** on your `PATH` — this script does not install these.
  (`sudo dnf install ffmpeg` / `sudo apt install ffmpeg` / `brew install ffmpeg`)
- **python3** with the standard `venv` module.
- Everything else (`yt-dlp`, `numpy`, `opencv-python-headless`) is installed
  automatically into `.venv/` on first run, from `requirements.txt`.

## Options

```
./clip.sh <youtube-url> [options]
./clip.sh --local <video-or-dir> [options]

  -o, --out DIR                Output directory (default: ./downloads)
  --local PATH                 Process an existing local video file or a
                                directory of videos instead of downloading
  --cookies-from-browser NAME  Pass browser cookies to yt-dlp, e.g. `firefox`.
                                Use this if YouTube blocks the download with
                                "Sign in to confirm you're not a bot" — this
                                tends to happen after downloading several
                                large videos back to back.
  --workers N                  Parallel ffmpeg workers for cutting (default 8)
  --delete-source               Delete each source video after its clips are
                                cut (default: keep it — useful for re-running
                                with different settings later)
  --review                      Also save contact-sheet PNGs (8 frames per
                                clip) under .clipper_work/<session>/review/ so
                                you can eyeball the results before trusting them
```

## How it works

For each video: the on-screen scoreboard is located automatically (its clock,
weight, attempt number, and the three referee-decision lights), then:

1. The scoreboard's clock **freezes** when a lifter takes the bar — that
   marks the start of an attempt.
2. Motion on the platform (frame differencing) tracks the lift through its
   phases — including the pause between the clean and the jerk in a clean &
   jerk — and settles once the lifter reaches the top/lockout position.
3. The referee lights (2+ white = made, 2+ red = miss) confirm the attempt
   and label the clip.

## Limitations — read before trusting the output on a new event

- **The scoreboard templates in `templates/` are specific to one broadcast
  graphic** (built from the Australian Weightlifting Federation's on-screen
  scoreboard). Videos using the *same* graphic — e.g. other sessions or years
  from the same federation/production — should work automatically. A
  differently-styled scoreboard will not be found, and the script will print
  a low-confidence warning per video rather than silently producing garbage.
  Adapting to a new graphic means rebuilding `templates/front_tpl.png` /
  `front_mask.png` / `board_tpl.png` — this was the fiddly, mostly-manual
  part of building this tool, and isn't automated. Ask for help redoing it
  against a sample video if you need to support a new event.
- **Not perfect.** This is frame-motion + template matching, not true object
  tracking. In validation across ~230 clips, the error rate was roughly 1-2%:
  occasionally two consecutive attempts get merged into one clip, or loaders
  moving the bar get mistaken for an attempt. Worth a skim of `--review`
  contact sheets, especially for clips much longer than ~10 seconds, before
  relying on the output unattended.
- **A broadcast that frequently cuts away from the platform camera (other
  camera feeds, picture-in-picture, a big-screen results-table graphic) loses
  whole attempts, not just cut quality.** Found on a real session where
  `analyze.py`'s camera-layout confidence was low (3/12): the scoreboard
  graphic matched the template fine whenever it was on screen, but the clock
  freeze that marks an attempt's start is invisible during a cutaway, so that
  attempt never becomes a candidate at all — it's silently missing from
  `clips.json`, not mis-cut. On that session only 24 of 50 referee-light
  decisions (48%) made it into the output. Run `src/audit_coverage.py
  SIGNALS.npz` (on the `.clipper_work/<session>/signals.npz` a normal run
  already leaves behind) to check this for any session: it compares the
  referee-light count (the true attempt count) against what actually got
  detected and kept, and reports how many were lost to no-candidate-at-all
  vs. the `>97%`-visibility filter. A low camera-layout confidence score is
  worth treating as "go run this audit," not just "maybe the template is
  wrong."
- **No lifter name / weight / attempt-number labels** — only order, timestamp,
  and made/miss. The scoreboard does show this text, but reading it reliably
  (OCR on a small LED/dot-matrix display) wasn't built. It's a plausible
  future addition if useful.
- Clips have no audio (the source recordings don't carry meaningful audio for
  this use case, so video is downloaded audio-free).

## Re-running without re-downloading or re-analyzing

- Already have the videos? `./clip.sh --local downloads/<title>/` skips the
  download step.
- Want to re-cut with different clip logic after editing `src/detect.py` or
  `src/final.py`, without re-running the slow per-frame analysis? The raw
  signals are kept in `.clipper_work/<session>/signals.npz` — re-run
  `.venv/bin/python src/finalize.py .clipper_work/<session>/signals.npz
  .clipper_work/<session>/clips.json` followed by a manual cut step, or ask
  Claude to do this for you.
