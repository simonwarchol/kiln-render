#!/usr/bin/env bash
# Rebuild vendor/brush-js from Brush's apps/brush-js.
#
#   scripts/build-brush-js.sh [commit]
#
# Needs rustup (Rust >= 1.95, wasm32-unknown-unknown target). Calls cargo and
# wasm-bindgen directly: an x86_64 wasm-pack on Apple silicon runs its
# children under Rosetta, where the linker cannot load Xcode's arm64 tools.
set -euo pipefail

COMMIT="${1:-79e8d374bcf23a0d30a8b0d0cfa0598274fbf73b}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/vendor/brush-js"
WORK="${BRUSH_BUILD_DIR:-$ROOT/.brush-build}"
TOOLCHAIN="${BRUSH_TOOLCHAIN:-1.95.0}"

rustup toolchain install "$TOOLCHAIN" --profile minimal --target wasm32-unknown-unknown
# Put the toolchain first on PATH (`rustup run` doesn't with Homebrew's rustup).
PATH="$(dirname "$(rustup which --toolchain "$TOOLCHAIN" cargo)"):$PATH"
export PATH
CARGO=(cargo)

if [ ! -d "$WORK/brush/.git" ]; then
  mkdir -p "$WORK"
  git clone https://github.com/ArthurBrussee/brush "$WORK/brush"
fi
git -C "$WORK/brush" fetch --depth 1 origin "$COMMIT"
git -C "$WORK/brush" checkout --detach "$COMMIT"

(cd "$WORK/brush/apps/brush-js" &&
  "${CARGO[@]}" build --release --target wasm32-unknown-unknown)

# wasm-bindgen-cli must match the wasm-bindgen crate version in Cargo.lock.
BINDGEN_VERSION="$(grep -A1 '^name = "wasm-bindgen"$' "$WORK/brush/Cargo.lock" | sed -n 's/^version = "\(.*\)"$/\1/p')"
"${CARGO[@]}" install wasm-bindgen-cli --version "$BINDGEN_VERSION" --locked --root "$WORK/tools"

"$WORK/tools/bin/wasm-bindgen" --target web --out-dir "$OUT" --out-name brush_js \
  "$WORK/brush/target/wasm32-unknown-unknown/release/brush_js.wasm"

# Optional: shrink with binaryen when installed.
if command -v wasm-opt >/dev/null; then
  wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int \
    "$OUT/brush_js_bg.wasm" -o "$OUT/brush_js_bg.wasm"
fi
echo "Built $OUT from Brush $COMMIT"
