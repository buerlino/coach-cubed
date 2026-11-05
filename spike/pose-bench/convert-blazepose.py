# SPDX-License-Identifier: AGPL-3.0-or-later
"""Converts MediaPipe Pose Landmarker full's two TF Lite models to ONNX.

python convert-blazepose.py   (with TensorFlow, tf2onnx, onnx and
onnxruntime installed; the versions used are in README.md)

Reads models/pose_landmarker_full.task (Apache-2.0, fetch-models.sh), a zip
of pose_detector.tflite and pose_landmarks_detector.tflite, and writes
models/pose_detector_full.onnx and models/pose_landmarks_full.onnx for
lib/blazepose-onnx.mjs. Not part of npm test; the outputs are gitignored.

- The detector stores 38 weight tensors sparse (TF Lite's DENSIFY op), which
  tf2onnx 1.17 can't convert. TF Lite's own interpreter densifies them (one
  invoke with every tensor kept); those values replace the sparse buffers
  and DENSIFY becomes an Identity.
- The landmark model converts as is; its segmentation mask and world
  landmarks are cut off (unused), keeping the landmarks, the pose flag and
  the heatmaps.
- Each ONNX model is checked against TF Lite on the same input.
"""
import hashlib
import os
import zipfile

import numpy as np
import onnx
import onnxruntime
import tensorflow as tf
import tf2onnx
from onnx import utils as onnx_utils
from tf2onnx import tflite_utils
from tf2onnx.handler import tfl_op

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, 'models')
OPSET = 17


@tfl_op(['TFL_DENSIFY'])
class Densify:  # pylint: disable=too-few-public-methods
    """Its input is made dense below, so DENSIFY is a no-op."""
    @classmethod
    def version_1(cls, ctx, node, **kwargs):  # pylint: disable=unused-argument
        node.type = 'Identity'


def interpreter(path, delegates=True):
    # XNNPACK (a default delegate) takes over the sparse layers, so their
    # densified weights are only computed with the delegates off.
    resolver = (tf.lite.experimental.OpResolverType.AUTO if delegates
                else tf.lite.experimental.OpResolverType.BUILTIN_WITHOUT_DEFAULT_DELEGATES)
    it = tf.lite.Interpreter(model_path=path, experimental_preserve_all_tensors=True,
                             experimental_op_resolver_type=resolver)
    it.allocate_tensors()
    inp = it.get_input_details()[0]
    x = np.random.default_rng(0).random(inp['shape'], dtype=np.float32)
    it.set_tensor(inp['index'], x)
    it.invoke()
    return it, x


def dense_buffers(path):
    """Buffer index of each DENSIFY input → the dense bytes of its output."""
    it, _ = interpreter(path, delegates=False)
    model = tflite_utils.Model.GetRootAsModel(bytearray(open(path, 'rb').read()), 0)
    graph = model.Subgraphs(0)
    out = {}
    for op in it._get_ops_details():  # pylint: disable=protected-access
        if op['op_name'] == 'DENSIFY':
            dense = it.get_tensor(op['outputs'][0])
            out[graph.Tensors(op['inputs'][0]).Buffer()] = dense.tobytes()
    return out


class _Buffer:
    def __init__(self, data):
        self.data = np.frombuffer(data, dtype=np.uint8)

    def DataIsNone(self):  # pylint: disable=invalid-name
        return False

    def DataAsNumpy(self):  # pylint: disable=invalid-name
        return self.data


class _Model:
    """The parsed model, with some buffers replaced."""
    def __init__(self, model, buffers):
        self._model, self._buffers = model, buffers

    def Buffers(self, i):  # pylint: disable=invalid-name
        return _Buffer(self._buffers[i]) if i in self._buffers else self._model.Buffers(i)

    def __getattr__(self, name):
        return getattr(self._model, name)


def convert(tfl, onnx_path, buffers=None, keep=None):
    read = tflite_utils.read_tflite_model
    if buffers:
        def patched(path):
            graphs, opcodes, model, shapes = read(path)
            return graphs, opcodes, _Model(model, buffers), shapes
        tflite_utils.read_tflite_model = patched
    try:
        proto, _ = tf2onnx.convert.from_tflite(tfl, opset=OPSET)
    finally:
        tflite_utils.read_tflite_model = read
    onnx.save(proto, onnx_path)
    if keep:   # only these outputs (by TF Lite name), the rest pruned
        names = [o.name for o in proto.graph.output if o.name in keep]
        onnx_utils.extract_model(onnx_path, onnx_path, [i.name for i in proto.graph.input], names)


def check(tfl, onnx_path):
    """Largest difference between TF Lite's and ONNX Runtime's outputs."""
    it, x = interpreter(tfl)
    ref = {d['name']: it.get_tensor(d['index']) for d in it.get_output_details()}
    sess = onnxruntime.InferenceSession(onnx_path, providers=['CPUExecutionProvider'])
    got = sess.run(None, {sess.get_inputs()[0].name: x})
    rows = []
    for o, v in zip(sess.get_outputs(), got):
        r = ref[o.name]
        rows.append(f'{o.name} {list(v.shape)} max |diff| {float(np.max(np.abs(v - r))):.2e} (range {float(r.min()):.2f}..{float(r.max()):.2f})')
    return rows


def main():
    task = os.path.join(MODELS, 'pose_landmarker_full.task')
    out_dir = os.path.join(MODELS, 'pose_landmarker_full')
    os.makedirs(out_dir, exist_ok=True)
    with zipfile.ZipFile(task) as z:
        z.extractall(out_dir, ['pose_detector.tflite', 'pose_landmarks_detector.tflite'])
    det = os.path.join(out_dir, 'pose_detector.tflite')
    lmk = os.path.join(out_dir, 'pose_landmarks_detector.tflite')
    det_onnx = os.path.join(MODELS, 'pose_detector_full.onnx')
    lmk_onnx = os.path.join(MODELS, 'pose_landmarks_full.onnx')

    buffers = dense_buffers(det)
    print(f'detector: {len(buffers)} sparse tensors densified by TF Lite, '
          f'{sum(np.count_nonzero(np.frombuffer(v, np.float16)) for v in buffers.values())} non-zero values')
    convert(det, det_onnx, buffers=buffers)
    # Identity: landmarks (195), Identity_1: pose flag, Identity_3: heatmaps.
    convert(lmk, lmk_onnx, keep={'Identity', 'Identity_1', 'Identity_3'})
    for tfl, path in ((det, det_onnx), (lmk, lmk_onnx)):
        digest = hashlib.sha256(open(path, 'rb').read()).hexdigest()
        print(f'{os.path.basename(path)}  {os.path.getsize(path)} bytes  sha256 {digest}')
        for row in check(tfl, path):
            print('  ' + row)
    print(f'tensorflow {tf.__version__}, tf2onnx {tf2onnx.__version__}, onnx {onnx.__version__}, '
          f'onnxruntime {onnxruntime.__version__}, opset {OPSET}')


if __name__ == '__main__':
    main()
