// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::{DecodedDocument, DecodedDocumentContent, WorkspaceImportDiagnostic, WorkspaceImportDiagnosticCode};

pub fn extract_database_blocks(
  document: &DecodedDocument,
) -> Result<Vec<yjs::LegacyDatabaseBlock>, WorkspaceImportDiagnostic> {
  match &document.content {
    DecodedDocumentContent::YjsV1(update) => yjs::extract_legacy_database_blocks(update).map_err(|_| {
      WorkspaceImportDiagnostic::blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
        "workspace document contains an unreadable Yjs Database payload",
      )
    }),
    DecodedDocumentContent::SnapshotBlocks(blocks) => extract_snapshot_database_blocks(blocks),
    DecodedDocumentContent::MarkdownUtf8(_) => Ok(Vec::new()),
  }
}

fn extract_snapshot_database_blocks(
  blocks: &[yjs::PortableSnapshotBlock],
) -> Result<Vec<yjs::LegacyDatabaseBlock>, WorkspaceImportDiagnostic> {
  let index = blocks
    .iter()
    .map(|block| (block.id.as_str(), block))
    .collect::<HashMap<_, _>>();

  let mut databases = Vec::new();
  for block in blocks {
    if yjs::resolve_flavour(&block.flavour) != "myoxus:database" {
      continue;
    }
    // Scoped Row blocks are references, including unavailable/malformed tuples;
    // importing them must never synthesize an editor-local Database or Task.
    if block_prop(block, "serverRowId").is_some() {
      continue;
    }
    let rows = block
      .children
      .iter()
      .map(|source_id| {
        let row = index.get(source_id.as_str()).ok_or_else(invalid_database_payload)?;
        Ok(yjs::LegacyDatabaseRow {
          source_id: source_id.to_string(),
          title: string_block_prop(row, "text")
            .or_else(|| string_block_prop(row, "title"))
            .unwrap_or_default(),
        })
      })
      .collect::<Result<Vec<_>, WorkspaceImportDiagnostic>>()?;
    databases.push(yjs::LegacyDatabaseBlock {
      block_id: block.id.clone(),
      source_database_id: string_block_prop(block, "databaseId"),
      title: string_block_prop(block, "title").unwrap_or_default(),
      columns: block_prop(block, "columns")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new())),
      views: block_prop(block, "views")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new())),
      cells: block_prop(block, "cells")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new())),
      rows,
      server_database_id: string_block_prop(block, "serverDatabaseId"),
      server_view_id: string_block_prop(block, "serverViewId"),
    });
  }
  databases.sort_by(|left, right| left.block_id.cmp(&right.block_id));
  Ok(databases)
}

fn block_prop<'a>(block: &'a yjs::PortableSnapshotBlock, key: &str) -> Option<&'a Value> {
  block.props.get(key)
}

fn string_block_prop(block: &yjs::PortableSnapshotBlock, key: &str) -> Option<String> {
  block_prop(block, key)
    .and_then(|value| yjs::snapshot_rich_text_plain_text(value).ok())
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
}

fn invalid_database_payload() -> WorkspaceImportDiagnostic {
  WorkspaceImportDiagnostic::blocking(
    WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
    "workspace document contains an invalid block collection",
  )
}
