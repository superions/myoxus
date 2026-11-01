// SPDX-License-Identifier: AGPL-3.0-or-later
//! Notion → DatabaseSnapshot adapter (P-DB-29).
//!
//! This module projects one or more [`crate::database::notion_import::NotionDocument`]s
//! into a single [`DatabaseSnapshot`] that can be fed to the existing
//! `DatabaseImportExportService::preview_json_import_with_options` /
//! `DatabaseImportExportService::import_json_with_options` code path. It is the
//! only place that knows the Notion-property → Myoxus-field matrix
//! documented in `docs/dev/server/databases-import-export.md`.
//!
//! The adapter is intentionally a pure function: given a
//! [`NotionParseResult`], it returns a `DatabaseSnapshot` and an updated
//! diagnostic list. The caller decides whether to attach the snapshot
//! to a `DatabaseJsonPreview` / `DatabaseJsonImportResult` so the
//! existing CSV / JSON UI renders it without change.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use myoxus_domain::database::{
  DATABASE_SNAPSHOT_SCHEMA_VERSION, DatabaseCellValueData, DatabaseDateTimeValue, DatabaseDateValue,
  DatabaseFieldConfig, DatabaseFieldType, DatabaseFileReference, DatabaseFilesValue, DatabaseProfileKind,
  DatabaseRichTextValue, DatabaseRollupAggregate, DatabaseRollupStalePolicy, DatabaseSnapshot,
  DatabaseSnapshotCellValue, DatabaseSnapshotCellValueData, DatabaseSnapshotContentDocument, DatabaseSnapshotDatabase,
  DatabaseSnapshotField, DatabaseSnapshotFieldConfig, DatabaseSnapshotFileManifestEntry,
  DatabaseSnapshotRelationFieldConfig, DatabaseSnapshotRollupFieldConfig, DatabaseSnapshotRow, DatabaseSnapshotSource,
  DatabaseSnapshotTableViewConfig, DatabaseSnapshotView, DatabaseSnapshotViewConfig, DatabaseSnapshotWorkspaceTag,
  DatabaseUniqueIdFieldConfig, DatabaseUniqueIdValue, DatabaseViewKind,
};
use myoxus_domain::workspace_tags::WorkspaceTag;
use tracing::{debug, instrument};
use uuid::Uuid;

use super::body::{PageBodyContext, convert_page_body};
use super::{
  NotionDiagnostic, NotionDiagnosticCode, NotionDiagnosticSeverity, NotionDocument, NotionParseResult, NotionProperty,
  NotionPropertyKind, NotionRichTextInline, NotionRichTextMark, NotionRow, project_select_options,
  project_status_options,
};

/// Outcome of building a snapshot: a snapshot ready to be fed into the
/// existing JSON-import pipeline, plus the merged diagnostics list. The
/// caller is responsible for combining diagnostics with any source-level
/// errors raised by the snapshot service.
#[derive(Debug, Clone)]
pub struct NotionSnapshotBuild {
  pub snapshot: DatabaseSnapshot,
  pub diagnostics: Vec<NotionDiagnostic>,
  pub matched_page_count: i32,
  pub content_document_count: i32,
  pub empty_page_count: i32,
  pub body_block_count: i32,
  pub rewritten_internal_link_count: i32,
}

#[derive(Default)]
struct NotionBodyCounters {
  matched_pages: i32,
  content_documents: i32,
  empty_pages: i32,
  blocks: i32,
  rewritten_internal_links: i32,
}

/// Build a [`DatabaseSnapshot`] from a parsed Notion result. Each
/// Notion database becomes its own [`DatabaseSnapshotDatabase`] entry
/// in `snapshot.databases`; the first one is also surfaced as
/// `snapshot.database` for backwards compatibility with the existing
/// JSON preview/apply flow (which always reads `snapshot.database`).
///
/// `source_zip_name` is the original archive filename (or HTML
/// filename) and is written into the snapshot's `source` field for
/// export round-tripping.
#[instrument(skip(parse_result, source_zip_name), fields(documents = parse_result.databases.len(), source = ?parse_result.source))]
pub fn build_snapshot_from_notion(
  parse_result: &NotionParseResult,
  source_zip_name: Option<&str>,
) -> NotionSnapshotBuild {
  let mut diagnostics: Vec<NotionDiagnostic> = parse_result.diagnostics.clone();

  // Each Notion document is its own database. We assign stable local
  // ids "database_0", "database_1", ... so the existing JSON-import
  // pipeline can resolve them.
  let mut databases: Vec<DatabaseSnapshotDatabase> = Vec::new();
  let mut files_manifest: Vec<DatabaseSnapshotFileManifestEntry> = Vec::new();
  let mut workspace_tags_manifest: Vec<DatabaseSnapshotWorkspaceTag> = Vec::new();
  let mut body_counters = NotionBodyCounters::default();
  let mut page_id_counts = std::collections::BTreeMap::<String, usize>::new();
  for document in &parse_result.databases {
    for row in &document.rows {
      if row.page_body.is_some() {
        *page_id_counts.entry(row.page_id.clone()).or_default() += 1;
      }
    }
  }
  let document_keys_by_page_id = parse_result
    .databases
    .iter()
    .enumerate()
    .flat_map(|(database_index, document)| {
      document
        .rows
        .iter()
        .enumerate()
        .filter(|(_, row)| row.page_body.is_some())
        .filter(|(_, row)| page_id_counts.get(&row.page_id) == Some(&1))
        .map(move |(row_index, row)| {
          (
            row.page_id.clone(),
            notion_content_document_key(database_index, row_index, &row.page_id),
          )
        })
    })
    .collect::<std::collections::BTreeMap<_, _>>();
  for (index, document) in parse_result.databases.iter().enumerate() {
    match build_snapshot_database(
      document,
      index,
      &document_keys_by_page_id,
      &parse_result.assets,
      &mut body_counters,
    ) {
      Ok((database, mut extra_files, mut extra_tags, mut extra_diagnostics)) => {
        diagnostics.append(&mut extra_diagnostics);
        files_manifest.append(&mut extra_files);
        workspace_tags_manifest.append(&mut extra_tags);
        databases.push(database);
      }
      Err(error) => {
        diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::HtmlInvalid,
          NotionDiagnosticSeverity::Error,
          format!("$.databases[{index}]"),
          error.to_string(),
        ));
      }
    }
  }

  // P-DB-29: real asset materialisation. After every database has been
  // projected we walk `parse_result.assets` and, for each path that
  // appears in the manifest, emit either an `AssetMaterialized` info
  // diagnostic (asset bytes are in the archive and will be uploaded by
  // the service layer) or an `AssetMissing` warning diagnostic (the
  // archive does not carry the file even though a row referenced it).
  // Paths that appear in `assets` but are not referenced by any cell
  // are recorded as `AssetRejected` so the operator sees that the
  // archive contained more than the cells used. We match cell paths
  // to archive paths by full equality first, then by suffix so
  // `assets/lamp.png` matches a cell referencing `lamp.png` (Notion
  // strips the parent directory when it embeds file references).
  if !parse_result.assets.is_empty() || !files_manifest.is_empty() {
    let manifest_paths: Vec<&str> = files_manifest.iter().map(|entry| entry.blob_key.as_str()).collect();
    for asset_path in parse_result.assets.keys() {
      let referenced = manifest_paths.iter().any(|mp| matches_asset_path(mp, asset_path));
      diagnostics.push(NotionDiagnostic::new(
        if referenced {
          NotionDiagnosticCode::AssetMaterialized
        } else {
          NotionDiagnosticCode::AssetRejected
        },
        if referenced {
          NotionDiagnosticSeverity::Info
        } else {
          NotionDiagnosticSeverity::Warning
        },
        format!("$.assets[{asset_path}]"),
        if referenced {
          format!(
            "Notion ZIP asset '{asset_path}' is available in the archive and will be \
             uploaded as a workspace blob during apply"
          )
        } else {
          format!(
            "Notion ZIP asset '{asset_path}' is present in the archive but not referenced by \
             any cell; it will not be uploaded"
          )
        },
      ));
    }
    for entry in &files_manifest {
      let available = parse_result
        .assets
        .keys()
        .any(|ap| matches_asset_path(&entry.blob_key, ap));
      if !available {
        diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::AssetMissing,
          NotionDiagnosticSeverity::Warning,
          format!("$.assets[{}]", entry.blob_key),
          format!(
            "Notion ZIP archive did not include asset '{}'; cell value preserves the original \
             path so the operator can upload it manually after import",
            entry.blob_key
          ),
        ));
      }
    }
  }

  let (database, databases) = match databases.split_first() {
    Some((first, rest)) => (
      first.clone(),
      std::iter::once(first.clone()).chain(rest.iter().cloned()).collect(),
    ),
    None => (empty_snapshot_database(), vec![empty_snapshot_database()]),
  };

  let source_label = match source_zip_name {
    Some(name) => name.to_string(),
    None => "notion-import".to_string(),
  };

  let snapshot = DatabaseSnapshot {
    schema_version: DATABASE_SNAPSHOT_SCHEMA_VERSION,
    exported_at: Utc::now(),
    source: DatabaseSnapshotSource {
      product: source_label.clone(),
      format: parse_result.source.as_str().to_string(),
      database_id: Some(database.id.clone()),
      exported_by: Some(source_label),
    },
    database,
    databases,
    files_manifest,
    workspace_tags_manifest,
    diagnostics: Vec::new(),
  };

  debug!(
    snapshot_databases = snapshot.databases.len(),
    manifest_entries = snapshot.files_manifest.len(),
    diagnostics = diagnostics.len(),
    "notion snapshot build complete"
  );
  NotionSnapshotBuild {
    snapshot,
    diagnostics,
    matched_page_count: body_counters.matched_pages,
    content_document_count: body_counters.content_documents,
    empty_page_count: body_counters.empty_pages,
    body_block_count: body_counters.blocks,
    rewritten_internal_link_count: body_counters.rewritten_internal_links,
  }
}

type NotionSnapshotDatabaseBuild = (
  DatabaseSnapshotDatabase,
  Vec<DatabaseSnapshotFileManifestEntry>,
  Vec<DatabaseSnapshotWorkspaceTag>,
  Vec<NotionDiagnostic>,
);

fn build_snapshot_database(
  document: &NotionDocument,
  index: usize,
  document_keys_by_page_id: &std::collections::BTreeMap<String, String>,
  assets: &std::collections::BTreeMap<String, Vec<u8>>,
  body_counters: &mut NotionBodyCounters,
) -> Result<NotionSnapshotDatabaseBuild, String> {
  let mut diagnostics: Vec<NotionDiagnostic> = Vec::new();
  let base_path = format!("$.databases[{index}]");

  // Normalize: the parser collects per-cell values; we union them up
  // to the column level so the field-config projection has the full
  // set of select / status options, file paths, people, and relation
  // targets for each column. Without this step, columns that are only
  // populated by data rows (which is the common Notion case) would
  // have empty option lists and the resulting field would be
  // unusable. Pre-existing column-level values are preserved.
  let mut normalized: NotionDocument = NotionDocument {
    database_id: document.database_id.clone(),
    title: document.title.clone(),
    description: document.description.clone(),
    properties: document.properties.clone(),
    rows: document.rows.clone(),
  };
  for row in normalized.rows.iter() {
    for (column_index, cell) in row.properties.iter().enumerate() {
      if let Some(column) = normalized.properties.get_mut(column_index) {
        for option in &cell.select_options {
          if !column.select_options.iter().any(|opt| opt == option) {
            column.select_options.push(option.clone());
          }
        }
        for path in &cell.file_paths {
          // Notion may pack multiple file paths into a single cell
          // value, separated by commas; split so each file becomes
          // its own manifest entry.
          for chunk in path.split(',') {
            let part = chunk.trim();
            if part.is_empty() {
              continue;
            }
            if !column.file_paths.iter().any(|p| p == part) {
              column.file_paths.push(part.to_string());
            }
          }
        }
        for person in &cell.people {
          if !column.people.iter().any(|p| p == person) {
            column.people.push(person.clone());
          }
        }
        for target in &cell.relation_targets {
          if !column.relation_targets.iter().any(|t| t == target) {
            column.relation_targets.push(target.clone());
          }
        }
      }
    }
  }

  // Map columns → fields. Use `field_<index>` as local id so the JSON
  // import pipeline can resolve cross-references.
  let mut fields: Vec<DatabaseSnapshotField> = Vec::new();
  let title_index = normalized
    .properties
    .iter()
    .position(|property| property.kind == NotionPropertyKind::Title)
    .unwrap_or(0);

  // P-DB-29A: page-id → local-row-id map for same-database relation
  // resolution. Notion's row.page_id is the 32-hex token (or a slug
  // fallback) derived from the HTML filename; the relation cell stores
  // those tokens in `relation_targets`. We rebuild the inverse map here
  // so each relation cell can be emitted with `target_row_ids = ["row_X", ...]`.
  let mut page_to_local_row: std::collections::HashMap<String, String> = std::collections::HashMap::new();
  for (row_index, notion_row) in normalized.rows.iter().enumerate() {
    if notion_row.page_id.is_empty() {
      continue;
    }
    let key = notion_row.page_id.to_ascii_lowercase();
    page_to_local_row
      .entry(key)
      .or_insert_with(|| format!("row_{row_index}"));
  }

  for (column_index, property) in normalized.properties.iter().enumerate() {
    let local_id = format!("field_{column_index}");
    let field = build_field(
      property,
      &local_id,
      column_index == title_index,
      &base_path,
      &mut diagnostics,
    )?;
    fields.push(field);
  }
  if fields.is_empty() {
    return Err("Notion document had no columns".to_string());
  }

  // P-DB-29: pre-scan DateTime fields. A field that maps to DateTime
  // but has zero valid DateTime cell values across every row must be
  // downgraded to Text so the source data stays visible to the user
  // instead of being hidden behind an empty DateTime column. We mark
  // the affected field ids here and the row builder uses the
  // downgraded kind when it materialises the cell.
  let mut datetime_downgraded: std::collections::HashSet<String> = std::collections::HashSet::new();
  for (column_index, property) in normalized.properties.iter().enumerate() {
    if !matches!(property.kind, NotionPropertyKind::DateTime) {
      continue;
    }
    if property.date_start.is_none() {
      continue;
    }
    let has_any_valid = normalized.rows.iter().any(|row| {
      row
        .properties
        .get(column_index)
        .and_then(|cell| cell.date_start.as_deref())
        .and_then(parse_notion_datetime_only)
        .is_some()
    });
    if !has_any_valid {
      let local_id = format!("field_{column_index}");
      datetime_downgraded.insert(local_id.clone());
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::DateTimeInvalid,
        NotionDiagnosticSeverity::Warning,
        format!("{base_path}.fields[{local_id}].kind"),
        format!(
          "Notion DateTime field '{}' has no valid date or timestamp values; \
           downgraded to Text to preserve the source data",
          property.name
        ),
      ));
    }
  }
  // Apply the downgrade in-place: rewrite the field type to Text and
  // re-derive the field config so the rendered cell shape is text.
  for field in fields.iter_mut() {
    if datetime_downgraded.contains(&field.id) {
      field.field_type = DatabaseFieldType::Text;
      field.read_only = false;
      field.config = DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Text(Default::default()));
    }
  }

  // P-DB-29A: same-database relation upgrade. A Relation column whose
  // every populated target resolves to a page_id that is one of this
  // database's own rows becomes a real DatabaseFieldType::Relation
  // pointing at the local primary database ("database_0"). Any target
  // that does not resolve here is treated as a cross-database link
  // and the entire column is downgraded to Text with a diagnostic.
  let mut relation_upgraded: std::collections::HashSet<String> = std::collections::HashSet::new();
  let mut relation_cross_database: std::collections::HashSet<String> = std::collections::HashSet::new();
  for (column_index, property) in normalized.properties.iter().enumerate() {
    if !matches!(property.kind, NotionPropertyKind::Relation) {
      continue;
    }
    let local_id = format!("field_{column_index}");
    // Collect every target across rows for this column.
    let mut targets: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in &normalized.rows {
      if let Some(cell) = row.properties.get(column_index) {
        for target in &cell.relation_targets {
          targets.insert(target.clone());
        }
      }
    }
    // Columns without targets: emit a diagnostic and downgrade to Text
    // (no rows, no relation cells, no point in a Relation field).
    if targets.is_empty() {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::RelationTargetUnresolved,
        NotionDiagnosticSeverity::Info,
        format!("{base_path}.fields[{local_id}].kind"),
        format!(
          "Notion relation field '{}' has no resolvable targets in the imported database; \
           imported as Text with the page mention text",
          property.name
        ),
      ));
      relation_cross_database.insert(local_id.clone());
      continue;
    }
    let missing: Vec<String> = targets
      .iter()
      .filter(|t| !page_to_local_row.contains_key(*t))
      .cloned()
      .collect();
    if missing.is_empty() {
      relation_upgraded.insert(local_id.clone());
    } else {
      relation_cross_database.insert(local_id.clone());
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::RelationCrossDatabase,
        NotionDiagnosticSeverity::Warning,
        format!("{base_path}.fields[{local_id}].kind"),
        format!(
          "Notion relation field '{}' targets {} page(s) outside the imported primary database; \
           imported as Text with the page title(s). Missing targets: {}",
          property.name,
          missing.len(),
          missing.iter().take(5).cloned().collect::<Vec<_>>().join(", ")
        ),
      ));
    }
  }
  for field in fields.iter_mut() {
    if relation_upgraded.contains(&field.id) {
      field.field_type = DatabaseFieldType::Relation;
      field.read_only = false;
      field.config = DatabaseSnapshotFieldConfig::Relation(DatabaseSnapshotRelationFieldConfig {
        target_database_id: "database_0".to_string(),
        allow_multiple: true,
        reciprocal_field_id: None,
        max_targets: None,
      });
    } else if relation_cross_database.contains(&field.id) {
      field.field_type = DatabaseFieldType::Text;
      field.read_only = false;
      field.config = DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Text(Default::default()));
    }
  }

  // P-DB-29A: rollup after same-database relation. A Rollup column
  // whose source relation was upgraded to a real DatabaseFieldType::Relation
  // becomes a real DatabaseFieldType::Rollup pointing at the same
  // database. Otherwise it stays as Text with a diagnostic.
  let mut rollup_upgraded: std::collections::HashSet<String> = std::collections::HashSet::new();
  for (column_index, property) in normalized.properties.iter().enumerate() {
    if !matches!(property.kind, NotionPropertyKind::Rollup) {
      continue;
    }
    let local_id = format!("field_{column_index}");
    // Find any same-database Relation field in the same document.
    // Notion does not export a rollup source_field reference in the
    // HTML/ZIP, so we use a positional convention: a Rollup column
    // depends on the most recent Relation field to its left.
    let source_relation_id = normalized
      .properties
      .iter()
      .enumerate()
      .take(column_index)
      .rev()
      .find_map(|(idx, prop)| {
        if matches!(prop.kind, NotionPropertyKind::Relation) {
          Some(format!("field_{idx}"))
        } else {
          None
        }
      });
    match source_relation_id {
      Some(source_field_id) if relation_upgraded.contains(&source_field_id) => {
        rollup_upgraded.insert(local_id.clone());
        diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::RollupImported,
          NotionDiagnosticSeverity::Info,
          format!("{base_path}.fields[{local_id}].kind"),
          format!(
            "Notion rollup field '{}' imported as a real Rollup over the same-database relation '{}'",
            property.name, source_field_id
          ),
        ));
      }
      _ => {
        diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::RollupDegraded,
          NotionDiagnosticSeverity::Warning,
          format!("{base_path}.fields[{local_id}].kind"),
          format!(
            "Notion rollup field '{}' has no resolvable same-database source relation; \
             imported as Text with the rolled-up value as displayed",
            property.name
          ),
        ));
      }
    }
  }
  for field in fields.iter_mut() {
    if rollup_upgraded.contains(&field.id) {
      let source_relation_field_id = relation_upgraded
        .iter()
        .find(|id| {
          // Find the leftmost upgraded relation id that is to the left
          // of this field id (parsed index from "field_N").
          let n: usize = field.id.trim_start_matches("field_").parse().unwrap_or(0);
          let my_n: usize = id.trim_start_matches("field_").parse().unwrap_or(usize::MAX);
          my_n < n
        })
        .cloned()
        .unwrap_or_default();
      // The rollup target field is the title field of the same primary
      // database, which is the safe default for Notion rollups that
      // usually aggregate a count of related rows.
      field.field_type = DatabaseFieldType::Rollup;
      field.read_only = false;
      field.config = DatabaseSnapshotFieldConfig::Rollup(DatabaseSnapshotRollupFieldConfig {
        source_relation_field_id,
        target_field_id: "field_0".to_string(),
        aggregate: DatabaseRollupAggregate::Count,
        empty_value: None,
        stale_policy: DatabaseRollupStalePolicy::Async,
      });
    }
  }

  // Build a default Table view that shows every field. The snapshot
  // adapter does not attempt to recreate Notion's Board / Gallery /
  // List views because Myoxus does not yet ship a Notion-fidelity
  // view model and we prefer honesty to lying about fidelity.
  // Notion's HTML/ZIP export rarely carries view metadata; surface a
  // single ViewUnsupported info diagnostic on the database so the
  // operator sees the fallback explicitly.
  let has_date_field = normalized
    .properties
    .iter()
    .any(|p| matches!(p.kind, NotionPropertyKind::Date | NotionPropertyKind::DateTime));
  let has_status_field = normalized
    .properties
    .iter()
    .any(|p| matches!(p.kind, NotionPropertyKind::Status));
  diagnostics.push(NotionDiagnostic::new(
    NotionDiagnosticCode::ViewUnsupported,
    NotionDiagnosticSeverity::Info,
    format!("{base_path}.views"),
    format!(
      "Notion HTML/ZIP exports rarely carry view-type metadata; a Table view was created \
       as the truthful fallback (date_field={}, status_field={}). If a richer view \
       (Board/Kanban over Status, Calendar over Date, Gallery) is desired, set it up \
       manually after import.",
      has_date_field, has_status_field
    ),
  ));
  let title_field_id = fields
    .get(title_index)
    .map(|f| f.id.clone())
    .ok_or_else(|| "Title field missing after build".to_string())?;
  let search_field_ids = fields
    .iter()
    .filter(|field| field.field_type.supports_server_search())
    .map(|field| field.id.clone())
    .collect();
  let view_config = DatabaseSnapshotViewConfig::Table(DatabaseSnapshotTableViewConfig {
    title_field_id: title_field_id.clone(),
    visible_field_ids: fields.iter().map(|f| f.id.clone()).collect(),
    field_widths: std::collections::BTreeMap::new(),
    search_field_ids,
    sort: Vec::new(),
    filter: Vec::new(),
    filter_tree: None,
    group: None,
    subgroup: None,
  });
  let view = DatabaseSnapshotView {
    id: "view_0".to_string(),
    name: "Table".to_string(),
    view_kind: DatabaseViewKind::Table,
    icon: None,
    config: view_config,
    position: 0,
  };

  // P-DB-29: template hints. The Notion HTML/ZIP parser cannot reliably
  // detect row templates because the export format does not carry the
  // "template" attribute that distinguishes a template row from a
  // data row. We surface a single
  // `MIX_DATABASE_NOTION_TEMPLATE_UNSUPPORTED` info diagnostic on the
  // database (alongside ViewUnsupported) so the operator knows that
  // row templates are intentionally absent. Visible rows still flow
  // through the row builder below — the diagnostic is informational,
  // not destructive.
  diagnostics.push(NotionDiagnostic::new(
    NotionDiagnosticCode::TemplateUnsupported,
    NotionDiagnosticSeverity::Info,
    format!("{base_path}.rowTemplates"),
    "Notion HTML/ZIP exports do not carry row-template metadata, so no Myoxus \
     row templates were created. The visible Notion rows are still imported as \
     regular Database rows. To add row templates for new entries, configure them \
     manually after import.",
  ));

  // Map rows.
  let mut rows: Vec<DatabaseSnapshotRow> = Vec::new();
  let relation_ctx = RelationResolutionContext {
    page_to_local_row: &page_to_local_row,
  };
  for (row_index, notion_row) in normalized.rows.iter().enumerate() {
    rows.push(build_snapshot_row(
      notion_row,
      &fields,
      row_index,
      &base_path,
      &mut diagnostics,
      &relation_ctx,
      index,
      document_keys_by_page_id,
      assets,
      body_counters,
    ));
  }

  // Files manifest: scan every Files cell and emit one entry per
  // distinct file path. We never silently consume a path; the
  // snapshot adapter either records it (so the existing JSON import
  // flow surfaces a `MissingFile` diagnostic if the asset isn't in
  // the upload) or drops it with a diagnostic.
  let mut files_manifest = collect_files_manifest(&rows, &fields);
  append_content_files_manifest(&rows, assets, &mut files_manifest);
  if !files_manifest.is_empty() {
    diagnostics.push(NotionDiagnostic::new(
      NotionDiagnosticCode::MissingFile,
      NotionDiagnosticSeverity::Info,
      format!("{base_path}.filesManifest"),
      format!("Notion document references {} file(s)", files_manifest.len()),
    ));
  }

  let mut workspace_tags = std::collections::BTreeMap::<Uuid, DatabaseSnapshotWorkspaceTag>::new();
  for (column_index, field) in fields.iter().enumerate() {
    if field.field_type != DatabaseFieldType::Tags {
      continue;
    }
    for row in &normalized.rows {
      let Some(property) = row.properties.get(column_index) else {
        continue;
      };
      for name in &property.select_options {
        let Ok(name) = WorkspaceTag::normalize_name(name) else {
          continue;
        };
        let Ok(slug) = WorkspaceTag::slug_base(&name) else {
          continue;
        };
        let id = notion_workspace_tag_id(&slug);
        workspace_tags.entry(id).or_insert(DatabaseSnapshotWorkspaceTag {
          id,
          name,
          slug,
          color_role: "tag.grey".to_string(),
          archived: false,
        });
      }
    }
  }

  let database = DatabaseSnapshotDatabase {
    managed_template: None,
    id: format!("database_{index}"),
    profile_kind: DatabaseProfileKind::Generic,
    profile_structure_preset: None,
    profile_config: serde_json::json!({}),
    title: document.title.clone(),
    description: document.description.clone(),
    fields,
    views: vec![view],
    field_roles: Vec::new(),
    view_roles: Vec::new(),
    rows,
    row_templates: Vec::new(),
  };
  Ok((
    database,
    files_manifest,
    workspace_tags.into_values().collect(),
    diagnostics,
  ))
}

fn build_field(
  property: &NotionProperty,
  local_id: &str,
  is_title: bool,
  base_path: &str,
  diagnostics: &mut Vec<NotionDiagnostic>,
) -> Result<DatabaseSnapshotField, String> {
  let path = format!("{base_path}.fields[{local_id}]");
  let mut kind = if is_title {
    DatabaseFieldType::Title
  } else {
    match property.kind.to_myoxus_field_type() {
      Some(kind) => kind,
      None => {
        let (code, message) = match property.kind {
          NotionPropertyKind::Relation => (
            NotionDiagnosticCode::RelationDegraded,
            "Notion relation column has no Myoxus equivalent in this import \
             (cross-database relations are not supported by P-DB-29); \
             imported as Text with the page name(s).",
          ),
          NotionPropertyKind::Rollup => (
            NotionDiagnosticCode::RollupDegraded,
            "Notion rollup column has no Myoxus equivalent in this import \
             (cross-database rollups are not supported by P-DB-29); \
             imported as Text with the rolled-up value as displayed.",
          ),
          NotionPropertyKind::Formula => (
            NotionDiagnosticCode::FormulaDegraded,
            "Notion formula column has no Myoxus equivalent; imported as Text \
             with the formula result as displayed.",
          ),
          NotionPropertyKind::People => (
            NotionDiagnosticCode::PeopleDegraded,
            "Notion people column has no Myoxus equivalent in this import \
             (workspace user identities do not transfer); imported as Text \
             with the user display name(s).",
          ),
          _ => (
            NotionDiagnosticCode::PropertyDowngraded,
            "Notion property kind has no Myoxus equivalent; imported as Text.",
          ),
        };
        diagnostics.push(NotionDiagnostic::new(
          code,
          NotionDiagnosticSeverity::Warning,
          format!("{path}.kind"),
          format!("{message} (kind='{}')", tag_of_kind(property.kind)),
        ));
        DatabaseFieldType::Text
      }
    }
  };
  if kind == DatabaseFieldType::MultiSelect
    && matches!(
      property.name.trim().to_ascii_lowercase().as_str(),
      "tag" | "tags" | "label" | "labels"
    )
  {
    kind = DatabaseFieldType::Tags;
  }
  let name = if property.name.trim().is_empty() {
    format!("Column {local_id}")
  } else {
    property.name.trim().to_string()
  };
  let config = build_field_config(&kind, property, &path, diagnostics);
  let read_only = matches!(
    kind,
    DatabaseFieldType::CreatedTime
      | DatabaseFieldType::CreatedBy
      | DatabaseFieldType::UpdatedTime
      | DatabaseFieldType::UpdatedBy
      | DatabaseFieldType::UniqueId
  );
  Ok(DatabaseSnapshotField {
    id: local_id.to_string(),
    name,
    field_type: kind,
    config,
    position: 0,
    required: false,
    read_only,
  })
}

fn build_field_config(
  kind: &DatabaseFieldType,
  property: &NotionProperty,
  path: &str,
  diagnostics: &mut Vec<NotionDiagnostic>,
) -> DatabaseSnapshotFieldConfig {
  // Delegate to the canonical `DatabaseFieldConfig::empty_for` so every
  // field kind carries the matching config variant. Previously this used
  // `default_field_config_for`, which fell back to `Text` for almost
  // every kind and made `validate_field_config` reject the resulting
  // snapshot at apply time.
  let mut base = DatabaseFieldConfig::empty_for(*kind);
  match kind {
    DatabaseFieldType::Select => {
      if let DatabaseFieldConfig::Select(config) = &mut base {
        config.options = project_select_options(property.select_options.clone(), path, diagnostics);
      }
    }
    DatabaseFieldType::MultiSelect => {
      if let DatabaseFieldConfig::MultiSelect(config) = &mut base {
        config.options = project_select_options(property.select_options.clone(), path, diagnostics);
      }
    }
    DatabaseFieldType::Status => {
      if let DatabaseFieldConfig::Status(config) = &mut base {
        let options = project_status_options(property.select_options.clone(), path, diagnostics);
        config.options = options.clone();
        // Always set a default so Myoxus Status is valid.
        config.default_option_id = options.first().map(|option| option.id.clone()).unwrap_or_default();
      }
    }
    DatabaseFieldType::UniqueId => {
      base = DatabaseFieldConfig::UniqueId(DatabaseUniqueIdFieldConfig::default());
    }
    _ => {}
  }
  DatabaseSnapshotFieldConfig::Domain(base)
}

/// Per-database context shared between field/row/cell builders so
/// same-database relation targets can be resolved into local row ids
/// without prop-drilling every intermediate type.
struct RelationResolutionContext<'a> {
  page_to_local_row: &'a std::collections::HashMap<String, String>,
}

fn notion_workspace_tag_id(slug: &str) -> Uuid {
  Uuid::new_v5(&Uuid::NAMESPACE_OID, format!("notion-workspace-tag:{slug}").as_bytes())
}

#[expect(
  clippy::too_many_arguments,
  reason = "the importer keeps source, target, diagnostics, and counters explicit"
)]
fn build_snapshot_row(
  notion_row: &NotionRow,
  fields: &[DatabaseSnapshotField],
  row_index: usize,
  base_path: &str,
  diagnostics: &mut Vec<NotionDiagnostic>,
  relation_ctx: &RelationResolutionContext<'_>,
  database_index: usize,
  document_keys_by_page_id: &std::collections::BTreeMap<String, String>,
  assets: &std::collections::BTreeMap<String, Vec<u8>>,
  body_counters: &mut NotionBodyCounters,
) -> DatabaseSnapshotRow {
  let local_row_id = format!("row_{row_index}");
  let mut cells: Vec<DatabaseSnapshotCellValue> = Vec::new();
  for (column_index, field) in fields.iter().enumerate() {
    let cell_property = notion_row.properties.get(column_index);
    if let Some(value) = build_cell_value(
      cell_property,
      field,
      &local_row_id,
      base_path,
      diagnostics,
      relation_ctx,
    ) {
      cells.push(DatabaseSnapshotCellValue {
        field_id: field.id.clone(),
        field_type: field.field_type,
        value,
      });
    }
  }
  let title = if notion_row.title.trim().is_empty() {
    diagnostics.push(NotionDiagnostic::new(
      NotionDiagnosticCode::EmptyTitleFallback,
      NotionDiagnosticSeverity::Info,
      format!("{base_path}.rows[{local_row_id}].title"),
      "Row title was empty; generated a fallback slug from the page id",
    ));
    let slug: String = notion_row.page_id.chars().take(12).collect();
    format!("Untitled ({slug})")
  } else {
    notion_row.title.trim().to_string()
  };
  // Page mentions and iconography are dropped here so the snapshot
  // stays within the documented supported subset.
  if notion_row.icon.is_some() {
    diagnostics.push(NotionDiagnostic::new(
      NotionDiagnosticCode::DroppedPageIconography,
      NotionDiagnosticSeverity::Info,
      format!("{base_path}.rows[{local_row_id}].icon"),
      "Notion page icon was not imported",
    ));
  }
  if notion_row.cover_url.is_some() {
    diagnostics.push(NotionDiagnostic::new(
      NotionDiagnosticCode::DroppedPageIconography,
      NotionDiagnosticSeverity::Info,
      format!("{base_path}.rows[{local_row_id}].cover"),
      "Notion page cover image was not imported",
    ));
  }
  let content_document = notion_row.page_body.as_ref().map(|body| {
    let conversion = convert_page_body(
      &title,
      body,
      PageBodyContext {
        document_keys_by_page_id,
        assets,
      },
    );
    body_counters.matched_pages += 1;
    body_counters.content_documents += 1;
    body_counters.empty_pages += i32::from(conversion.block_count == 0);
    body_counters.blocks += conversion.block_count as i32;
    body_counters.rewritten_internal_links += conversion.rewritten_internal_links as i32;
    diagnostics.extend(conversion.diagnostics);
    DatabaseSnapshotContentDocument {
      document_key: notion_content_document_key(database_index, row_index, &notion_row.page_id),
      title: title.clone(),
      yjs_update_base64: STANDARD.encode(conversion.update),
      asset_keys: conversion.asset_keys,
    }
  });
  DatabaseSnapshotRow {
    id: local_row_id,
    title,
    position: row_index as i32,
    content_document,
    row_kind: myoxus_domain::database::DatabaseRowKind::Record,
    source: None,
    cells,
    projections: Vec::new(),
  }
}

fn notion_content_document_key(database_index: usize, row_index: usize, page_id: &str) -> String {
  let stable_page_id = page_id
    .chars()
    .map(|character| {
      if character.is_ascii_alphanumeric() {
        character
      } else {
        '-'
      }
    })
    .collect::<String>();
  format!("notion-page-{database_index}-{row_index}-{stable_page_id}")
}

fn build_cell_value(
  property: Option<&NotionProperty>,
  field: &DatabaseSnapshotField,
  row_id: &str,
  base_path: &str,
  diagnostics: &mut Vec<NotionDiagnostic>,
  relation_ctx: &RelationResolutionContext<'_>,
) -> Option<DatabaseSnapshotCellValueData> {
  let property = property?;
  // Title fields store their value on the Row record, not as a Cell.
  // We still emit a Text-typed placeholder cell here so the snapshot's
  // `cells` vector stays index-aligned with its `fields` vector — the
  // JSON import pipeline filters the title cell out via
  // `normalize_editable_cell_value` instead, leaving apply-time cell
  // values untouched for every other field.
  let path = format!("{base_path}.rows[{row_id}].cells[{}]", field.id);
  // P-DB-29A: a same-database Relation column emits its targets as
  // `DatabaseSnapshotCellValueData::Relation(Vec<String>)` so the JSON
  // import pipeline can wire the cell value into the local row id map.
  if matches!(field.field_type, DatabaseFieldType::Relation) {
    let targets: Vec<String> = property
      .relation_targets
      .iter()
      .filter_map(|target| relation_ctx.page_to_local_row.get(target).cloned())
      .collect();
    if targets.is_empty() {
      return None;
    }
    return Some(DatabaseSnapshotCellValueData::Relation(targets));
  }
  let value = build_domain_cell_value(property, field.field_type, &path, diagnostics)?;
  // UniqueIds from Notion are kept as Domain wrappers; everything else
  // goes through the Domain variant so the existing JSON pipeline
  // treats it as an editable value.
  Some(DatabaseSnapshotCellValueData::Domain(value))
}

fn build_domain_cell_value(
  property: &NotionProperty,
  field_type: DatabaseFieldType,
  path: &str,
  diagnostics: &mut Vec<NotionDiagnostic>,
) -> Option<DatabaseCellValueData> {
  match field_type {
    DatabaseFieldType::RichText => {
      notion_rich_text_value(property, path, diagnostics).map(DatabaseCellValueData::RichText)
    }
    DatabaseFieldType::Title
    | DatabaseFieldType::Text
    | DatabaseFieldType::Url
    | DatabaseFieldType::Email
    | DatabaseFieldType::Phone => {
      // P-DB-29: a downgraded DateTime field renders the raw
      // start value as readable text. The cell keeps the source
      // data visible instead of becoming an empty Text column.
      let raw: Option<String> = if matches!(property.kind, NotionPropertyKind::DateTime) {
        property
          .date_start
          .as_ref()
          .map(|start| match property.date_end.as_ref() {
            Some(end) if end != start => format!("{start} → {end}"),
            _ => start.clone(),
          })
          .or_else(|| property.raw_text.clone())
      } else if matches!(property.kind, NotionPropertyKind::People) && !property.people.is_empty() {
        Some(property.people.join(", "))
      } else {
        property.raw_text.clone()
      };
      if field_type == DatabaseFieldType::Url {
        return raw
          .as_deref()
          .map(str::trim)
          .filter(|value| !value.is_empty())
          .map(|value| DatabaseCellValueData::Url(value.to_string()));
      }
      if field_type == DatabaseFieldType::Email {
        return raw
          .as_deref()
          .map(str::trim)
          .filter(|value| !value.is_empty())
          .map(|value| DatabaseCellValueData::Email(value.to_string()));
      }
      if field_type == DatabaseFieldType::Phone {
        return raw
          .as_deref()
          .map(str::trim)
          .filter(|value| !value.is_empty())
          .map(|value| DatabaseCellValueData::Phone(value.to_string()));
      }
      raw
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| DatabaseCellValueData::Text(value.to_string()))
    }
    DatabaseFieldType::Number | DatabaseFieldType::Percent | DatabaseFieldType::Currency => property
      .number
      .and_then(|value| if value.is_finite() { Some(value) } else { None })
      .map(DatabaseCellValueData::Number),
    DatabaseFieldType::Checkbox => property.checkbox.map(DatabaseCellValueData::Checkbox),
    DatabaseFieldType::Date => match property.date_start.as_deref() {
      Some(start) => {
        // NaiveDate is what DatabaseDateValue stores. We accept ISO
        // 8601 dates (`YYYY-MM-DD`) and degrade gracefully otherwise.
        match chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d") {
          Ok(parsed) => Some(DatabaseCellValueData::Date(DatabaseDateValue {
            start: parsed,
            end: property
              .date_end
              .as_deref()
              .and_then(|raw| chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d").ok()),
          })),
          Err(_) => None,
        }
      }
      None => None,
    },
    DatabaseFieldType::DateTime => {
      parse_datetime_value(property, path, diagnostics).map(DatabaseCellValueData::DateTime)
    }
    DatabaseFieldType::Select | DatabaseFieldType::Status => {
      property.select_options.first().cloned().map(|name| match field_type {
        DatabaseFieldType::Status => DatabaseCellValueData::Status(name),
        _ => DatabaseCellValueData::Select(name),
      })
    }
    DatabaseFieldType::MultiSelect => {
      if property.select_options.is_empty() {
        None
      } else {
        Some(DatabaseCellValueData::MultiSelect(property.select_options.clone()))
      }
    }
    DatabaseFieldType::Tags => {
      if property.select_options.is_empty() {
        None
      } else {
        Some(DatabaseCellValueData::Tags(
          property
            .select_options
            .iter()
            .filter_map(|name| WorkspaceTag::slug_base(name).ok())
            .map(|slug| notion_workspace_tag_id(&slug))
            .collect(),
        ))
      }
    }
    DatabaseFieldType::UniqueId => property
      .raw_text
      .as_deref()
      .map(str::trim)
      .filter(|value| !value.is_empty())
      .map(|value| {
        DatabaseCellValueData::UniqueId(DatabaseUniqueIdValue {
          prefix: String::new(),
          sequence: 0,
          display: value.to_string(),
        })
      }),
    DatabaseFieldType::Files => {
      // Files cells in Myoxus reference blob keys. Notion files are
      // ZIP-relative paths; we surface them as a Files cell value so
      // the import can either materialise them as workspace blobs
      // (via the existing JSON import pipeline) or surface a
      // missing-file diagnostic. The file paths are stored as blob
      // keys verbatim.
      if property.file_paths.is_empty() {
        None
      } else {
        let entries: Vec<DatabaseFileReference> = property
          .file_paths
          .iter()
          .map(|path| DatabaseFileReference {
            blob_key: path.clone(),
            name: Some(path.split('/').next_back().unwrap_or(path).to_string()),
            mime: Some(guess_mime(path)),
            size: Some(0),
            caption: None,
            cover: false,
          })
          .collect();
        Some(DatabaseCellValueData::Files(DatabaseFilesValue { files: entries }))
      }
    }
    DatabaseFieldType::Relation => {
      // Reached only when a Relation field has no resolved targets in
      // the current row (e.g. the relation column was upgraded but the
      // row's cell had no targets). Return None; the field is already
      // represented elsewhere with real targets.
      None
    }
    DatabaseFieldType::Rollup | DatabaseFieldType::Formula => {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::PropertyDowngraded,
        NotionDiagnosticSeverity::Info,
        path.to_string(),
        format!(
          "Notion {} field is informational and was not imported",
          tag_of_kind(property.kind)
        ),
      ));
      None
    }
    DatabaseFieldType::User | DatabaseFieldType::Users => {
      // P-DB-29R: the snapshot adapter cannot resolve workspace
      // members from here (pure function, no MembershipRepository
      // access). Emit a placeholder empty Users cell so the JSON
      // apply step creates the `Users` field without rejecting the
      // snapshot. The service layer walks the original `notion_parse`
      // result after apply and fills in the resolved `Users` values
      // through `DatabaseEditingService::update_cell_value`, recording
      // MATCHED / AMBIGUOUS / UNMATCHED diagnostics in the apply
      // result. The previous `Text(joined)` placeholder had to be
      // dropped because the JSON apply rejects cells whose value
      // kind does not match the field type.
      Some(DatabaseCellValueData::Users(Vec::new()))
    }
    DatabaseFieldType::DocumentLink
    | DatabaseFieldType::Duration
    | DatabaseFieldType::CreatedTime
    | DatabaseFieldType::CreatedBy
    | DatabaseFieldType::UpdatedTime
    | DatabaseFieldType::UpdatedBy => None,
  }
}

fn notion_rich_text_value(
  property: &NotionProperty,
  path: &str,
  diagnostics: &mut Vec<NotionDiagnostic>,
) -> Option<DatabaseRichTextValue> {
  if !property.rich_text.is_empty() {
    let mut content = Vec::new();
    let mut plain_text = String::new();
    for inline in &property.rich_text {
      match inline {
        NotionRichTextInline::HardBreak => {
          content.push(serde_json::json!({ "type": "hardBreak" }));
          plain_text.push('\n');
        }
        NotionRichTextInline::Text { text, marks } if !text.is_empty() => {
          plain_text.push_str(text);
          let marks = marks
            .iter()
            .map(|mark| match mark {
              NotionRichTextMark::Bold => serde_json::json!({ "type": "bold" }),
              NotionRichTextMark::Italic => serde_json::json!({ "type": "italic" }),
              NotionRichTextMark::Strike => serde_json::json!({ "type": "strike" }),
              NotionRichTextMark::Code => serde_json::json!({ "type": "code" }),
              NotionRichTextMark::Link { href } => {
                serde_json::json!({ "type": "link", "attrs": { "href": href } })
              }
            })
            .collect::<Vec<_>>();
          let mut node = serde_json::json!({ "type": "text", "text": text });
          if !marks.is_empty() {
            node["marks"] = serde_json::Value::Array(marks);
          }
          content.push(node);
        }
        NotionRichTextInline::Text { .. } => {}
      }
    }
    if property.rich_text_lossy {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::PropertyDowngraded,
        NotionDiagnosticSeverity::Info,
        path.to_string(),
        "Unsupported Notion rich-text formatting was removed; all readable text and supported marks were preserved.",
      ));
    }
    return (!plain_text.trim().is_empty()).then(|| DatabaseRichTextValue {
      plain_text,
      document: serde_json::json!({
        "type": "doc",
        "content": [{ "type": "paragraph", "content": content }]
      }),
    });
  }

  property
    .raw_text
    .as_deref()
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(|value| {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::PropertyDowngraded,
        NotionDiagnosticSeverity::Info,
        path.to_string(),
        "Notion rich-text formatting was unavailable in the source parser; readable text was preserved in a canonical RichText cell.",
      ));
      DatabaseRichTextValue {
        plain_text: value.to_string(),
        document: serde_json::json!({
          "type": "doc",
          "content": [{
            "type": "paragraph",
            "content": [{ "type": "text", "text": value }]
          }]
        }),
      }
    })
}

/// Parse the Notion `date_start` / `date_end` strings into a Myoxus
/// DateTime cell value. Notion exports dates as one of:
///   - `YYYY-MM-DD` (all-day, no time)
///   - `YYYY-MM-DDTHH:MM:SS(.fff)(Z|+HH:MM)` (timed, timezone-bearing)
///   - `YYYY-MM-DDTHH:MM:SS(.fff)Z` (UTC instant)
///   - mixed: start is a date and end is a date (all-day range), or
///     start is a datetime and end is a datetime (timed range).
///
/// `time_zone` is preserved verbatim so Calendar/Timeline display
/// surfaces keep the original IANA identifier.
///
/// Invalid input emits a row-local
/// `MIX_DATABASE_NOTION_DATETIME_INVALID` diagnostic and returns
/// `None`. A field whose every cell returns `None` is downgraded to
/// `Text` by `build_field` so the source data is preserved as readable
/// text instead of being hidden behind an empty DateTime column.
fn parse_datetime_value(
  property: &NotionProperty,
  path: &str,
  diagnostics: &mut Vec<NotionDiagnostic>,
) -> Option<DatabaseDateTimeValue> {
  let start_raw = property.date_start.as_deref()?;
  let end_raw = property.date_end.as_deref();
  let parsed_start = parse_notion_datetime(start_raw);
  let parsed_end = end_raw.and_then(parse_notion_datetime);
  let (start_value, time_zone) = match parsed_start {
    Some((value, zone)) => (value, zone),
    None => {
      diagnostics.push(NotionDiagnostic::new(
        NotionDiagnosticCode::DateTimeInvalid,
        NotionDiagnosticSeverity::Warning,
        path.to_string(),
        format!(
          "Notion DateTime start '{}' could not be parsed as a date or timestamp; \
           falling back to readable text",
          start_raw
        ),
      ));
      return None;
    }
  };
  let end_value = if let Some(end_raw) = end_raw {
    match parsed_end {
      Some((value, _)) => Some(value),
      None => {
        diagnostics.push(NotionDiagnostic::new(
          NotionDiagnosticCode::DateTimeInvalid,
          NotionDiagnosticSeverity::Warning,
          path.to_string(),
          format!(
            "Notion DateTime end '{}' could not be parsed; ignoring end value",
            end_raw
          ),
        ));
        None
      }
    }
  } else {
    None
  };
  let all_day = start_raw.len() == 10 && end_raw.map(|raw| raw.len() == 10).unwrap_or(true);
  Some(DatabaseDateTimeValue {
    start: start_value,
    end: end_value,
    all_day,
    time_zone,
  })
}

/// Parse a single Notion date/datetime string. Returns the UTC instant
/// (or naive midnight for all-day values) plus the offset string
/// (e.g. `+02:00`) when one was supplied. Bare `YYYY-MM-DD` parses as
/// an all-day value with an empty timezone; bare `YYYY-MM-DDTHH:MM:SS`
/// (no zone) parses as UTC.
fn parse_notion_datetime(raw: &str) -> Option<(DateTime<Utc>, String)> {
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    return None;
  }
  if let Ok(naive_date) = NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
    let naive = naive_date.and_hms_opt(0, 0, 0)?;
    return Some((naive.and_utc(), String::new()));
  }
  // Detect a trailing offset (`+HH:MM`, `-HH:MM`, `+HHMM`, `-HHMM` or
  // trailing `Z`) so we can preserve it as the timezone label and
  // normalise the offset for chrono's `%z` parser.
  let mut zone_label = String::new();
  let mut normalized = trimmed.to_string();
  if let Some(t_pos) = trimmed.find('T') {
    let suffix = &trimmed[t_pos + 1..];
    if suffix.contains('Z') {
      zone_label = "UTC".to_string();
      normalized = format!("{}+0000", &trimmed[..trimmed.len() - 1]);
    } else if let Some(plus_pos) = suffix.rfind('+') {
      if plus_pos >= 2 {
        let zone = &suffix[plus_pos..];
        zone_label = zone.to_string();
        // Strip the colon: chrono `%z` accepts `+0200`, not `+02:00`.
        let normalized_zone = zone.replace(':', "");
        normalized = format!("{}{}", &trimmed[..trimmed.len() - zone.len()], normalized_zone);
      }
    } else if let Some(minus_pos) = suffix.rfind('-')
      && minus_pos >= 2
    {
      let zone = &suffix[minus_pos..];
      zone_label = zone.to_string();
      let normalized_zone = zone.replace(':', "");
      normalized = format!("{}{}", &trimmed[..trimmed.len() - zone.len()], normalized_zone);
    }
  }
  let datetime_formats: [&str; 3] = ["%Y-%m-%dT%H:%M:%S%.f%z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S"];
  for format in datetime_formats {
    if let Ok(parsed) = DateTime::parse_from_str(&normalized, format) {
      return Some((parsed.with_timezone(&Utc), zone_label.clone()));
    }
  }
  if let Ok(naive) = NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%dT%H:%M:%S%.f") {
    return Some((naive.and_utc(), zone_label));
  }
  if let Ok(naive) = NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%dT%H:%M:%S") {
    return Some((naive.and_utc(), zone_label));
  }
  None
}

/// Boolean variant of [`parse_notion_datetime`] used by the
/// all-invalid DateTime field downgrade pre-scan.
fn parse_notion_datetime_only(raw: &str) -> Option<(DateTime<Utc>, String)> {
  parse_notion_datetime(raw)
}

fn collect_files_manifest(
  rows: &[DatabaseSnapshotRow],
  fields: &[DatabaseSnapshotField],
) -> Vec<DatabaseSnapshotFileManifestEntry> {
  let mut manifest: Vec<DatabaseSnapshotFileManifestEntry> = Vec::new();
  let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
  for row in rows {
    for cell in &row.cells {
      let Some(field) = fields.iter().find(|field| field.id == cell.field_id) else {
        continue;
      };
      if !matches!(field.field_type, DatabaseFieldType::Files) {
        continue;
      }
      let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Files(value)) = &cell.value else {
        continue;
      };
      for file in &value.files {
        if !seen.insert(file.blob_key.clone()) {
          continue;
        }
        manifest.push(DatabaseSnapshotFileManifestEntry {
          blob_key: file.blob_key.clone(),
          name: file.name.clone(),
          mime: file.mime.clone(),
          size: file.size,
          field_name: Some(field.name.clone()),
          row_id: Some(row.id.clone()),
        });
      }
    }
  }
  manifest
}

fn append_content_files_manifest(
  rows: &[DatabaseSnapshotRow],
  assets: &std::collections::BTreeMap<String, Vec<u8>>,
  manifest: &mut Vec<DatabaseSnapshotFileManifestEntry>,
) {
  let mut seen = manifest
    .iter()
    .map(|entry| entry.blob_key.clone())
    .collect::<std::collections::HashSet<_>>();
  for row in rows {
    let Some(content) = &row.content_document else {
      continue;
    };
    for asset_key in &content.asset_keys {
      if !seen.insert(asset_key.clone()) {
        continue;
      }
      manifest.push(DatabaseSnapshotFileManifestEntry {
        blob_key: asset_key.clone(),
        name: asset_key.rsplit('/').next().map(str::to_string),
        mime: Some(guess_mime(asset_key)),
        size: assets.get(asset_key).map(|bytes| bytes.len() as i64),
        field_name: None,
        row_id: Some(row.id.clone()),
      });
    }
  }
}

fn empty_snapshot_database() -> DatabaseSnapshotDatabase {
  let title_field_id = "field_0".to_string();
  let view = DatabaseSnapshotView {
    id: "view_0".to_string(),
    name: "Table".to_string(),
    view_kind: DatabaseViewKind::Table,
    icon: None,
    config: DatabaseSnapshotViewConfig::Table(DatabaseSnapshotTableViewConfig {
      title_field_id: title_field_id.clone(),
      visible_field_ids: vec![title_field_id.clone()],
      field_widths: Default::default(),
      search_field_ids: vec![title_field_id.clone()],
      sort: Vec::new(),
      filter: Vec::new(),
      filter_tree: None,
      group: None,
      subgroup: None,
    }),
    position: 0,
  };
  let field = DatabaseSnapshotField {
    id: title_field_id,
    name: "Title".to_string(),
    field_type: DatabaseFieldType::Title,
    config: DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Text(Default::default())),
    position: 0,
    required: false,
    read_only: false,
  };
  DatabaseSnapshotDatabase {
    managed_template: None,
    id: "database_0".to_string(),
    profile_kind: DatabaseProfileKind::Generic,
    profile_structure_preset: None,
    profile_config: serde_json::json!({}),
    title: "Empty Notion import".to_string(),
    description: None,
    fields: vec![field],
    views: vec![view],
    field_roles: Vec::new(),
    view_roles: Vec::new(),
    rows: Vec::new(),
    row_templates: Vec::new(),
  }
}

fn guess_mime(path: &str) -> String {
  let lower = path.to_ascii_lowercase();
  if lower.ends_with(".png") {
    "image/png".to_string()
  } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
    "image/jpeg".to_string()
  } else if lower.ends_with(".gif") {
    "image/gif".to_string()
  } else if lower.ends_with(".svg") {
    "image/svg+xml".to_string()
  } else if lower.ends_with(".pdf") {
    "application/pdf".to_string()
  } else {
    "application/octet-stream".to_string()
  }
}

/// True when a Notion cell path (what the parser extracts from HTML)
/// refers to the same file as an archive path (the actual ZIP entry
/// name). The cell path may be the bare filename `lamp.png`; the
/// archive path may carry a `assets/` prefix or be a deeper path. We
/// match by full equality, then by trailing-slash basename, then by
/// full suffix when the cell path itself starts with a directory
/// prefix. The match is conservative: we never accept a cell that
/// looks like a different file just because the basenames happen to
/// agree — both strings must end in the same path tail.
fn matches_asset_path(cell_path: &str, archive_path: &str) -> bool {
  if cell_path.is_empty() || archive_path.is_empty() {
    return false;
  }
  if cell_path == archive_path {
    return true;
  }
  let cell_tail = cell_path.trim_start_matches('/');
  let arc_tail = archive_path.trim_start_matches('/');
  cell_tail.ends_with(arc_tail) || arc_tail.ends_with(cell_tail)
}

fn tag_of_kind(kind: NotionPropertyKind) -> &'static str {
  match kind {
    NotionPropertyKind::Title => "title",
    NotionPropertyKind::RichText => "rich_text",
    NotionPropertyKind::Number => "number",
    NotionPropertyKind::Checkbox => "checkbox",
    NotionPropertyKind::Select => "select",
    NotionPropertyKind::MultiSelect => "multi_select",
    NotionPropertyKind::Status => "status",
    NotionPropertyKind::Date => "date",
    NotionPropertyKind::DateTime => "date_time",
    NotionPropertyKind::Url => "url",
    NotionPropertyKind::Email => "email",
    NotionPropertyKind::Phone => "phone_number",
    NotionPropertyKind::People => "people",
    NotionPropertyKind::Files => "files",
    NotionPropertyKind::Relation => "relation",
    NotionPropertyKind::Rollup => "rollup",
    NotionPropertyKind::Formula => "formula",
    NotionPropertyKind::Verification => "verification",
    NotionPropertyKind::CreatedTime => "created_time",
    NotionPropertyKind::CreatedBy => "created_by",
    NotionPropertyKind::LastEditedTime => "last_edited_time",
    NotionPropertyKind::LastEditedBy => "last_edited_by",
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::database::notion_import::{NotionRow, NotionSource, parse_notion_zip};

  fn row_with_title(title: &str, properties: Vec<NotionProperty>) -> NotionRow {
    NotionRow {
      page_id: format!("page-{title}"),
      title: title.to_string(),
      icon: None,
      cover_url: None,
      page_body: None,
      properties,
    }
  }

  fn title_property(text: &str) -> NotionProperty {
    NotionProperty::title("Name", text)
  }

  #[test]
  fn build_snapshot_from_simple_database() {
    let html = r#"
      <html>
        <head><title>My Tasks</title></head>
        <body>
          <table class="collection-content">
            <thead>
              <tr>
                <th data-property-name="Name" data-property-type="title">Name</th>
                <th data-property-name="Done" data-property-type="checkbox">Done</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Write spec</td>
                <td>true</td>
              </tr>
              <tr>
                <td>Send for review</td>
                <td>false</td>
              </tr>
            </tbody>
          </table>
        </body>
      </html>
    "#;
    let parsed = crate::database::notion_import::parser::parse_notion_html(html.as_bytes());
    assert_eq!(parsed.databases.len(), 1);
    let built = build_snapshot_from_notion(&parsed, Some("test.html"));
    assert_eq!(built.snapshot.schema_version, DATABASE_SNAPSHOT_SCHEMA_VERSION);
    // Page-level <title>My Tasks</title> is propagated into the
    // PendingDatabase so the built snapshot carries the page title.
    assert_eq!(built.snapshot.database.title, "My Tasks");
    assert_eq!(built.snapshot.database.profile_kind, DatabaseProfileKind::Generic);
    assert!(built.snapshot.database.field_roles.is_empty());
    assert!(built.snapshot.database.view_roles.is_empty());
    assert_eq!(built.snapshot.database.fields.len(), 2);
    assert_eq!(built.snapshot.database.rows.len(), 2);
    assert_eq!(built.snapshot.database.rows[0].title, "Write spec");
  }

  #[test]
  fn notion_rich_text_becomes_canonical_rich_text_with_lossy_diagnostic() {
    let html = r#"
      <html>
        <head><title>Product brief</title></head>
        <body>
          <table class="collection-content">
            <thead><tr>
              <th data-property-name="Name" data-property-type="title">Name</th>
              <th data-property-name="Description" data-property-type="rich_text">Description</th>
            </tr></thead>
            <tbody><tr><td>Launch</td><td><u>Preserve readable details</u></td></tr></tbody>
          </table>
        </body>
      </html>
    "#;
    let parsed = crate::database::notion_import::parser::parse_notion_html(html.as_bytes());
    let built = build_snapshot_from_notion(&parsed, Some("product-brief.html"));
    let field = built
      .snapshot
      .database
      .fields
      .iter()
      .find(|field| field.name == "Description")
      .expect("Notion RichText field");
    assert_eq!(field.field_type, DatabaseFieldType::RichText);
    let value = built.snapshot.database.rows[0]
      .cells
      .iter()
      .find(|cell| cell.field_id == field.id)
      .and_then(|cell| match &cell.value {
        DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::RichText(value)) => Some(value),
        _ => None,
      })
      .expect("canonical Notion RichText value");
    assert_eq!(value.plain_text, "Preserve readable details");
    assert_eq!(value.document["type"], "doc");
    assert_eq!(value.document["content"][0]["type"], "paragraph");
    assert!(built.diagnostics.iter().any(|diagnostic| {
      diagnostic.code == NotionDiagnosticCode::PropertyDowngraded.as_str() && diagnostic.path.contains(".rows[")
    }));
  }

  #[test]
  fn notion_rich_text_preserves_every_supported_inline_mark() {
    let html = r#"
      <html>
        <head><title>Formatted brief</title></head>
        <body>
          <table class="collection-content">
            <thead><tr>
              <th data-property-name="Name" data-property-type="title">Name</th>
              <th data-property-name="Description" data-property-type="rich_text">Description</th>
            </tr></thead>
            <tbody><tr><td>Launch</td><td><strong>Bold</strong> <em>italic</em> <s>strike</s> <code>code</code><br/><a href="https://example.test/spec">link</a></td></tr></tbody>
          </table>
        </body>
      </html>
    "#;
    let parsed = crate::database::notion_import::parser::parse_notion_html(html.as_bytes());
    let built = build_snapshot_from_notion(&parsed, Some("formatted-brief.html"));
    let field = built
      .snapshot
      .database
      .fields
      .iter()
      .find(|field| field.name == "Description")
      .expect("Notion RichText field");
    let value = built.snapshot.database.rows[0]
      .cells
      .iter()
      .find(|cell| cell.field_id == field.id)
      .and_then(|cell| match &cell.value {
        DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::RichText(value)) => Some(value),
        _ => None,
      })
      .expect("canonical formatted Notion RichText value");

    assert_eq!(value.plain_text, "Bold italic strike code\nlink");
    let nodes = value.document["content"][0]["content"]
      .as_array()
      .expect("canonical inline nodes");
    for (index, mark) in ["bold", "italic", "strike", "code"].into_iter().enumerate() {
      assert_eq!(nodes[index * 2]["marks"][0]["type"], mark);
    }
    assert_eq!(nodes[7]["type"], "hardBreak");
    assert_eq!(nodes[8]["marks"][0]["type"], "link");
    assert_eq!(nodes[8]["marks"][0]["attrs"]["href"], "https://example.test/spec");
    assert!(
      built.diagnostics.iter().all(
        |diagnostic| diagnostic.code != NotionDiagnosticCode::PropertyDowngraded.as_str()
          || !diagnostic.path.contains(".rows[")
      ),
      "supported Notion marks must not be reported as lossy: {:#?}",
      built.diagnostics
    );
  }

  #[test]
  fn named_notion_tag_columns_use_the_workspace_tag_contract() {
    let html = r#"
      <html>
        <head><title>Release tasks</title></head>
        <body>
          <table class="collection-content">
            <thead><tr>
              <th data-property-name="Name" data-property-type="title">Name</th>
              <th data-property-name="Tags" data-property-type="multi_select">Tags</th>
            </tr></thead>
            <tbody><tr><td>Ship</td><td>Backend, Release Ready</td></tr></tbody>
          </table>
        </body>
      </html>
    "#;
    let parsed = crate::database::notion_import::parser::parse_notion_html(html.as_bytes());
    let built = build_snapshot_from_notion(&parsed, Some("release-tasks.html"));
    let tags_field = built
      .snapshot
      .database
      .fields
      .iter()
      .find(|field| field.name == "Tags")
      .expect("Notion Tags field");
    assert_eq!(tags_field.field_type, DatabaseFieldType::Tags);
    let manifest = &built.snapshot.workspace_tags_manifest;
    assert_eq!(manifest.len(), 2);
    assert!(manifest.iter().any(|tag| tag.slug == "backend"));
    assert!(manifest.iter().any(|tag| tag.slug == "release-ready"));
    assert!(manifest.iter().all(|tag| tag.color_role == "tag.grey"));
    let tag_ids = built.snapshot.database.rows[0]
      .cells
      .iter()
      .find(|cell| cell.field_id == tags_field.id)
      .and_then(|cell| match &cell.value {
        DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Tags(tag_ids)) => Some(tag_ids),
        _ => None,
      })
      .expect("Notion workspace tag ids");
    assert_eq!(tag_ids.len(), 2);
    assert!(
      tag_ids
        .iter()
        .all(|tag_id| manifest.iter().any(|tag| tag.id == *tag_id))
    );
  }

  #[test]
  fn empty_notion_parse_yields_empty_snapshot() {
    let parsed = NotionParseResult {
      databases: Vec::new(),
      diagnostics: Vec::new(),
      source: NotionSource::Zip,
      assets: std::collections::BTreeMap::new(),
    };
    let built = build_snapshot_from_notion(&parsed, None);
    assert!(!built.snapshot.database.fields.is_empty());
  }

  #[test]
  fn collect_files_manifest_dedupes() {
    let rows = vec![DatabaseSnapshotRow {
      id: "row_0".to_string(),
      title: "r0".to_string(),
      position: 0,
      content_document: None,
      row_kind: myoxus_domain::database::DatabaseRowKind::Record,
      source: None,
      cells: vec![DatabaseSnapshotCellValue {
        field_id: "field_0".to_string(),
        field_type: DatabaseFieldType::Files,
        value: DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Files(DatabaseFilesValue {
          files: vec![
            DatabaseFileReference {
              blob_key: "notion/a.png".to_string(),
              name: Some("a.png".to_string()),
              mime: Some("image/png".to_string()),
              size: Some(0),
              caption: None,
              cover: false,
            },
            DatabaseFileReference {
              blob_key: "notion/a.png".to_string(),
              name: Some("a.png".to_string()),
              mime: Some("image/png".to_string()),
              size: Some(0),
              caption: None,
              cover: false,
            },
          ],
        })),
      }],
      projections: Vec::new(),
    }];
    let fields = vec![DatabaseSnapshotField {
      id: "field_0".to_string(),
      name: "Attachments".to_string(),
      field_type: DatabaseFieldType::Files,
      config: DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Text(Default::default())),
      position: 0,
      required: false,
      read_only: false,
    }];
    let manifest = collect_files_manifest(&rows, &fields);
    assert_eq!(manifest.len(), 1);
    assert_eq!(manifest[0].blob_key, "notion/a.png");
  }

  #[test]
  fn guess_mime_uses_extension() {
    assert_eq!(guess_mime("foo/Bar.PNG"), "image/png");
    assert_eq!(guess_mime("a.pdf"), "application/pdf");
    assert_eq!(guess_mime("a.unknown"), "application/octet-stream");
  }

  #[test]
  fn matches_asset_path_handles_prefix_and_suffix_overlap() {
    // Full equality is the canonical hit.
    assert!(matches_asset_path("lamp.png", "lamp.png"));
    // Cell path uses bare filename; archive path has the assets/ prefix.
    assert!(matches_asset_path("lamp.png", "assets/lamp.png"));
    assert!(matches_asset_path("assets/lamp.png", "lamp.png"));
    // Deeper archive paths still match.
    assert!(matches_asset_path("img/lamp.png", "Notion Export/assets/img/lamp.png"));
    // Different filenames do not collide.
    assert!(!matches_asset_path("lamp.png", "chair.png"));
    // Empty inputs are safe.
    assert!(!matches_asset_path("", "lamp.png"));
    assert!(!matches_asset_path("lamp.png", ""));
  }

  #[test]
  fn title_row_uses_page_slug_fallback() {
    let doc = NotionDocument {
      database_id: "db0".to_string(),
      title: "Tasks".to_string(),
      description: None,
      properties: vec![NotionProperty::title("Name", "")],
      rows: vec![row_with_title("", vec![title_property("")])],
    };
    let parsed = NotionParseResult {
      databases: vec![doc],
      diagnostics: Vec::new(),
      source: NotionSource::Zip,
      assets: std::collections::BTreeMap::new(),
    };
    let built = build_snapshot_from_notion(&parsed, None);
    assert!(
      built
        .diagnostics
        .iter()
        .any(|d| d.code == NotionDiagnosticCode::EmptyTitleFallback.as_str())
    );
    assert!(built.snapshot.database.rows[0].title.starts_with("Untitled ("));
  }

  #[test]
  fn zip_parse_returns_diagnostic_on_invalid_archive() {
    let result = parse_notion_zip(b"not a real zip");
    assert!(result.databases.is_empty());
    assert!(
      result
        .diagnostics
        .iter()
        .any(|d| d.code == NotionDiagnosticCode::ZipParseFailed.as_str())
    );
  }

  #[test]
  fn unused_status_field_default_option_is_set() {
    let doc = NotionDocument {
      database_id: "db0".to_string(),
      title: "Tasks".to_string(),
      description: None,
      properties: vec![
        NotionProperty::title("Name", "x"),
        NotionProperty {
          name: "State".to_string(),
          kind: NotionPropertyKind::Status,
          raw_text: None,
          rich_text: Vec::new(),
          rich_text_lossy: false,
          select_options: vec!["Open".to_string(), "Closed".to_string()],
          date_start: None,
          date_end: None,
          number: None,
          checkbox: None,
          relation_targets: Vec::new(),
          rollup_aggregate: None,
          file_paths: Vec::new(),
          url: None,
          email: None,
          phone: None,
          people: Vec::new(),
          tags: Vec::new(),
        },
      ],
      rows: vec![row_with_title(
        "Task 1",
        vec![title_property("Task 1"), {
          let mut p = NotionProperty {
            name: "State".to_string(),
            kind: NotionPropertyKind::Status,
            raw_text: None,
            rich_text: Vec::new(),
            rich_text_lossy: false,
            select_options: vec!["Open".to_string()],
            date_start: None,
            date_end: None,
            number: None,
            checkbox: None,
            relation_targets: Vec::new(),
            rollup_aggregate: None,
            file_paths: Vec::new(),
            url: None,
            email: None,
            phone: None,
            people: Vec::new(),
            tags: Vec::new(),
          };
          p.kind = NotionPropertyKind::Status;
          p
        }],
      )],
    };
    let parsed = NotionParseResult {
      databases: vec![doc],
      diagnostics: Vec::new(),
      source: NotionSource::Zip,
      assets: std::collections::BTreeMap::new(),
    };
    let built = build_snapshot_from_notion(&parsed, None);
    let state_field = built
      .snapshot
      .database
      .fields
      .iter()
      .find(|f| f.name == "State")
      .unwrap();
    if let DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Status(config)) = &state_field.config {
      assert_eq!(config.options.len(), 2);
      assert!(!config.default_option_id.is_empty());
    } else {
      panic!("expected Status config");
    }
  }
}
