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
