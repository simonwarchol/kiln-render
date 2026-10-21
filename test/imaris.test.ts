import { describe, expect, it } from "vitest";
import {
  axisSampling,
  coalesceRanges,
  overlappingChunks,
  planVirtualPyramid,
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

  it("lists overlapping chunks and coalesces nearby byte ranges", () => {
    expect(
      overlappingChunks([63, 0, 0], [129, 66, 17], [128, 128, 16]),
    ).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [0, 0, 1],
      [1, 0, 1],
    ]);
    const groups = coalesceRanges(
      [
        { address: 1000, size: 100 },
        { address: 0, size: 500 },
        { address: 10_000_000, size: 10 },
      ],
      1024,
    );
    expect(groups).toEqual([
      { start: 0, end: 1100, members: [1, 0] },
      { start: 10_000_000, end: 10_000_010, members: [2] },
    ]);
  });
});
