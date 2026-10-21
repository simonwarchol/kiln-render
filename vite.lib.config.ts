import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  // Don't copy public/ assets into the library output
  publicDir: false,
  build: {
    lib: {
      entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "kiln-render.js",
    },
    outDir: "lib",
    emptyOutDir: true,
    target: "esnext",
    // Don't minify — consumers' bundlers handle that
    minify: false,
    // No externals: wgpu-matrix, zarrita, fflate are implementation
    // details that consumers should not need to install separately
    rollupOptions: {
      // Optional peers — splat preview (playcanvas) and Brush training (brush-js).
      external: ["playcanvas", "brush-js"],
      output: {
        // Keep all chunks in lib/ root — avoids Vite emitting duplicate
        // copies in lib/assets/ alongside the canonical lib/ versions
        chunkFileNames: "[name]-[hash].js",
        assetFileNames: "[name]-[hash][extname]",
      },
    },
  },
  worker: {
    format: "es",
    rollupOptions: {
      output: {
        // Inline all dynamic imports (zarrita codec chunks) into the worker
        // bundle so it is self-contained when run from a blob: URL
        inlineDynamicImports: true,
      },
    },
  },
  resolve: {
    alias: {
      "@kiln": srcDir,
    },
  },
});
