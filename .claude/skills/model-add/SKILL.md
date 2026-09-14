---
name: model-add
description: Add or swap the equipment-detection model in coach — the video tab's "detect bar & plates" pass (src/equipment_backend.py). Use when asked to replace/upgrade the detector or segmenter (e.g. CLIPSeg → Grounding DINO), plug in a new HuggingFace text-prompted detection/segmentation checkpoint, or otherwise change which model produces the bar/plate overlay. Covers the detect() contract the frontend and pose worker depend on, the MPS concurrency lock every GPU submission must take, the download/wiring/doc files that name the model, and how to validate the swap on a real fixture frame.
---

# Add / swap the equipment model

The equipment model is the **optional** second model coach runs on the video
tab: text prompt + frame in, bar/plate detections out, drawn over the mesh. It
lives entirely behind `src/equipment_backend.py` — everything else (the pose
worker, the frontend overlay, the setup scripts) talks to it through one small
contract. Swapping the model means honouring that contract, not rewriting the
callers.

**Do the download FIRST, in the background, then write code while it runs.**
The checkpoint is ~700MB–1GB and is the long pole. Kick it off before anything
else so the ~minutes of transfer overlap the wiring, which needs no network:

```bash
# start it detached, keep working; check on it before you validate
COACH_DINO=1 ./scripts/download_models.sh   # or the equivalent for the new model
```

(Or run the raw `curl` loop for just the new repo's files if the script isn't
updated yet — see step 3.) By the time the code edits are done the weights are
usually on disk, and the end-to-end test in step 6 runs immediately instead of
stalling.

## The contract — what `equipment_backend` must expose

The callers depend on exactly these. Keep the names and shapes; change what is
behind them.

| Symbol | Contract |
| --- | --- |
| `detect(frame_rgb)` | RGB `np.ndarray` (H,W,3) in → `{"plates": [...], "bar": {...} or None, "crop": [...] or None}`. |
| a detection dict | `{"box": [x0,y0,x1,y1] ints in frame coords, "score": float}` — plus optional `"polygon": [[x,y],...]`, `"side"`, `"diameter_px"`. |
| `available()` | bool, **no model load, no network** — checks the on-disk snapshot (and hub cache). Called at startup preflight and by `/api/capabilities`. |
| `model_source()` | local dir if fetched, else the hub id — shown in preflight/setup output. |
| `prompts()` | `{"plates": <str>, "bar": <str>}` — the phrases, for the UI label. |
| `get_model()` | lazy-load + cache; "first request pays". |
| `gpu_submit()` | the shared MPS lock context manager (see below) — **must exist**; `vitpose_backend` imports and calls it every frame. |

Frontend specifics (`src/app.py`, `drawEquipment`):
- `plates` at most two, ordered **left→right** by box centre, each with
  `diameter_px` (short side of the box = the 450mm scale reference) and `side`.
- The overlay draws `polygon` if present and **falls back to `box`** if not — a
  box-only detector (Grounding DINO) is fine; you just lose the traced outline.
- `crop` (the search window) is drawn dashed when present; return `None` if the
  model does one full-frame pass.
- Labels read `p.score` and `eq.bar.score` — always populate `score`.

## The MPS concurrency lock — non-negotiable

Pose and equipment run on **two threads sharing one GPU**. On Apple Silicon,
MPSGraph is *not* thread-safe for concurrent Metal command-buffer encode: two
forwards encoding at once segfaults the driver (a SIGSEGV on the "metal gpu
stream" thread, ~15 frames in, wherever the two happened to line up). So both
backends take **one shared lock** — `equipment_backend.gpu_submit()` — around
**every GPU submission**, held as briefly as possible:

- the forward pass,
- the host→device copy (`inputs.to(DEVICE)`),
- **and the lazy weight copy** `model.to(DEVICE)` in `get_model()` — it runs on
  the worker thread on frame 0 while pose is already going, so it must take the
  lock too.

`gpu_submit()` is a real lock on `mps` and a `contextlib.nullcontext()` on
cuda/cpu (where concurrent submission is safe and overlap is the whole point).
Keep CPU-side prep (resize, tokenize, post-process math) **outside** the lock.
If you add a new GPU touch, it goes inside `gpu_submit()` or the crash comes
back.

## Portability — MPS now, Ubuntu too

- Device pick mirrors `vitpose_backend`: cuda (incl. ROCm) → mps → cpu, chosen
  at import.
- `os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")` **before** `import
  torch`, so an op the MPS backend lacks falls back to CPU instead of raising.
- No CUDA-only calls; let `transformers`/`torch` pick kernels. The same code
  path must run on both boxes.

## Files that name the model — change them all

`detect()` is one file; the model's *name* leaks into user-facing strings and
setup. Grep first so nothing goes stale:

```bash
grep -rIln -i "<oldmodelname>" . | grep -vE "\.git/|__pycache__|/report/"
```

Checklist (what the CLIPSeg → Grounding DINO swap touched):
- `src/equipment_backend.py` — `MODEL_ID`, model dir constant + env var, loader
  classes, prompts, thresholds, docstring.
- `scripts/download_models.sh` — repo base URL, the file list (**safetensors,
  not `pytorch_model.bin`** — the repo ships both and `from_pretrained` prefers
  safetensors; taking both doubles the download), the opt-in env var
  (`COACH_DINO`/`COACH_DINO=0`), and the "done" summary lines.
- `requirements.txt` — the `transformers` comment / any new dep + min version.
- `src/app.py` — the 503 message, the `title=` on the tickbox, the
  `/api/capabilities` disable note (`veqnote`), and `preflight()`'s label.
- `scripts/coach_launch.sh` — the optional-detector offer block (the dir-present
  check + interactive prompt); its `DINO_DIR` default **must match**
  `equipment_backend`'s. Keep it non-fatal — a missing optional model never
  blocks launch.
- `scripts/setup_conda_mac.sh` + `setup_conda_linux.sh` — the verify-print label.
- `scripts/batch_extract_tracks.py` — the `--detect-equipment` help text.
- `docs/deploy.md` — the optional-checkpoint paragraph, size, and env vars.
- `src/vitpose_backend.py` — the `_EquipmentWorker` docstring + the per-frame
  `gpu_submit()` comment that name the old model.

## Download script conventions

`download_models.sh` fetches with plain `curl` against the public `resolve/main`
URLs — no `huggingface_hub`/auth at setup. Mirror the existing block: an
**opt-in** prompt (the model is optional), an env var for unattended installs
(`COACH_<X>=1` takes it, `=0` declines), atomic `.part`→`mv`, a dir constant that
**must match** `equipment_backend`'s default, and only the files
`from_pretrained` actually opens.

## Prompt tuning gotcha

Grounding DINO (and any contrastive text-conditioned detector) scores objects
that **share one query** against each other — a strong match steals probability
mass from a weak one. Measured on a real snatch frame: the near plate stack
scored "colorful bumper plates" 0.54 but bare "weight plates" 0.21 (under the
0.25 gate → gone) *when "a barbell" was in the same query*. So:
- Measure phrasings on a real fixture frame, don't guess.
- A specific, distinctive phrase survives a shared query; a bland one gets
  crowded out.
- Keep prompts env-overridable (`COACH_BAR_PROMPT`, `COACH_PLATE_PROMPT`).
- If routing detections by label keyword (`"plate" in label`, `"bar" in label`),
  the prompt words must contain those keywords, and check the more specific one
  first ("barbell" contains "bar" but not "plate").

## Boxes vs masks — composing a detector with a segmenter

A detector (Grounding DINO) gives boxes; a segmenter (CLIPSeg, SAM) gives
per-pixel masks. The tempting composition is **detector locates → segmenter
refines**: run the segmenter on a crop of each box, where the object fills the
frame (the regime CLIPSeg is sharp in) and localisation is already solved. The
frontend renders `polygon` for free, so a mask drops straight in.

But **verify the mask earns its place before shipping it — don't assume finer =
better.** This was built (DINO→CLIPSeg, ellipse-fit for a tilt-corrected plate
diameter) and MEASURED on the test lift, and it was a net loss: DINO boxes the
whole plate *stack*, so on a side-on lift the box short side is already ≈one
plate's diameter while an ellipse over the box spans all ~8 plates (458px vs the
correct ~157px); and CLIPSeg over a cluttered, multi-colour crop returned a
diffuse cloud that fragmented into 40+ speckle blobs and leaked onto the floor
and a background athlete. Dump the crop, heatmap, and mask to a PNG and LOOK
(`cv2.imwrite` a side-by-side) before trusting a mask-derived number. A finer
mask helps only when the object presents the shape you're measuring (a plate
*facing* the camera → a real disc to fit); a projection/orientation problem is
the 3D task, not a segmenter bolt-on. When the mask doesn't win, keep it
box-only and record *why* in the backend docstring so it isn't blindly retried.

## Validate before calling it done

1. **Import smoke test** — `available()`, `model_source()`, `prompts()`,
   `DEVICE` print without loading weights.
2. **Real frame** — run `detect()` on a fixture frame that has the equipment
   (`report/examples/athlete-a-trim.mp4` frame 50/70) and confirm `plates`
   populate with `diameter_px` and `bar` has a `box`+`score`. The first call
   pays a one-time MPS compile (several seconds); steady-state should be ~1s/
   frame ("roughly halves throughput" is expected and documented).
3. **Restart to load it** — `waitress` does not hot-reload; `./scripts/restart.sh`
   after any `src/*.py` edit or the running process keeps the old model.

Run everything in the `coach` conda env: `conda run -n coach python ...` (cv2/
torch/transformers live there).
