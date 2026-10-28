/// <reference types="@webgpu/types" />
/** kiln-render — public API */

export type { OrbitState, UpAxis } from "./core/camera.js";
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
export type {
  ImarisProviderOptions,
  ImsChannelInfo,
} from "./data/imaris-provider.js";
export { ImarisDataProvider } from "./data/imaris-provider.js";
export {
  isRemoteIms,
  looksLikeImsUrl,
  preValidateLocalIms,
  preValidateRemoteIms,
} from "./data/imaris-validator.js";
export type { FsReadPermission } from "./data/local-loader.js";
// Local file loader utilities (File System Access API)
export {
  getStoredHandle,
  getStoredImsHandle,
  promptForImsFile,
  promptForZarrDirectory,
  queryReadPermission,
  requestPermission,
} from "./data/local-loader.js";
// Built-in providers
export { LocalZarrDataProvider } from "./data/local-zarr-provider.js";
export { openDataset } from "./data/open-dataset.js";
export type { ZarrProbeResult } from "./data/zarr-validator.js";
// Validation utilities
export {
  isRemoteZarr,
  preValidateLocalZarr,
  preValidateRemoteZarr,
  probeLocalZarr,
  probeRemoteZarr,
} from "./data/zarr-validator.js";
// Gaussian splats
export type { GaussianCloud } from "./splat/cloud.js";
export {
  createCloud,
  mergeClouds,
  readPly,
  splitByChannel,
  writePly,
} from "./splat/cloud.js";
export type {
  BuildProgress,
  BuildStage,
  SplatBuildOptions,
} from "./splat/splat-builder.js";
export { SplatLayer } from "./splat/splat-layer.js";
export type {
  DisplayMode,
  GenerateSplatsOptions,
  ViewerOptions,
  ViewerState,
} from "./viewer.js";
// Viewer
export { KilnViewer } from "./viewer.js";
