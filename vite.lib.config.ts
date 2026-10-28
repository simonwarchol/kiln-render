import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, transformWithEsbuild } from "vite";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

/**
 * Minify worker bundles. They are inlined into the library as strings
 * (`?worker&inline`), so consumers' bundlers can't minify them.
 */
const minifyWorker = (): Plugin => ({
  name: "kiln-minify-worker",
  async renderChunk(code, chunk) {
    const out = await transformWithEsbuild(code, chunk.fileName, {
      minify: true,
      format: "esm",
      target: "esnext",
    });
    return { code: out.code, map: out.map };
  },
});

/**
 * zarrita builds its codec registry when it loads. Once bundled into the
 * library, consumers' bundlers can't tell that call is pure, so it, and the
 * blosc/zstd/lz4 chunks it imports lazily (~1.4 MB), reached apps that never
 * open Zarr. Annotated, they drop it.
 */
const pureZarritaRegistry = (): Plugin => ({
  name: "kiln-pure-zarrita-registry",
  transform(code, id) {
    if (!/[\\/]zarrita[\\/].*[\\/]codecs\.js$/.test(id)) return null;
    const call = "= create_default_registry();";
    if (!code.includes(call)) {
      this.warn("zarrita's codec registry moved: its codecs ship to every app");
      return null;
    }
    return {
      code: code.replace(call, "= /* @__PURE__ */ create_default_registry();"),
      map: null,
    };
  },
});

export default defineConfig({
  // Don't copy public/ assets into the library output
  publicDir: false,
  plugins: [pureZarritaRegistry()],
  build: {
    lib: {
      entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "kiln-render.js",
    },
    outDir: "lib",
    emptyOutDir: true,
    target: "esnext",
    // Don't minify — consumers' bundlers handle that (workers excepted, below)
    minify: false,
    // No externals: wgpu-matrix, zarrita, fflate are implementation
    // details that consumers should not need to install separately
    rollupOptions: {
      // Brush (vendor/brush-js, loaded only to train splats) ships in
      // lib/brush-js/, copied by postbuild-lib, and is imported from there:
      // installed packages have no vendor/ folder to link to.
      external: ["brush-js"],
      output: {
        paths: { "brush-js": "./brush-js/brush_js.js" },
        // Keep all chunks in lib/ root — avoids Vite emitting duplicate
        // copies in lib/assets/ alongside the canonical lib/ versions
        chunkFileNames: "[name]-[hash].js",
        assetFileNames: "[name]-[hash][extname]",
      },
    },
  },
  worker: {
    format: "es",
    plugins: () => [minifyWorker()],
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
