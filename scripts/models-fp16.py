"""Stores the OCR models' weights as 16-bit floats, halving their size.

Each large float32 weight becomes a float16 one followed by a Cast back to float32, so the models still compute in
float32: ONNX Runtime folds the casts away when it loads a model (graphOptimizationLevel 'all'), so recognition
runs exactly as before. On the test pages in scripts/ocr-check the text recognised is the same, character for
character.

    pip install onnx numpy
    python3 scripts/models-fp16.py ORIGINAL_MODELS_DIR extension/ocr/models

ORIGINAL_MODELS_DIR holds det.onnx, rec.onnx and cls.onnx as exported from PaddleOCR (float32).
"""
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def half(src, dst):
    m = onnx.load(src)
    g = m.graph
    inits, casts = [], []
    for init in g.initializer:
        a = numpy_helper.to_array(init)
        if init.data_type != TensorProto.FLOAT or a.size < 256:   # small tensors aren't worth it
            inits.append(init)
            continue
        h = numpy_helper.from_array(a.astype(np.float16), init.name + '__fp16')
        inits.append(h)
        casts.append(helper.make_node('Cast', [h.name], [init.name], to=TensorProto.FLOAT, name=init.name + '__cast'))
    del g.initializer[:]
    g.initializer.extend(inits)
    nodes = list(g.node)
    del g.node[:]
    g.node.extend(casts + nodes)
    cast = {c.output[0] for c in casts}   # older opsets list weights as graph inputs too
    keep = [i for i in g.input if i.name not in cast]
    del g.input[:]
    g.input.extend(keep)
    onnx.checker.check_model(m)
    onnx.save(m, dst)


if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    for f in ['det.onnx', 'rec.onnx', 'cls.onnx']:
        half(os.path.join(src, f), os.path.join(dst, f))
        print(f, os.path.getsize(os.path.join(src, f)) // 1024, '->', os.path.getsize(os.path.join(dst, f)) // 1024, 'KB')
