/// <reference types="@webgpu/types" />
/** kiln-render — public API */

export type { UpAxis } from "./core/camera.js";
// Render state enums/types (needed to construct ViewerOptions)
export type { VolumeRenderMode } from "./core/renderer.js";
export type { OpacityPoint, TFPreset } from "./core/transfer-function.js";
// Data provider interface (implement this to support custom formats)
export type {
  BitDepth,
  BrickData,
  BrickLoadResult,
  BrickStats,
  DataProvider,
  LodLevel,
  NetworkStats,
  VolumeMetadata,
} from "./data/data-provider.js";
export { UnsupportedDatasetError } from "./data/data-provider.js";
export { clearHandle } from "./data/handle-storage.js";
export { ImarisDataProvider } from "./data/imaris-provider.js";
export type { ImsProbeResult } from "./data/imaris-validator.js";
export {
  isRemoteIms,
  looksLikeImsUrl,
  preValidateLocalIms,
  preValidateRemoteIms,
  probeRemoteIms,
} from "./data/imaris-validator.js";
// Local file loader utilities (File System Access API)
export {
  getStoredHandle,
  getStoredImsHandle,
  promptForImsFile,
  promptForZarrDirectory,
  requestPermission,
} from "./data/local-loader.js";
// Built-in providers
export { LocalZarrDataProvider } from "./data/local-zarr-provider.js";
export type { ZarrProbeResult } from "./data/zarr-validator.js";
// Validation utilities
export {
  isRemoteZarr,
  preValidateLocalZarr,
  preValidateRemoteZarr,
  probeLocalZarr,
  probeRemoteZarr,
} from "./data/zarr-validator.js";
export type { ViewerOptions, ViewerState } from "./viewer.js";
// Viewer
export { KilnViewer } from "./viewer.js";
