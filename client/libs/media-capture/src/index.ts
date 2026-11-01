// SPDX-License-Identifier: AGPL-3.0-or-later
// @myoxus/media-capture — Audio/video capture standalone NAPI binding.
//
// This package is a standalone NAPI module compiled from Rust.
// The .node binary is loaded at runtime; types mirror the NAPI-RS generated
// declarations from myoxus_media_capture.

import type * as Binding from "./binding";

// oxlint-disable-next-line typescript/no-var-requires
const binding = require("../myoxus_media.node") as typeof Binding;

export const ApplicationInfo = binding.ApplicationInfo;
export const ApplicationListChangedSubscriber =
  binding.ApplicationListChangedSubscriber;
export const ApplicationStateChangedSubscriber =
  binding.ApplicationStateChangedSubscriber;
export const AudioCaptureSession = binding.AudioCaptureSession;
export const ShareableContent = binding.ShareableContent;
export const decodeAudio = binding.decodeAudio;
export const decodeAudioSync = binding.decodeAudioSync;
