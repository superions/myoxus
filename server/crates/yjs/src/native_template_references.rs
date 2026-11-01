// SPDX-License-Identifier: AGPL-3.0-or-later
//! Optional native template slots bind only server-authorized identities.
use std::collections::BTreeSet;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::{Any, Array, Doc, Map, Out, ReadTxn, Transact};

#[derive(Debug, Clone)]
pub struct NativeTemplateReferenceTargets {
  pub workspace_id: Uuid,
  pub database_id: Uuid,
  pub task_id: Option<Uuid>,
}
fn decode(snapshot: &[u8]) -> Result<Doc, String> {
  let doc = Doc::new();
  doc
    .transact_mut()
    .apply_update(yrs::Update::decode_v1(snapshot).map_err(|_| "invalid template references")?)
    .map_err(|_| "invalid template references")?;
  Ok(doc)
}
fn slots(doc: &Doc) -> Result<Vec<(String, String)>, String> {
  let blocks = doc.get_or_insert_map("blocks");
  let txn = doc.transact();
  let mut result = Vec::new();
  let mut keys = BTreeSet::new();
  for (id, value) in blocks.iter(&txn) {
    let Out::YMap(block) = value else { continue };
    let Some(marker) = block.get(&txn, "prop:templateReference") else {
      continue;
    };
    let Out::Any(Any::Map(marker)) = marker else {
      return Err("invalid native reference marker".into());
    };
    let text = |key: &str| match marker.get(key) {
      Some(Any::String(value)) => Some(value.as_ref()),
      _ => None,
    };
    let key = text("key").ok_or("native reference key missing")?;
    let kind = match key {
      "context.container" => "database",
      "context.task" => "task",
      _ => return Err("unsupported native reference key".into()),
    };
    if marker.len() != 3
      || text("kind") != Some(kind)
      || marker.get("optional") != Some(&Any::Bool(true))
      || !keys.insert(key.to_string())
    {
      return Err("invalid or repeated native reference slot".into());
    }
    if block
      .get(&txn, "sys:flavour")
      .map(|value| value.to_string(&txn))
      .as_deref()
      != Some("myoxus:database")
      || block
        .get(&txn, "prop:serverReferencePresentation")
        .map(|value| value.to_string(&txn))
        .as_deref()
        != Some("compact")
      || block.iter(&txn).any(|(key, _)| {
        !matches!(
          key,
          "sys:id"
            | "sys:flavour"
            | "sys:version"
            | "sys:children"
            | "prop:templateReference"
            | "prop:serverReferencePresentation"
        )
      })
      || !matches!(block.get(&txn,"sys:children"),Some(Out::YArray(children)) if children.len(&txn)==0)
    {
      return Err("native reference slot must be an empty compact Database block".into());
    }
    let parents = blocks
      .iter(&txn)
      .filter_map(|(_, value)| {
        let Out::YMap(parent) = value else { return None };
        let Some(Out::YArray(children)) = parent.get(&txn, "sys:children") else {
          return None;
        };
        children
          .iter(&txn)
          .any(|child| child.to_string(&txn) == id)
          .then_some(parent)
      })
      .collect::<Vec<_>>();
    if parents.len() != 1
      || parents[0]
        .get(&txn, "sys:flavour")
        .map(|value| value.to_string(&txn))
        .as_deref()
        != Some("myoxus:note")
    {
      return Err("native reference slot requires one Note parent".into());
    }
    result.push((id.to_string(), key.to_string()));
  }
  Ok(result)
}
/// Admission and inspection preserve slots until one final native instantiation.
pub fn inspect_native_template_references(snapshot: &[u8]) -> Result<Vec<String>, String> {
  Ok(slots(&decode(snapshot)?)?.into_iter().map(|(_, key)| key).collect())
}
/// Ordinary Library copies remove optional unbound slots through the same native
/// subtree mutation used by editing; contextual copies receive no caller UUIDs.
pub fn bind_native_template_references(
  snapshot: &[u8],
  targets: Option<&NativeTemplateReferenceTargets>,
) -> Result<Vec<u8>, String> {
  let doc = decode(snapshot)?;
  let slots = slots(&doc)?;
  let blocks = doc.get_or_insert_map("blocks");
  let mut remove = Vec::new();
  {
    let mut txn = doc.transact_mut();
    for (id, key) in slots {
      let Some(target) = targets.filter(|target| key == "context.container" || target.task_id.is_some()) else {
        remove.push(id);
        continue;
      };
      if target.workspace_id.is_nil() || target.database_id.is_nil() || target.task_id.is_some_and(|id| id.is_nil()) {
        return Err("invalid authorized reference identity".into());
      }
      let Some(Out::YMap(block)) = blocks.get(&txn, &id) else {
        return Err("native reference disappeared".into());
      };
      block.remove(&mut txn, "prop:templateReference");
      block.insert(&mut txn, "prop:serverWorkspaceId", target.workspace_id.to_string());
      block.insert(&mut txn, "prop:serverDatabaseId", target.database_id.to_string());
      if key == "context.task" {
        block.insert(
          &mut txn,
          "prop:serverRowId",
          target.task_id.ok_or("Task reference missing")?.to_string(),
        );
      }
    }
  }
  let mut result = doc.transact().encode_state_as_update_v1(&yrs::StateVector::default());
  for id in remove {
    result = crate::document_mutation::apply_document_mutation(
      &result,
      &crate::document_mutation::DocumentMutation::DeleteBlock { block_id: id },
    )
    .map_err(|_| "cannot remove optional native reference")?
    .state;
  }
  Ok(result)
}
