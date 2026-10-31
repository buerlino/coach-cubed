# Dataset statistics

Where the numbers live, what they currently say, and the command that
regenerates each one. **As of 2026-10-15**, after the first full pose pass
finished (2026-10-14 07:38, zero restarts).

Nothing here is computed on demand — it is a snapshot written by hand. The
authoritative sources are:

| number | source of truth |
| --- | --- |
| clips cut, made/miss, timestamps | `$CLIPPER_OUT/<playlist>/<session>/clips.json` |
| fixtures accepted, stance, result | `tests/fixtures/local/manifest.json` |
| why a clip was rejected | `log/pose-sync.log` |
| what the dataset has been dedup'd against | `tests/fixtures/local/.clipper_sync_state.json` |

`CLIPPER_OUT=/mnt/datasets/coach/clipper` (set on the app via a systemd
drop-in, not in the shell).

## Stage 1 — source footage to clips (clipper)

72 sessions, 121.6 h of footage in, 3,226 clips out (6.3 h, 7.3 GB) — about
26.5 clips per hour of broadcast.

| playlist | sessions | hours | clips | made | miss | unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2019-arafura-games | 9 | 3.7 | 107 | 0 | 0 | 107 |
| 2023-australian-championships | 14 | 25.1 | 714 | 423 | 291 | 0 |
| 2023-pacific-games-oceania-championships | 18 | 33.0 | 689 | 490 | 199 | 0 |
| 2024-australian-championships | 9 | 15.3 | 407 | 272 | 135 | 0 |
| 2025-australian-senior-junior-championships | 22 | 44.4 | 1309 | 817 | 492 | 0 |
| **total** | **72** | **121.6** | **3226** | **2002** | **1117** | **107** |

Arafura is all `unknown` by design: that production shows no referee lights at
all, so the pipeline cannot read a verdict (see clipper's `README.md`,
"Limitations"). 3,119 clips carry a `lights_t`; anchoring was 1,925 via lights
and 1,301 via the attempt clock.

Clip length is the dominant quality variable downstream: min 3.5, p25 3.9,
median 5.6, p75 8.5, p90 15.3, max 16.2 s. **712 clips (22%) sit exactly on the
`MIN_LEN = 3.5 s` floor** in clipper's `src/final.py`.

```sh
python3 - <<'PY'
import json, glob, collections
n = collections.Counter()
for f in glob.glob('/mnt/datasets/coach/clipper/*/*/clips.json'):
    for c in json.load(open(f)):
        n[c['result']] += 1
print(n, sum(n.values()))
PY
```

## Stage 2 — clips to fixtures (pose extraction)

Run on the 1080 Ti via `coach-pose-sync.service` + `coach-app-cu.service`
(the `coach-cu` env, torch 2.14.0+cu126 — the default `coach` env is ROCm and
cannot see that card). ~15.9 frames/s, ~203 clips/h.

| outcome | clips | |
| --- | ---: | --- |
| accepted, written as a fixture | 1,720 | 53.3% |
| held for review, no fixture | 1,475 | 45.7% |
| skipped, filename not parsed | 30 | 0.9% |
| failed outright | 1 | — |
| **considered** | **3,226** | |

The manifest holds **1,722** examples — the 1,720 above plus two fixtures from
earlier hand-run sessions.

The one failure is `division by zero` on
`06-2023-pacific-games-oceania-championships-session-6-…_57_1h59m27s_made.mp4`.
All 30 skips are one session,
`18-2025-australian-senior-junior-championships-session-8-and-9-…`. The
session name parses. The likely cause is the attempt number: the filename
pattern in `scripts/sync_clipper_fixtures.py` takes exactly two digits
(`\d{2}`; `src/app.py` takes `\d+`), so a session that runs past attempt 99
loses every attempt after it.

### What the 1,722 in the manifest are labelled

```
stance    snatch 1470   clean-and-jerk 252          85:15, against a true ~50:50
result    made 929   miss 707   unknown 84   none 2
```

The stance skew is unchanged from the mid-run snapshot, so it is a property of
`scripts/pose_stance.py` plus the clipper window, not a sampling artefact.
See `docs/train-data-todo.md` item 3.

### Why 1,475 were held

```
1176  clip doesn't start with the bar near the bottom of its range
 154  clip appears to end before the lift settles (possible early cut)
  50  barely any vertical bar motion detected
  46  wrist/hip keypoints never met the confidence gate
  34  implausible motion range — likely a tracking glitch, not a real lift
  15  no person was tracked in this clip
```

**80% of all rejections are the first reason, and it is a clipper problem, not
a pose problem** — the window opens after the lift has already started.

### Accept rate by clip length (all 3,224 clips with a readable duration)

| length | accepted | not accepted | usable |
| --- | ---: | ---: | ---: |
| 3.5–4 s | 202 | 658 | **23%** |
| 4–6 s | 428 | 414 | 51% |
| 6–10 s | 665 | 252 | 73% |
| 10 s+ | 425 | 180 | 70% |

Widening `_tighten()` in clipper's `src/final.py` for short-burst attempts and
re-cutting the 860 clips under 4 s is the single highest-yield fix available.
Held clips are deliberately **not** recorded in `.clipper_sync_state.json`, so
they re-extract with no bookkeeping once the windows are better.

### Accept rate by production

| playlist | accepted | clips | rate |
| --- | ---: | ---: | ---: |
| 2019-arafura-games | 84 | 107 | 78.5% |
| 2023-australian-championships | 241 | 714 | **33.8%** |
| 2023-pacific-games-oceania-championships | 436 | 689 | 63.3% |
| 2024-australian-championships | 254 | 407 | 62.4% |
| 2025-australian-senior-junior-championships | 705 | 1309 | 53.9% |
| **total** | **1720** | **3226** | **53.3%** |

2023-Australian at 34% is the outlier worth a look before any re-cut.

```sh
# outcomes and reasons from the run log
for t in NEW REVIEW FAILED SKIP; do printf '%-7s %s\n' "$t" "$(grep -c "^$t" log/pose-sync.log)"; done
grep '^REVIEW' log/pose-sync.log | sed -E 's/^REVIEW +[^ ]+ +//; s/\(range[^)]*\)//' | sort | uniq -c | sort -rn
```

## Stage 3 — markers read off the video

**Nothing yet. Zero clips carry an OCR'd marker.**

```
gender    "" × 3226
category  "" × 3226
exercise  unknown 1506   snatch 1470   clean-and-jerk 252      (from the pose pass only)
```

Weight lifted, attempt number, athlete name, nation and bodyweight are all
visible in the footage and none of them have been extracted. What is readable
from which production — and why attempt 1-6 needs no OCR at all — is the
coverage table in [`docs/train-data-todo.md`](train-data-todo.md) item 4.

## Caveats

- Every count above is a snapshot. Re-running the pose pass, widening clipper
  windows or re-cutting invalidates stage 2 and 3 wholesale.
- `made` / `miss` come from reading referee lights, not from results sheets.
  clipper's `README.md` lists the failure modes.
- Stance is inferred from the pose trace and **has never been validated against
  a hand-label**. Treat the 85:15 split as evidence it is wrong.
