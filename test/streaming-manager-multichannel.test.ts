/**
 * Multi-channel loading behaviour in StreamingManager
 *
 * These tests verify that for a dataset with N channels:
 *  - dataProvider.loadBrick is called once per channel per brick (channelIndex 0…N-1)
 *  - writeToCanvas is called once per channel, writing to the correct atlas canvas
 *  - Empty bricks short-circuit before any channel data is fetched
 *
 * WebGPU is avoided by mocking writeToCanvas and supplying lightweight stand-ins
 * for Renderer and GPUDevice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mat4 } from "wgpu-matrix";
import type {
  DataProvider,
  NetworkStats,
  VolumeMetadata,
} from "../src/data/data-provider.js";
import { StreamingManager } from "../src/streaming/streaming-manager.js";

// ---------------------------------------------------------------------------
// Mock writeToCanvas — the only WebGPU-touching function called during base
// LOD loading.  Everything else operates on plain JS objects.
// ---------------------------------------------------------------------------

vi.mock("../src/core/volume.js", () => ({
  writeToCanvas: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetadata(numChannels: number): VolumeMetadata {
  return {
    name: "test",
    dimensions: [64, 64, 64],
    brickSize: 64,
    physicalBrickSize: 66,
    maxLod: 0,
    bitDepth: 8,
    numChannels,
    levels: [
      {
        lod: 0,
        dimensions: [64, 64, 64],
        brickGrid: [1, 1, 1],
        brickCount: 1,
      },
    ],
  };
}

function makeProvider(numChannels: number, isEmpty = false): DataProvider {
  const brickData = new Uint8Array(66 * 66 * 66);
  return {
    initialize: vi.fn().mockResolvedValue(makeMetadata(numChannels)),
    getMetadata: vi.fn().mockReturnValue(makeMetadata(numChannels)),
    getBrickGrid: vi
      .fn()
      .mockReturnValue([1, 1, 1] as [number, number, number]),
    loadBrick: vi
      .fn()
      .mockResolvedValue({ data: brickData, min: 0, max: 128, avg: 64 }),
    isBrickEmpty: vi.fn().mockResolvedValue(isEmpty),
    getBrickStats: vi.fn().mockResolvedValue(null),
    getNetworkStats: vi.fn().mockReturnValue({
      totalBytesDownloaded: 0,
      recentBytesPerSecond: 0,
      requestCount: 0,
    } as NetworkStats),
    dispose: vi.fn(),
  };
}

/**
 * Minimal VolumeResources stand-in.  Only the properties accessed during
 * loadBaseLod and the streaming loadBrick path are populated.
 * `canvases` is an array of plain objects — the real type is irrelevant
 * because writeToCanvas is mocked.
 */
function makeResources(numChannels: number) {
  return {
    numChannels,
    allocator: {
      allocate: vi.fn().mockReturnValue({
        slot: { x: 0, y: 0, z: 0 },
        slotIndex: 0,
        evicted: null,
      }),
      hasEvictableSlot: vi.fn().mockReturnValue(true),
      setMetadata: vi.fn(),
      pin: vi.fn(),
      touch: vi.fn(),
      free: vi.fn(),
      usedCount: 0,
      totalSlots: 512,
    },
    indirection: {
      setBrick: vi.fn(),
      setEmpty: vi.fn(),
      clearBrick: vi.fn(),
      clearAll: vi.fn(),
    },
    // One canvas per channel — indexed in loadBrick as resources.canvases[ch]
    canvases: Array.from({ length: Math.max(numChannels, 1) }, (_, i) => ({
      _ch: i,
    })),
  };
}

/** Minimal DatasetConfig stand-in. */
function makeConfig() {
  return {
    normalizedSize: [1, 1, 1] as [number, number, number],
    emptyBrickThreshold: 1,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StreamingManager — multi-channel base LOD loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls loadBrick once for a 1-channel dataset (channelIndex 0)", async () => {
    const provider = makeProvider(1);
    const resources = makeResources(1);

    const sm = new StreamingManager(
      resources as any,
      provider,
      makeMetadata(1),
      {} as GPUDevice,
      makeConfig() as any,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });

    expect(provider.loadBrick).toHaveBeenCalledTimes(1);
    expect(provider.loadBrick).toHaveBeenCalledWith(0, 0, 0, 0, 0);
  });

  it("calls loadBrick twice for a 2-channel dataset, once per channel", async () => {
    const provider = makeProvider(2);
    const resources = makeResources(2);

    const sm = new StreamingManager(
      resources as any,
      provider,
      makeMetadata(2),
      {} as GPUDevice,
      makeConfig() as any,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });

    expect(provider.loadBrick).toHaveBeenCalledTimes(2);
    expect(provider.loadBrick).toHaveBeenCalledWith(0, 0, 0, 0, 0); // ch 0
    expect(provider.loadBrick).toHaveBeenCalledWith(0, 0, 0, 0, 1); // ch 1
  });

  it("calls loadBrick for all 4 channels of a 4-channel dataset", async () => {
    const provider = makeProvider(4);
    const resources = makeResources(4);

    const sm = new StreamingManager(
      resources as any,
      provider,
      makeMetadata(4),
      {} as GPUDevice,
      makeConfig() as any,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });

    expect(provider.loadBrick).toHaveBeenCalledTimes(4);
    for (let ch = 0; ch < 4; ch++) {
      expect(provider.loadBrick).toHaveBeenCalledWith(0, 0, 0, 0, ch);
    }
  });

  it("writes each channel to the corresponding atlas canvas", async () => {
    const { writeToCanvas } = await import("../src/core/volume.js");

    const provider = makeProvider(2);
    const resources = makeResources(2);

    const sm = new StreamingManager(
      resources as any,
      provider,
      makeMetadata(2),
      {} as GPUDevice,
      makeConfig() as any,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });

    // writeToCanvas must have been called twice — once per channel
    expect(vi.mocked(writeToCanvas)).toHaveBeenCalledTimes(2);

    // Channel 0 → canvases[0], channel 1 → canvases[1]
    expect(vi.mocked(writeToCanvas)).toHaveBeenCalledWith(
      expect.anything(), // device (mocked)
      resources.canvases[0], // atlas for channel 0
      expect.any(Uint8Array),
      expect.anything(),
      expect.anything(),
    );
    expect(vi.mocked(writeToCanvas)).toHaveBeenCalledWith(
      expect.anything(),
      resources.canvases[1], // atlas for channel 1
      expect.any(Uint8Array),
      expect.anything(),
      expect.anything(),
    );
  });

  it("allocates exactly one atlas slot shared across all channels", async () => {
    const provider = makeProvider(3);
    const resources = makeResources(3);

    const sm = new StreamingManager(
      resources as any,
      provider,
      makeMetadata(3),
      {} as GPUDevice,
      makeConfig() as any,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });

    // 3 channels loaded, but only 1 slot allocated (channels share the atlas slot)
    expect(resources.allocator.allocate).toHaveBeenCalledTimes(1);
  });

  it("does not call loadBrick for an empty brick", async () => {
    const provider = makeProvider(2, /* isEmpty */ true);
    const resources = makeResources(2);

    const sm = new StreamingManager(
      resources as any,
      provider,
      makeMetadata(2),
      {} as GPUDevice,
      makeConfig() as any,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });

    expect(provider.loadBrick).not.toHaveBeenCalled();
  });

  it("marks empty bricks in the indirection table without loading data", async () => {
    const provider = makeProvider(2, /* isEmpty */ true);
    const resources = makeResources(2);

    const sm = new StreamingManager(
      resources as any,
      provider,
      makeMetadata(2),
      {} as GPUDevice,
      makeConfig() as any,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });

    expect(resources.indirection.setEmpty).toHaveBeenCalledWith(0, 0, 0, 0);
    expect(resources.allocator.allocate).not.toHaveBeenCalled();
  });
});

describe("StreamingManager — skip hidden channels on LOD change", () => {
  function makePyramidMetadata(numChannels: number): VolumeMetadata {
    return {
      name: "test",
      dimensions: [128, 128, 128],
      brickSize: 64,
      physicalBrickSize: 66,
      maxLod: 1,
      bitDepth: 8,
      numChannels,
      levels: [
        {
          lod: 0,
          dimensions: [128, 128, 128],
          brickGrid: [2, 2, 2],
          brickCount: 8,
        },
        {
          lod: 1,
          dimensions: [64, 64, 64],
          brickGrid: [1, 1, 1],
          brickCount: 1,
        },
      ],
    };
  }

  function makePyramidProvider(numChannels: number): DataProvider {
    const brickData = new Uint8Array(66 * 66 * 66);
    const meta = makePyramidMetadata(numChannels);
    return {
      initialize: vi.fn().mockResolvedValue(meta),
      getMetadata: vi.fn().mockReturnValue(meta),
      getBrickGrid: vi
        .fn()
        .mockImplementation((lod: number) =>
          lod === 0 ? [2, 2, 2] : [1, 1, 1],
        ),
      loadBrick: vi
        .fn()
        .mockResolvedValue({ data: brickData, min: 0, max: 128, avg: 64 }),
      isBrickEmpty: vi.fn().mockResolvedValue(false),
      getBrickStats: vi.fn().mockResolvedValue(null),
      getNetworkStats: vi.fn().mockReturnValue({
        totalBytesDownloaded: 0,
        recentBytesPerSecond: 0,
        requestCount: 0,
      } as NetworkStats),
      dispose: vi.fn(),
    };
  }

  function stubCamera() {
    const pos: [number, number, number] = [0, 0, 0.5];
    const view = mat4.lookAt(pos, [0, 0, 0], [0, 1, 0]);
    return {
      position: new Float32Array(pos),
      getViewMatrix: () => view,
      getProjectionMatrix: (aspect: number) =>
        mat4.perspective(Math.PI / 4, aspect, 0.01, 100),
      isInteracting: () => false,
    };
  }

  const canvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not fetch a hidden channel when streaming a finer LOD", async () => {
    const provider = makePyramidProvider(2);
    const resources = makeResources(2);
    let nextSlot = 0;
    resources.allocator.allocate = vi.fn().mockImplementation(() => {
      const i = nextSlot++;
      return { slot: { x: i, y: 0, z: 0 }, slotIndex: i, evicted: null };
    });

    const sm = new StreamingManager(
      resources as never,
      provider,
      makePyramidMetadata(2),
      {} as GPUDevice,
      makeConfig() as never,
      vi.fn(),
    );
    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });
    expect(provider.loadBrick).toHaveBeenCalledTimes(2); // base LOD, both channels

    sm.setChannelEnabled(1, false);
    sm.forcedLod = 0;
    sm.forceUpdate(stubCamera() as never, canvas);
    (sm as unknown as { processLoadQueue(): void }).processLoadQueue();

    await vi.waitFor(() => {
      const lod0 = vi
        .mocked(provider.loadBrick)
        .mock.calls.filter((c) => c[0] === 0);
      expect(lod0.length).toBeGreaterThan(0);
    });

    const lod0Calls = vi
      .mocked(provider.loadBrick)
      .mock.calls.filter((c) => c[0] === 0);
    expect(lod0Calls.every((c) => c[4] === 0)).toBe(true);
    expect(lod0Calls.some((c) => c[4] === 1)).toBe(false);
  });

  it("backfills a re-enabled channel into resident bricks", async () => {
    const provider = makePyramidProvider(2);
    const resources = makeResources(2);
    let nextSlot = 0;
    resources.allocator.allocate = vi.fn().mockImplementation(() => {
      const i = nextSlot++;
      return { slot: { x: i, y: 0, z: 0 }, slotIndex: i, evicted: null };
    });

    const sm = new StreamingManager(
      resources as never,
      provider,
      makePyramidMetadata(2),
      {} as GPUDevice,
      makeConfig() as never,
      vi.fn(),
    );
    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });

    sm.setChannelEnabled(1, false);
    sm.forcedLod = 0;
    sm.forceUpdate(stubCamera() as never, canvas);
    (sm as unknown as { processLoadQueue(): void }).processLoadQueue();
    await vi.waitFor(() => {
      expect(
        vi.mocked(provider.loadBrick).mock.calls.some((c) => c[0] === 0),
      ).toBe(true);
    });

    const before = vi.mocked(provider.loadBrick).mock.calls.length;
    sm.setChannelEnabled(1, true);
    await vi.waitFor(() => {
      expect(vi.mocked(provider.loadBrick).mock.calls.length).toBeGreaterThan(
        before,
      );
    });
    const added = vi.mocked(provider.loadBrick).mock.calls.slice(before);
    expect(added.every((c) => c[4] === 1)).toBe(true);
  });

  it("does not upload hidden channels when committing a finer brick", async () => {
    const { writeToCanvas } = await import("../src/core/volume.js");
    const provider = makePyramidProvider(2);
    const resources = makeResources(2);
    let nextSlot = 0;
    resources.allocator.allocate = vi.fn().mockImplementation(() => {
      const i = nextSlot++;
      return { slot: { x: i, y: 0, z: 0 }, slotIndex: i, evicted: null };
    });

    const sm = new StreamingManager(
      resources as never,
      provider,
      makePyramidMetadata(2),
      {} as GPUDevice,
      makeConfig() as never,
      vi.fn(),
    );
    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });
    vi.mocked(writeToCanvas).mockClear();

    sm.setChannelEnabled(1, false);
    sm.forcedLod = 0;
    sm.forceUpdate(stubCamera() as never, canvas);
    (sm as unknown as { processLoadQueue(): void }).processLoadQueue();

    await vi.waitFor(() => {
      expect(vi.mocked(writeToCanvas).mock.calls.length).toBeGreaterThan(0);
    });

    const canvasesWritten = vi
      .mocked(writeToCanvas)
      .mock.calls.map((c) => c[1]);
    expect(canvasesWritten.every((c) => c === resources.canvases[0])).toBe(
      true,
    );
    expect(canvasesWritten.some((c) => c === resources.canvases[1])).toBe(
      false,
    );
  });

  it("limits concurrent channel fetches across bricks", async () => {
    let inFlight = 0;
    let peak = 0;
    const brickData = new Uint8Array(66 * 66 * 66);
    const meta = makePyramidMetadata(4);
    const provider: DataProvider = {
      initialize: vi.fn().mockResolvedValue(meta),
      getMetadata: vi.fn().mockReturnValue(meta),
      getBrickGrid: vi
        .fn()
        .mockImplementation((lod: number) =>
          lod === 0 ? [2, 2, 2] : [1, 1, 1],
        ),
      loadBrick: vi.fn().mockImplementation(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return { data: brickData, min: 0, max: 128, avg: 64 };
      }),
      isBrickEmpty: vi.fn().mockResolvedValue(false),
      getBrickStats: vi.fn().mockResolvedValue(null),
      getNetworkStats: vi.fn().mockReturnValue({
        totalBytesDownloaded: 0,
        recentBytesPerSecond: 0,
        requestCount: 0,
      } as NetworkStats),
      dispose: vi.fn(),
    };
    const resources = makeResources(4);
    let nextSlot = 0;
    resources.allocator.allocate = vi.fn().mockImplementation(() => {
      const i = nextSlot++;
      return { slot: { x: i, y: 0, z: 0 }, slotIndex: i, evicted: null };
    });

    const sm = new StreamingManager(
      resources as never,
      provider,
      meta,
      {} as GPUDevice,
      makeConfig() as never,
      vi.fn(),
    );
    // Cap below 4-channels × several bricks so the semaphore is forced to engage.
    (
      sm as unknown as { maxConcurrentChannelJobs: number }
    ).maxConcurrentChannelJobs = 3;

    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });
    // Base LOD alone is 1 brick × 4 channels with budget 3 → peak must be ≤ 3.
    expect(peak).toBeLessThanOrEqual(3);
  });
});
