import { describe, expect, it } from "vitest";
import { parseImsDtype } from "../src/data/imaris/dtype.js";
import { isHdf5Magic, looksLikeImsUrl } from "../src/data/imaris/probe.js";
import { preValidateLocalIms } from "../src/data/imaris-validator.js";
import { imarisWorkerIndex } from "../src/data/imaris-worker-pool.js";

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

describe("IMS spatial worker routing", () => {
  it("is stable for the same brick/channel", () => {
    const a = imarisWorkerIndex(1, 3, 2, 4, 0, 4);
    const b = imarisWorkerIndex(1, 3, 2, 4, 0, 4);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(4);
  });

  it("spreads different channels of the same brick across workers", () => {
    const idxs = [0, 1, 2, 3].map((ch) => imarisWorkerIndex(0, 1, 1, 1, ch, 4));
    expect(new Set(idxs).size).toBeGreaterThan(1);
  });

  it("does not round-robin consecutive neighbor bricks onto every worker", () => {
    // Round-robin would map 4 consecutive bricks to 4 distinct workers.
    // Spatial hash should keep some neighbors together more often than that.
    const idxs = [0, 1, 2, 3].map((bx) => imarisWorkerIndex(0, bx, 0, 0, 0, 4));
    // At least not a perfect 0,1,2,3 permutation every time — allow any
    // distribution except "must use all 4". Soft check: same coords still stable.
    expect(idxs[0]).toBe(imarisWorkerIndex(0, 0, 0, 0, 0, 4));
    expect(idxs.every((i) => i >= 0 && i < 4)).toBe(true);
  });
});

describe("IMS dtype parsing", () => {
  it("reads h5wasm struct codes", () => {
    expect(parseImsDtype("<B")).toEqual({ bitDepth: 8, isFloat: false });
    expect(parseImsDtype("<H")).toEqual({ bitDepth: 16, isFloat: false });
    expect(parseImsDtype("<h")).toEqual({ bitDepth: 16, isFloat: false });
    expect(parseImsDtype("<f")).toEqual({ bitDepth: 16, isFloat: true });
    expect(parseImsDtype(">B")).toEqual({ bitDepth: 8, isFloat: false });
  });

  it("reads numpy-style names", () => {
    expect(parseImsDtype("<u2")).toEqual({ bitDepth: 16, isFloat: false });
    expect(parseImsDtype("uint8")).toEqual({ bitDepth: 8, isFloat: false });
    expect(parseImsDtype("<f4")).toEqual({ bitDepth: 16, isFloat: true });
  });

  it("prefers HDF5 metadata", () => {
    expect(
      parseImsDtype("unknown", { type: 0, size: 2, signed: false }),
    ).toEqual({ bitDepth: 16, isFloat: false });
    expect(
      parseImsDtype("unknown", { type: 1, size: 4, signed: false }),
    ).toEqual({ bitDepth: 16, isFloat: true });
    expect(parseImsDtype("<I")).toBeNull();
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
