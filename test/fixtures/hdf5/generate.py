"""Generate small HDF5 fixtures for test/hdf5-reader.test.ts.

Usage: uv run -q --with h5py --with numpy --with hdf5plugin python \
         test/fixtures/hdf5/generate.py test/fixtures/hdf5

Values follow deterministic formulas mirrored in the TS test:
  int:   v(i) = (i * 37 + (i // 7)) % mod
  float: v(i) = (i % 1000) * 0.25 - 17.5   (exact in float32)
"""
import json, sys, os
import numpy as np
import h5py

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
expected = {}

def ival(shape, dtype):
    n = int(np.prod(shape))
    i = np.arange(n, dtype=np.int64)
    mod = {1: 251, 2: 65521, 4: 2**31 - 1}[np.dtype(dtype).itemsize]
    return ((i * 37 + i // 7) % mod).astype(dtype).reshape(shape)

def fval(shape):
    n = int(np.prod(shape))
    i = np.arange(n, dtype=np.int64)
    return ((i % 1000) * 0.25 - 17.5).astype(np.float32).reshape(shape)

def chars(s):
    return np.array([c.encode() for c in s], dtype="S1")

def chunk_list(d):
    try:
        n = d.id.get_num_chunks()
    except Exception:
        return None
    infos = [d.id.get_chunk_info(i) for i in range(n)]
    lst = sorted([[list(x.chunk_offset), x.byte_offset, x.size, x.filter_mask] for x in infos])
    if len(lst) > 64:
        return {"count": len(lst), "first": lst[:4], "last": lst[-4:]}
    return lst

def describe(fname, f):
    ds = {}
    def visit(name, obj):
        if isinstance(obj, h5py.Dataset):
            ds["/" + name] = {
                "shape": list(obj.shape),
                "chunks": list(obj.chunks) if obj.chunks else None,
                "dtype": obj.dtype.str,
                "chunkList": chunk_list(obj) if obj.chunks else None,
                "formula": obj.attrs.get("formula", b"").decode() if isinstance(obj.attrs.get("formula", b""), bytes) else str(obj.attrs.get("formula", "")),
            }
    f.visititems(visit)
    expected[fname] = {"datasets": ds}

def common_content(f, dense):
    # Imaris-style char-array attributes + assorted scalar/array attributes
    g = f.create_group("DataSetInfo")
    ch = g.create_group("Channel 0")
    ch.attrs["Name"] = chars("hoechst")
    ch.attrs["Color"] = chars("0.000 0.165 1.000")
    ch.attrs["ColorRange"] = chars("519.369 4560.004")
    ch.attrs["Empty"] = np.array([b""], dtype="S1")
    f.attrs["IntScalar"] = np.int32(-42)
    f.attrs["U16Array"] = np.array([1, 2, 65535], dtype=np.uint16)
    f.attrs["F64Scalar"] = np.float64(3.25)
    f.attrs["F32Array"] = np.array([0.5, -1.5], dtype=np.float32)
    f.attrs["FixedStr"] = np.bytes_(b"hello")
    f.attrs["Big64"] = np.uint64(2**60 + 3)
    f.attrs["VlenStr"] = "variable length"
    f.attrs["BigEndianI32"] = np.array([7, -9], dtype=">i4")
    # group with many children (dense links when > 8 and libver >= v108)
    many = f.create_group("Many")
    for k in range(12):
        many.create_group(f"Child {k}")
    if dense:
        # > 8 attributes => dense attribute storage
        for k in range(12):
            many.attrs[f"Attr{k:02d}"] = chars(str(k * 11))

    # Hundreds of hard links (to one group): multi-block fractal heap with an
    # indirect root block + multi-level v2 B-tree (new style), or many SNODs
    # under a multi-level v1 B-tree (old style).
    lots = f.create_group("Lots")
    for k in range(300):
        lots[f"hard link number {k:04d} with a fairly long name"] = many

    level = f.create_group("DataSet/ResolutionLevel 0/TimePoint 0/Channel 0")
    level.attrs["ImageSizeX"] = chars("17")
    level.attrs["ImageSizeY"] = chars("33")
    level.attrs["ImageSizeZ"] = chars("20")
    d = level.create_dataset("Data", data=ival((20, 33, 17), np.uint8), chunks=(8, 16, 8), compression="gzip", compression_opts=2)
    d.attrs["formula"] = "int"
    d = f.create_dataset("u16_gzip_shuffle", data=ival((10, 40, 30), np.uint16), chunks=(4, 16, 16), compression="gzip", shuffle=True)
    d.attrs["formula"] = "int"
    d = f.create_dataset("f32_gzip_shuffle_fletcher", data=fval((9, 50, 21)), chunks=(4, 32, 8), compression="gzip", compression_opts=1, shuffle=True, fletcher32=True)
    d.attrs["formula"] = "float"
    d = f.create_dataset("f32_gzip", data=fval((12, 12, 12)), chunks=(5, 5, 5), compression="gzip")
    d.attrs["formula"] = "float"
    # partially allocated: only two chunks written; fill value 0
    d = f.create_dataset("partial_u16", shape=(32, 32, 32), dtype=np.uint16, chunks=(16, 16, 16), compression="gzip")
    full = ival((32, 32, 32), np.uint16)
    d[0:16, 0:16, 0:16] = full[0:16, 0:16, 0:16]
    d[16:32, 16:32, 0:16] = full[16:32, 16:32, 0:16]
    d.attrs["formula"] = "int-partial"
    d = f.create_dataset("contig_i16", data=ival((6, 7), np.int16))
    d.attrs["formula"] = "int"
    d = f.create_dataset("contig_be_u16", data=ival((5, 9), ">u2"))
    d.attrs["formula"] = "int"

# 1. old-style: superblock v0, v1 object headers, symbol-table groups
with h5py.File(f"{out}/old.h5", "w", libver="earliest") as f:
    common_content(f, dense=False)
with h5py.File(f"{out}/old.h5", "r") as f:
    describe("old.h5", f)

# 2. Imaris-like: superblock v2, OHDR v2, dense links/attrs, layout v3 + v1 B-tree chunk index
with h5py.File(f"{out}/v108.h5", "w", libver=("v108", "v108")) as f:
    common_content(f, dense=True)
with h5py.File(f"{out}/v108.h5", "r") as f:
    describe("v108.h5", f)

def layout_content(f):
    d = f.create_dataset("single_chunk_gzip", data=ival((10, 20), np.uint16), chunks=(10, 20), compression="gzip")
    d.attrs["formula"] = "int"
    d = f.create_dataset("single_chunk_raw", data=ival((10, 20), np.uint8), chunks=(10, 20))
    d.attrs["formula"] = "int"
    d = f.create_dataset("fixed_array_paged", data=ival((32, 128), np.uint8), chunks=(1, 2))
    d.attrs["formula"] = "int"
    d = f.create_dataset("fixed_array_gzip", data=fval((9, 50, 21)), chunks=(4, 32, 8), compression="gzip", shuffle=True)
    d.attrs["formula"] = "float"
    # implicit index: early allocation, no filters, fixed max dims
    dcpl = h5py.h5p.create(h5py.h5p.DATASET_CREATE)
    dcpl.set_chunk((4, 8))
    dcpl.set_alloc_time(h5py.h5d.ALLOC_TIME_EARLY)
    sid = h5py.h5s.create_simple((10, 20))
    dsid = h5py.h5d.create(f.id, b"implicit_u16", h5py.h5t.NATIVE_UINT16, sid, dcpl=dcpl)
    d = h5py.Dataset(dsid)
    d[...] = ival((10, 20), np.uint16)
    d.attrs["formula"] = "int"
    # compact layout
    dcpl = h5py.h5p.create(h5py.h5p.DATASET_CREATE)
    dcpl.set_layout(h5py.h5d.COMPACT)
    sid = h5py.h5s.create_simple((4, 5))
    dsid = h5py.h5d.create(f.id, b"compact_i32", h5py.h5t.STD_I32LE, sid, dcpl=dcpl)
    d = h5py.Dataset(dsid)
    d[...] = ival((4, 5), np.int32)
    d.attrs["formula"] = "int"
    # extensible array index (unsupported, must throw cleanly)
    f.create_dataset("extensible", data=ival((10,), np.uint8), chunks=(4,), maxshape=(None,))

# 3. latest (HDF5 2.x): superblock v3, layout v4/v5 (single chunk, fixed array (paged), implicit), compact layout
with h5py.File(f"{out}/latest.h5", "w", libver="latest") as f:
    common_content(f, dense=True)
    layout_content(f)
with h5py.File(f"{out}/latest.h5", "r") as f:
    describe("latest.h5", f)

# 3b. v1.14 format: layout message v4 only
with h5py.File(f"{out}/v114.h5", "w", libver=("v114", "v114")) as f:
    layout_content(f)
with h5py.File(f"{out}/v114.h5", "r") as f:
    describe("v114.h5", f)

# 4. LZ4 (HDF5 LZ4 plugin framing, filter 32004)
try:
    import hdf5plugin
    with h5py.File(f"{out}/lz4.h5", "w", libver=("v108", "v108")) as f:
        d = f.create_dataset("lz4_u16", data=ival((8, 48, 48), np.uint16), chunks=(4, 32, 32), **hdf5plugin.LZ4(nbytes=4096))
        d.attrs["formula"] = "int"
        # incompressible-ish data so some blocks are stored raw
        i = np.arange(4 * 64 * 64, dtype=np.uint64)
        noise = (((i * np.uint64(2654435761)) % np.uint64(2**32)) >> np.uint64(13)) & np.uint64(255)
        d = f.create_dataset("lz4_random_u8", data=noise.astype(np.uint8).reshape(4, 64, 64), chunks=(2, 64, 64), **hdf5plugin.LZ4(nbytes=1000))
        d.attrs["formula"] = "hash"
        d = f.create_dataset("lz4_shuffle_f32", data=fval((8, 40, 40)), chunks=(4, 20, 40), shuffle=True, **hdf5plugin.LZ4())
        d.attrs["formula"] = "float"
    with h5py.File(f"{out}/lz4.h5", "r") as f:
        describe("lz4.h5", f)
        print("lz4 filters", f["lz4_u16"].id.get_create_plist().get_filter(0))
except ImportError as e:
    print("no hdf5plugin", e)

expected["attrs"] = {
    "/": {"IntScalar": -42, "U16Array": [1, 2, 65535], "F64Scalar": 3.25, "F32Array": [0.5, -1.5],
          "FixedStr": "hello", "Big64": str(2**60 + 3), "VlenStr": "variable length", "BigEndianI32": [7, -9]},
    "/DataSetInfo/Channel 0": {"Name": "hoechst", "Color": "0.000 0.165 1.000", "ColorRange": "519.369 4560.004", "Empty": ""},
}
with open(f"{out}/expected.json", "w") as fh:
    json.dump(expected, fh, indent=1)
for fn in sorted(os.listdir(out)):
    print(fn, os.path.getsize(f"{out}/{fn}"))
