// SPDX-License-Identifier: AGPL-3.0-or-later
//! Identity hasher for `u64` client IDs.
//!
//! Yjs client IDs are already well-distributed random u64 values, so hashing
//! them through SipHash or AHash wastes cycles. This identity hasher returns
//! the u64 value directly, giving O(1) hash with zero overhead.
//!
//! Deviation G-03: required for deterministic HashMap iteration after sorting.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};

/// Identity hasher — returns the written `u64` directly as the hash.
#[derive(Default)]
pub struct ClientHasher(u64);

impl Hasher for ClientHasher {
  #[inline]
  fn finish(&self) -> u64 {
    self.0
  }

  fn write(&mut self, _bytes: &[u8]) {
    // Not used — we only hash u64 keys via write_u64.
  }

  #[inline]
  fn write_u64(&mut self, i: u64) {
    self.0 = i;
  }
}

/// Builder for [`ClientHasher`].
#[derive(Default, Clone)]
pub struct ClientHasherBuilder;

impl BuildHasher for ClientHasherBuilder {
  type Hasher = ClientHasher;

  #[inline]
  fn build_hasher(&self) -> Self::Hasher {
    ClientHasher::default()
  }
}

/// HashMap keyed by client ID with identity hashing.
pub type ClientMap<V> = HashMap<u64, V, ClientHasherBuilder>;

/// Create a [`ClientMap`] with pre-allocated capacity.
#[inline]
pub fn client_map_with_capacity<V>(capacity: usize) -> ClientMap<V> {
  HashMap::with_capacity_and_hasher(capacity, ClientHasherBuilder)
}
