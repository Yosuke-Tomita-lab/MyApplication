#!/usr/bin/env python3
"""Convert the released InstantHMR ONNX graph into the file the STS Web Analyzer loads in the browser.

    pip install onnx onnxruntime numpy huggingface_hub
    python scripts/convert_instanthmr_web.py --out instanthmr-medium-fit1-web.onnx

The original (`instanthmr-medium-fit1.onnx` from huggingface.co/momolesang/InstantHMR) does not run correctly
in onnxruntime-web on WebGPU. Three changes fix that; none of them changes the result:

1. fp16 -> fp32 (initializers, Constant tensors, Cast targets, value types). Without the WebGPU `shader-f16`
   feature the fp16 graph does not compile, and on the CPU fp32 is ~40x faster than emulated fp16.
2. MaxPool `ceil_mode` 1 -> 0. The only MaxPool has a 2x2 kernel, stride 1 and no padding, where floor and ceil
   give the same output size; onnxruntime-web's WebGPU MaxPool rejects ceil_mode.
3. Slice nodes whose constant `axes` are not ascending (one, axes [1, 0]) get axes, starts, ends and steps
   reordered. onnxruntime-web's WebGPU Slice returns `shape_params` with the wrong values otherwise.

The script checks the converted graph against the original on the CPU before writing it.
The weights are under the SAM License, and the `medium` model is for non-commercial use only.
"""
from __future__ import annotations

import argparse

import numpy as np
import onnx
from onnx import TensorProto, numpy_helper


def to_fp32(graph: onnx.GraphProto) -> None:
    for i, t in enumerate(graph.initializer):
        if t.data_type == TensorProto.FLOAT16:
            graph.initializer[i].CopyFrom(numpy_helper.from_array(numpy_helper.to_array(t).astype(np.float32), t.name))
    for n in graph.node:
        for a in n.attribute:
            if n.op_type == "Cast" and a.name == "to" and a.i == TensorProto.FLOAT16:
                a.i = TensorProto.FLOAT
            if a.type == onnx.AttributeProto.TENSOR and a.t.data_type == TensorProto.FLOAT16:
                a.t.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(a.t).astype(np.float32), a.t.name))
    for vi in list(graph.value_info) + list(graph.input) + list(graph.output):
        if vi.type.tensor_type.elem_type == TensorProto.FLOAT16:
            vi.type.tensor_type.elem_type = TensorProto.FLOAT


def fix_maxpool(graph: onnx.GraphProto) -> int:
    fixed = 0
    for n in graph.node:
        if n.op_type != "MaxPool":
            continue
        attrs = {a.name: onnx.helper.get_attribute_value(a) for a in n.attribute}
        if attrs.get("ceil_mode", 0) != 1:
            continue
        if list(attrs.get("strides", [1, 1])) != [1, 1] or any(attrs.get("pads", [0, 0, 0, 0])):
            raise SystemExit(f"{n.name}: ceil_mode only matters here with stride > 1 or padding; not handled")
        for a in n.attribute:
            if a.name == "ceil_mode":
                a.i = 0
        fixed += 1
    return fixed


def fix_slice_axes(graph: onnx.GraphProto) -> int:
    init = {i.name: numpy_helper.to_array(i) for i in graph.initializer}
    fixed = 0
    for n in graph.node:
        if n.op_type != "Slice" or len(n.input) < 4 or n.input[3] not in init:
            continue
        axes = init[n.input[3]]
        if axes.size < 2 or list(axes) == sorted(axes):
            continue
        order = np.argsort(axes)
        for k in range(1, min(5, len(n.input))):
            if not n.input[k]:
                continue
            if n.input[k] not in init:
                raise SystemExit(f"{n.name}: non-constant Slice input {n.input[k]}")
            name = f"{n.input[k]}_sorted_{n.name}"
            graph.initializer.append(numpy_helper.from_array(init[n.input[k]][order], name))
            n.input[k] = name
        fixed += 1
    used = {i for n in graph.node for i in n.input}
    keep = [i for i in graph.initializer if i.name in used]
    del graph.initializer[:]
    graph.initializer.extend(keep)
    return fixed


def check(original: str, converted: onnx.ModelProto) -> None:
    import onnxruntime as ort

    rng = np.random.default_rng(0)
    feeds = {"image": rng.integers(0, 255, (1, 288, 288, 3), dtype=np.uint8),
             "cliff_cond": np.array([[0.0, 0.1, 0.6]], np.float32),
             "crop_box": np.array([[200, 500, 400, 400]], np.float32),
             "cam": np.array([[1550, 360, 640]], np.float32)}
    a = ort.InferenceSession(original, providers=["CPUExecutionProvider"]).run(None, feeds)
    b = ort.InferenceSession(converted.SerializeToString(), providers=["CPUExecutionProvider"]).run(None, feeds)
    names = ["mhr_params", "shape_params", "cam_trans", "joints_2d"]
    diffs = {k: float(np.abs(x - y).max()) for k, x, y in zip(names, a, b)}
    print("max |original - converted|:", diffs)
    if diffs["joints_2d"] > 2.0 or diffs["cam_trans"] > 0.05:
        raise SystemExit("converted graph differs too much from the original")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--src", help="original .onnx (default: download instanthmr-medium-fit1.onnx)")
    p.add_argument("--out", default="instanthmr-medium-fit1-web.onnx")
    args = p.parse_args()
    src = args.src
    if not src:
        from huggingface_hub import hf_hub_download
        src = hf_hub_download("momolesang/InstantHMR", "instanthmr-medium-fit1.onnx")
    model = onnx.load(src)
    to_fp32(model.graph)
    print("MaxPool ceil_mode fixed:", fix_maxpool(model.graph))
    print("Slice axes reordered:", fix_slice_axes(model.graph))
    check(src, model)
    onnx.save(model, args.out)
    print("wrote", args.out)


if __name__ == "__main__":
    main()
