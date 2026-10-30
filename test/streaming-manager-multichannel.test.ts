/**
 * Multi-channel loading behaviour in StreamingManager
 *
 * These tests verify that for a dataset with N channels:
 *  - dataProvider.loadBrick is called once per channel per brick (channelIndex 0…N-1)
 *  - resources.writeBrick is called once per channel, with that channel index
 *  - Empty bricks short-circuit before any channel data is fetched
 *
 * WebGPU is avoided by supplying a lightweight VolumeResources stand-in whose
 * upload methods are mocks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mat4 } from "wgpu-matrix";
import type {
  BrickStaleListener,
  DataProvider,
  VolumeMetadata,
} from "../src/data/data-provider.js";
import { StreamingManager } from "../src/streaming/streaming-manager.js";
import { mockProvider, mockResources } from "./helpers/streaming-mocks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Channel loads carry a signal that hiding the channel aborts. */
const CANCELLABLE = expect.any(AbortSignal);

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

const makeProvider = (numChannels: number, isEmpty = false) =>
  mockProvider(makeMetadata(numChannels), { isEmpty });
const makeResources = (numChannels: number) =>
  mockResources(numChannels, { evictable: true });

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
      makeConfig() as any,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });

    expect(provider.loadBrick).toHaveBeenCalledTimes(1);
    expect(provider.loadBrick).toHaveBeenCalledWith(
      0,
      0,
      0,
      0,
      0,
      CANCELLABLE,
      undefined,
    );
  });

  it("calls loadBrick twice for a 2-channel dataset, once per channel", async () => {
    const provider = makeProvider(2);
    const resources = makeResources(2);

    const sm = new StreamingManager(
      resources as any,
      provider,
      makeMetadata(2),
      makeConfig() as any,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });

    expect(provider.loadBrick).toHaveBeenCalledTimes(2);
    expect(provider.loadBrick).toHaveBeenCalledWith(
      0,
      0,
      0,
      0,
      0,
      CANCELLABLE,
      undefined,
    ); // ch 0
    expect(provider.loadBrick).toHaveBeenCalledWith(
      0,
      0,
      0,
      0,
      1,
      CANCELLABLE,
      undefined,
    ); // ch 1
  });

  it("calls loadBrick for all 4 channels of a 4-channel dataset", async () => {
    const provider = makeProvider(4);
    const resources = makeResources(4);

    const sm = new StreamingManager(
      resources as any,
      provider,
      makeMetadata(4),
      makeConfig() as any,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });

    expect(provider.loadBrick).toHaveBeenCalledTimes(4);
    for (let ch = 0; ch < 4; ch++) {
      expect(provider.loadBrick).toHaveBeenCalledWith(
        0,
        0,
        0,
        0,
        ch,
        CANCELLABLE,
        undefined,
      );
    }
  });

  it("writes each channel to the corresponding atlas canvas", async () => {
    const provider = makeProvider(2);
    const resources = makeResources(2);

    const sm = new StreamingManager(
      resources as any,
      provider,
      makeMetadata(2),
      makeConfig() as any,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });

    // writeBrick must have been called twice — once per channel
    expect(resources.writeBrick).toHaveBeenCalledTimes(2);
    expect(resources.writeBrick).toHaveBeenCalledWith(
      expect.anything(), // slot
      0,
      expect.any(Uint8Array),
    );
    expect(resources.writeBrick).toHaveBeenCalledWith(
      expect.anything(),
      1,
      expect.any(Uint8Array),
    );
  });

  it("allocates exactly one atlas slot shared across all channels", async () => {
    const provider = makeProvider(3);
    const resources = makeResources(3);

    const sm = new StreamingManager(
      resources as any,
      provider,
      makeMetadata(3),
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

  const pyramidGrid = (lod: number): [number, number, number] =>
    lod === 0 ? [2, 2, 2] : [1, 1, 1];
  const makePyramidProvider = (numChannels: number) =>
    mockProvider(makePyramidMetadata(numChannels), { brickGrid: pyramidGrid });

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
      makeConfig() as never,
      vi.fn(),
    );
    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });
    resources.writeBrick.mockClear();

    sm.setChannelEnabled(1, false);
    sm.forcedLod = 0;
    sm.forceUpdate(stubCamera() as never, canvas);
    (sm as unknown as { processLoadQueue(): void }).processLoadQueue();

    await vi.waitFor(() => {
      expect(resources.writeBrick.mock.calls.length).toBeGreaterThan(0);
    });

    const channelsWritten = resources.writeBrick.mock.calls.map((c) => c[1]);
    expect(channelsWritten.every((ch) => ch === 0)).toBe(true);
    // The hidden channel is marked empty instead of uploaded
    expect(resources.clearChannel).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it("limits concurrent channel fetches across bricks", async () => {
    let inFlight = 0;
    let peak = 0;
    const brickData = new Uint8Array(66 * 66 * 66);
    const meta = makePyramidMetadata(4);
    const provider: DataProvider = {
      ...mockProvider(meta, { brickGrid: pyramidGrid }),
      loadBrick: vi.fn().mockImplementation(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return { data: brickData, min: 0, max: 128, avg: 64 };
      }),
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

  /** Streams LOD 0 with a provider that can report stale bricks. */
  async function streamWithStaleReports(loadBrick: DataProvider["loadBrick"]) {
    let report!: BrickStaleListener;
    const provider: DataProvider = {
      ...makePyramidProvider(2),
      loadBrick: vi.fn(loadBrick),
      setBrickStaleListener: (l) => {
        report = l!;
      },
    };
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
      makeConfig() as never,
      vi.fn(),
    );
    await vi.waitFor(() => {
      expect(sm.baseLodLoaded).toBe(true);
    });
    sm.forcedLod = 0;
    sm.forceUpdate(stubCamera() as never, canvas);
    (sm as unknown as { processLoadQueue(): void }).processLoadQueue();
    const loaded = (key: string) =>
      (
        sm as unknown as { loadedBricks: Map<string, unknown> }
      ).loadedBricks.has(key);
    const callsFor = (ch: number) =>
      vi
        .mocked(provider.loadBrick)
        .mock.calls.filter(
          (c) =>
            c[0] === 0 && c[1] === 0 && c[2] === 0 && c[3] === 0 && c[4] === ch,
        ).length;
    return { report: () => report, loaded, callsFor, resources };
  }

  const brick = {
    data: new Uint8Array(66 * 66 * 66),
    min: 0,
    max: 128,
    avg: 64,
  };

  it("reloads a resident brick channel the provider reports stale", async () => {
    const s = await streamWithStaleReports(async () => brick);
    await vi.waitFor(() => {
      expect(s.loaded("lod0:0/0/0")).toBe(true);
    });
    expect(s.callsFor(1)).toBe(1);
    s.resources.writeBrick.mockClear();
    s.report()(0, 0, 0, 0, 1);
    await vi.waitFor(() => {
      expect(s.callsFor(1)).toBe(2);
      expect(s.resources.writeBrick).toHaveBeenCalledWith(
        expect.anything(),
        1,
        expect.anything(),
      );
    });
    expect(s.callsFor(0)).toBe(1);
  });

  it("reloads a channel reported stale while its brick was loading", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const s = await streamWithStaleReports(async (lod, bx, by, bz, ch) => {
      if (lod === 0 && bx === 0 && by === 0 && bz === 0 && ch === 0 && first) {
        first = false;
        await held;
      }
      return brick;
    });
    await vi.waitFor(() => {
      expect(s.callsFor(0)).toBe(1);
    });
    s.report()(0, 0, 0, 0, 0);
    release();
    await vi.waitFor(() => {
      expect(s.loaded("lod0:0/0/0")).toBe(true);
      expect(s.callsFor(0)).toBe(2);
    });
    expect(s.callsFor(1)).toBe(1);
  });
});
