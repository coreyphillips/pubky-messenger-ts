# iroh-discovery

The Rust source for the browser peer-discovery WASM. It wraps [iroh](https://github.com/n0-computer/iroh) so two browsers can find each other by pubky and exchange a chat request over n0's public relays, with no server of our own.

A pubky is an ed25519 keypair and so is an iroh endpoint, so a node listens on the network under its own pubky; iroh's EndpointId is the hex of the pubky's 32 bytes. Peers are discovered via pkarr (the same layer pubky uses) and connections are relayed through n0's public relay servers, so this works in the browser without any server we run.

## Layout

- `src/node.rs` - the discovery protocol (spawn a pubky-keyed endpoint, accept chat requests, connect to a peer by EndpointId).
- `src/wasm.rs` - the wasm-bindgen wrapper exposed to JavaScript.
- `src/lib.rs` - module wiring.

The JavaScript side (`src/discovery/iroh.ts` in the parent package) wraps the generated bindings and maps between iroh EndpointIds and pubkys.

## Building the WASM

The committed artifact lives in `../src/discovery/iroh-wasm/` (the 2.4MB `iroh_discovery_bg.wasm` plus the JS glue), so the web build and consumers do not need a Rust toolchain. Rebuild it only when this crate changes:

```sh
./build.sh
```

See the top of `build.sh` for the prerequisites (rustup wasm target, LLVM clang, wasm-bindgen-cli 0.2.122, binaryen). Building on macOS needs LLVM's clang because Apple's clang cannot target WebAssembly, which iroh's `ring` dependency requires.
