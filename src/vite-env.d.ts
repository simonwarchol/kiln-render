/// <reference types="vite/client" />

// WGSL shader imports with ?raw suffix
declare module "*.wgsl?raw" {
  const content: string;
  export default content;
}

// Regular WGSL imports
declare module "*.wgsl" {
  const content: string;
  export default content;
}

/** Optional peer for in-browser Brush training (not bundled with kiln). */
declare module "brush-js" {
  export class BrushApp {
    init(): Promise<void>;
    initExisting?(
      adapter: GPUAdapter,
      device: GPUDevice,
      queue: GPUQueue,
    ): Promise<void>;
    startTrainingFromDirectory(
      dir: FileSystemDirectoryHandle,
      configFn: (cfg: unknown) => Promise<unknown>,
    ): Promise<{
      trainSteps(n: number): Promise<unknown[]>;
      currentSplats(): {
        exportPly?: () => Uint8Array | Promise<Uint8Array>;
        toPly?: () => Uint8Array | Promise<Uint8Array>;
      } | null;
      free(): void;
    }>;
  }
}
