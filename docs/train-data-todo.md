# Training-data TODO

Turning the 3,226 clipper clips into usable labelled data: fixing what the
pose pass got wrong, getting a 3D calibration, weeding out the bad ones.
Observations first, each with what has actually been verified and what the next
step is — so nobody re-diagnoses from scratch.

The numbers from the full pose pass (2026-10-14) are in
[dataset-stats.md](dataset-stats.md); this file says what to do about them.

## 1. "Video can't be played because the file is corrupt" on every example

**Verified good, server-side, so this is not the data or the proxy:**

| check | result |
| --- | --- |
| `/api/examples/<id>/video` direct on :8080 | 200, 9,492,208 B, `video/mp4` |
| same through Caddy | 200, full bytes |
| `/api/train/clip/<path>` direct | 200, 5,411,333 B, `video/mp4` |
| `Range: bytes=0-1023` | 206 + correct `Content-Range` |
| 12-clip codec sample | `h264 High, yuv420p, 1920x1080, L4.0/L4.2, 30 or 60 fps` |
| `moov` atom | present, `ftypisom`, `start_time=0` |
| frontend blob | `vr.blob()` keeps `Content-Type`, so `createObjectURL` gets a typed blob |

**Leading hypothesis: the client has no H.264 decoder.** The browser is
Firefox 150 on `X11; Linux x86_64`, on another machine over the tailnet. A
Linux Firefox without system ffmpeg — or sandboxed as a snap/flatpak without
codec access — fails *every* H.264 file with exactly this wording, and every
example clip is H.264. That matches "on every example" better than
anything file-specific, since the global examples failed too.

Check on the client, in this order:

1. `about:support` → Media → look for an H264 decoder; and
   `about:config` → `media.ffmpeg.enabled`.
2. Play any other local .mp4 in the same browser. If that also fails, it is the
   codec, full stop.
3. If it is the codec: install `ffmpeg`/`libavcodec` (or `openh264`) on that
   machine. Transcoding 3,226 clips to VP9 is the fallback, not the fix.

Second hypothesis, much weaker: the request landed while the app was being
restarted (four times between 23:26 and 23:31 on 2026-10-13). But the example
picker's handler checks `vr.ok` and would have shown "error loading example",
not a corrupt video — so a 502 does not produce this message.

## 2. Most clips show exercise `unknown`

Updated 2026-10-15, after the full pose pass finished. Of the 3,226 clips,
1,506 read `unknown` in `/api/train/clips`: the clips with no fixture that has
both a track and a clip. They are the 1,475 held for review, the 30 the sync
skipped and the 1 that failed ([dataset-stats.md](dataset-stats.md)). They stay
`unknown` until the clipper windows are widened and they are re-cut.

Worth separating in the UI: `not analysed yet` and `analysed, stance
unreadable` are different problems and only the second needs a human.

## 3. The snatch / clean-and-jerk split is wrong

1,470 snatch to 252 clean-and-jerk, 85:15, against a true ~50:50 — every
lifter takes three of each. So `scripts/pose_stance.py` is either reading
cleans as snatches or losing them to review. The ratio did not move between
48% through the run and the end of it, so it is not a sampling artefact.

The dominant review reason is not a tracking failure: the clipper's window
opens after the lift has started, and the shortest clips fare worst (the
reasons and the accept rate by length are in [dataset-stats.md](dataset-stats.md)).

Two jobs, in order:

1. **Validate the classifier before trusting any of it.** Hand-label ~30
   accepted clips and measure its error rate. A wrong stance scores a clip
   against the wrong lift's cues and nothing downstream notices — the
   `sync_clipper_fixtures.py` docstring says as much.
2. **Widen the clipper window** for short-burst attempts (`_tighten()` in
   `final.py`) and re-cut. Held clips are deliberately *not* cached in
   `.clipper_sync_state.json`, so they re-extract with no bookkeeping once the
   windows are better.

The free signal nobody is using yet, now confirmed on a real frame: the AWF
lower third reads `SNATCH | <name> | SA 47KG | 47 | 0:37`. It **states
the lift type**, in the fixed box `awf-overlay` already locates, for the 23
Australian-Championship sessions (14 in 2023, 9 in 2024). Pacific's start-list card does the same at
group level (`SNATCH - 1ST ATTEMPT`). That is ground truth to score
`pose_stance.py` against rather than a second guess — and it is the same OCR
work as item 4, so do them together.

## 4. No gender, no category, on any clip

None of the 3,226 clips has either ([dataset-stats.md](dataset-stats.md)). The field and the API exist — `PUT /api/train/labels/<path>` accepts
`gender` against `TRAIN_GENDERS` and a free-text `category` — but nothing
populates them, and there is no source in the pipeline: clipper never captured
it, and `clips.json` has no such field.

**YouTube is a dead end — checked, four ways.** The AWF channel publishes
these as bare "Session N":

```
title              "2024 Australian Championships - Session 1"
description        empty (one video has the string "NBBL8FUSLVE6XLFS")
chapters           NA
tags               []            categories  ['Sports']
playlist_description  NA
```

Note the ids needed to re-query are recoverable despite the lowercase rename:
`.download-archive.txt` keeps the real case, and slugging each archive id the
same way `normalize_names.sh` did matches all 72 videos with no collisions.

**The footage itself carries it, stated in plain text.** Every production
broadcasts a full-screen start list between groups:

| production | what the card says |
| --- | --- |
| 2023 Pacific | `WOMEN 55 KG GROUP A` / `START LIST` / `SNATCH - 1ST ATTEMPT`, then rank, nation flag+code, athlete, entry total |
| 2023 + 2024 Australian | `SCOREBOARD`, then `# / Athlete / Born / Nation / Bodyweight / SN 1-3 / CJ 1-3 / Best SN / Best CJ / Total` |
| 2019 Arafura | no card seen; the filmed board gives per-attempt `2 Att / <name> / 53kg / Chinese Taipei` |

Pacific states gender and category outright. The AWF scoreboard does not name
the category but lists the whole field with bodyweights (43.82–48.80 in session
1) and athlete names, which pins it. Arafura gives athlete name and nation per
attempt, so gender comes from the roster rather than a header.

So this is **one OCR read per session, not per clip** — 72 reads covering 3,226
clips. The card is easy to find: it is full-screen, high-contrast, static for
seconds at a time, and `analyze.py` already votes per frame on whether the
normal graphic is present, so "graphic absent and the frame is mostly a bright
rectangle" isolates candidates almost for free.

Two things fall out of the same work:

- **Per-attempt athlete identity.** The AWF lower third carries the athlete
  name, their state, and the attempt weight (`SA 47KG`,
  `47`), in the fixed box `awf-overlay` already locates. Join to the session
  roster and every clip gets an athlete, not just a gender.
- **Attempt weight, i.e. load.** Visible in every production's overlay
  (`63kg | 1st` on Pacific, `53kg | 2 Att` on Arafura). That is a real
  covariate for technique analysis and currently nowhere in the dataset.

Manual session labelling stays the fallback for anything OCR cannot read — 72
labels is tractable either way — but it is no longer the first move.

### Coverage, by production

Potential, not actual — **nothing below is extracted yet**. Read off six
sampled frames of one session per production, so per-session availability still
needs a scan.

| production | clips | athlete + nation | attempt weight | attempt 1-3 | lift type | bodyweight | gender + category |
| --- | ---: | :-: | :-: | :-: | :-: | :-: | :-: |
| 2019 Arafura | 107 | board | board | board | — | — | — |
| 2023 Australian | 714 | overlay | overlay | board | **stated** | **scoreboard** | roster |
| 2023 Pacific | 689 | start list | overlay | overlay | card | — | **stated** |
| 2024 Australian | 407 | overlay | overlay | board | **stated** | **scoreboard** | roster |
| 2025 ASJC | 1309 | board | board | board | — | — | — |
| **total** | **3226** | 3226 | 3226 | 3226 | 1810 | 1121 | 1810 |

Notes that matter:

- **Attempt 1-6 needs no lift-type OCR.** Every production shows the attempt
  number *within a lift* (1-3). A session runs all three snatches before all
  three cleans, and `clips.json` already timestamps every attempt, so ordering
  by `start` and splitting where the counter resets gives 1-6 for all 3,226.
  The stated lift type then becomes a *check* on that inference rather than its
  only source.
- **Pacific's start-list kg column is the opening declaration, not
  bodyweight** — the header reads `SNATCH - 1ST ATTEMPT`, and the values
  (63-75 kg) exceed the 55 kg category. Only the AWF `SCOREBOARD` has a real
  Bodyweight column (43.82, 44.46, 48.10 ... in 2024 session 1).
- **2025 is the weak spot and the biggest playlist.** Its per-attempt LED board
  is clean (`<name> / 1:00 / QLD / 78 / 2`), but the only category
  source is a projected start list on a side wall, caught obliquely and far too
  blurred to OCR in the frames sampled. Bodyweights are *visible* on it
  (81.86, 81.85, 81.71 ...) and unreadable. Another camera angle or a zoom may
  do better; otherwise 2025 + Arafura, 1,416 clips, need the published results.

Free signals in the same boxes, not yet used: nation/state code (all five),
athlete name (all five), and the countdown clock at lift start — which
`analyze.py` already reads — as a time-pressure covariate.

## 5. 3D calibration

Not started on this data. What exists: `tests/fixtures/*/profiles/signs/` holds
per-camera depth-direction tables and `profiles/limbs/` per-athlete limb
ratios — see [`fixture-data-contract.md`](fixture-data-contract.md) for the
schemas and [`../TODO.md`](../TODO.md) for the solver's own open problems.

What makes this dataset unusually good for it: a competition session is **one
fixed camera**, so one signs profile serves every clip in that session — 72
profiles, not 3,226. The sessions are already the natural unit, same as the
gender labelling in item 4.

Open question worth settling early: whether a signs profile can be *solved*
once per session from the accepted clips rather than set by eye, given that the
athletes differ but the camera does not.

## 6. Two small losses from the first pose pass

Found when the run finished (2026-10-14): 30 clips the sync skipped and one
that crashed with `division by zero`. Which ones, and the likely cause of the
skips: [dataset-stats.md](dataset-stats.md). The skips are a bug in the sync
script ([backlog.md](backlog.md)); the crash is one clip, not worth chasing
for its own sake, but an unguarded divide in the stance or metric path will
hit again on a re-cut.
