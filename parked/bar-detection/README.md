# Bar and plate detection (parked)

Parked on 2026-10-31 (restructuring step 2.3): 0.1.0's core is the lift
analysis, and these models (Grounding DINO about 700 MB, SAM 3 about 3.4 GB)
can't run on a phone. Map area 5 in [docs/map.md](../../docs/map.md) describes
what this did.

## What is here

| File | Was |
| --- | --- |
| `equipment_backend.py` | `src/equipment_backend.py`: Grounding DINO, and the `gpu_submit()` lock it shared with ViTPose |
| `equipment_sam3.py` | `src/equipment_sam3.py`: SAM 3, swapped in with `COACH_SAM3=1` |
| `download_models.sh` | `scripts/download_models.sh` as it was, with the Grounding DINO and SAM 3 sections (the live one keeps only pose) |
| `requirements.txt` | the `transformers` line from the root `requirements.txt` |
| `reference/` | `reference/barbell.png`, `plates.png` (no code read them) |
| `model-add-skill/` | `.claude/skills/model-add/`, the playbook for swapping the detector |

## What was unwired

To revive it, these are the places that used to call it (the parking commit
shows each diff: `git log -- parked/bar-detection/equipment_backend.py`):

- `src/vitpose_backend.py`, `infer_video()`: the `detect_equipment` argument,
  the `_EquipmentWorker` thread that ran `detect()` beside ViTPose, the
  `gpu_submit()` lock around the pose forward pass (on Apple Silicon the two
  models must not submit to Metal at once), and the `equipment`,
  `equipment_prompts` and `equipment_error` fields in `meta`.
- `src/app.py`, server: the `detect_equipment` form field on
  `/api/pose/video/start` (it now answers 400), `/api/capabilities`'
  `equipment` flag, the `/api/train/link` manifest field, and the
  `preflight()` line.
- `src/app.py`, `INDEX_HTML`: the "equipment overlay" settings group
  (`veqrun`, `veqbar`, `veqplates`, `veqnote`), `drawEquipment()`,
  `vRenderEqNote()`, the capability gating, and the status line for
  `equipment_error`. `vEquipment` stays only as 3D's input.
- `scripts/batch_extract_tracks.py`, `scripts/sync_clipper_fixtures.py`:
  `--detect-equipment`.
- `scripts/coach_launch.sh`: the "download Grounding DINO?" prompt.
- `scripts/setup_conda_linux.sh`, `setup_conda_mac.sh`: the import check.

Tracks made before the parking still carry `meta.equipment`; the 3D
plate-anchor method reads it until 3D is parked too.

## The checkpoints, as they were

Kept from `docs/deploy.md`, which step 2.6 folded into `docs/server.md`:

- **Grounding DINO** (`~/models/grounding-dino-base`, about 700 MB) was the
  one optional checkpoint. The download script offered it: `COACH_DINO=1`
  took it without asking and `COACH_DINO=0` declined, for unattended
  installs. `COACH_DINO_DIR` moved it, and the download script,
  `equipment_backend.py` and the launch check had to agree on that path. It
  was fetched to disk rather than left to `transformers`, so the first
  analysis didn't stall on a hub download and the detector ran offline.
  Without it the app still started: `/api/capabilities` reported it missing,
  the page greyed out the tickboxes and the start endpoint answered 503.
- **SAM 3** (`~/models/sam3`, about 3.4 GB; `COACH_SAM3=1` or `0`,
  `COACH_SAM3_DIR`) is **gated**. `facebook/sam3` needs a Hugging Face token
  (`$HF_TOKEN`, or `hf auth login`) **and** that account approved by hand at
  <https://huggingface.co/facebook/sam3>. The script sent the token for this
  block only, and probed access with a 1-byte ranged GET before the 3.4 GB
  download. It took only `model.safetensors`; the repo's `sam3.pt` is the
  same weights in Meta's own format. Where the script put it and where the
  loader looked differed (map area 5).
