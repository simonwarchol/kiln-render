import { describe, expect, it } from "vitest";
import {
  type BrickRequest,
  selectResidentSet,
} from "../src/streaming/streaming-manager.js";

function brick(key: string, distance: number): BrickRequest {
  return { lod: 0, bx: 0, by: 0, bz: 0, distance, key };
}

describe("selectResidentSet", () => {
  it("keeps every candidate when they fit in the atlas", () => {
    const candidates = [brick("a", 3), brick("b", 1), brick("c", 2)];
    expect(selectResidentSet(candidates, new Set(), 8)).toEqual([
      brick("b", 1),
      brick("c", 2),
      brick("a", 3),
    ]);
  });

  it("keeps pinned bricks and the closest unpinned remainder", () => {
    const candidates = [
      brick("far", 9),
      brick("pin", 8),
      brick("near", 1),
      brick("mid", 2),
    ];
    const selected = selectResidentSet(candidates, new Set(["pin"]), 3);
    expect(selected.map((b) => b.key)).toEqual(["pin", "near", "mid"]);
  });

  it("does not queue more unpinned bricks than free atlas slots", () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      brick(`b${i}`, i + 1),
    );
    const pinned = new Set(["b19"]);
    const selected = selectResidentSet(candidates, pinned, 4);
    expect(selected).toHaveLength(4);
    expect(selected[0]!.key).toBe("b19");
    expect(selected.slice(1).map((b) => b.key)).toEqual(["b0", "b1", "b2"]);
  });
});
