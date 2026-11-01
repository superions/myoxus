// SPDX-License-Identifier: AGPL-3.0-or-later
//! Final Organizer link removal shared by atomic deletion and automatic catch-up.

use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Any, Doc, Map, Out, ReadTxn, Transact, Update};

use super::{DELETED_FLAG, FOLDER_INDEX_MAP, OrganizerError, map_optional_string};

pub struct OrganizerDocumentLinkRemoval {
  pub update: Vec<u8>,
  pub entry_ids: Vec<String>,
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn retirement_removes_indexed_and_unindexed_local_links_but_preserves_foreign_links() {
    let owner = Uuid::new_v4();
    let foreign = Uuid::new_v4();
    let doc = Doc::new();
    let index = doc.get_or_insert_map(FOLDER_INDEX_MAP);
    for (id, indexed, target) in [
      ("indexed", true, None),
      ("unindexed", false, None),
      ("foreign", true, Some(foreign)),
    ] {
      let row = doc.get_or_insert_map(id);
      let mut txn = doc.transact_mut();
      for (field, value) in [
        ("id", id),
        ("parentId", "folder"),
        ("type", "doc"),
        ("data", "deleted-key"),
        ("index", "a0"),
      ] {
        row.insert(&mut txn, field, value);
      }
      if let Some(target) = target {
        row.insert(&mut txn, "targetWorkspaceId", target.to_string());
      }
      if indexed {
        index.insert(&mut txn, id, true);
      }
    }
    let payload = doc.transact().encode_state_as_update_v1(&Default::default());
    let removed = remove_document_links(&payload, owner, owner, &["deleted-key".into()]).unwrap();
    assert_eq!(removed.entry_ids.len(), 2);
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(&removed.update).unwrap())
      .unwrap();
    let txn = doc.transact();
    for id in ["indexed", "unindexed"] {
      let row = txn.get_map(id).unwrap();
      assert!(matches!(row.get(&txn, DELETED_FLAG), Some(Out::Any(Any::Bool(true)))));
      assert!(row.get(&txn, "data").is_none());
      assert!(index.get(&txn, id).is_none());
    }
    assert!(index.get(&txn, "foreign").is_some());
    assert!(txn.get_map("foreign").unwrap().get(&txn, "data").is_some());
    let after = txn.encode_state_as_update_v1(&Default::default());
    assert!(
      remove_document_links(&after, owner, owner, &["deleted-key".into()])
        .unwrap()
        .update
        .is_empty()
    );
  }
}

/// Tombstone only document links to these keys in the qualified target workspace.
///
/// Scan canonical row maps, not just the visible/indexed projection: legacy
/// unindexed rows and indexed tombstones need the same cleanup. Foreign links
/// with a coincidentally identical external key are never removed. Trash does
/// not use this projection, so restore keeps the original placement.
pub fn remove_document_links(
  payload: &[u8],
  organizer_workspace_id: Uuid,
  target_workspace_id: Uuid,
  document_keys: &[String],
) -> Result<OrganizerDocumentLinkRemoval, OrganizerError> {
  let doc = Doc::new();
  if !payload.is_empty() {
    doc
      .transact_mut()
      .apply_update(Update::decode_v1(payload).map_err(|_| OrganizerError::Decode)?)
      .map_err(|_| OrganizerError::Decode)?;
  }
  let index = doc.get_or_insert_map(FOLDER_INDEX_MAP);
  let rows = {
    let txn = doc.transact();
    txn
      .root_refs()
      // Root types decoded from updates have no encoded Map type tag. Resolve
      // them through the named root accessor, as the Organizer ORM does.
      .filter_map(|(name, _)| {
        (name != FOLDER_INDEX_MAP)
          .then(|| txn.get_map(name).map(|map| (name.to_string(), map)))
          .flatten()
      })
      .collect::<Vec<_>>()
  };
  let mut selected = Vec::new();
  {
    let txn = doc.transact();
    for (root_id, row) in rows {
      let indexed_tombstone =
        matches!(row.get(&txn, DELETED_FLAG), Some(Out::Any(Any::Bool(true)))) && index.get(&txn, &root_id).is_some();
      let target_matches = map_optional_string(&row, &txn, "type").ok().flatten().as_deref() == Some("doc")
        && map_optional_string(&row, &txn, "data")
          .ok()
          .flatten()
          .is_some_and(|key| document_keys.contains(&key));
      if !target_matches && !indexed_tombstone {
        continue;
      }
      // A tombstone has no target fields; clearing its stale index is safe.
      if target_matches {
        let target = map_optional_string(&row, &txn, "targetWorkspaceId")
          .map_err(|_| OrganizerError::MalformedRow(root_id.clone()))?
          .map(|value| Uuid::parse_str(&value).map_err(|_| OrganizerError::MalformedRow(root_id.clone())))
          .transpose()?
          .unwrap_or(organizer_workspace_id);
        if target != target_workspace_id {
          continue;
        }
      }
      let entry_id = map_optional_string(&row, &txn, "id")
        .map_err(|_| OrganizerError::MalformedRow(root_id.clone()))?
        .unwrap_or_else(|| root_id.clone());
      selected.push((root_id, entry_id, row));
    }
  }
  if selected.is_empty() {
    return Ok(OrganizerDocumentLinkRemoval {
      update: Vec::new(),
      entry_ids: Vec::new(),
    });
  }
  let before = doc.transact().state_vector();
  {
    let mut txn = doc.transact_mut();
    index.insert(&mut txn, DELETED_FLAG, true);
    for (root_id, entry_id, row) in &selected {
      for field in ["id", "parentId", "data", "type", "index", "targetWorkspaceId"] {
        row.remove(&mut txn, field);
      }
      row.insert(&mut txn, DELETED_FLAG, true);
      index.remove(&mut txn, root_id);
      index.remove(&mut txn, entry_id);
    }
  }
  let update = doc.transact().encode_state_as_update_v1(&before);
  Ok(OrganizerDocumentLinkRemoval {
    update,
    entry_ids: selected.into_iter().map(|(_, id, _)| id).collect(),
  })
}
