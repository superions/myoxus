// SPDX-License-Identifier: AGPL-3.0-or-later
//! Update — a collection of CRDT struct lists and a delete set.
//!
//! Clean reimplementation. Wire format matches y-octo exactly.
//!
//! ## Deviation A-01 (part 1): Descending client sort for Update
//!
//! When encoding, client IDs are sorted **descending** (`b.cmp(a)`).
//! This is the OPPOSITE of StateVector (which uses ascending).
//! The asymmetry is intentional and must be replicated exactly.
//!
//! ## Deviation F-04: Clock tracking (accumulation, not delta)
//!
//! The initial clock for each client group is written explicitly.
//! Subsequent items accumulate the clock via `clock += node.len()`.
//! No delta encoding — clock increments are implicit from item lengths.
//!
//! ## Deviation G-01: Empty update sentinel
//!
//! An empty update encodes as `[0, 0]` (zero clients, empty delete set).

use std::collections::VecDeque;

use super::delete_set::DeleteSet;
use super::error::{CodecError, CodecResult};
use super::hasher::{ClientMap, client_map_with_capacity};
use super::item::{Id, Node};
use super::state_vector::StateVector;
use super::varint::{RawDecoder, RawEncoder};

/// A decoded Yjs v1 update: struct lists per client + delete set.
///
/// This is a pure codec type — no Doc, no Store, no pending state.
/// Identical inputs always produce identical output (deterministic).
#[derive(Debug, Default, Clone)]
pub struct Update {
  /// Struct lists indexed by client ID.
  pub structs: ClientMap<VecDeque<Node>>,
  /// Deleted clock ranges.
  delete_set: DeleteSet,
}

impl Update {
  /// Decode from Yjs v1 binary.
  ///
  /// Wire format:
  /// ```text
  /// [varint: num_clients]
  /// per client (descending by ID — deviation A-01):
  ///   [varint: num_structs][varint: client_id][varint: initial_clock]
  ///   [struct_1][struct_2]...
  /// [delete_set]
  /// ```
  ///
  /// **Deviation F-04**: Each struct's ID clock is tracked by accumulation:
  /// `id.clock = initial_clock`, then `clock += node.len()` after each node.
  pub fn decode_v1<T: AsRef<[u8]>>(buffer: T) -> CodecResult<Self> {
    let buf = buffer.as_ref();
    let mut dec = RawDecoder::new(buf);

    let num_clients = dec.read_var_u64()? as usize;
    let mut map = client_map_with_capacity(num_clients.min(1024));

    for _ in 0..num_clients {
      let num_structs = dec.read_var_u64()? as usize;
      let client = dec.read_var_u64()?;
      let mut clock = dec.read_var_u64()?;

      let mut structs = VecDeque::with_capacity(num_structs.min(1024));
      for _ in 0..num_structs {
        // DEVIATION F-04: clock accumulated, not delta-encoded.
        let node = Node::read(&mut dec, Id::new(client, clock))?;
        clock += node.len();
        structs.push_back(node);
      }

      structs.shrink_to_fit();
      map.insert(client, structs);
    }

    map.shrink_to_fit();

    let delete_set = DeleteSet::read(&mut dec)?;

    if !dec.is_empty() {
      return Err(CodecError::UpdateNotFullyConsumed {
        remaining: dec.remaining(),
      });
    }

    Ok(Update {
      structs: map,
      delete_set,
    })
  }

  /// Encode to Yjs v1 binary.
  ///
  /// **Deviation A-01**: Clients sorted **descending** (`b.cmp(a)`).
  /// **Deviation F-04**: Initial clock written explicitly per client group.
  pub fn encode_v1(&self) -> CodecResult<Vec<u8>> {
    let mut enc = RawEncoder::default();

    enc.write_var_u64(self.structs.len() as u64);

    // DEVIATION A-01: descending client sort.
    let mut clients: Vec<_> = self.structs.keys().copied().collect();
    clients.sort_by(|a, b| b.cmp(a));

    for client in clients {
      let structs = &self.structs[&client];
      enc.write_var_u64(structs.len() as u64);
      enc.write_var_u64(client);

      // DEVIATION F-04: write initial clock.
      let initial_clock = structs.front().map(|s| s.id().clock).unwrap_or(0);
      enc.write_var_u64(initial_clock);

      for node in structs {
        node.write(&mut enc)?;
      }
    }

    self.delete_set.write(&mut enc);

    Ok(enc.into_inner())
  }

  /// Iterate over all (client, nodes) entries in the struct map.
  pub fn iter_structs(&self) -> impl Iterator<Item = (&u64, &VecDeque<Node>)> {
    self.structs.iter()
  }

  /// Clone the delete set from this update.
  pub fn clone_delete_set(&self) -> DeleteSet {
    self.delete_set.clone()
  }

  /// Replace the delete set (used when building diff updates).
  pub fn set_delete_set(&mut self, ds: DeleteSet) {
    self.delete_set = ds;
  }

  /// Compute the state vector implied by the structs in this update.
  ///
  /// For each client, the max clock = initial_clock + sum(node.len()).
  pub fn state_vector(&self) -> StateVector {
    let mut sv = StateVector::default();
    for (client, nodes) in &self.structs {
      if let Some(last) = nodes.back() {
        let max_clock = last.id().clock + last.len();
        sv.set_max(*client, max_clock);
      }
    }
    sv
  }

  /// True when both structs and delete set are empty.
  pub fn is_empty(&self) -> bool {
    self.structs.is_empty() && self.delete_set.is_empty()
  }

  /// True when the struct map is empty (delete set may still have entries).
  pub fn is_content_empty(&self) -> bool {
    self.structs.is_empty()
  }
}
