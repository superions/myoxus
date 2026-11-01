// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};
use std::path::Path;

use rusqlite::{Connection, DatabaseName, OpenFlags, OptionalExtension};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{
  DecodedAsset, DecodedDocument, DecodedDocumentContent, DecodedOmittedObjectCounts, DecodedWorkspace,
  WorkspaceImportDiagnostic, WorkspaceImportDiagnosticCode, WorkspaceImportFormat, WorkspaceImportLimits,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyWorkspaceMetadata {
  #[serde(default)]
  workspace_tags: Vec<crate::DecodedWorkspaceTag>,
  #[serde(default = "default_workspace_title")]
  title: String,
  #[serde(default)]
  documents: Vec<LegacyDocumentMetadata>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDocumentMetadata {
  #[serde(default)]
  tags: Vec<String>,
  id: String,
  #[serde(default = "default_document_title")]
  title: String,
  #[serde(default)]
  parent_id: Option<String>,
  #[serde(default)]
  order: String,
  #[serde(default = "default_document_mode")]
  mode: String,
  #[serde(default, alias = "trash")]
  is_trashed: bool,
}

fn default_workspace_title() -> String {
  "Imported workspace".to_string()
}

fn default_document_title() -> String {
  "Untitled".to_string()
}

fn default_document_mode() -> String {
  "page".to_string()
}

fn diagnostic(code: WorkspaceImportDiagnosticCode, message: impl Into<String>) -> WorkspaceImportDiagnostic {
  WorkspaceImportDiagnostic::blocking(code, message)
}

fn open_read_only(path: &Path) -> Result<Connection, WorkspaceImportDiagnostic> {
  let canonical = path.canonicalize().map_err(|_| {
    diagnostic(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
      "workspace SQLite source cannot be resolved",
    )
  })?;
  let mut uri = url::Url::from_file_path(canonical)
    .map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace SQLite source path is invalid",
      )
    })?
    .to_string();
  uri.push_str("?mode=ro&immutable=1");
  let connection = Connection::open_with_flags(
    uri,
    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
  )
  .map_err(|_| {
    diagnostic(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
      "workspace SQLite source cannot be opened read-only",
    )
  })?;
  connection
    .execute_batch("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;")
    .map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace SQLite safety policy cannot be enabled",
      )
    })?;
  Ok(connection)
}

fn table_names(connection: &Connection) -> Result<HashSet<String>, WorkspaceImportDiagnostic> {
  let mut statement = connection
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace SQLite schema cannot be inspected",
      )
    })?;
  let names = statement
    .query_map([], |row| row.get::<_, String>(0))
    .map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace SQLite schema cannot be inspected",
      )
    })?
    .collect::<Result<HashSet<_>, _>>()
    .map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace SQLite schema contains an invalid table name",
      )
    })?;
  Ok(names)
}

fn table_columns(connection: &Connection, table: &str) -> Result<HashSet<String>, WorkspaceImportDiagnostic> {
  let sql = match table {
    "updates" => "PRAGMA table_info('updates')",
    "snapshots" => "PRAGMA table_info('snapshots')",
    "blobs" => "PRAGMA table_info('blobs')",
    "meta" => "PRAGMA table_info('meta')",
    "sync_metadata" => "PRAGMA table_info('sync_metadata')",
    _ => {
      return Err(diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteSchemaUnsupported,
        "workspace SQLite schema contains an unsupported source table",
      ));
    }
  };
  let mut statement = connection.prepare(sql).map_err(|_| {
    diagnostic(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteSchemaUnsupported,
      "workspace SQLite source table cannot be inspected",
    )
  })?;
  statement
    .query_map([], |row| row.get::<_, String>(1))
    .map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteSchemaUnsupported,
        "workspace SQLite source columns cannot be inspected",
      )
    })?
    .collect::<Result<HashSet<_>, _>>()
    .map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteSchemaUnsupported,
        "workspace SQLite source contains an invalid column",
      )
    })
}

fn has_columns(connection: &Connection, table: &str, expected: &[&str]) -> Result<bool, WorkspaceImportDiagnostic> {
  let columns = table_columns(connection, table)?;
  Ok(expected.iter().all(|column| columns.contains(*column)))
}

pub(crate) fn detect_sqlite_layout(path: &Path) -> Result<WorkspaceImportFormat, WorkspaceImportDiagnostic> {
  let connection = open_read_only(path)?;
  let tables = table_names(&connection)?;
  if ["meta", "snapshots", "updates", "blobs"]
    .iter()
    .all(|table| tables.contains(*table))
    && has_columns(&connection, "snapshots", &["doc_id", "data"])?
    && has_columns(&connection, "updates", &["doc_id", "data"])?
    && has_columns(&connection, "blobs", &["key", "data", "size"])?
  {
    return Ok(WorkspaceImportFormat::SqliteDocStorage);
  }
  if ["updates", "blobs", "version_info", "server_clock", "sync_metadata"]
    .iter()
    .all(|table| tables.contains(*table))
    && has_columns(&connection, "updates", &["data", "doc_id"])?
    && has_columns(&connection, "blobs", &["key", "data"])?
    && has_columns(&connection, "sync_metadata", &["key", "data"])?
  {
    return Ok(WorkspaceImportFormat::SqliteV1);
  }
  Err(diagnostic(
    WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteSchemaUnsupported,
    "workspace SQLite schema is not an allowlisted Myoxus layout",
  ))
}

pub(crate) fn decode_sqlite(
  path: &Path,
  limits: WorkspaceImportLimits,
) -> Result<DecodedWorkspace, WorkspaceImportDiagnostic> {
  let format = detect_sqlite_layout(path)?;
  let connection = open_read_only(path)?;
  let mut updates = match format {
    WorkspaceImportFormat::SqliteV1 => read_v1_updates(&connection)?,
    WorkspaceImportFormat::SqliteDocStorage => read_doc_storage_updates(&connection)?,
    WorkspaceImportFormat::SnapshotZip | WorkspaceImportFormat::ObsidianZip => {
      unreachable!("SQLite decoder received ZIP format")
    }
  };
  let metadata = match format {
    WorkspaceImportFormat::SqliteV1 => read_legacy_metadata(&connection, limits)?,
    WorkspaceImportFormat::SqliteDocStorage => read_doc_storage_metadata(&connection, &mut updates, limits)?,
    WorkspaceImportFormat::SnapshotZip | WorkspaceImportFormat::ObsidianZip => {
      unreachable!("SQLite decoder received ZIP format")
    }
  };
  if updates.len() > limits.max_documents {
    return Err(diagnostic(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportUploadLimit,
      "workspace SQLite source exceeds the configured document limit",
    ));
  }

  let metadata_by_id = metadata
    .as_ref()
    .map(|metadata| {
      metadata
        .documents
        .iter()
        .map(|document| (document.id.as_str(), document))
        .collect::<HashMap<_, _>>()
    })
    .unwrap_or_default();
  if let Some(metadata) = &metadata
    && metadata
      .documents
      .iter()
      .any(|document| !updates.contains_key(&document.id))
  {
    return Err(diagnostic(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
      "workspace SQLite metadata references a document without Yjs content",
    ));
  }
  let mut block_count = 0_usize;
  let mut documents = Vec::with_capacity(updates.len());
  for (source_id, document_updates) in updates {
    let source_bytes = document_updates
      .iter()
      .try_fold(0_u64, |total, update| total.checked_add(update.len() as u64))
      .ok_or_else(|| {
        diagnostic(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportUploadLimit,
          "workspace SQLite document byte count overflowed",
        )
      })?;
    if source_bytes > limits.max_document_bytes {
      return Err(diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
        "workspace SQLite document exceeds the global document byte limit",
      ));
    }
    // Current native caches also carry reserved organizer/user helper docs.
    // They are not user documents and must not become empty imported pages.
    // Keep the existing byte/count limits above; a page claiming a reserved
    // identity is invalid rather than silently dropped.
    if format == WorkspaceImportFormat::SqliteDocStorage
      && (source_id.starts_with("db$") || source_id.starts_with("userdata$"))
    {
      if metadata_by_id.contains_key(source_id.as_str()) {
        return Err(diagnostic(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
          "workspace page references a reserved helper document identity",
        ));
      }
      continue;
    }
    let source_id = if source_id.is_empty() {
      "workspace-root".to_string()
    } else {
      source_id
    };
    let update = yjs::merge_updates(document_updates).map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
        "workspace SQLite source contains an invalid Yjs document",
      )
    })?;
    if update.len() as u64 > limits.max_document_bytes {
      return Err(diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
        "workspace SQLite merged document exceeds the global document byte limit",
      ));
    }
    let extracted = yjs::extract_blocks_from_yjs(&update).map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
        "workspace SQLite source contains an unreadable Yjs document",
      )
    })?;
    if extracted.extraction_partial {
      return Err(diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
        "workspace SQLite source contains unsupported partial Yjs block state",
      ));
    }
    block_count = block_count.saturating_add(extracted.blocks.len());
    if block_count > limits.max_blocks {
      return Err(diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportUploadLimit,
        "workspace SQLite source exceeds the configured block limit",
      ));
    }
    let source_metadata = metadata_by_id.get(source_id.as_str()).copied();
    let extracted_title = yjs::extract_structural_document_title(&update)
      .ok()
      .flatten()
      .filter(|title| !title.trim().is_empty());
    documents.push(DecodedDocument {
      source_id,
      title: source_metadata
        .map(|value| value.title.clone())
        .or(extracted_title)
        .unwrap_or_else(default_document_title),
      mode: source_metadata
        .map(|value| value.mode.clone())
        .unwrap_or_else(default_document_mode),
      parent_source_id: source_metadata.and_then(|value| value.parent_id.clone()),
      order: source_metadata.map(|value| value.order.clone()).unwrap_or_default(),
      created_at_ms: None,
      is_trashed: source_metadata.is_some_and(|value| value.is_trashed),
      tags: source_metadata.map(|value| value.tags.clone()).unwrap_or_default(),
      content: DecodedDocumentContent::YjsV1(update),
    });
  }
  documents.sort_by(|left, right| {
    left
      .order
      .cmp(&right.order)
      .then_with(|| left.source_id.cmp(&right.source_id))
  });
  let assets = read_assets(&connection, format, limits)?;
  validate_asset_references(&documents, &assets)?;
  Ok(DecodedWorkspace {
    format,
    workspace_tags: metadata
      .as_ref()
      .map(|value| value.workspace_tags.clone())
      .unwrap_or_default(),
    title: metadata
      .map(|metadata| metadata.title)
      .unwrap_or_else(default_workspace_title),
    documents,
    assets,
    directories: Vec::new(),
    omitted_counts: DecodedOmittedObjectCounts::default(),
    diagnostics: Vec::new(),
  })
}

fn validate_asset_references(
  documents: &[DecodedDocument],
  assets: &[DecodedAsset],
) -> Result<(), WorkspaceImportDiagnostic> {
  let aliases = assets
    .iter()
    .flat_map(|asset| crate::archive::asset_aliases(&asset.source_key))
    .collect::<HashSet<_>>();
  for document in documents {
    let DecodedDocumentContent::YjsV1(update) = &document.content else {
      continue;
    };
    let references = yjs::extract_portable_asset_references(update).map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
        "workspace SQLite document asset references cannot be read",
      )
    })?;
    if references.iter().any(|reference| {
      !crate::archive::asset_aliases(&reference.source_key)
        .iter()
        .any(|candidate| aliases.contains(candidate))
    }) {
      return Err(diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportAssetMissing,
        "workspace SQLite document references a missing declared asset",
      ));
    }
  }
  Ok(())
}

fn read_doc_storage_metadata(
  connection: &Connection,
  updates: &mut BTreeMap<String, Vec<Vec<u8>>>,
  limits: WorkspaceImportLimits,
) -> Result<Option<LegacyWorkspaceMetadata>, WorkspaceImportDiagnostic> {
  let space_id = connection
    .query_row("SELECT space_id FROM meta LIMIT 1", [], |row| row.get::<_, String>(0))
    .optional()
    .map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace SQLite root identity cannot be read",
      )
    })?;
  let Some(space_id) = space_id else {
    return Ok(None);
  };
  let Some(root_updates) = updates.remove(&space_id) else {
    return Ok(None);
  };
  if root_updates
    .iter()
    .fold(0_u64, |size, update| size.saturating_add(update.len() as u64))
    > limits.max_document_bytes
  {
    return Err(diagnostic(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
      "workspace root metadata exceeds the document byte limit",
    ));
  }
  let root_update = yjs::merge_updates(root_updates).map_err(|_| {
    diagnostic(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
      "workspace SQLite root document is invalid",
    )
  })?;
  let root = yjs::extract_workspace_root_metadata(&root_update).map_err(|_| {
    diagnostic(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
      "workspace SQLite root metadata is unreadable",
    )
  })?;
  Ok(Some(LegacyWorkspaceMetadata {
    workspace_tags: serde_json::from_value(root.workspace_tags).map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
        "workspace label catalog is invalid",
      )
    })?,
    title: root.name.unwrap_or_else(default_workspace_title),
    documents: root
      .pages
      .into_iter()
      .map(|page| {
        Ok(LegacyDocumentMetadata {
          tags: serde_json::from_value(page.tags).map_err(|_| {
            diagnostic(
              WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
              "workspace label assignments are invalid",
            )
          })?,
          id: page.id,
          title: page.title.unwrap_or_else(default_document_title),
          parent_id: None,
          order: format!("{:020}", page.order),
          mode: default_document_mode(),
          is_trashed: page.is_trashed,
        })
      })
      .collect::<Result<Vec<_>, WorkspaceImportDiagnostic>>()?,
  }))
}

fn read_legacy_metadata(
  connection: &Connection,
  limits: WorkspaceImportLimits,
) -> Result<Option<LegacyWorkspaceMetadata>, WorkspaceImportDiagnostic> {
  let size = connection
    .query_row(
      "SELECT length(data) FROM sync_metadata WHERE key = 'workspace:meta' LIMIT 1",
      [],
      |row| row.get::<_, u64>(0),
    )
    .optional()
    .map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace metadata size cannot be read",
      )
    })?;
  if size.is_some_and(|size| size > limits.max_document_bytes) {
    return Err(diagnostic(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
      "workspace metadata exceeds the document byte limit",
    ));
  }
  let payload = connection
    .query_row(
      "SELECT data FROM sync_metadata WHERE key = 'workspace:meta' LIMIT 1",
      [],
      |row| row.get::<_, Vec<u8>>(0),
    )
    .optional()
    .map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace SQLite metadata cannot be read",
      )
    })?;
  payload
    .map(|payload| {
      serde_json::from_slice(&payload).map_err(|_| {
        diagnostic(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
          "workspace SQLite metadata is invalid",
        )
      })
    })
    .transpose()
}

fn read_v1_updates(connection: &Connection) -> Result<BTreeMap<String, Vec<Vec<u8>>>, WorkspaceImportDiagnostic> {
  read_updates(
    connection,
    "SELECT COALESCE(doc_id, ''), data FROM updates ORDER BY COALESCE(doc_id, ''), id",
  )
}

fn read_doc_storage_updates(
  connection: &Connection,
) -> Result<BTreeMap<String, Vec<Vec<u8>>>, WorkspaceImportDiagnostic> {
  let mut updates = read_updates(connection, "SELECT doc_id, data FROM snapshots ORDER BY doc_id")?;
  for (doc_id, values) in read_updates(
    connection,
    "SELECT doc_id, data FROM updates ORDER BY doc_id, created_at, rowid",
  )? {
    updates.entry(doc_id).or_default().extend(values);
  }
  Ok(updates)
}

fn read_updates(
  connection: &Connection,
  sql: &'static str,
) -> Result<BTreeMap<String, Vec<Vec<u8>>>, WorkspaceImportDiagnostic> {
  let mut statement = connection.prepare(sql).map_err(|_| {
    diagnostic(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
      "workspace SQLite document records cannot be read",
    )
  })?;
  let rows = statement
    .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)))
    .map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace SQLite document records cannot be read",
      )
    })?;
  let mut updates = BTreeMap::<String, Vec<Vec<u8>>>::new();
  for row in rows {
    let (doc_id, payload) = row.map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace SQLite document record is invalid",
      )
    })?;
    updates.entry(doc_id).or_default().push(payload);
  }
  Ok(updates)
}

fn read_assets(
  connection: &Connection,
  format: WorkspaceImportFormat,
  limits: WorkspaceImportLimits,
) -> Result<Vec<DecodedAsset>, WorkspaceImportDiagnostic> {
  let sql = if format == WorkspaceImportFormat::SqliteDocStorage {
    "SELECT rowid, key, length(data) FROM blobs WHERE deleted_at IS NULL ORDER BY key"
  } else {
    "SELECT rowid, key, length(data) FROM blobs ORDER BY key"
  };
  let mut statement = connection.prepare(sql).map_err(|_| {
    diagnostic(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
      "workspace SQLite asset records cannot be read",
    )
  })?;
  let rows = statement
    .query_map([], |row| {
      Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, u64>(2)?))
    })
    .map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace SQLite asset records cannot be read",
      )
    })?;
  let mut asset_rows = Vec::new();
  let mut total_bytes = 0_u64;
  for row in rows {
    let row = row.map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace SQLite asset record is invalid",
      )
    })?;
    total_bytes = total_bytes.saturating_add(row.2);
    asset_rows.push(row);
  }
  drop(statement);
  if asset_rows.len() > limits.max_assets || total_bytes > limits.max_asset_bytes {
    return Err(diagnostic(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportUploadLimit,
      "workspace SQLite source exceeds the configured asset limit",
    ));
  }

  let mut assets = BTreeMap::<String, DecodedAsset>::new();
  for (row_id, source_key, size_bytes) in asset_rows {
    let mut blob = connection
      .blob_open(DatabaseName::Main, "blobs", "data", row_id, true)
      .map_err(|_| {
        diagnostic(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
          "workspace SQLite asset payload cannot be inspected",
        )
      })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
      let read = blob.read(&mut buffer).map_err(|_| {
        diagnostic(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
          "workspace SQLite asset payload cannot be inspected",
        )
      })?;
      if read == 0 {
        break;
      }
      hasher.update(&buffer[..read]);
    }
    let source_key = canonical_asset_key(&source_key)?;
    let content_hash = format!("{:x}", hasher.finalize());
    if let Some(existing) = assets.get(&source_key) {
      if existing.content_hash != content_hash {
        return Err(diagnostic(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
          "workspace SQLite source contains conflicting asset aliases",
        ));
      }
      continue;
    }
    assets.insert(
      source_key.clone(),
      DecodedAsset {
        source_key,
        size_bytes,
        content_hash,
      },
    );
  }
  Ok(assets.into_values().collect())
}

fn canonical_asset_key(value: &str) -> Result<String, WorkspaceImportDiagnostic> {
  let value = value.trim().trim_start_matches('/');
  if value.is_empty()
    || value.contains('\\')
    || value
      .split('/')
      .any(|segment| segment.is_empty() || segment == "." || segment == "..")
  {
    return Err(diagnostic(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
      "workspace SQLite source contains an invalid asset identity",
    ));
  }
  Ok(if value.starts_with("assets/") {
    value.to_string()
  } else {
    format!("assets/{value}")
  })
}

pub(crate) fn copy_asset_to<W: Write>(
  path: &Path,
  source_key: &str,
  writer: &mut W,
) -> Result<u64, WorkspaceImportDiagnostic> {
  let connection = open_read_only(path)?;
  let format = detect_sqlite_layout(path)?;
  let sql = if format == WorkspaceImportFormat::SqliteDocStorage {
    "SELECT rowid, key FROM blobs WHERE deleted_at IS NULL ORDER BY key"
  } else {
    "SELECT rowid, key FROM blobs ORDER BY key"
  };
  let mut statement = connection.prepare(sql).map_err(|_| {
    diagnostic(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
      "workspace SQLite asset index cannot be read",
    )
  })?;
  let rows = statement
    .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
    .map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace SQLite asset index cannot be read",
      )
    })?;
  let mut target_row = None;
  for row in rows {
    let (row_id, key) = row.map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace SQLite asset identity is invalid",
      )
    })?;
    if canonical_asset_key(&key)?.as_str() == source_key {
      target_row = Some(row_id);
      break;
    }
  }
  drop(statement);
  let row_id = target_row.ok_or_else(|| {
    diagnostic(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportAssetMissing,
      "workspace SQLite asset is missing",
    )
  })?;
  let mut blob = connection
    .blob_open(DatabaseName::Main, "blobs", "data", row_id, true)
    .map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace SQLite asset cannot be opened",
      )
    })?;
  let mut total = 0_u64;
  let mut buffer = [0_u8; 64 * 1024];
  loop {
    let read = blob.read(&mut buffer).map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportSqliteInvalid,
        "workspace SQLite asset cannot be read",
      )
    })?;
    if read == 0 {
      return Ok(total);
    }
    writer.write_all(&buffer[..read]).map_err(|_| {
      diagnostic(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportAssetMissing,
        "workspace SQLite asset cannot be materialized",
      )
    })?;
    total = total.saturating_add(read as u64);
  }
}
