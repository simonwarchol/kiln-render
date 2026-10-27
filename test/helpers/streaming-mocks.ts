/**
 * Stand-ins for StreamingManager tests: a DataProvider serving one constant
 * brick, and the VolumeResources parts that base-LOD loading and brick
 * streaming touch (no WebGPU).
 */
import { vi } from "vitest";
import type {
  DataProvider,
  NetworkStats,
  VolumeMetadata,
} from "../../src/data/data-provider.js";

/** Every load returns the same empty 66³ brick (stats max 128). */
export function mockProvider(
  meta: VolumeMetadata,
  opts: {
    isEmpty?: boolean;
    brickGrid?: (lod: number) => [number, number, number];
  } = {},
): DataProvider {
  const brick = new Uint8Array(66 * 66 * 66);
  return {
    initialize: vi.fn().mockResolvedValue(meta),
    getMetadata: vi.fn().mockReturnValue(meta),
    getBrickGrid: opts.brickGrid
      ? vi.fn().mockImplementation(opts.brickGrid)
      : vi.fn().mockReturnValue([1, 1, 1] as [number, number, number]),
    loadBrick: vi
      .fn()
      .mockResolvedValue({ data: brick, min: 0, max: 128, avg: 64 }),
    isBrickEmpty: vi.fn().mockResolvedValue(opts.isEmpty ?? false),
    getNetworkStats: vi.fn().mockReturnValue({
      totalBytesDownloaded: 0,
      recentBytesPerSecond: 0,
      requestCount: 0,
    } as NetworkStats),
    dispose: vi.fn(),
  };
}

/**
 * VolumeResources stand-in: one 8-bit atlas canvas per channel; uploads go
 * through the mocked writeBrick. `evictable` adds allocator.hasEvictableSlot
 * (always true), which lets streaming dispatch bricks.
 */
export function mockResources(
  numChannels: number,
  opts: { evictable?: boolean } = {},
) {
  return {
    numChannels,
    allocator: {
      allocate: vi.fn().mockReturnValue({
        slot: { x: 0, y: 0, z: 0 },
        slotIndex: 0,
        evicted: null,
      }),
      ...(opts.evictable
        ? { hasEvictableSlot: vi.fn().mockReturnValue(true) }
        : {}),
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
    canvases: Array.from({ length: Math.max(numChannels, 1) }, () => ({
      bitDepth: 8,
    })),
    // The only WebGPU-touching calls during loading
    writeBrick: vi.fn(),
    clearChannel: vi.fn(),
  };
}
