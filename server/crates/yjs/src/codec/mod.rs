// SPDX-License-Identifier: AGPL-3.0-or-later
//! Clean Yjs v1 binary codec — no y-octo dependency.
//!
//! This module provides decode, encode, merge, and diff operations for
//! Yjs v1 binary updates. It is a complete reimplementation that matches
//! the y-octo wire format exactly (see `docs/dev/server/yjs-codec-reimplementation.md`
//! for the 21 documented deviations).
//!
//! Design goals:
//! - **Zero unsafe** — no Somr, no AtomicU8, no raw pointer casts
//! - **Concrete types** — no trait-generic readers/writers, just RawDecoder/RawEncoder
//! - **Deterministic** — identical inputs always produce identical bytes
//! - **Documented** — every wire-format deviation is inline-annotated

pub mod any;
pub mod content;
pub mod delete_set;
pub mod error;
pub mod hasher;
pub mod item;
pub mod merge;
pub mod state_vector;
pub mod update;
pub mod varint;

#[cfg(test)]
mod tests;

// ── Public re-exports ────────────────────────────────────────────────────────

pub use delete_set::DeleteSet;
pub use error::{CodecError, CodecResult};
pub use hasher::{ClientMap, client_map_with_capacity};
pub use item::{Id, Item, Node, Parent};
pub use merge::merge_updates_v1;
pub use state_vector::StateVector;
pub use update::Update;
pub use varint::{RawDecoder, RawEncoder};
