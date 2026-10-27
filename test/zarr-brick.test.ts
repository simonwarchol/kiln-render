import { describe, expect, it } from "vitest";
import {
  assembleBrick,
  chunkCoords,
  firstChunk,
  type LodParams,
  planBrick,
} from "../src/data/zarr-brick.js";
import { float32ToFloat16Bits } from "../src/utils/float16.js";

// 100³ array at full resolution in 64³ chunks, channel axis first ([c, z, y, x]).
const params: LodParams = {
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
  actualDimX: 100,
  actualDimY: 100,
  actualDimZ: 100,
  csx: 64,
  csy: 64,
  csz: 64,
  shapePrefixLength: 1,
  channelAxisIdx: 0,
};

/** Chunk (cz, cy, cx) of 64³ where each voxel holds its global x + 1000·cz. */
function chunk(cz: number, _cy: number, cx: number) {
  const data = new Uint16Array(64 ** 3);
  for (let i = 0; i < data.length; i++)
    data[i] = cx * 64 + (i % 64) + 1000 * cz;
  return { data, shape: [1, 64, 64, 64] };
}

describe("zarr bricks", () => {
  it("plans the chunks and ghost-bordered samples of a brick", () => {
    const plan = planBrick(params, 1, 0, 0, 64, 66);
    // x samples 63..128 clamp to 63..99 → chunks 0..1
    expect([plan.minCx, plan.maxCx, plan.minCy, plan.maxCy]).toEqual([
      0, 1, 0, 1,
    ]);
    expect(plan.count).toBe(2 * 2 * 2);
    expect([
      plan.chunkX[0],
      plan.offX[0],
      plan.chunkX[1],
      plan.offX[1],
    ]).toEqual([0, 63, 1, 0]);
    expect(plan.offX[65]).toBe(35); // clamped to the last voxel (99)
    expect(firstChunk(1, 1, 64, 64)).toBe(plan.minCx);
    expect(chunkCoords(params, 2, 1, 0, 1)).toEqual([2, 1, 0, 1]);
  });

  it("encodes integer bricks as stored, as float16 or as high bytes", () => {
    const plan = planBrick(params, 1, 0, 0, 64, 66);
    const chunks = [
      chunk(0, 0, 0),
      chunk(0, 0, 1),
      null,
      null,
      null,
      null,
      null,
      null,
    ];
    const base = { isFloat: false, floatMin: 0, floatMax: 1 };
    const raw = assembleBrick(plan, chunks, {
      ...base,
      out: "u16",
      encode: "raw",
    });
    expect(raw.data[1]).toBe(64); // x = 64 at z = y = 0
    // z ≥ 64 lies in the missing chunks: zeros, left out of the stats
    expect(raw.data[65 * 66 * 66]).toBe(0);
    expect([raw.min, raw.max]).toEqual([63, 99]);
    const f16 = assembleBrick(plan, chunks, {
      ...base,
      out: "u16",
      encode: "f16",
    });
    expect(f16.data[1]).toBe(float32ToFloat16Bits(64 / 65535));
    const hi = assembleBrick(plan, chunks, {
      ...base,
      out: "u8",
      encode: "high-byte",
    });
    expect(hi.data).toBeInstanceOf(Uint8Array);
    expect([hi.min, hi.max]).toEqual([63, 99]); // stats stay in source units
  });

  it("stores float voxels as float16 and normalises their stats", () => {
    const plan = planBrick(params, 0, 0, 0, 64, 66);
    const data = new Float32Array(64 ** 3).fill(2.5);
    const chunks = [{ data, shape: [1, 64, 64, 64] }];
    const b = assembleBrick(
      plan,
      [...chunks, null, null, null, null, null, null, null],
      {
        isFloat: true,
        floatMin: 0,
        floatMax: 10,
        out: "u16",
        encode: "raw",
      },
    );
    expect(b.data[0]).toBe(float32ToFloat16Bits(2.5));
    expect([b.max, b.rawMin, b.rawMax]).toEqual([
      Math.round(0.25 * 65535),
      2.5,
      2.5,
    ]);
  });
});
