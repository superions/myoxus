//! Synthetic fixture for the July 2026 document-sync memory incident.
//!
//! The fixture deliberately contains no production-derived content or IDs. It
//! fixes the incident shape at one large workspace root, 50 pending root
//! updates, and 128 small leaf documents so load, reconnect, and multi-client
//! tests share one reproducible workload instead of inventing smaller mocks.

use yrs::{ReadTxn, StateVector, Text, Transact};

pub const ROOT_TAIL_UPDATE_COUNT: usize = 50;
pub const LEAF_DOCUMENT_COUNT: usize = 128;
pub const ROOT_STATE_MIN_BYTES: usize = 1_520_436; // 1.45 MiB, rounded up.
pub const ROOT_STATE_MAX_BYTES: usize = 1_677_721; // 1.60 MiB, rounded up.

#[derive(Debug, Clone)]
pub struct SyntheticLeafDocument {
  pub external_id: String,
  pub update: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct SyncIncidentFixture {
  pub root_snapshot: Vec<u8>,
  pub root_tail_updates: Vec<Vec<u8>>,
  pub leaf_documents: Vec<SyntheticLeafDocument>,
}

impl SyncIncidentFixture {
  /// Build the bounded synthetic workload used by sync regression tests.
  ///
  /// The root snapshot is a valid Yjs-v1 state in the incident size range.
  /// Every tail entry is a valid incremental update relative to the preceding
  /// root state, preserving the exact 50-row repository shape.
  pub fn generate() -> Self {
    let root = yrs::Doc::new();
    let root_text = root.get_or_insert_text("synthetic-root");
    {
      let mut txn = root.transact_mut();
      root_text.insert(&mut txn, 0, &"s".repeat(1_535_000));
    }

    let root_snapshot = root.transact().encode_state_as_update_v1(&StateVector::default());
    let mut root_tail_updates = Vec::with_capacity(ROOT_TAIL_UPDATE_COUNT);
    let mut offset = 1_535_000_u32;
    for index in 0..ROOT_TAIL_UPDATE_COUNT {
      let before = root.transact().state_vector();
      let tail = format!("tail-{index:02};");
      {
        let mut txn = root.transact_mut();
        root_text.insert(&mut txn, offset, &tail);
      }
      offset += tail.len() as u32;
      root_tail_updates.push(root.transact().encode_state_as_update_v1(&before));
    }

    let leaf_documents = (0..LEAF_DOCUMENT_COUNT)
      .map(|index| {
        let external_id = format!("synthetic-leaf-{index:03}");
        let doc = yrs::Doc::new();
        let text = doc.get_or_insert_text("content");
        {
          let mut txn = doc.transact_mut();
          text.insert(&mut txn, 0, &external_id);
        }
        let update = doc.transact().encode_state_as_update_v1(&StateVector::default());
        SyntheticLeafDocument { external_id, update }
      })
      .collect();

    Self {
      root_snapshot,
      root_tail_updates,
      leaf_documents,
    }
  }

  pub fn assert_contract(&self) {
    assert!(
      (ROOT_STATE_MIN_BYTES..=ROOT_STATE_MAX_BYTES).contains(&self.root_snapshot.len()),
      "root snapshot must remain inside the 1.45-1.60 MiB incident range, got {} bytes",
      self.root_snapshot.len()
    );
    assert_eq!(self.root_tail_updates.len(), ROOT_TAIL_UPDATE_COUNT);
    assert_eq!(self.leaf_documents.len(), LEAF_DOCUMENT_COUNT);
    assert!(self.root_tail_updates.iter().all(|update| !update.is_empty()));
    assert!(self.leaf_documents.iter().all(|leaf| !leaf.update.is_empty()));
  }
}

#[cfg(test)]
mod tests {
  use std::collections::HashSet;

  use super::*;
  use yrs::updates::decoder::Decode;

  #[test]
  fn synthetic_incident_fixture_has_the_production_failure_shape_without_production_data() {
    let fixture = SyncIncidentFixture::generate();
    fixture.assert_contract();

    yrs::Update::decode_v1(&fixture.root_snapshot).expect("valid root snapshot");
    for update in &fixture.root_tail_updates {
      yrs::Update::decode_v1(update).expect("valid root tail update");
    }
    for leaf in &fixture.leaf_documents {
      yrs::Update::decode_v1(&leaf.update).expect("valid leaf update");
    }

    let ids = fixture
      .leaf_documents
      .iter()
      .map(|leaf| leaf.external_id.as_str())
      .collect::<HashSet<_>>();
    assert_eq!(ids.len(), LEAF_DOCUMENT_COUNT);
    assert!(ids.iter().all(|id| id.starts_with("synthetic-leaf-")));
  }
}
