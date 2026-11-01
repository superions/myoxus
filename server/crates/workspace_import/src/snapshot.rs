// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashSet;
use std::io::{Read, Write};

use serde_json::Value;
use std::fs::File;
use std::path::Path;
use zip::ZipArchive;

use crate::{
  DecodedDocument, DecodedDocumentContent, DecodedOmittedObjectCounts, DecodedWorkspace, WorkspaceImportDiagnostic,
  WorkspaceImportDiagnosticCode, WorkspaceImportFormat, WorkspaceImportLimits, validate_snapshot_archive_reader,
};

const MAX_SNAPSHOT_BLOCK_DEPTH: usize = 256;

pub(crate) fn decode_snapshot(
  path: &Path,
  limits: WorkspaceImportLimits,
) -> Result<DecodedWorkspace, WorkspaceImportDiagnostic> {
  let file = File::open(path).map_err(|_| {
    WorkspaceImportDiagnostic::blocking(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveInvalid,
      "workspace snapshot archive cannot be opened",
    )
  })?;
  let archive = ZipArchive::new(file)
    .map_err(|_| {
      WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveInvalid,
        "workspace snapshot archive is not a valid ZIP",
      )
    })
    .and_then(|archive| {
      validate_snapshot_archive_reader(archive, limits.archive()).map_err(|error| error.diagnostic())
    })?;
  decode_archive(archive, limits)
}

/// Decode an already validated archive through the same normalization as files.
pub(crate) fn decode_archive(
  archive: crate::SnapshotArchive,
  limits: WorkspaceImportLimits,
) -> Result<DecodedWorkspace, WorkspaceImportDiagnostic> {
  if archive.documents.len() > limits.max_documents {
    return Err(WorkspaceImportDiagnostic::blocking(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveLimit,
      "workspace snapshot exceeds the configured document limit",
    ));
  }
  if archive.assets.len() > limits.max_assets
    || archive.assets.iter().map(|asset| asset.size_bytes).sum::<u64>() > limits.max_asset_bytes
  {
    return Err(WorkspaceImportDiagnostic::blocking(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveLimit,
      "workspace snapshot exceeds the configured asset limit",
    ));
  }

  let mut source_ids = HashSet::new();
  let mut block_count = 0_usize;
  let mut documents = Vec::with_capacity(archive.documents.len());
  for document in archive.documents {
    if document.size_bytes > limits.max_document_bytes {
      return Err(WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
        "workspace document snapshot exceeds the global document byte limit",
      ));
    }
    let value = document.value;
    let meta = value.get("meta").and_then(Value::as_object).ok_or_else(|| {
      WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSnapshotInvalid,
        "workspace document snapshot is missing metadata",
      )
    })?;
    let source_id = required_string(meta.get("id"), "workspace document snapshot has no source identity")?;
    if !source_ids.insert(source_id.clone()) {
      return Err(WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSnapshotInvalid,
        "workspace snapshot contains duplicate document identities",
      ));
    }
    let blocks = value.get("blocks").ok_or_else(|| {
      WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
        "workspace document snapshot is missing its block collection",
      )
    })?;
    let blocks = normalize_snapshot_blocks(blocks)?;
    block_count = block_count.saturating_add(blocks.len());
    if block_count > limits.max_blocks {
      return Err(WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveLimit,
        "workspace snapshot exceeds the configured block limit",
      ));
    }
    documents.push(DecodedDocument {
      tags: serde_json::from_value(meta.get("tags").cloned().unwrap_or_else(|| serde_json::json!([])))
        .map_err(|_| invalid_snapshot_blocks("workspace document labels must be an ordered identity list"))?,
      source_id,
      title: optional_string(meta.get("title")).unwrap_or_else(|| "Untitled".to_string()),
      mode: optional_string(meta.get("mode")).unwrap_or_else(|| "page".to_string()),
      parent_source_id: optional_string(meta.get("parentId")),
      order: optional_string(meta.get("order")).unwrap_or_default(),
      created_at_ms: meta.get("createDate").and_then(Value::as_i64),
      is_trashed: meta
        .get("trash")
        .or_else(|| meta.get("isTrashed"))
        .and_then(Value::as_bool)
        .unwrap_or(false),
      content: DecodedDocumentContent::SnapshotBlocks(blocks),
    });
  }
  documents.sort_by(|left, right| {
    left
      .order
      .cmp(&right.order)
      .then_with(|| left.source_id.cmp(&right.source_id))
  });

  let title = archive
    .info
    .as_ref()
    .and_then(|info| info.get("name").or_else(|| info.get("title")))
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .unwrap_or("Imported workspace")
    .to_string();
  let omitted_counts = archive.info.as_ref().map(omitted_counts_from_info).unwrap_or_default();
  Ok(DecodedWorkspace {
    workspace_tags: archive.workspace_tags,
    format: WorkspaceImportFormat::SnapshotZip,
    title,
    documents,
    assets: archive.assets,
    directories: Vec::new(),
    omitted_counts,
    diagnostics: Vec::new(),
  })
}

fn normalize_snapshot_blocks(value: &Value) -> Result<Vec<yjs::PortableSnapshotBlock>, WorkspaceImportDiagnostic> {
  let mut blocks = Vec::new();
  let mut identities = HashSet::new();
  match value {
    Value::Array(values) => {
      for value in values {
        normalize_snapshot_block(value, None, 0, &mut identities, &mut blocks)?;
      }
    }
    Value::Object(_) if is_snapshot_block(value) => {
      normalize_snapshot_block(value, None, 0, &mut identities, &mut blocks)?;
    }
    Value::Object(values) => {
      for (identity, value) in values {
        normalize_snapshot_block(value, Some(identity), 0, &mut identities, &mut blocks)?;
      }
    }
    _ => {
      return Err(invalid_snapshot_blocks(
        "workspace document block collection must be an array or object",
      ));
    }
  }
  let known = blocks.iter().map(|block| block.id.as_str()).collect::<HashSet<_>>();
  if blocks
    .iter()
    .flat_map(|block| block.children.iter())
    .any(|child| !known.contains(child.as_str()))
  {
    return Err(invalid_snapshot_blocks(
      "workspace document block collection contains an unresolved child identity",
    ));
  }
  Ok(blocks)
}

fn is_snapshot_block(value: &Value) -> bool {
  value.as_object().is_some_and(|value| {
    value.get("type").and_then(Value::as_str) == Some("block")
      || value.contains_key("id")
      || value.contains_key("sys:id")
  })
}

fn normalize_snapshot_block(
  value: &Value,
  fallback_identity: Option<&String>,
  depth: usize,
  identities: &mut HashSet<String>,
  blocks: &mut Vec<yjs::PortableSnapshotBlock>,
) -> Result<String, WorkspaceImportDiagnostic> {
  if depth > MAX_SNAPSHOT_BLOCK_DEPTH {
    return Err(invalid_snapshot_blocks(
      "workspace document block tree exceeds the supported nesting depth",
    ));
  }
  let value = value
    .as_object()
    .ok_or_else(|| invalid_snapshot_blocks("workspace document block must be an object"))?;
  let identity = value
    .get("id")
    .or_else(|| value.get("sys:id"))
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string)
    .or_else(|| fallback_identity.cloned())
    .ok_or_else(|| invalid_snapshot_blocks("workspace document block has no identity"))?;
  if !identities.insert(identity.clone()) {
    return Err(invalid_snapshot_blocks(
      "workspace document block collection contains duplicate identities",
    ));
  }
  let flavour = value
    .get("flavour")
    .or_else(|| value.get("sys:flavour"))
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string)
    .ok_or_else(|| invalid_snapshot_blocks("workspace document block has no flavour"))?;
  let version = value
    .get("version")
    .or_else(|| value.get("sys:version"))
    .map(|version| {
      version
        .as_u64()
        .ok_or_else(|| invalid_snapshot_blocks("workspace document block version must be an unsigned integer"))
    })
    .transpose()?;
  let mut props = value
    .get("props")
    .map(|props| {
      props
        .as_object()
        .cloned()
        .ok_or_else(|| invalid_snapshot_blocks("workspace document block props must be an object"))
    })
    .transpose()?
    .unwrap_or_default();
  for (key, prop) in value {
    if let Some(key) = key.strip_prefix("prop:") {
      props.entry(key.to_string()).or_insert_with(|| prop.clone());
    }
  }
  let child_values = value
    .get("children")
    .or_else(|| value.get("sys:children"))
    .map(|children| {
      children
        .as_array()
        .ok_or_else(|| invalid_snapshot_blocks("workspace document block children must be an array"))
    })
    .transpose()?
    .cloned()
    .unwrap_or_default();
  let mut children = Vec::with_capacity(child_values.len());
  for child in child_values {
    let child_identity = if let Some(identity) = child.as_str() {
      identity.trim().to_string()
    } else {
      normalize_snapshot_block(&child, None, depth + 1, identities, blocks)?
    };
    if child_identity.is_empty() {
      return Err(invalid_snapshot_blocks(
        "workspace document block contains an empty child identity",
      ));
    }
    children.push(child_identity);
  }
  blocks.push(yjs::PortableSnapshotBlock {
    id: identity.clone(),
    flavour,
    version,
    props,
    children,
  });
  Ok(identity)
}

fn invalid_snapshot_blocks(message: &str) -> WorkspaceImportDiagnostic {
  WorkspaceImportDiagnostic::blocking(
    WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
    message,
  )
}

fn omitted_counts_from_info(info: &Value) -> DecodedOmittedObjectCounts {
  let count = |keys: &[&str]| {
    keys
      .iter()
      .filter_map(|key| info.get(*key))
      .map(|value| match value {
        Value::Array(values) => values.len(),
        Value::Object(values) => values.len(),
        Value::Null => 0,
        _ => 1,
      })
      .sum()
  };
  DecodedOmittedObjectCounts {
    memberships: count(&["members", "memberships"]),
    sessions: count(&["sessions"]),
    sharing_and_publications: count(&["sharing", "shares", "publications"]),
    comments: count(&["comments"]),
    activity_and_history: count(&["activity", "history"]),
    external_integrations_and_credentials: count(&["integrations", "credentials"]),
    excluded_entries: 0,
  }
}

fn required_string(value: Option<&Value>, message: &str) -> Result<String, WorkspaceImportDiagnostic> {
  optional_string(value).ok_or_else(|| {
    WorkspaceImportDiagnostic::blocking(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportSnapshotInvalid,
      message,
    )
  })
}

fn optional_string(value: Option<&Value>) -> Option<String> {
  value
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string)
}

pub(crate) fn copy_asset_to<W: Write>(
  path: &Path,
  source_key: &str,
  writer: &mut W,
  limits: WorkspaceImportLimits,
) -> Result<u64, WorkspaceImportDiagnostic> {
  let file = File::open(path).map_err(|_| {
    WorkspaceImportDiagnostic::blocking(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveInvalid,
      "workspace snapshot archive cannot be opened",
    )
  })?;
  let mut archive = ZipArchive::new(file).map_err(|_| {
    WorkspaceImportDiagnostic::blocking(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveInvalid,
      "workspace snapshot archive is not a valid ZIP",
    )
  })?;
  for index in 0..archive.len() {
    let mut entry = archive.by_index(index).map_err(|_| {
      WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveInvalid,
        "workspace snapshot asset entry cannot be opened",
      )
    })?;
    let name = entry.name().map_err(|_| {
      WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveInvalid,
        "workspace snapshot asset entry name cannot be decoded",
      )
    })?;
    if crate::archive::normalize_asset_key(&name).as_deref() != Some(source_key) {
      continue;
    }
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
      let read = entry.read(&mut buffer).map_err(|_| {
        WorkspaceImportDiagnostic::blocking(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveInvalid,
          "workspace snapshot asset cannot be read",
        )
      })?;
      if read == 0 {
        return Ok(total);
      }
      total = total.saturating_add(read as u64);
      if total > limits.max_entry_bytes || total > limits.max_asset_bytes {
        return Err(WorkspaceImportDiagnostic::blocking(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportArchiveLimit,
          "workspace snapshot asset exceeds the configured byte limit",
        ));
      }
      writer.write_all(&buffer[..read]).map_err(|_| {
        WorkspaceImportDiagnostic::blocking(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportAssetMissing,
          "workspace snapshot asset cannot be materialized",
        )
      })?;
    }
  }
  Err(WorkspaceImportDiagnostic::blocking(
    WorkspaceImportDiagnosticCode::MixWorkspaceImportAssetMissing,
    "workspace snapshot asset is missing",
  ))
}
