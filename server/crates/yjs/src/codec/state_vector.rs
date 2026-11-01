// SPDX-License-Identifier: AGPL-3.0-or-later
//! StateVector — maps client IDs to their highest known clock.
//!
//! Clean reimplementation. Wire format matches y-octo exactly.
//!
//! ## Deviation A-01 (part 3): Ascending client sort
//!
//! StateVector encodes clients **ascending** (`a.cmp(b)`).
//! This is the OPPOSITE of Update and DeleteSet (which use descending).
//! The asymmetry is intentional and must be replicated exactly.
//!
//! ## Deviation G-02: Zero-clock clients omitted
//!
//! Clients with clock=0 are not written to the wire.

use std::ops::{Deref, DerefMut};

use super::error::CodecResult;
use super::hasher::{ClientMap, client_map_with_capacity};
use super::varint::{RawDecoder, RawEncoder};

/// Map of client ID → highest known clock.
///
/// Wire format: `[varint: num_clients]` then per client (ascending by ID):
/// `[varint: client_id][varint: clock]`.
#[derive(Debug, Default, PartialEq, Clone)]
pub struct StateVector(ClientMap<u64>);

impl StateVector {
  /// Set the clock for `client` to `max(existing, clock)`.
  pub fn set_max(&mut self, client: u64, clock: u64) {
    self
      .0
      .entry(client)
      .and_modify(|c| {
        if *c < clock {
          *c = clock;
        }
      })
      .or_insert(clock);
  }

  /// Get the clock for `client` (0 if unknown).
  pub fn get(&self, client: &u64) -> u64 {
    self.0.get(client).copied().unwrap_or(0)
  }

  /// Decode a StateVector from Yjs v1 binary.
  pub fn read(dec: &mut RawDecoder) -> CodecResult<Self> {
    let len = dec.read_var_u64()? as usize;
    let mut map = client_map_with_capacity(len.min(1024));
    for _ in 0..len {
      let client = dec.read_var_u64()?;
      let clock = dec.read_var_u64()?;
      map.insert(client, clock);
    }
    Ok(StateVector(map))
  }

  /// Encode this StateVector to Yjs v1 binary.
  ///
  /// **Deviation A-01**: clients sorted **ascending** by ID.
  /// **Deviation G-02**: clients with clock=0 are omitted.
  pub fn write(&self, enc: &mut RawEncoder) {
    // Filter out zero clocks (G-02) and sort ascending (A-01).
    let mut entries: Vec<_> = self.0.iter().filter(|(_, c)| **c > 0).collect();
    entries.sort_by_key(|(client, _)| **client);

    enc.write_var_u64(entries.len() as u64);
    for (client, clock) in entries {
      enc.write_var_u64(*client);
      enc.write_var_u64(*clock);
    }
  }

  /// Iterate over all (client, clock) entries.
  pub fn iter(&self) -> impl Iterator<Item = (&u64, &u64)> {
    self.0.iter()
  }
}

impl Deref for StateVector {
  type Target = ClientMap<u64>;
  fn deref(&self) -> &Self::Target {
    &self.0
  }
}

impl DerefMut for StateVector {
  fn deref_mut(&mut self) -> &mut Self::Target {
    &mut self.0
  }
}

impl<const N: usize> From<[(u64, u64); N]> for StateVector {
  fn from(pairs: [(u64, u64); N]) -> Self {
    let mut map = client_map_with_capacity(N);
    for (client, clock) in pairs {
      map.insert(client, clock);
    }
    StateVector(map)
  }
}
