/** Data module — volume data provider abstraction. */

// Core types and interface
export type {
  BitDepth,
  BrickData,
  BrickStats,
  DataProvider,
  LodLevel,
  NetworkStats,
  VolumeMetadata,
} from "./data-provider.js";
// Decompression utilities
export {
  DecompressionPool,
  getDecompressionPool,
  terminateDecompressionPool,
} from "./decompression-pool.js";
export { ImarisDataProvider } from "./imaris-provider.js";
// Sharded format implementation (Kiln's native format)
export { ShardedDataProvider } from "./sharded-provider.js";
// OME-Zarr format implementation
export { ZarrDataProvider } from "./zarr-provider.js";
