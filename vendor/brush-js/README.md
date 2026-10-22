# brush-js (vendored build)

WebAssembly build of [Brush](https://github.com/ArthurBrussee/brush)'s
JavaScript bindings (`apps/brush-js`), which Kiln uses to train Gaussian
splats. Brush is Apache-2.0. It is not published to npm, so the build lives
here.

- Brush commit: `79e8d374bcf23a0d30a8b0d0cfa0598274fbf73b` (2026-05-31).
  Later commits don't train in a browser yet: from `3da02ec` CubeCL's
  autotuner blocks on a GPU sync (a panic on wasm), and from `993c3a2` a
  kernel needs 12 storage buffers per stage where Chrome on Apple GPUs
  allows 10.
- Rebuild: `scripts/build-brush-js.sh` (needs rustup with Rust ≥ 1.95 and the
  `wasm32-unknown-unknown` target; it fetches a matching `wasm-bindgen-cli`).
