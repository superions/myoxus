// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Export-only reference inventory over the existing complete native Snapshot.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone)]
pub enum ReferenceTarget {
  Document {
    workspace: Uuid,
    key: String,
    params: Option<Value>,
  },
  Database {
    workspace: Uuid,
    id: Uuid,
    row: Option<Uuid>,
  },
}

#[derive(Clone)]
pub struct NativeReference {
  pub target: Option<ReferenceTarget>,
  pub alias: Option<String>,
}

#[derive(Clone)]
pub struct ReadableReference {
  pub label: String,
  pub url: String,
}

pub fn inline_reference_key(reference: &yjs::MarkdownDocumentReference, workspace: Option<&Value>) -> String {
  // Navigation is part of the occurrence: two links to one Page may select
  // different blocks/Database rows. Authored aliases do not change authority.
  serde_json::to_string(&(workspace, &reference.page_id, &reference.params)).expect("JSON reference coordinates")
}

/// Values are admitted by the transport's existing resource access owners.
/// Missing values never authorize cached native titles or raw resource keys.
#[derive(Default)]
pub struct ExportReferencePresentation {
  pub documents: BTreeMap<String, ReadableReference>,
  pub blocks: BTreeMap<String, ReadableReference>,
  pub unavailable_blocks: BTreeSet<String>,
  pub mentions: BTreeMap<String, String>,
  pub fallbacks: BTreeMap<String, super::ReadableFallback>,
}

pub(super) fn native_content_blocks(snapshot: &Value) -> Vec<&Value> {
  let mut result = Vec::new();
  // document_to_snapshot returns flat PortableSnapshotBlocks with child IDs,
  // unlike the client Snapshot archive's recursively embedded block objects.
  let blocks = snapshot["blocks"]
    .as_array()
    .into_iter()
    .flatten()
    .filter_map(|block| Some((block["id"].as_str()?, block)))
    .collect::<BTreeMap<_, _>>();
  let mut pending = blocks
    .values()
    .filter(|block| block["flavour"] == "myoxus:page")
    .copied()
    .collect::<Vec<_>>();
  while let Some(block) = pending.pop() {
    result.push(block);
    if matches!(
      block["flavour"].as_str(),
      Some("myoxus:database" | "myoxus:embed-linked-doc" | "myoxus:embed-synced-doc" | "myoxus:surface-ref")
    ) {
      continue;
    }
    if let Some(children) = block["children"].as_array() {
      pending.extend(children.iter().filter_map(|child| blocks.get(child.as_str()?).copied()));
    }
  }
  result
}

pub fn block_reference_inventory(snapshot: &Value, workspace: Uuid) -> BTreeMap<String, NativeReference> {
  let mut result = BTreeMap::new();
  for block in native_content_blocks(snapshot) {
    let props = &block["props"];
    let flavour = block["flavour"].as_str().unwrap_or_default();
    if matches!(
      flavour,
      "myoxus:embed-linked-doc" | "myoxus:embed-synced-doc" | "myoxus:surface-ref" | "myoxus:database"
    ) {
      let target_workspace = match props.get("serverWorkspaceId").or_else(|| props.get("workspaceId")) {
        None => Some(workspace),
        Some(value) => value.as_str().and_then(|value| Uuid::parse_str(value).ok()),
      };
      let target = target_workspace.and_then(|workspace| {
        if flavour == "myoxus:database" {
          let row = match props.get("rowId").or_else(|| props.get("serverRowId")) {
            None => None,
            Some(value) => Some(Uuid::parse_str(value.as_str()?).ok()?),
          };
          Some(ReferenceTarget::Database {
            workspace,
            id: Uuid::parse_str(
              props
                .get("databaseId")
                .or_else(|| props.get("serverDatabaseId"))?
                .as_str()?,
            )
            .ok()?,
            row,
          })
        } else {
          Some(ReferenceTarget::Document {
            workspace,
            key: props["pageId"].as_str()?.to_string(),
            params: props.get("params").cloned(),
          })
        }
      });
      let alias = ["title", "caption", "label"].iter().find_map(|key| {
        let value = props.get(key)?;
        let text = value
          .as_str()
          .map(str::to_string)
          .or_else(|| yjs::snapshot_rich_text_plain_text(value).ok())?;
        (!text.trim().is_empty()).then_some(text)
      });
      if let Some(id) = block["id"].as_str() {
        result.insert(id.to_string(), NativeReference { target, alias });
      }
      // Referenced Database bodies and document embeds are opaque. Never walk
      // stale cached descendants or recursively load their target content.
      continue;
    }
  }
  result
}
