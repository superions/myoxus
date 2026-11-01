// SPDX-License-Identifier: AGPL-3.0-or-later
//
// myoxus-media-capture-native — NAPI entry point for @myoxus/media-capture.
//
// Re-exports all public symbols from myoxus_media_capture so that NAPI-RS
// compiles them into a `.node` binary loadable by Node.js. Platform-specific
// audio/video capture (macOS ScreenCaptureKit, Windows WASAPI) is implemented
// in the inner crate; this wrapper only provides the cdylib + allocator setup.

#[cfg(not(target_arch = "arm"))]
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

pub use myoxus_media_capture::*;
