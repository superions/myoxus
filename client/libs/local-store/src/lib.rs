// SPDX-License-Identifier: AGPL-3.0-or-later
//
// myoxus-local-store-native — NAPI entry point for @myoxus/local-store.
//
// This is the top-level cdylib that NAPI-RS compiles into the `.node` binary
// loaded by the TypeScript `@myoxus/local-store` package. It re-exports all
// public symbols from:
//
// - `client_storage` — Document & blob storage pool (current schema)
//
// The resulting binary is named `myoxus_storage.node` and provides the full
// local storage API to Electron, web workers, and development tooling.

#[cfg(not(target_arch = "arm"))]
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

pub use client_storage::*;
