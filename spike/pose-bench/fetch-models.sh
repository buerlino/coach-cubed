#!/usr/bin/env bash
# Downloads the spike's model weights into models/ (gitignored) and checks
# each against its SHA-256. Pinned URLs only; licences in README.md.
#   ./fetch-models.sh            every model
#   ./fetch-models.sh vitpose-s  only the files whose name contains "vitpose-s"
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p models

# name | url | sha256 ("-" = not published by the host; printed for the README)
MODELS=(
  "vitpose-s-coco.onnx|https://huggingface.co/JunkyByte/easy_ViTPose/resolve/e83805274e89428969355ec4afffcbc413e79188/onnx/coco/vitpose-s-coco.onnx|4fa1d994578f76eb96e95f3cebecb6ebecd7021a85d16b4f4de8eb4441006da5"
  "vitpose-b-coco.onnx|https://huggingface.co/JunkyByte/easy_ViTPose/resolve/e83805274e89428969355ec4afffcbc413e79188/onnx/coco/vitpose-b-coco.onnx|26e215fd6e27305824f13db0a0d0b597c3c4adf030dd66cbadf2228256f4af25"
  "pose_landmarker_lite.task|https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task|59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a"
  "pose_landmarker_full.task|https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task|5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1"
  "pose_landmarker_heavy.task|https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task|64437af838a65d18e5ba7a0d39b465540069bc8aae8308de3e318aad31fcbc7b"
  "yolox_nano.onnx|https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx|c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d"
  "yolox_tiny.onnx|https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx|427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7"
  "rtmpose-s.zip|https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-s_simcc-body7_pt-body7_420e-256x192-acd4a1ef_20230504.zip|7673922e531014906ca4f0f239b7e233b740146a10b632deaa2a28d45470d802"
  "rtmpose-m.zip|https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.zip|f7fbb6c5c11a1bb70f3d445e4ddec5d144ea89ad5649c081ef976f9b24a0b741"
)

only="${1:-}"
for row in "${MODELS[@]}"; do
  IFS='|' read -r name url sha <<<"$row"
  [[ -n "$only" && "$name" != *"$only"* ]] && continue
  if [[ ! -f "models/$name" ]]; then
    echo "fetching $name"
    curl -fL --retry 3 -o "models/$name.part" "$url"
    mv "models/$name.part" "models/$name"
  fi
  got=$(sha256sum "models/$name" | cut -d' ' -f1)
  if [[ "$sha" == "-" ]]; then
    echo "$name  $(stat -c %s "models/$name") bytes  sha256 $got (no published hash)"
  elif [[ "$got" != "$sha" ]]; then
    echo "SHA-256 MISMATCH for $name: $got" >&2; exit 1
  else
    echo "$name  $(stat -c %s "models/$name") bytes  ok"
  fi
  # OpenMMLab ships ONNX inside a zip (end2end.onnx plus its pipeline json):
  # unpacked into a folder of its own, the .onnx then copied out by name.
  if [[ "$name" == *.zip && ! -f "models/${name%.zip}.onnx" ]]; then
    rm -rf "models/${name%.zip}"; mkdir "models/${name%.zip}"
    unzip -q -j "models/$name" -d "models/${name%.zip}"
    cp "models/${name%.zip}/end2end.onnx" "models/${name%.zip}.onnx"
    echo "  -> ${name%.zip}.onnx  sha256 $(sha256sum "models/${name%.zip}.onnx" | cut -d' ' -f1)"
  fi
done
