// SPDX-License-Identifier: AGPL-3.0-or-later
//! Deterministic, order-preserving repair plans for Organizer order keys.
//!
//! Planning is pure with respect to persistence. It operates on one decoded
//! Organizer revision and emits the single index-only Yjs delta that a guarded
//! maintenance write may append later.

use std::collections::BTreeMap;

use serde::Serialize;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Doc, Map, ReadTxn, Transact, Update};

use super::order_key::{generate_base_key_between, is_valid_order_key};
use super::{OrganizerDocument, OrganizerError};

const CANONICAL_SUFFIX: &str = "011111111111111111111111111111111";

/// One row whose order key will change in an affected sibling group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerReindexRowChange {
  pub id: String,
  pub before_index: String,
  pub after_index: String,
}

/// One exact-parent sibling group selected for complete reindexing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerReindexGroup {
  pub parent_id: Option<String>,
  pub rows: Vec<OrganizerReindexRowChange>,
}

/// Deterministic repair plan tied to one content-addressed Organizer revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerReindexPlan {
  pub workspace_id: Uuid,
  pub revision: String,
  pub groups: Vec<OrganizerReindexGroup>,
  pub row_count: usize,
  #[serde(skip)]
  pub(crate) delta: Vec<u8>,
}

impl OrganizerReindexPlan {
  pub fn is_empty(&self) -> bool {
    self.groups.is_empty()
  }
}

pub(super) fn plan(workspace_id: Uuid, document: &OrganizerDocument) -> Result<OrganizerReindexPlan, OrganizerError> {
  let mut siblings = BTreeMap::<Option<String>, Vec<_>>::new();
  for row in &document.rows {
    siblings.entry(row.parent_id.clone()).or_default().push(row);
  }

  let mut groups = Vec::new();
  for (parent_id, mut rows) in siblings {
    let unique_keys = rows
      .iter()
      .map(|row| row.index.as_str())
      .collect::<std::collections::BTreeSet<_>>();
    if rows.iter().all(|row| is_valid_order_key(&row.index)) && unique_keys.len() == rows.len() {
      continue;
    }
    rows.sort_by(|left, right| left.index.cmp(&right.index).then_with(|| left.id.cmp(&right.id)));
    let mut lower = None;
    let mut changes = Vec::with_capacity(rows.len());
    for row in rows {
      let base = generate_base_key_between(lower.as_deref(), None)?;
      let after_index = format!("{base}{CANONICAL_SUFFIX}");
      changes.push(OrganizerReindexRowChange {
        id: row.id.clone(),
        before_index: row.index.clone(),
        after_index,
      });
      lower = Some(base);
    }
    groups.push(OrganizerReindexGroup {
      parent_id,
      rows: changes,
    });
  }

  let row_count = groups.iter().map(|group| group.rows.len()).sum();
  let delta = if groups.is_empty() {
    Vec::new()
  } else {
    let repair_doc = Doc::new();
    if !document.source.is_empty() {
      let update = Update::decode_v1(&document.source).map_err(|_| OrganizerError::Decode)?;
      repair_doc
        .transact_mut()
        .apply_update(update)
        .map_err(|_| OrganizerError::Decode)?;
    }
    let before = repair_doc.transact().state_vector();
    let repaired_rows = groups
      .iter()
      .flat_map(|group| &group.rows)
      .map(|change| {
        (
          repair_doc.get_or_insert_map(change.id.as_str()),
          change.after_index.clone(),
        )
      })
      .collect::<Vec<_>>();
    {
      let mut txn = repair_doc.transact_mut();
      for (row, after_index) in repaired_rows {
        row.insert(&mut txn, "index", after_index);
      }
    }
    repair_doc.transact().encode_state_as_update_v1(&before)
  };

  Ok(OrganizerReindexPlan {
    workspace_id,
    revision: document.revision.clone(),
    groups,
    row_count,
    delta,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::organizer::order_key::generate_order_key_between;
  use yrs::{Any, Out, StateVector};

  fn legacy_fixture() -> Vec<u8> {
    let doc = Doc::new();
    let index = doc.get_or_insert_map(super::super::FOLDER_INDEX_MAP);
    let root_rows = [
      ("legacy-0", "0000"),
      ("legacy-1", "0100"),
      ("legacy-2", "0150"),
      ("legacy-3", "0175"),
      ("legacy-4", "0200"),
      ("legacy-5", "0300"),
      ("nested-parent", "a9"),
    ];
    let nested_rows = [("nested-b", "a0"), ("nested-a", "a0")];
    {
      let mut txn = doc.transact_mut();
      index.insert(&mut txn, super::super::DELETED_FLAG, true);
      for (id, _) in root_rows.iter().chain(nested_rows.iter()) {
        index.insert(&mut txn, *id, true);
      }
      index.insert(&mut txn, "deleted-row", true);
    }
    for (id, key) in root_rows {
      let row = doc.get_or_insert_map(id);
      {
        let mut txn = doc.transact_mut();
        row.insert(&mut txn, "id", id);
        row.insert(&mut txn, "data", id);
        row.insert(&mut txn, "type", "folder");
        row.insert(&mut txn, "index", key);
        if id == "legacy-0" {
          row.insert(&mut txn, "unknownColumn", "must-survive");
        }
      }
    }
    for (id, key) in nested_rows {
      let row = doc.get_or_insert_map(id);
      {
        let mut txn = doc.transact_mut();
        row.insert(&mut txn, "id", id);
        row.insert(&mut txn, "parentId", "nested-parent");
        row.insert(&mut txn, "data", id);
        row.insert(&mut txn, "type", "folder");
        row.insert(&mut txn, "index", key);
      }
    }
    let deleted = doc.get_or_insert_map("deleted-row");
    {
      let mut txn = doc.transact_mut();
      deleted.insert(&mut txn, super::super::DELETED_FLAG, true);
      deleted.insert(&mut txn, "unknownColumn", "deleted-metadata");
    }
    doc.transact().encode_state_as_update_v1(&StateVector::default())
  }

  fn apply(source: &[u8], delta: &[u8]) -> Vec<u8> {
    let doc = Doc::new();
    for payload in [source, delta] {
      let update = Update::decode_v1(payload).expect("decode fixture update");
      doc.transact_mut().apply_update(update).expect("apply fixture update");
    }
    doc.transact().encode_state_as_update_v1(&StateVector::default())
  }

  #[test]
  fn reported_mixed_duplicate_and_nested_groups_reindex_deterministically_without_field_loss() {
    let workspace_id = Uuid::new_v4();
    let source = legacy_fixture();
    let first = plan(
      workspace_id,
      &OrganizerDocument::decode(source.clone()).expect("decode legacy fixture"),
    )
    .expect("plan legacy repair");
    let second = plan(
      workspace_id,
      &OrganizerDocument::decode(source.clone()).expect("decode second legacy fixture"),
    )
    .expect("repeat dry-run");

    assert_eq!(first.groups, second.groups);
    assert_eq!(first.revision, second.revision);
    assert_eq!(first.groups.len(), 2);
    assert_eq!(first.row_count, 9);
    assert_eq!(
      first.groups[0]
        .rows
        .iter()
        .take(6)
        .map(|row| row.before_index.as_str())
        .collect::<Vec<_>>(),
      ["0000", "0100", "0150", "0175", "0200", "0300"]
    );
    assert_eq!(
      first.groups[1]
        .rows
        .iter()
        .map(|row| row.id.as_str())
        .collect::<Vec<_>>(),
      ["nested-a", "nested-b"],
      "duplicate keys use stable row-id tie breaking"
    );
    for group in &first.groups {
      for (position, row) in group.rows.iter().enumerate() {
        assert!(is_valid_order_key(&row.after_index));
        assert!(row.after_index.ends_with(CANONICAL_SUFFIX));
        if position > 0 {
          assert!(group.rows[position - 1].after_index < row.after_index);
        }
      }
      let keys = group
        .rows
        .iter()
        .map(|row| row.after_index.as_str())
        .collect::<Vec<_>>();
      assert!(generate_order_key_between(None, keys.first().copied()).is_ok());
      for pair in keys.windows(2) {
        assert!(generate_order_key_between(Some(pair[0]), Some(pair[1])).is_ok());
      }
      assert!(generate_order_key_between(keys.last().copied(), None).is_ok());
    }

    let repaired = apply(&source, &first.delta);
    let repaired_doc = OrganizerDocument::decode(repaired.clone()).expect("decode repaired fixture");
    let repeated = plan(workspace_id, &repaired_doc).expect("plan repaired fixture");
    assert!(repeated.is_empty());
    assert!(repeated.delta.is_empty());

    let doc = repaired_doc.doc;
    let row = doc.get_or_insert_map("legacy-0");
    let deleted = doc.get_or_insert_map("deleted-row");
    let txn = doc.transact();
    assert!(matches!(
      row.get(&txn, "unknownColumn"),
      Some(Out::Any(Any::String(value))) if value.as_ref() == "must-survive"
    ));
    assert!(matches!(
      deleted.get(&txn, super::super::DELETED_FLAG),
      Some(Out::Any(Any::Bool(true)))
    ));
    assert!(matches!(
      deleted.get(&txn, "unknownColumn"),
      Some(Out::Any(Any::String(value))) if value.as_ref() == "deleted-metadata"
    ));
  }
}
