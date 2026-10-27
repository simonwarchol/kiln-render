/**
 * Screen-Space Error (SSE) LOD selection — exercises the REAL StreamingManager
 * traversal, not a reimplemented formula. A stub camera (view/proj matrices) and
 * mocked resources are supplied as inputs; the class's own computeDesiredSet →
 * traverse → SSE + hysteresis logic decides which LODs land in the desired set.
 *
 * Covered:
 *  - getVoxelWorldSize scales 2^lod (real private method)
 *  - closer camera selects finer LODs; distant camera stays coarse (monotonic)
 *  - hysteresis band: a brick only splits when finer children are already resident
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mat4 } from "wgpu-matrix";
import { DatasetConfig } from "../src/core/config.js";
import type { VolumeMetadata } from "../src/data/data-provider.js";
import { StreamingManager } from "../src/streaming/streaming-manager.js";
import { mockProvider, mockResources } from "./helpers/streaming-mocks.js";

// 512³ volume, 4 LOD levels (brick grids 8 → 4 → 2 → 1).
function makeMetadata(): VolumeMetadata {
  return {
    name: "sse",
    dimensions: [512, 512, 512],
    brickSize: 64,
    physicalBrickSize: 66,
    maxLod: 3,
    bitDepth: 8,
    numChannels: 1,
    levels: [
      {
        lod: 0,
        dimensions: [512, 512, 512],
        brickGrid: [8, 8, 8],
        brickCount: 512,
      },
      {
        lod: 1,
        dimensions: [256, 256, 256],
        brickGrid: [4, 4, 4],
        brickCount: 64,
      },
      {
        lod: 2,
        dimensions: [128, 128, 128],
        brickGrid: [2, 2, 2],
        brickCount: 8,
      },
      { lod: 3, dimensions: [64, 64, 64], brickGrid: [1, 1, 1], brickCount: 1 },
    ],
  };
}

const makeProvider = () => mockProvider(makeMetadata());
const makeResources = () => mockResources(1);

// Camera test double: supplies exactly the matrices/position computeDesiredSet
// reads. Not the logic under test — just an input fixture.
function stubCamera(pos: [number, number, number]) {
  const view = mat4.lookAt(pos, [0, 0, 0], [0, 1, 0]);
  return {
    position: new Float32Array(pos),
    getViewMatrix: () => view,
    getProjectionMatrix: (aspect: number) =>
      mat4.perspective(Math.PI / 4, aspect, 0.01, 100),
  };
}

const canvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;

// Construct an SM, wait for the constructor's base-LOD load, then wipe the
// residual base-load state so each SSE scenario starts from a clean slate.
async function freshSM(): Promise<StreamingManager> {
  const sm = new StreamingManager(
    makeResources() as never,
    makeProvider(),
    makeMetadata(),
    new DatasetConfig([512, 512, 512], [1, 1, 1]) as never,
    vi.fn(),
  );
  await vi.waitFor(() => {
    expect(sm.baseLodLoaded).toBe(true);
  });
  const priv = sm as unknown as {
    loadedBricks: Map<string, unknown>;
    emptyBricks: Set<string>;
    pinnedBricks: Set<string>;
  };
  priv.loadedBricks.clear();
  priv.emptyBricks.clear();
  priv.pinnedBricks.clear();
  return sm;
}

// LODs present in the real desired set after a forceUpdate.
/** LODs of the desired set, without the temporary coarse fallbacks. */
function desiredLods(sm: StreamingManager): number[] {
  const { desiredKeys, coarseFallbackKeys } = sm as unknown as {
    desiredKeys: Set<string>;
    coarseFallbackKeys: Set<string>;
  };
  return [...desiredKeys]
    .filter((k) => !coarseFallbackKeys.has(k))
    .map((k) => Number(/^lod(\d+):/.exec(k)![1]));
}

/** Mark every LOD-2 child of the LOD-3 root resident. */
function loadAllRootChildren(sm: StreamingManager): void {
  const loaded = (sm as unknown as { loadedBricks: Map<string, unknown> })
    .loadedBricks;
  for (let z = 0; z < 2; z++)
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++)
        loaded.set(`lod2:${z}/${y}/${x}`, {
          slot: { x, y, z },
          slotIndex: z * 4 + y * 2 + x,
        });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SSE — voxel world size", () => {
  it("doubles per LOD level (real getVoxelWorldSize)", async () => {
    const sm = await freshSM();
    const g = (lod: number) =>
      (
        sm as unknown as { getVoxelWorldSize(l: number): number }
      ).getVoxelWorldSize(lod);
    expect(g(1) / g(0)).toBeCloseTo(2);
    expect(g(2) / g(1)).toBeCloseTo(2);
    expect(g(3) / g(0)).toBeCloseTo(8); // 2^3
  });
});

describe("SSE — LOD selection vs. camera distance", () => {
  async function minLodAt(dist: number): Promise<number> {
    const sm = await freshSM();
    sm.forceUpdate(stubCamera([0, 0, dist]), canvas);
    return Math.min(...desiredLods(sm));
  }

  it("keeps the coarsest LOD when the camera is far away", async () => {
    expect(await minLodAt(8)).toBe(3); // maxLod — nothing splits
  });

  it("selects finer LODs as the camera moves closer", async () => {
    expect(await minLodAt(0.6)).toBeLessThan(3);
  });

  it("is monotonic: nearer never selects a coarser floor than farther", async () => {
    const near = await minLodAt(0.6);
    const mid = await minLodAt(2);
    const far = await minLodAt(8);
    expect(near).toBeLessThanOrEqual(mid);
    expect(mid).toBeLessThanOrEqual(far);
  });
});

describe("finest stream LOD", () => {
  it("reports the finest desired LOD after a forceUpdate", async () => {
    const sm = await freshSM();
    sm.forcedLod = 1;
    sm.forceUpdate(stubCamera([0, 0, 0.6]), canvas);
    expect(sm.getFinestStreamLod()).toBe(1);
  });
});

describe("idle recompute gating", () => {
  it("skips the desired-set walk while the view is settled", async () => {
    const sm = await freshSM();
    const camera = {
      ...stubCamera([0, 0, 8]),
      version: 1,
      isInteracting: () => false,
    };
    const priv = sm as unknown as {
      desiredKeys: Set<string>;
      loadedBricks: Map<string, unknown>;
      computeDesiredSet(): void;
    };
    // Make everything desired resident, so the recompute leaves nothing to load.
    sm.forceUpdate(camera as never, canvas);
    for (const key of priv.desiredKeys)
      priv.loadedBricks.set(key, { slotIndex: 0, lod: 3 });
    sm.forceUpdate(camera as never, canvas);
    expect(sm.isLoading).toBe(false);

    const walk = vi.spyOn(priv, "computeDesiredSet");
    for (let i = 0; i < 30; i++) sm.update(camera as never, canvas);
    expect(walk).not.toHaveBeenCalled();

    // A clip change (shared by reference with the renderer) is noticed
    sm.clipBox = { min: [0, 0, 0], max: [0.5, 1, 1] };
    for (let i = 0; i < 30; i++) sm.update(camera as never, canvas);
    expect(walk).toHaveBeenCalled();

    // ...and so is a camera change
    walk.mockClear();
    camera.version++;
    for (let i = 0; i < 30; i++) sm.update(camera as never, canvas);
    expect(walk).toHaveBeenCalled();
  });
});

describe("coarse-to-fine fallbacks", () => {
  type Priv = {
    coarseFallbackKeys: Set<string>;
    loadQueue: Array<{ key: string; lod: number }>;
    loadedBricks: Map<string, unknown>;
  };

  it("loads the ancestor two levels up first while fine bricks are missing", async () => {
    const sm = await freshSM();
    sm.forcedLod = 0;
    sm.forceUpdate(stubCamera([0, 0, 8]), canvas);
    const priv = sm as unknown as Priv;
    expect(priv.coarseFallbackKeys.size).toBeGreaterThan(0);
    expect(
      [...priv.coarseFallbackKeys].every((k) => k.startsWith("lod2:")),
    ).toBe(true);
    // Fallbacks sort ahead of the leaves they stand in for.
    const firstLeaf = priv.loadQueue.findIndex((r) => r.lod === 0);
    const lastFallback = priv.loadQueue.findLastIndex((r) => r.lod === 2);
    expect(lastFallback).toBeLessThan(firstLeaf);
  });

  it("keeps a loaded fallback desired until its descendants arrive", async () => {
    const sm = await freshSM();
    sm.forcedLod = 0;
    const priv = sm as unknown as Priv & { desiredKeys: Set<string> };
    priv.loadedBricks.set("lod2:0/0/0", {
      slot: { x: 0, y: 0, z: 0 },
      slotIndex: 0,
    });
    sm.forceUpdate(stubCamera([0, 0, 8]), canvas);
    expect(priv.desiredKeys.has("lod2:0/0/0")).toBe(true);
    expect(priv.loadQueue.some((r) => r.key === "lod2:0/0/0")).toBe(false);
  });
});

describe("detail in CSS pixels", () => {
  it("a device pixel ratio of 2 doesn't request finer bricks", async () => {
    const at = async (pixelRatio: number, height: number) => {
      const sm = await freshSM();
      sm.pixelRatio = pixelRatio;
      sm.forceUpdate(stubCamera([0, 0, 1.2]), {
        width: height,
        height,
      } as HTMLCanvasElement);
      return desiredLods(sm).sort().join(",");
    };
    // The same CSS size at DPR 2 (twice the device pixels) selects the same set.
    expect(await at(2, 2 * canvas.height)).toBe(await at(1, canvas.height));
  });
});

describe("accumulation resets while streaming", () => {
  it("coalesces bursts of commits into one reset per window", async () => {
    const sm = await freshSM();
    const onReset = vi.fn();
    const priv = sm as unknown as {
      onResetAccumulation: () => void;
      scheduleAccumulationReset(): void;
      resetAccumulationTimer: ReturnType<typeof setTimeout> | null;
    };
    // The base-level load leaves a reset pending.
    if (priv.resetAccumulationTimer !== null)
      clearTimeout(priv.resetAccumulationTimer);
    priv.resetAccumulationTimer = null;
    priv.onResetAccumulation = onReset;
    const schedule = priv.scheduleAccumulationReset.bind(sm);
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 20; i++) {
        schedule();
        vi.advanceTimersByTime(20); // a commit every 20 ms
      }
      vi.advanceTimersByTime(300);
      // 400 ms of commits + the tail: two windows, never 0 and never 20.
      expect(onReset.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(onReset.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("forced LOD override", () => {
  it("forces the finest level when forcedLod = 0", async () => {
    const sm = await freshSM();
    sm.forcedLod = 0;
    // Far camera would normally stay at maxLod under SSE
    sm.forceUpdate(stubCamera([0, 0, 8]), canvas);
    const lods = desiredLods(sm);
    expect(Math.min(...lods)).toBe(0);
    expect(lods.every((l) => l === 0)).toBe(true);
  });

  it("forces the coarsest level when forcedLod = maxLod", async () => {
    const sm = await freshSM();
    sm.forcedLod = 3;
    // Near camera would normally refine under SSE
    sm.forceUpdate(stubCamera([0, 0, 0.6]), canvas);
    const lods = desiredLods(sm);
    expect(Math.max(...lods)).toBe(3);
    expect(lods.every((l) => l === 3)).toBe(true);
  });

  it("restores SSE selection when forcedLod is cleared", async () => {
    const sm = await freshSM();
    sm.forcedLod = 0;
    sm.forceUpdate(stubCamera([0, 0, 8]), canvas);
    expect(Math.min(...desiredLods(sm))).toBe(0);

    sm.forcedLod = null;
    sm.forceUpdate(stubCamera([0, 0, 8]), canvas);
    expect(Math.min(...desiredLods(sm))).toBe(3);
  });
});

describe("SSE — hysteresis band", () => {
  it("detects resident children (real hasResidentChildren)", async () => {
    const sm = await freshSM();
    const priv = sm as unknown as {
      hasResidentChildren(
        bx: number,
        by: number,
        bz: number,
        lod: number,
      ): boolean;
      loadedBricks: Map<string, unknown>;
    };
    expect(priv.hasResidentChildren(0, 0, 0, 3)).toBe(false);
    // One resident child is not enough: its 7 siblings would stay requested.
    priv.loadedBricks.set("lod2:0/0/0", {
      slot: { x: 0, y: 0, z: 0 },
      slotIndex: 0,
    });
    expect(priv.hasResidentChildren(0, 0, 0, 3)).toBe(false);
    loadAllRootChildren(sm);
    expect(priv.hasResidentChildren(0, 0, 0, 3)).toBe(true);
  });

  it("within the band, only splits when the finer children are resident", async () => {
    // dist ≈ 1.7 puts the LOD-3 root's projected error inside the hysteresis
    // band (0.7·maxPixelError, maxPixelError].
    const DIST = 1.7;

    // DIST was chosen for an 8 px threshold; pin it so the default can change.
    const without = await freshSM();
    without.maxPixelError = 8;
    without.forceUpdate(stubCamera([0, 0, DIST]), canvas);
    expect(Math.min(...desiredLods(without))).toBe(3); // no resident child → stays coarse

    const withChild = await freshSM();
    withChild.maxPixelError = 8;
    loadAllRootChildren(withChild);
    withChild.forceUpdate(stubCamera([0, 0, DIST]), canvas);
    expect(Math.min(...desiredLods(withChild))).toBeLessThan(3); // resident children → splits
  });
});
