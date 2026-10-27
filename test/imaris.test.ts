import { describe, expect, it } from "vitest";
import {
  type AxisSampling,
  axisSampling,
  clampGhost,
  faceBit,
  overlappingChunks,
  planBorders,
  planVirtualPyramid,
  type Vec3,
} from "../src/data/imaris/ims-layout.js";
import { isHdf5Magic, looksLikeImsUrl } from "../src/data/imaris/probe.js";
import { preValidateLocalIms } from "../src/data/imaris-validator.js";

describe("IMS URL / magic helpers", () => {
  it("detects .ims paths", () => {
    expect(looksLikeImsUrl("https://x.com/a.ims")).toBe(true);
    expect(looksLikeImsUrl("https://x.com/a.ims?foo=1")).toBe(true);
    expect(looksLikeImsUrl("https://x.com/a.ome.zarr")).toBe(false);
    expect(looksLikeImsUrl("https://x.com/a.ome.tif")).toBe(false);
  });

  it("recognises the HDF5 signature", () => {
    expect(
      isHdf5Magic(
        new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe(true);
    expect(isHdf5Magic(new Uint8Array([0x49, 0x49, 0x2a, 0x00]))).toBe(false);
  });
});

describe("local IMS pre-validation", () => {
  it("accepts an .ims file with HDF5 magic", async () => {
    const bytes = new Uint8Array([
      0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    const file = new File([bytes], "scan.ims");
    await expect(preValidateLocalIms(file)).resolves.toEqual([]);
  });

  it("rejects a non-HDF5 .ims name", async () => {
    const file = new File(
      [new Uint8Array([0x49, 0x49, 0x2a, 0x00])],
      "scan.ims",
    );
    await expect(preValidateLocalIms(file)).resolves.toEqual([
      "Not an Imaris HDF5 file (missing HDF5 magic)",
    ]);
  });

  it("rejects a non-.ims name", async () => {
    const file = new File([new Uint8Array(8)], "scan.zarr");
    await expect(preValidateLocalIms(file)).resolves.toEqual([
      "Expected an Imaris .ims file",
    ]);
  });
});

describe("IMS virtual pyramid", () => {
  // LSP22408.ims: Z is not halved at level 1
  const sources = [
    { index: 0, dims: [1024, 1024, 100] as [number, number, number] },
    { index: 1, dims: [512, 512, 100] as [number, number, number] },
    { index: 2, dims: [256, 256, 50] as [number, number, number] },
    { index: 3, dims: [128, 128, 25] as [number, number, number] },
    { index: 4, dims: [64, 64, 12] as [number, number, number] },
  ];

  it("halves every axis per LOD and picks the coarsest adequate source", () => {
    const p = planVirtualPyramid(sources);
    expect(p.map((l) => l.dims)).toEqual([
      [1024, 1024, 100],
      [512, 512, 50],
      [256, 256, 25],
      [128, 128, 13],
      [64, 64, 7],
    ]);
    expect(p.map((l) => l.source)).toEqual([0, 1, 2, 3, 4]);
    expect(p[1]!.ratio).toEqual([1, 1, 2]);
    expect(p[4]!.brickGrid).toEqual([1, 1, 1]);
  });

  it("never upsamples from a coarser source", () => {
    const p = planVirtualPyramid([sources[0]!, sources[2]!]);
    expect(p[1]!.source).toBe(0);
    expect(p[2]!.source).toBe(2);
  });

  it("maps brick samples (with ghost border) to source ranges", () => {
    const s = axisSampling(0, 50, 100, 2);
    // first sample is the clamped ghost voxel → virtual 0 → source [0, 2)
    expect([s.ranges[0], s.ranges[1]]).toEqual([0, 2]);
    expect([s.ranges[2], s.ranges[3]]).toEqual([0, 2]);
    expect([s.ranges[4], s.ranges[5]]).toEqual([2, 4]);
    expect(s.lo).toBe(0);
    expect(s.hi).toBe(100);
    const t = axisSampling(1, 1024, 1024, 1);
    expect(t.lo).toBe(63);
    expect(t.hi).toBe(129);
  });

  it("lists overlapping chunks", () => {
    expect(
      overlappingChunks([63, 0, 0], [129, 66, 17], [128, 128, 16]),
    ).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [0, 0, 1],
      [1, 0, 1],
    ]);
  });
});

describe("IMS ghost borders", () => {
  const chunk: Vec3 = [128, 128, 16];
  // LSP22408 level 0 brick (2, 1, 0): x interior [128, 192) + ghost 127 and
  // 192, y [64, 128) + 63 and 128, z [0, 64) + 64.
  const axes = (): [AxisSampling, AxisSampling, AxisSampling] => [
    axisSampling(2, 1024, 1024, 1),
    axisSampling(1, 1024, 1024, 1),
    axisSampling(0, 100, 100, 1),
  ];
  const chunksOf = (a: [AxisSampling, AxisSampling, AxisSampling]) =>
    overlappingChunks(
      [a[0].lo, a[1].lo, a[2].lo],
      [a[0].hi, a[1].hi, a[2].hi],
      chunk,
    );

  it("keeps every face whose border chunks are cached", () => {
    const plan = planBorders(axes(), chunk, () => true);
    expect(plan).toEqual({ clamped: 0, filled: [], waiting: [] });
    expect(chunksOf(axes())).toHaveLength(2 * 2 * 5);
  });

  it("clamps faces whose border-only chunks are missing", () => {
    const interior = (cx: number, cy: number, cz: number) =>
      cx === 1 && cy === 0 && cz <= 3;
    const plan = planBorders(axes(), chunk, interior);
    // x low (chunk 0), y high (chunk 1), z high (chunk 4); x high and y low
    // ghosts lie in interior chunks.
    expect(plan.clamped).toBe(faceBit(0, 0) | faceBit(1, 1) | faceBit(2, 1));
    // Edges between clamped faces aren't read at all.
    expect(plan.filled).toEqual([]);
    expect(plan.waiting).toEqual([
      [0, 1, 2, 3].map((z) => [0, 0, z]),
      [0, 1, 2, 3].map((z) => [1, 1, z]),
      [[1, 0, 4]],
    ]);

    const [sx, sy, sz] = axes();
    const clamped: [AxisSampling, AxisSampling, AxisSampling] = [
      clampGhost(sx, 0),
      clampGhost(sy, 1),
      clampGhost(sz, 1),
    ];
    expect(chunksOf(clamped)).toEqual([0, 1, 2, 3].map((z) => [1, 0, z]));
    // ghost samples repeat their interior neighbours
    expect([clamped[0].ranges[0], clamped[0].ranges[1]]).toEqual([128, 129]);
    expect([clamped[1].ranges[130], clamped[1].ranges[131]]).toEqual([
      127, 128,
    ]);
    expect(clamped[2].hi).toBe(64);
  });

  it("keeps faces when only an edge chunk between them is missing", () => {
    // Everything cached except the x-low / z-high edge chunk, which often
    // belongs to a diagonal neighbour that is never loaded.
    const plan = planBorders(
      axes(),
      chunk,
      (cx, cy, cz) => !(cx === 0 && cy === 0 && cz === 4),
    );
    expect(plan).toEqual({
      clamped: 0,
      filled: [[0, 0, 4]],
      waiting: [[[0, 0, 4]]],
    });
  });
});
