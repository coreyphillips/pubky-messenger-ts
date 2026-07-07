#!/usr/bin/env bash
#
# Build the iroh discovery WASM and copy the wasm-bindgen output into
# src/discovery/iroh-wasm/ (which is committed, so consumers do not need Rust).
#
# Prerequisites:
#   - rustup with the wasm32-unknown-unknown target
#       rustup target add wasm32-unknown-unknown
#   - LLVM's clang (Apple clang cannot target wasm, which ring needs)
#       brew install llvm
#   - wasm-bindgen-cli pinned to the crate's version
#       cargo install wasm-bindgen-cli --version 0.2.122
#   - wasm-opt (binaryen)
#       brew install binaryen
#
set -euo pipefail
cd "$(dirname "$0")"

# ring compiles a little C to wasm and needs a wasm-capable clang.
LLVM_BIN="${LLVM_BIN:-/opt/homebrew/opt/llvm/bin}"
export CC_wasm32_unknown_unknown="${CC_wasm32_unknown_unknown:-$LLVM_BIN/clang}"
export AR_wasm32_unknown_unknown="${AR_wasm32_unknown_unknown:-$LLVM_BIN/llvm-ar}"

cargo build --target wasm32-unknown-unknown --release

wasm-bindgen ./target/wasm32-unknown-unknown/release/iroh_discovery.wasm \
  --out-dir=pkg --target=web --weak-refs

wasm-opt --enable-nontrapping-float-to-int --enable-bulk-memory -Oz \
  -o pkg/iroh_discovery_bg.wasm pkg/iroh_discovery_bg.wasm

OUT=../src/discovery/iroh-wasm
mkdir -p "$OUT"
cp pkg/iroh_discovery.js \
   pkg/iroh_discovery_bg.wasm \
   pkg/iroh_discovery.d.ts \
   pkg/iroh_discovery_bg.wasm.d.ts \
   "$OUT/"

echo "Updated $OUT ($(du -h pkg/iroh_discovery_bg.wasm | cut -f1) wasm)"
