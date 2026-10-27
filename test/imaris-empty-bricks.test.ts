import { describe, expect, it } from "vitest";
import { imsBrickIsEmpty } from "../src/data/imaris/empty-bricks.js";

describe("IMS empty-brick skip", () => {
  it("uses cached stats at the requested brick", () => {
    expect(
      imsBrickIsEmpty({
        lod: 0,
        bx: 1,
        by: 0,
        bz: 0,
        maxLod: 2,
        threshold: 100,
        getStats: (lod, bx) =>
          lod === 0 && bx === 1 ? { max: 4 } : { max: 500 },
      }),
    ).toBe(true);
  });

  it("inherits emptiness only from a truly zero ancestor", () => {
    expect(
      imsBrickIsEmpty({
        lod: 0,
        bx: 4,
        by: 4,
        bz: 4,
        maxLod: 2,
        threshold: 100,
        getStats: (lod) => (lod === 1 ? { max: 0 } : null),
      }),
    ).toBe(true);
    expect(
      imsBrickIsEmpty({
        lod: 0,
        bx: 4,
        by: 4,
        bz: 4,
        maxLod: 2,
        threshold: 100,
        getStats: (lod) => (lod === 1 ? { max: 40 } : null),
      }),
    ).toBe(false);
  });
});
