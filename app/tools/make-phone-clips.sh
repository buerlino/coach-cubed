#!/usr/bin/env bash
# app/tools/make-phone-clips.sh <dir> [clip...]
#
# The clips for the phone's media measurements (package c34), made with ffmpeg
# into <dir>, a cache outside the repo (never committed, never a camera file):
#   k1        1080p H.264, 30 fps, 60 s, a keyframe every 1 s
#   k2to5     the same, keyframes 2-5 s apart (as phone cameras write)
#   p60       1080p H.264, 60 fps, 60 s, a keyframe every 1 s
#   rot90     k1's stream with the file's rotation set to 90° clockwise (1080x1920 upright)
#   rot90p60  p60's stream, the same rotation
#   vfr       1080p H.264, about 30 fps, 60 s: each time jittered by up to 4 ms, every 7th frame dropped
#   hevc      1080p H.265, 30 fps, 10 s, a keyframe every 1 s
#   big       1080p H.264, 30 fps, 60 s, about 100 MB (13.5 Mbit/s), a keyframe every 1 s
# No clip names: all of them, skipping those already there. The source is ffmpeg's
# testsrc2 with temporal noise, so the encoder spends a phone camera's bitrate on it
# (x264 veryfast, about 10 Mbit/s, B-frames on, yuv420p, no audio).
# Each encode is heavy: on the shared laptop run one clip per slice,
#   pipeline/devlock.sh slice clip-k1 app/tools/make-phone-clips.sh ~/.cache/coach/c34-clips k1
set -euo pipefail
DIR="${1:?usage: make-phone-clips.sh <dir> [clip...]}"; shift
mkdir -p "$DIR"
CLIPS=("$@"); (( ${#CLIPS[@]} )) || CLIPS=(k1 k2to5 p60 rot90 rot90p60 vfr hevc big)

src() { echo "-f lavfi -i testsrc2=size=1920x1080:rate=$1:duration=$2"; }
NOISE="noise=alls=12:allf=t+u"
X264="-c:v libx264 -preset veryfast -pix_fmt yuv420p -an -map_metadata -1 -movflags +faststart"
RATE="-b:v 10M -maxrate 12M -bufsize 20M"
ff() { nice -n 19 ffmpeg -v error -y "$@"; }

for c in "${CLIPS[@]}"; do
  out="$DIR/$c.mp4"
  [[ -f $out ]] && { echo "have $out"; continue; }
  case "$c" in
    k1)    ff $(src 30 60) -vf "$NOISE" $X264 $RATE -g 30 -keyint_min 30 -sc_threshold 0 "$out" ;;
    k2to5) ff $(src 30 60) -vf "$NOISE" $X264 $RATE -x264-params keyint=300:min-keyint=300:scenecut=0 \
             -force_key_frames 0,3,5,9,11,16,20,22,27,30,34,36,41,45,47,52,55 "$out" ;;
    p60)   ff $(src 60 60) -vf "$NOISE" $X264 -b:v 16M -maxrate 19M -bufsize 32M -g 60 -keyint_min 60 -sc_threshold 0 "$out" ;;
    # ffmpeg's display_rotation counts counter-clockwise: -90 is the file's 90° clockwise (tests/README.md)
    rot90)    [[ -f $DIR/k1.mp4 ]] || "$0" "$DIR" k1
              ff -display_rotation -90 -i "$DIR/k1.mp4" -c copy -map_metadata -1 "$out" ;;
    rot90p60) [[ -f $DIR/p60.mp4 ]] || "$0" "$DIR" p60
              ff -display_rotation -90 -i "$DIR/p60.mp4" -c copy -map_metadata -1 "$out" ;;
    vfr)   ff $(src 30 60) -vf "$NOISE,settb=1/90000,setpts='(N/30+0.004*sin(N*1.7))/TB',select='not(eq(mod(n\,7)\,3))'" \
             -fps_mode vfr -video_track_timescale 90000 $X264 $RATE -g 30 -keyint_min 30 -sc_threshold 0 "$out" ;;
    hevc)  ff $(src 30 10) -vf "$NOISE" -c:v libx265 -preset ultrafast -b:v 6M -pix_fmt yuv420p -tag:v hvc1 \
             -x265-params "keyint=30:min-keyint=30:scenecut=0:log-level=error" -an -map_metadata -1 -movflags +faststart "$out" ;;
    big)   ff $(src 30 60) -vf "$NOISE" $X264 -b:v 13.5M -maxrate 15M -bufsize 27M -g 30 -keyint_min 30 -sc_threshold 0 "$out" ;;
    *) echo "make-phone-clips.sh: no clip '$c'" >&2; exit 2 ;;
  esac
  ls -l "$out"
done
