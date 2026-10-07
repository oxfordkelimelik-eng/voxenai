# MediaPipe .tflite modelini skinSeg.js'in okuduğu graph.json + weights.bin
# biçimine aktarır. Kullanım (pip install tflite numpy):
#   python exportTflite.py   (selfie_multiclass_256x256.tflite ile aynı klasörde)
# Çıktıları functions/models/selfie_multiclass/ altına kopyala.
import json, sys, numpy as np, tflite
buf = open('selfie_multiclass_256x256.tflite', 'rb').read()
m = tflite.Model.GetRootAsModel(buf, 0)
g = m.Subgraphs(0)
names = {v: k for k, v in tflite.BuiltinOperator.__dict__.items() if not k.startswith('_')}
TYPES = {0: np.float32, 2: np.int32, 4: np.int64, 1: np.float16}
tensors, blobs, off = [], [], 0
for i in range(g.TensorsLength()):
    t = g.Tensors(i)
    b = m.Buffers(t.Buffer())
    ent = {"shape": t.ShapeAsNumpy().tolist() if t.ShapeLength() else [], "type": t.Type()}
    if b is not None and b.DataLength() > 0:
        arr = np.frombuffer(b.DataAsNumpy().tobytes(), dtype=TYPES[t.Type()])
        if t.Type() == 1: arr = arr.astype(np.float32); ent["type"] = 0
        if t.Type() == 4: arr = arr.astype(np.int32); ent["type"] = 2
        raw = arr.astype(np.float32 if ent["type"] == 0 else np.int32).tobytes()
        ent["offset"], ent["length"] = off, len(raw) // 4
        blobs.append(raw); off += len(raw)
    tensors.append(ent)
def opts(op, cls):
    o = cls(); t = op.BuiltinOptions()
    if t is None: return None
    o.Init(t.Bytes, t.Pos); return o
PAD = {0: "same", 1: "valid"}
ops = []
for i in range(g.OperatorsLength()):
    op = g.Operators(i); oc = m.OperatorCodes(op.OpcodeIndex())
    name = names[max(oc.BuiltinCode(), oc.DeprecatedBuiltinCode())]
    e = {"op": name, "in": op.InputsAsNumpy().tolist(), "out": op.OutputsAsNumpy().tolist()}
    if name == "CONV_2D":
        o = opts(op, tflite.Conv2DOptions); e.update(pad=PAD[o.Padding()], s=[o.StrideH(), o.StrideW()], d=[o.DilationHFactor(), o.DilationWFactor()], act=o.FusedActivationFunction())
    elif name == "DEPTHWISE_CONV_2D":
        o = opts(op, tflite.DepthwiseConv2DOptions); e.update(pad=PAD[o.Padding()], s=[o.StrideH(), o.StrideW()], d=[o.DilationHFactor(), o.DilationWFactor()], act=o.FusedActivationFunction(), mult=o.DepthMultiplier())
    elif name in ("ADD", "MUL"):
        o = opts(op, tflite.AddOptions if name == "ADD" else tflite.MulOptions); e.update(act=o.FusedActivationFunction() if o else 0)
    elif name == "RESHAPE":
        o = opts(op, tflite.ReshapeOptions)
        if o is not None and o.NewShapeLength(): e["shape"] = o.NewShapeAsNumpy().tolist()
    elif name == "SOFTMAX":
        o = opts(op, tflite.SoftmaxOptions); e["beta"] = o.Beta()
    elif name == "SUM":
        o = opts(op, tflite.ReducerOptions); e["keep"] = bool(o.KeepDims())
    elif name == "RESIZE_BILINEAR":
        o = opts(op, tflite.ResizeBilinearOptions); e.update(ac=bool(o.AlignCorners()), hp=bool(o.HalfPixelCenters()))
    elif name == "RESIZE_NEAREST_NEIGHBOR":
        o = opts(op, tflite.ResizeNearestNeighborOptions); e.update(ac=bool(o.AlignCorners()), hp=bool(o.HalfPixelCenters()))
    elif name == "TRANSPOSE_CONV":
        o = opts(op, tflite.TransposeConvOptions); e.update(pad=PAD[o.Padding()], s=[o.StrideH(), o.StrideW()])
    ops.append(e)
out = {"inputs": g.InputsAsNumpy().tolist(), "outputs": g.OutputsAsNumpy().tolist(), "tensors": tensors, "ops": ops}
json.dump(out, open('graph.json', 'w'))
open('weights.bin', 'wb').write(b''.join(blobs))
print(len(ops), 'ops', off, 'bytes', set(t["type"] for t in tensors))
