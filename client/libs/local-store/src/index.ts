// SPDX-License-Identifier: AGPL-3.0-or-later
// @myoxus/local-store — Local SQLite storage NAPI bindings.
//
// Loads from the locally-built platform-specific myoxus_storage*.node binary.

import type * as Binding from "./binding";

// oxlint-disable-next-line typescript/no-var-requires
const native = require("../native-binding.cjs") as typeof Binding;

// Classes
export const DocStorage = native.DocStorage;
export const DocStoragePool = native.DocStoragePool;

// Types (interfaces are re-exported via `export type` for erasure safety)
export type {
  Blob,
  DocClock,
  DocIndexedClock,
  DocRecord,
  DocUpdate,
  ListedBlob,
  NativeBlockInfo,
  NativeCrawlResult,
  NativeMatch,
  NativeSearchHit,
  SetBlob,
} from "./binding";
