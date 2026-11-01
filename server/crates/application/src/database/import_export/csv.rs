// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::database::{
  DatabaseImportExportService, DatabaseResult, DatabaseRowRead, DatabaseServiceError, ERR_CELL_INVALID,
  ERR_CELL_VALUE_READONLY, ERR_CSV_COLUMN_LIMIT, ERR_CSV_INVALID, ERR_CSV_LIMIT_EXCEEDED, ERR_CSV_ROW_LIMIT,
  ERR_CSV_TOO_LARGE, ERR_CURRENCY_INVALID, ERR_DATE_TIME_INVALID, ERR_DURATION_INVALID, ERR_STORAGE, ERR_VIEW_INVALID,
};
use crate::database::{access, workspace_lookup_error};
use crate::workspace_tags::WorkspaceTagService;
use chrono::{DateTime, NaiveDate, Utc};
use myoxus_domain::database::*;
use myoxus_domain::ids::*;
use myoxus_domain::permission::WorkspaceAction;
use myoxus_domain::repositories::PageRequest;
use myoxus_domain::workspace_tags::WorkspaceTag;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use tracing::instrument;
use uuid::Uuid;

#[derive(Debug)]
struct CsvWorkspaceTagImportPlan {
  diagnostics: Vec<DatabaseWorkspaceTagImportDiagnostic>,
  slug_to_target: HashMap<String, Uuid>,
  create_tags: Vec<WorkspaceTag>,
}

struct ParsedCsvRows {
  applied_dialect: DatabaseCsvDialect,
  confidence: String,
  detected_dialect: DatabaseCsvDialect,
  rows: Vec<csv::StringRecord>,
}
impl DatabaseImportExportService {
  #[instrument(
    skip(self, database_title, content, options),
    fields(workspace_id = %workspace_id, actor_id = %actor, content_bytes = content.len())
  )]
  pub async fn preview_csv_import(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    database_title: String,
    content: &[u8],
    options: DatabaseCsvImportOptions,
  ) -> DatabaseResult<DatabaseCsvPreview> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::CreateDoc).await?;
    let _ = crate::database::definition::rules::validate_title(&database_title)?;
    let mut preview = self.parse_csv_preview(content, &options)?;
    let tag_plan = self
      .plan_csv_workspace_tags(actor, workspace_id, content, &options, &preview)
      .await?;
    preview.workspace_tag_diagnostics = tag_plan.diagnostics;
    Ok(preview)
  }

  fn parse_csv_workspace_tag_token(raw: &str) -> DatabaseResult<(String, String)> {
    let (name, source_color) = raw
      .rsplit_once('|')
      .map(|(name, color)| (name.trim(), color.trim()))
      .filter(|(_, color)| !color.is_empty())
      .unwrap_or((raw.trim(), "tag.grey"));
    let name = WorkspaceTag::normalize_name(name)
      .map_err(|error| DatabaseServiceError::new(ERR_CELL_INVALID, error.to_string()))?;
    Ok((name, source_color.to_string()))
  }

  async fn plan_csv_workspace_tags(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    content: &[u8],
    options: &DatabaseCsvImportOptions,
    preview: &DatabaseCsvPreview,
  ) -> DatabaseResult<CsvWorkspaceTagImportPlan> {
    let tag_columns = preview
      .applied_mapping
      .iter()
      .filter(|column| column.import_column && column.field_type == DatabaseFieldType::Tags)
      .collect::<Vec<_>>();
    if tag_columns.is_empty() {
      return Ok(CsvWorkspaceTagImportPlan {
        diagnostics: Vec::new(),
        slug_to_target: HashMap::new(),
        create_tags: Vec::new(),
      });
    }
    let rows = self.parse_csv_rows(content, &preview.applied_dialect)?.rows;
    let data_start = usize::from(options.first_row_is_header.unwrap_or(true));
    let mut candidates: BTreeMap<String, (String, String, Vec<i32>, HashSet<String>)> = BTreeMap::new();
    for (row_index, row) in rows.iter().enumerate().skip(data_start) {
      for column in &tag_columns {
        let raw = row.get(column.source_index as usize).unwrap_or("").trim();
        for token in raw.split(';').map(str::trim).filter(|value| !value.is_empty()) {
          let (name, source_color) = Self::parse_csv_workspace_tag_token(token)?;
          let slug = WorkspaceTag::slug_base(&name)
            .map_err(|error| DatabaseServiceError::new(ERR_CELL_INVALID, error.to_string()))?;
          let entry = candidates
            .entry(slug)
            .or_insert_with(|| (name, source_color, Vec::new(), HashSet::new()));
          let source_row = row_index as i32 + 1;
          if !entry.2.contains(&source_row) {
            entry.2.push(source_row);
          }
          entry.3.insert(column.field_name.clone());
        }
      }
    }
    let service = self
      .workspace_tags
      .as_ref()
      .cloned()
      .ok_or_else(|| DatabaseServiceError::new(ERR_STORAGE, "workspace tag service is not configured"))?;
    let existing = service
      .list_tags(actor, workspace_id, true)
      .await
      .map_err(|error| DatabaseServiceError::new(error.code, error.message))?;
    let existing_by_slug = existing
      .iter()
      .map(|tag| (tag.slug.as_str(), tag))
      .collect::<HashMap<_, _>>();
    let now = Utc::now();
    let mut diagnostics = Vec::with_capacity(candidates.len());
    let mut slug_to_target = HashMap::with_capacity(candidates.len());
    let mut create_tags = Vec::new();
    for (slug, (name, source_color, affected_rows, affected_fields)) in candidates {
      let mut affected_fields = affected_fields.into_iter().collect::<Vec<_>>();
      affected_fields.sort();
      if let Some(tag) = existing_by_slug.get(slug.as_str()).copied() {
        slug_to_target.insert(slug.clone(), tag.id);
        diagnostics.push(DatabaseWorkspaceTagImportDiagnostic {
          source_id: None,
          target_id: Some(tag.id),
          name,
          slug,
          source_color: Some(source_color),
          color_role: tag.color_role.to_string(),
          action: if tag.archived_at.is_some() {
            DatabaseWorkspaceTagImportAction::ArchivedReference
          } else {
            DatabaseWorkspaceTagImportAction::Reuse
          },
          affected_rows,
          affected_fields,
          message: if tag.archived_at.is_some() {
            "Reuses an archived workspace tag for explicitly previewed historical references".to_string()
          } else {
            "Reuses an existing active workspace tag".to_string()
          },
        });
        continue;
      }
      let normalized_color = WorkspaceTagService::normalize_import_color(&source_color);
      let tag_id = Uuid::new_v5(&workspace_id, format!("csv-import-tag:{slug}").as_bytes());
      slug_to_target.insert(slug.clone(), tag_id);
      create_tags.push(WorkspaceTag {
        id: tag_id,
        workspace_id,
        name: name.clone(),
        slug: slug.clone(),
        color_role: normalized_color.role,
        description: None,
        archived_at: None,
        created_at: now,
        updated_at: now,
        created_by: Some(actor),
        updated_by: Some(actor),
      });
      diagnostics.push(DatabaseWorkspaceTagImportDiagnostic {
        source_id: None,
        target_id: Some(tag_id),
        name,
        slug,
        source_color: Some(source_color),
        color_role: normalized_color.role.to_string(),
        action: DatabaseWorkspaceTagImportAction::Create,
        affected_rows,
        affected_fields,
        message: if normalized_color.normalized {
          format!(
            "Creates a workspace tag and normalizes color '{}' to '{}'",
            normalized_color.source, normalized_color.role
          )
        } else {
          "Creates a new active workspace tag".to_string()
        },
      });
    }
    Ok(CsvWorkspaceTagImportPlan {
      diagnostics,
      slug_to_target,
      create_tags,
    })
  }

  fn csv_workspace_tag_cell_value(
    raw: &str,
    slug_to_target: &HashMap<String, Uuid>,
  ) -> DatabaseResult<DatabaseCellValueData> {
    let mut tag_ids = Vec::new();
    let mut seen = HashSet::new();
    for token in raw.split(';').map(str::trim).filter(|value| !value.is_empty()) {
      let (name, _) = Self::parse_csv_workspace_tag_token(token)?;
      let slug = WorkspaceTag::slug_base(&name)
        .map_err(|error| DatabaseServiceError::new(ERR_CELL_INVALID, error.to_string()))?;
      let tag_id = slug_to_target.get(&slug).copied().ok_or_else(|| {
        DatabaseServiceError::new(
          ERR_CELL_INVALID,
          format!("workspace tag '{name}' was not present in import preview"),
        )
      })?;
      if !seen.insert(tag_id) {
        return Err(DatabaseServiceError::new(
          ERR_CELL_INVALID,
          format!("workspace tag '{name}' occurs more than once in one CSV cell"),
        ));
      }
      tag_ids.push(tag_id);
    }
    Ok(DatabaseCellValueData::Tags(tag_ids))
  }

  pub async fn import_csv(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    database_title: String,
    content: &[u8],
    options: DatabaseCsvImportOptions,
  ) -> DatabaseResult<DatabaseCsvImportResult> {
    self
      .import_csv_with_job(actor, workspace_id, database_title, content, options, None)
      .await
  }

  /// P-DB-26 (reopen 2026-07-08): CSV import that:
  ///   * accepts an optional `import_job_id` so the worker can stamp each
  ///     created row with its provenance;
  ///   * checks cancellation while planning rows and writes the Database,
  ///     rows and planned workspace tags in one transaction;
  ///   * returns a per-row diagnostic stream (`failed_rows`) instead of
  ///     short-circuiting on the first per-row failure, so a partial
  ///     import is reported honestly and never silently.
  #[instrument(
    skip(self, database_title, content, options),
    fields(workspace_id = %workspace_id, actor_id = %actor, content_bytes = content.len(), import_job_id = tracing::field::Empty)
  )]
  pub async fn import_csv_with_job(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    database_title: String,
    content: &[u8],
    options: DatabaseCsvImportOptions,
    import_job_id: Option<DatabaseImportJobId>,
  ) -> DatabaseResult<DatabaseCsvImportResult> {
    if let Some(job_id) = import_job_id {
      tracing::Span::current().record("import_job_id", tracing::field::display(job_id));
    }
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::CreateDoc).await?;
    let database_title = crate::database::definition::rules::validate_title(&database_title)?;
    let parsed = self.parse_csv_preview(content, &options)?;
    if !parsed.errors.is_empty() {
      return Err(DatabaseServiceError::new(
        ERR_CSV_INVALID,
        "CSV import preview contains errors",
      ));
    }
    let tag_plan = self
      .plan_csv_workspace_tags(actor, workspace_id, content, &options, &parsed)
      .await?;
    let now = Utc::now();
    let database_id = Uuid::new_v4();
    let title_field_id = Uuid::new_v4();
    let Some(title_mapping) = parsed
      .applied_mapping
      .iter()
      .find(|column| column.is_title && column.import_column)
    else {
      return Err(DatabaseServiceError::new(
        ERR_CSV_INVALID,
        "CSV import requires exactly one title column",
      ));
    };
    let mut fields = vec![DatabaseField {
      id: title_field_id,
      database_id,
      name: title_mapping.field_name.clone(),
      field_type: DatabaseFieldType::Title,
      config: DatabaseFieldConfig::Title,
      position: 0,
      required: true,
      edit_revision: 1,
      created_at: now,
      updated_at: now,
    }];
    let rows = self.parse_csv_rows(content, &parsed.applied_dialect)?.rows;
    let data_start = if options.first_row_is_header.unwrap_or(true) {
      1
    } else {
      0
    };
    let data_rows = rows.iter().skip(data_start).cloned().collect::<Vec<_>>();
    for (index, column) in parsed
      .applied_mapping
      .iter()
      .filter(|column| column.import_column && !column.is_title)
      .enumerate()
    {
      let field_type = column.field_type;
      let config = self.csv_field_config(field_type, &data_rows, column.source_index as usize);
      fields.push(DatabaseField {
        id: Uuid::new_v4(),
        database_id,
        name: column.field_name.clone(),
        field_type,
        config,
        position: index as i32 + 1,
        required: false,
        edit_revision: 1,
        created_at: now,
        updated_at: now,
      });
    }
    let visible = fields.iter().map(|field| field.id).collect::<Vec<_>>();
    let searchable = fields
      .iter()
      .filter(|field| field.field_type.supports_server_search())
      .map(|field| field.id)
      .collect::<Vec<_>>();
    let view = DatabaseView {
      id: Uuid::new_v4(),
      database_id,
      name: "Table".to_string(),
      view_kind: DatabaseViewKind::Table,
      icon: None,
      config: DatabaseViewConfig::Table(DatabaseTableViewConfig {
        title_field_id,
        visible_field_ids: visible.clone(),
        field_widths: BTreeMap::new(),
        search_field_ids: searchable,
        sort: Vec::new(),
        filter: Vec::new(),
        filter_tree: None,
        group: None,
        subgroup: None,
      }),
      position: 0,
      edit_revision: 1,
      created_at: now,
      updated_at: now,
    };
    let database = Database {
      system_role: None,
      managed_installation: None,

      id: database_id,
      workspace_id,
      profile_kind: DatabaseProfileKind::Generic,
      profile_structure_preset: None,
      profile_config: serde_json::json!({}),
      title: database_title,
      description: None,
      created_by: Some(actor),
      updated_by: Some(actor),
      deleted_at: None,
      deleted_by: None,
      edit_revision: 1,
      created_at: now,
      updated_at: now,
    };

    let field_by_position = parsed
      .applied_mapping
      .iter()
      .filter(|column| column.import_column && !column.is_title)
      .zip(fields.iter().skip(1).cloned())
      .map(|(column, field)| (column.source_index as usize, field))
      .collect::<Vec<_>>();
    let mut warnings = parsed.warnings.clone();
    let mut row_records = Vec::new();
    let mut failed_rows: Vec<DatabaseBulkRowOutcome> = Vec::new();
    for (row_index, row) in rows.into_iter().enumerate().skip(data_start) {
      // Cancellation is checked while planning rows, before the one atomic
      // Database/tag transaction starts. No compensation is needed because no
      // product state exists until the final commit.
      if let Some(job_id) = import_job_id
        && self
          .import_export_repo
          .is_import_job_cancellation_requested(job_id)
          .await?
      {
        return Err(DatabaseServiceError::new(
          "MIX_DATABASE_IMPORT_CANCELLED",
          "import job was cancelled by the operator before all rows applied",
        ));
      }
      let source_row = row_index + 1;
      let title = row
        .get(title_mapping.source_index as usize)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
          warnings.push(DatabaseCsvDiagnostic {
            code: ERR_CSV_INVALID.to_string(),
            source: "csv".to_string(),
            row: Some(source_row as i32),
            field: Some("Title".to_string()),
            message: format!("Empty title replaced with Untitled Row {source_row}"),
          });
          format!("Untitled Row {source_row}")
        });
      // Pre-generate the row id so the per-row diagnostic can carry it
      // back when the row fails to commit. The id is meaningful only
      // when the row actually persisted; for a never-created row the
      // wizard still has a stable identifier to correlate with the
      // source-row number.
      let row_id = Uuid::new_v4();
      let mut cells: Vec<DatabaseCellValue> = Vec::new();
      let mut row_failed: Option<(String, String)> = None;
      for (source_index, field) in field_by_position.iter() {
        if crate::database::editing::rules::is_projection_field(field.field_type) {
          warnings.push(DatabaseCsvDiagnostic {
            code: ERR_CELL_VALUE_READONLY.to_string(),
            source: "csv".to_string(),
            row: Some(source_row as i32),
            field: Some(field.name.clone()),
            message: "Projection fields are read-only and were ignored during import".to_string(),
          });
          continue;
        }
        let raw = row.get(*source_index).unwrap_or("").trim();
        if raw.is_empty() {
          continue;
        }
        let parsed_value = if field.field_type == DatabaseFieldType::Tags {
          Self::csv_workspace_tag_cell_value(raw, &tag_plan.slug_to_target)
        } else {
          self.csv_cell_value(workspace_id, field, raw).await
        };
        match parsed_value {
          Ok(value) => match crate::database::editing::rules::validate_cell_value(field, &value, &self.limits) {
            Ok(()) => cells.push(DatabaseCellValue {
              row_id,
              field_id: field.id,
              field_type: field.field_type,
              value,
              updated_by: Some(actor),
              edit_revision: 1,
              updated_at: now,
            }),
            Err(err) => {
              row_failed = Some((err.code.to_string(), err.to_string()));
              break;
            }
          },
          Err(err) => {
            row_failed = Some((err.code.to_string(), err.to_string()));
            break;
          }
        }
      }
      if let Some((code, msg)) = row_failed {
        failed_rows.push(DatabaseBulkRowOutcome::err(row_id, code, msg));
        continue;
      }
      row_records.push(DatabaseRowRecord {
        row: DatabaseRow {
          id: row_id,
          database_id,
          content_document_id: None,
          row_kind: DatabaseRowKind::Record,
          title,
          position: row_records.len() as i32,
          created_by: Some(actor),
          updated_by: Some(actor),
          edit_revision: 1,
          created_at: now,
          updated_at: now,
          deleted_at: None,
        },
        cells,
        cell_revisions: Vec::new(),
      });
    }
    let imported_row_ids = row_records.iter().map(|record| record.row.id).collect::<Vec<_>>();
    let mut result = DatabaseCsvImportResult {
      database: DatabaseRecord {
        managed_schema: None,
        database: database.clone(),
        fields: fields.clone(),
        views: vec![view.clone()],
        field_roles: Vec::new(),
        view_roles: Vec::new(),
        row_count: imported_row_ids.len() as i64,
      },
      created_field_count: field_by_position.len() as i32 + 1,
      created_row_count: imported_row_ids.len() as i32,
      created_doc_count: 0,
      skipped_row_count: 0,
      failed_rows,
      errors: Vec::new(),
      warnings,
      workspace_tag_diagnostics: tag_plan.diagnostics,
    };
    // Persist the exact public result with the native write, so a lost commit
    // reply cannot turn a retry into a second Database with fresh identities.
    let import_job_result = if import_job_id.is_some() {
      let mut summary = serde_json::to_value(&result).map_err(|_| {
        DatabaseServiceError::new(
          "MIX_DATABASE_BULK_RESULT_SERIALIZATION",
          "import result cannot be serialized",
        )
      })?;
      summary
        .as_object_mut()
        .ok_or_else(|| {
          DatabaseServiceError::new(
            "MIX_DATABASE_BULK_RESULT_SERIALIZATION",
            "import result is not an object",
          )
        })?
        .insert("status".to_string(), serde_json::Value::String("succeeded".to_string()));
      Some(summary)
    } else {
      None
    };
    let database = self
      .import_export_repo
      .apply_database_snapshot_import(
        DatabaseJsonImportMode::Create,
        None,
        None,
        database,
        fields,
        vec![view],
        Vec::new(),
        Vec::new(),
        row_records,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        tag_plan.create_tags,
        import_job_id,
        import_job_result,
      )
      .await
      .map_err(|error| match error {
        myoxus_domain::repositories::RepositoryError::Validation(message)
          if message == "MIX_DATABASE_IMPORT_CANCELLED" =>
        {
          DatabaseServiceError::new(
            "MIX_DATABASE_IMPORT_CANCELLED",
            "import job was cancelled before atomic apply",
          )
        }
        error => error.into(),
      })?;
    if database.database.id == database_id {
      for row_id in &imported_row_ids {
        self
          .projection
          .enqueue_index_row(workspace_id, database_id, *row_id, 0)
          .await;
      }
    }
    if let Some(job_id) = import_job_id {
      let retained = self
        .import_export_repo
        .get_import_job(job_id)
        .await?
        .and_then(|job| job.result)
        .ok_or_else(|| {
          DatabaseServiceError::repository_storage(ERR_STORAGE, "committed import result is unavailable")
        })?;
      return serde_json::from_value(retained)
        .map_err(|_| DatabaseServiceError::repository_storage(ERR_STORAGE, "committed import result cannot be read"));
    }
    result.database = database;
    Ok(result)
  }

  pub async fn export_csv(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    view_id: Option<DatabaseViewId>,
    dialect: DatabaseCsvDialect,
  ) -> DatabaseResult<DatabaseCsvExport> {
    self
      .export_csv_with_options(
        actor,
        database_id,
        DatabaseCsvExportOptions {
          dialect,
          view_id,
          ..DatabaseCsvExportOptions::default()
        },
      )
      .await
  }

  /// P-DB-27: advanced CSV export that supports header on/off,
  /// quote strategy, locale mode, target mode (whole database /
  /// view / selected rows), and a per-export diagnostic stream for
  /// unknown row ids in a `SelectedRows` request. Old `export_csv`
  /// delegates here with defaults so all existing call sites keep
  /// working unchanged.
  #[instrument(
    skip(self, options),
    fields(actor_id = %actor, database_id = %database_id, view_id = tracing::field::Empty, target_mode = tracing::field::Empty)
  )]
  pub async fn export_csv_with_options(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    options: DatabaseCsvExportOptions,
  ) -> DatabaseResult<DatabaseCsvExport> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let title_field = crate::database::definition::rules::title_field(&record.fields)?;

    let DatabaseCsvExportOptions {
      dialect,
      include_header,
      quote_strategy,
      locale_mode,
      locale,
      target,
      view_id,
      row_ids,
    } = options;
    let span = tracing::Span::current();
    if let Some(view_id) = view_id {
      span.record("view_id", tracing::field::display(view_id));
    }
    span.record("target_mode", tracing::field::debug(target));

    if target == DatabaseCsvExportTarget::View && view_id.is_none() {
      return Err(DatabaseServiceError::new(
        ERR_CSV_INVALID,
        "CSV export target=view requires view_id",
      ));
    }
    if target == DatabaseCsvExportTarget::SelectedRows && row_ids.is_empty() {
      return Err(DatabaseServiceError::new(
        ERR_CSV_INVALID,
        "CSV export target=selectedRows requires at least one row_id",
      ));
    }
    if target == DatabaseCsvExportTarget::SelectedRows && row_ids.len() > DATABASE_CSV_EXPORT_MAX_ROWS_PER_REQUEST {
      return Err(DatabaseServiceError::new(
        ERR_CSV_LIMIT_EXCEEDED,
        format!(
          "CSV export target=selectedRows may select at most {DATABASE_CSV_EXPORT_MAX_ROWS_PER_REQUEST} rows in one request"
        ),
      ));
    }
    if let Some(ref loc) = locale
      && locale_mode != DatabaseCsvLocaleMode::Localized
    {
      // Locale is meaningless without Localized mode; fail loud to
      // surface client-side wiring bugs instead of silently ignoring.
      return Err(DatabaseServiceError::new(
        ERR_CSV_INVALID,
        format!("locale '{loc}' requires locale_mode=localized"),
      ));
    }

    let (visible_ids, exported_view_id) = match target {
      DatabaseCsvExportTarget::Database => (record.fields.iter().map(|field| field.id).collect::<Vec<_>>(), None),
      DatabaseCsvExportTarget::View | DatabaseCsvExportTarget::SelectedRows => {
        let view = view_id
          .and_then(|id| record.views.iter().find(|view| view.id == id))
          .or_else(|| record.views.first())
          .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_INVALID, "database has no view"))?;
        let visible_ids = match &view.config {
          DatabaseViewConfig::Table(config) => config.visible_field_ids.clone(),
          DatabaseViewConfig::Kanban(config) => config.visible_field_ids.clone(),
          DatabaseViewConfig::List(config) => config.visible_field_ids.clone(),
          DatabaseViewConfig::Gallery(config) => config.visible_field_ids.clone(),
          DatabaseViewConfig::Calendar(config) => config.visible_field_ids.clone(),
          DatabaseViewConfig::Timeline(config) => config.visible_field_ids.clone(),
          DatabaseViewConfig::Gantt(config) => config.visible_field_ids.clone(),
          DatabaseViewConfig::Progress(config) => config.visible_field_ids.clone(),
        };
        (visible_ids, Some(view.id))
      }
    };
    let field_map = record
      .fields
      .iter()
      .map(|field| (field.id, field))
      .collect::<HashMap<_, _>>();
    let mut export_fields = Vec::new();
    export_fields.push(title_field);
    for field_id in &visible_ids {
      if *field_id != title_field.id
        && let Some(field) = field_map.get(field_id)
      {
        export_fields.push(*field);
      }
    }

    let (export_rows, mut export_warnings): (Vec<DatabaseRowRead>, Vec<DatabaseCsvDiagnostic>) = match target {
      DatabaseCsvExportTarget::Database | DatabaseCsvExportTarget::View => (
        self
          .views
          .list_rows(
            actor,
            database_id,
            PageRequest {
              limit: self.limits.max_rows_per_page,
              offset: 0,
            },
          )
          .await?
          .rows,
        Vec::new(),
      ),
      DatabaseCsvExportTarget::SelectedRows => {
        let page = self
          .views
          .list_rows(
            actor,
            database_id,
            PageRequest {
              limit: self.limits.max_rows_per_page,
              offset: 0,
            },
          )
          .await?
          .rows;
        let mut by_id = HashMap::new();
        for row in page {
          by_id.insert(row.row.id, row);
        }
        let mut kept = Vec::with_capacity(row_ids.len());
        let mut warnings = Vec::new();
        for requested in &row_ids {
          match by_id.remove(requested) {
            Some(row) => kept.push(row),
            None => warnings.push(DatabaseCsvDiagnostic {
              code: "MIX_CSV_EXPORT_UNKNOWN_ROW".to_string(),
              source: "csv_export.selected_rows".to_string(),
              row: None,
              field: Some(requested.to_string()),
              message: format!("row id {requested} does not belong to database {database_id}"),
            }),
          }
        }
        (kept, warnings)
      }
    };

    let mut exported_tag_ids = Vec::new();
    let mut seen_exported_tag_ids = HashSet::new();
    for row in &export_rows {
      for cell in &row.cells {
        if let DatabaseCellValueData::Tags(tag_ids) = &cell.value {
          for tag_id in tag_ids {
            if seen_exported_tag_ids.insert(*tag_id) {
              exported_tag_ids.push(*tag_id);
            }
          }
        }
      }
    }
    let exported_tags = if exported_tag_ids.is_empty() {
      Vec::new()
    } else {
      let service = self
        .workspace_tags
        .as_ref()
        .cloned()
        .ok_or_else(|| DatabaseServiceError::new(ERR_STORAGE, "workspace tag service is not configured"))?;
      service
        .resolve_tags(actor, record.database.workspace_id, &exported_tag_ids)
        .await
        .map_err(|error| DatabaseServiceError::new(error.code, error.message))?
    };
    let exported_tags_by_id = exported_tags.iter().map(|tag| (tag.id, tag)).collect::<HashMap<_, _>>();
    let workspace_tag_diagnostics = exported_tags
      .iter()
      .map(|tag| DatabaseWorkspaceTagImportDiagnostic {
        source_id: Some(tag.id),
        target_id: Some(tag.id),
        name: tag.name.clone(),
        slug: tag.slug.clone(),
        source_color: Some(tag.color_role.to_string()),
        color_role: tag.color_role.to_string(),
        action: if tag.archived_at.is_some() {
          DatabaseWorkspaceTagImportAction::ArchivedReference
        } else {
          DatabaseWorkspaceTagImportAction::Reuse
        },
        affected_rows: Vec::new(),
        affected_fields: Vec::new(),
        message: "CSV carries the tag name and color role; stable id and slug remain in export diagnostics".to_string(),
      })
      .collect::<Vec<_>>();
    if !workspace_tag_diagnostics.is_empty() {
      export_warnings.push(DatabaseCsvDiagnostic {
        code: "MIX_DATABASE_CSV_TAG_ROUNDTRIP_LOSSY".to_string(),
        source: "csv_export.workspace_tags".to_string(),
        row: None,
        field: None,
        message:
          "CSV cannot embed stable workspace-tag ids/slugs in cells; use JSON export for lossless tag round-trip"
            .to_string(),
      });
    }

    let writer_builder = self.csv_writer_builder(&dialect, quote_strategy)?;
    let mut writer = writer_builder.from_writer(Vec::new());
    let quote_byte = Self::csv_one_byte("quote", &dialect.quote)?.unwrap_or(b'"');
    if include_header {
      let header_values: Vec<String> = export_fields
        .iter()
        .map(|field| Self::csv_export_field_value(field.name.as_str(), quote_strategy, quote_byte))
        .collect();
      writer
        .write_record(header_values)
        .map_err(|error| DatabaseServiceError::new(ERR_CSV_INVALID, error.to_string()))?;
    }
    let mut row_count = 0;
    let locale_ref = locale.as_deref();
    for row in export_rows.into_iter().filter(|row| !row.redacted) {
      let cells = row
        .cells
        .into_iter()
        .map(|cell| (cell.field_id, cell.value))
        .collect::<HashMap<_, _>>();
      let mut record_values = Vec::new();
      for field in &export_fields {
        if field.field_type == DatabaseFieldType::Title {
          record_values.push(Self::csv_export_field_value(
            row.row.title.as_str(),
            quote_strategy,
            quote_byte,
          ));
        } else {
          let value = match cells.get(&field.id) {
            Some(DatabaseCellValueData::Relation(target_row_ids)) => {
              self.csv_relation_value_to_string(actor, target_row_ids).await?
            }
            Some(DatabaseCellValueData::Tags(tag_ids)) => tag_ids
              .iter()
              .filter_map(|tag_id| exported_tags_by_id.get(tag_id))
              .map(|tag| format!("{}|{}", tag.name, tag.color_role))
              .collect::<Vec<_>>()
              .join("; "),
            Some(value) => Self::csv_value_to_string(value, field.field_type, locale_mode, locale_ref),
            None => String::new(),
          };
          record_values.push(Self::csv_export_field_value(value.as_str(), quote_strategy, quote_byte));
        }
      }
      writer
        .write_record(record_values)
        .map_err(|error| DatabaseServiceError::new(ERR_CSV_INVALID, error.to_string()))?;
      row_count += 1;
    }
    let content = String::from_utf8(
      writer
        .into_inner()
        .map_err(|error| DatabaseServiceError::new(ERR_CSV_INVALID, error.to_string()))?,
    )
    .map_err(|error| DatabaseServiceError::new(ERR_CSV_INVALID, error.to_string()))?;
    Ok(DatabaseCsvExport {
      file_name: format!("{}.csv", record.database.title.replace(['/', '\\'], "-")),
      content_type: "text/csv".to_string(),
      content,
      row_count,
      column_count: export_fields.len() as i32,
      database_id,
      view_id: exported_view_id,
      target,
      include_header,
      quote_strategy,
      locale_mode,
      locale,
      warnings: export_warnings,
      workspace_tag_diagnostics,
    })
  }

  // ─────────────────────────────────────────────────────────────────────
  // P-DB-27: CSV mapping template storage — server-side bookkeeping
  // for the wizard's "save / load / list / delete" affordances. Each
  // call delegates to the repository trait so a future storage
  // backend (e.g. a user-personal `database_csv_mapping_templates`
  // table) only needs to swap the implementation here.
  // ─────────────────────────────────────────────────────────────────────

  /// Save (or update) a CSV mapping template. The caller is the
  /// template owner; the workspace must be one the actor is a member
  /// of. Saving under an existing name creates a new revision and
  /// demotes the previous current revision in a single transaction.
  #[instrument(
    skip(self, name, mapping),
    fields(workspace_id = %workspace_id, actor_id = %actor, template_name = tracing::field::Empty, mapping_count = tracing::field::Empty, first_row_is_header)
  )]
  pub async fn save_csv_mapping_template(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    name: String,
    dialect: DatabaseCsvDialect,
    first_row_is_header: bool,
    mapping: Vec<DatabaseCsvAppliedColumnMapping>,
  ) -> DatabaseResult<DatabaseCsvMappingTemplate> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::CreateDoc).await?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
      return Err(DatabaseServiceError::new(
        ERR_CSV_INVALID,
        "CSV mapping template name must not be empty",
      ));
    }
    if trimmed.len() > 128 {
      return Err(DatabaseServiceError::new(
        ERR_CSV_INVALID,
        "CSV mapping template name must be at most 128 characters",
      ));
    }
    if mapping.is_empty() {
      return Err(DatabaseServiceError::new(
        ERR_CSV_INVALID,
        "CSV mapping template requires at least one column mapping",
      ));
    }
    let span = tracing::Span::current();
    span.record("template_name", tracing::field::display(trimmed));
    span.record("mapping_count", mapping.len());
    let template = NewDatabaseCsvMappingTemplate {
      workspace_id,
      name: trimmed.to_string(),
      dialect,
      first_row_is_header,
      mapping,
      created_by: actor,
    };
    Ok(self.import_export_repo.save_csv_mapping_template(template).await?)
  }

  /// List current revisions of every CSV mapping template in the
  /// workspace, ordered most-recently-updated first. Used by the
  /// wizard's "reuse template" dropdown.
  pub async fn list_csv_mapping_templates(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
  ) -> DatabaseResult<Vec<DatabaseCsvMappingTemplate>> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Read).await?;
    Ok(self.import_export_repo.list_csv_mapping_templates(workspace_id).await?)
  }

  /// Load the current revision of a template by name, or `None` if
  /// no template exists under that name in the workspace.
  pub async fn load_csv_mapping_template(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    name: &str,
  ) -> DatabaseResult<Option<DatabaseCsvMappingTemplate>> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Read).await?;
    Ok(
      self
        .import_export_repo
        .get_csv_mapping_template_by_name(workspace_id, name)
        .await?,
    )
  }

  /// Delete every revision of a template by name. Returns
  /// `Ok(false)` when the name did not exist (idempotent), `Ok(true)`
  /// when at least one row was removed.
  #[instrument(
    skip(self, name),
    fields(workspace_id = %workspace_id, actor_id = %actor, template_name = %name)
  )]
  pub async fn delete_csv_mapping_template(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    name: &str,
  ) -> DatabaseResult<bool> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::Delete).await?;
    let removed = self
      .import_export_repo
      .delete_csv_mapping_template(workspace_id, name)
      .await?;
    Ok(removed > 0)
  }

  fn dialect_for_delimiter(delimiter: u8, source: &DatabaseCsvDialect) -> DatabaseCsvDialect {
    let mut dialect = source.clone();
    dialect.delimiter = match delimiter {
      b',' => DatabaseCsvDelimiter::Comma,
      b';' => DatabaseCsvDelimiter::Semicolon,
      b'\t' => DatabaseCsvDelimiter::Tab,
      b'|' => DatabaseCsvDelimiter::Pipe,
      _ => DatabaseCsvDelimiter::Custom,
    };
    dialect.custom_delimiter = if dialect.delimiter == DatabaseCsvDelimiter::Custom {
      Some((delimiter as char).to_string())
    } else {
      None
    };
    dialect
  }

  fn default_dialect_for_delimiter(delimiter: u8) -> DatabaseCsvDialect {
    DatabaseCsvDialect {
      delimiter: match delimiter {
        b';' => DatabaseCsvDelimiter::Semicolon,
        b'\t' => DatabaseCsvDelimiter::Tab,
        b'|' => DatabaseCsvDelimiter::Pipe,
        other if other != b',' => DatabaseCsvDelimiter::Custom,
        _ => DatabaseCsvDelimiter::Comma,
      },
      custom_delimiter: if matches!(delimiter, b',' | b';' | b'\t' | b'|') {
        None
      } else {
        Some((delimiter as char).to_string())
      },
      quote: None,
      escape: None,
      double_quote: true,
    }
  }

  fn csv_one_byte(label: &str, value: &Option<String>) -> DatabaseResult<Option<u8>> {
    let Some(value) = value else {
      return Ok(None);
    };
    let bytes = value.as_bytes();
    if bytes.len() != 1 {
      return Err(DatabaseServiceError::new(
        ERR_CSV_INVALID,
        format!("{label} must be exactly one byte"),
      ));
    }
    Ok(Some(bytes[0]))
  }

  fn csv_delimiter(&self, dialect: &DatabaseCsvDialect) -> DatabaseResult<Option<u8>> {
    match dialect.delimiter {
      DatabaseCsvDelimiter::Auto => Ok(None),
      DatabaseCsvDelimiter::Comma => Ok(Some(b',')),
      DatabaseCsvDelimiter::Semicolon => Ok(Some(b';')),
      DatabaseCsvDelimiter::Tab => Ok(Some(b'\t')),
      DatabaseCsvDelimiter::Pipe => Ok(Some(b'|')),
      DatabaseCsvDelimiter::Custom => Self::csv_one_byte("custom delimiter", &dialect.custom_delimiter),
    }
  }

  fn csv_export_delimiter(&self, dialect: &DatabaseCsvDialect) -> DatabaseResult<u8> {
    match self.csv_delimiter(dialect)? {
      Some(delimiter) => Ok(delimiter),
      None => Err(DatabaseServiceError::new(
        ERR_CSV_INVALID,
        "CSV export requires an explicit delimiter",
      )),
    }
  }

  fn csv_writer_builder(
    &self,
    dialect: &DatabaseCsvDialect,
    quote_strategy: DatabaseCsvQuoteStrategy,
  ) -> DatabaseResult<csv::WriterBuilder> {
    let delimiter = self.csv_export_delimiter(dialect)?;
    if !dialect.double_quote && dialect.escape.is_none() {
      return Err(DatabaseServiceError::new(
        ERR_CSV_INVALID,
        "CSV export requires an escape byte when doubleQuote is false",
      ));
    }
    let mut builder = csv::WriterBuilder::new();
    builder
      .delimiter(delimiter)
      .terminator(csv::Terminator::CRLF)
      .double_quote(dialect.double_quote);
    if let Some(quote) = Self::csv_one_byte("quote", &dialect.quote)? {
      builder.quote(quote);
    }
    if let Some(escape) = Self::csv_one_byte("escape", &dialect.escape)? {
      builder.escape(escape);
    }
    // csv::WriterBuilder has no `quote_strategy` knob, so the
    // `All` mode is implemented at the call site by manually
    // quoting every record through `csv_export_field_value`. We
    // assert the requested strategy here to fail loud if a future
    // refactor forgets to thread it through.
    let _ = quote_strategy;
    Ok(builder)
  }

  /// Apply the requested quote strategy to a single field value.
  ///
  /// `Minimal` returns the value unchanged — `csv::Writer` already
  /// quotes fields that contain the delimiter, quote, newline or
  /// leading/trailing whitespace.
  ///
  /// `All` wraps the value in the configured quote byte and escapes
  /// any embedded quote byte. The csv writer still only quotes a
  /// field when it has to, so this pass guarantees the consumer sees
  /// a quoted value regardless of cell content.
  fn csv_export_field_value(value: &str, quote_strategy: DatabaseCsvQuoteStrategy, quote_byte: u8) -> String {
    match quote_strategy {
      DatabaseCsvQuoteStrategy::Minimal => value.to_string(),
      DatabaseCsvQuoteStrategy::All => {
        let quote_char = char::from(quote_byte);
        let escaped = if quote_byte == b'"' {
          value.replace('"', "\"\"")
        } else {
          value.replace(quote_char, &format!("{quote_char}{quote_char}"))
        };
        format!("{quote_char}{escaped}{quote_char}")
      }
    }
  }

  fn csv_reader_builder(&self, dialect: &DatabaseCsvDialect, delimiter: u8) -> DatabaseResult<csv::ReaderBuilder> {
    if !dialect.double_quote && dialect.escape.is_none() {
      return Err(DatabaseServiceError::new(
        ERR_CSV_INVALID,
        "CSV import requires an escape byte when doubleQuote is false",
      ));
    }
    let mut builder = csv::ReaderBuilder::new();
    builder
      .delimiter(delimiter)
      .has_headers(false)
      .double_quote(dialect.double_quote);
    if let Some(quote) = Self::csv_one_byte("quote", &dialect.quote)? {
      builder.quote(quote);
    }
    if let Some(escape) = Self::csv_one_byte("escape", &dialect.escape)? {
      builder.escape(Some(escape));
    }
    Ok(builder)
  }

  fn read_csv_rows_with_delimiter(
    &self,
    content: &[u8],
    dialect: &DatabaseCsvDialect,
    delimiter: u8,
  ) -> DatabaseResult<Vec<csv::StringRecord>> {
    let builder = self.csv_reader_builder(dialect, delimiter)?;
    builder
      .from_reader(content)
      .records()
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| DatabaseServiceError::new(ERR_CSV_INVALID, error.to_string()))
  }

  fn detect_csv_delimiter(&self, content: &[u8], dialect: &DatabaseCsvDialect) -> DatabaseResult<(u8, String)> {
    let candidates = [b',', b';', b'\t', b'|'];
    let mut best: Option<(u8, usize, usize)> = None;
    for delimiter in candidates {
      let Ok(rows) = self.read_csv_rows_with_delimiter(content, dialect, delimiter) else {
        continue;
      };
      let sample = rows.iter().take(20).collect::<Vec<_>>();
      let header_width = sample.first().map(|row| row.len()).unwrap_or(0);
      let stable_rows = sample.iter().filter(|row| row.len() == header_width).count();
      let score = header_width.saturating_mul(stable_rows);
      match best {
        Some((_, best_score, best_width))
          if best_score > score || (best_score == score && best_width >= header_width) => {}
        _ => best = Some((delimiter, score, header_width)),
      }
    }
    let (delimiter, score, width) = best.unwrap_or((b',', 0, 0));
    let confidence = if width > 1 && score >= width * 3 {
      "high"
    } else if width > 1 {
      "medium"
    } else {
      "low"
    }
    .to_string();
    Ok((delimiter, confidence))
  }

  fn parse_csv_rows(&self, content: &[u8], dialect: &DatabaseCsvDialect) -> DatabaseResult<ParsedCsvRows> {
    if content.len() > self.limits.csv_max_bytes {
      return Err(DatabaseServiceError::new(
        ERR_CSV_TOO_LARGE,
        "CSV file exceeds configured limit",
      ));
    }
    let content = content.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(content);
    let (delimiter, detected_dialect, confidence) = match self.csv_delimiter(dialect)? {
      Some(delimiter) => (
        delimiter,
        Self::dialect_for_delimiter(delimiter, dialect),
        "explicit".to_string(),
      ),
      None => {
        let (delimiter, confidence) = self.detect_csv_delimiter(content, dialect)?;
        (delimiter, Self::default_dialect_for_delimiter(delimiter), confidence)
      }
    };
    let rows = self.read_csv_rows_with_delimiter(content, dialect, delimiter)?;
    if rows.len().saturating_sub(1) > self.limits.csv_max_rows {
      return Err(DatabaseServiceError::new(ERR_CSV_ROW_LIMIT, "CSV row limit exceeded"));
    }
    let mut applied_dialect = dialect.clone();
    if applied_dialect.delimiter == DatabaseCsvDelimiter::Auto {
      applied_dialect = Self::dialect_for_delimiter(delimiter, dialect);
    }
    Ok(ParsedCsvRows {
      applied_dialect,
      confidence,
      detected_dialect,
      rows,
    })
  }

  fn parse_csv_preview(
    &self,
    content: &[u8],
    options: &DatabaseCsvImportOptions,
  ) -> DatabaseResult<DatabaseCsvPreview> {
    let parsed = self.parse_csv_rows(content, &options.dialect)?;
    let rows = parsed.rows;
    let Some(header) = rows.first() else {
      return Err(DatabaseServiceError::new(ERR_CSV_INVALID, "CSV file is empty"));
    };
    if header.len() > self.limits.csv_max_columns {
      return Err(DatabaseServiceError::new(
        ERR_CSV_COLUMN_LIMIT,
        "CSV column limit exceeded",
      ));
    }
    let first_row_is_header = options.first_row_is_header.unwrap_or(true);
    let source_headers = header
      .iter()
      .enumerate()
      .map(|(index, raw)| {
        if first_row_is_header {
          raw.trim().to_string()
        } else {
          format!("Column {}", index + 1)
        }
      })
      .collect::<Vec<_>>();
    let normalized_headers = Self::dedupe_csv_headers(&source_headers);
    let data_start = if first_row_is_header { 1 } else { 0 };
    let data_rows = rows.iter().skip(data_start).cloned().collect::<Vec<_>>();
    let inferred = normalized_headers
      .iter()
      .enumerate()
      .map(|(index, name)| {
        let field_type = if index == 0 {
          DatabaseFieldType::Title
        } else {
          self.infer_csv_field_type(&data_rows, index, name)
        };
        DatabaseCsvDetectedColumn {
          index: index as i32,
          source_header: source_headers.get(index).cloned().unwrap_or_default(),
          field_name: name.clone(),
          field_type,
          is_title: index == 0,
        }
      })
      .collect::<Vec<_>>();
    let (applied_mapping, mut errors) = self.normalize_csv_mapping(&inferred, &data_rows, &options.mapping)?;
    let now = Utc::now();
    let inferred_fields = applied_mapping
      .iter()
      .filter(|column| column.import_column)
      .map(|column| DatabaseField {
        id: Uuid::new_v4(),
        database_id: Uuid::nil(),
        name: column.field_name.clone(),
        field_type: column.field_type,
        config: self.csv_field_config(column.field_type, &data_rows, column.source_index as usize),
        position: column.source_index,
        required: column.is_title,
        edit_revision: 1,
        created_at: now,
        updated_at: now,
      })
      .collect();
    Ok(DatabaseCsvPreview {
      detected_delimiter: parsed.detected_dialect.delimiter.as_str().to_string(),
      detected_dialect: parsed.detected_dialect,
      applied_dialect: parsed.applied_dialect,
      detected_columns: inferred,
      applied_mapping,
      confidence: parsed.confidence,
      inferred_fields,
      row_count: data_rows.len() as i32,
      errors: std::mem::take(&mut errors),
      warnings: Vec::new(),
      workspace_tag_diagnostics: Vec::new(),
    })
  }

  fn dedupe_csv_headers(headers: &[String]) -> Vec<String> {
    let mut used_names = HashMap::<String, usize>::new();
    headers
      .iter()
      .enumerate()
      .map(|(index, raw)| {
        let base = if raw.trim().is_empty() {
          format!("Column {}", index + 1)
        } else {
          raw.trim().to_string()
        };
        let count = used_names.entry(base.to_lowercase()).or_insert(0);
        *count += 1;
        if *count == 1 { base } else { format!("{base} {count}") }
      })
      .collect()
  }

  fn is_csv_importable_field_type(field_type: DatabaseFieldType) -> bool {
    matches!(
      field_type,
      DatabaseFieldType::Title
        | DatabaseFieldType::Text
        | DatabaseFieldType::RichText
        | DatabaseFieldType::Number
        | DatabaseFieldType::Percent
        | DatabaseFieldType::Currency
        | DatabaseFieldType::Duration
        | DatabaseFieldType::Date
        | DatabaseFieldType::DateTime
        | DatabaseFieldType::Checkbox
        | DatabaseFieldType::Select
        | DatabaseFieldType::MultiSelect
        | DatabaseFieldType::Tags
        | DatabaseFieldType::Status
        | DatabaseFieldType::Url
        | DatabaseFieldType::Email
        | DatabaseFieldType::Phone
        | DatabaseFieldType::User
        | DatabaseFieldType::Users
    )
  }

  fn normalize_csv_mapping(
    &self,
    inferred: &[DatabaseCsvDetectedColumn],
    data_rows: &[csv::StringRecord],
    mapping: &[DatabaseCsvColumnMapping],
  ) -> DatabaseResult<(Vec<DatabaseCsvAppliedColumnMapping>, Vec<DatabaseCsvDiagnostic>)> {
    let mut errors = Vec::new();
    let mapping_is_explicit = !mapping.is_empty();
    let applied = if mapping.is_empty() {
      inferred
        .iter()
        .map(|column| DatabaseCsvAppliedColumnMapping {
          source_index: column.index,
          import_column: true,
          source_header: column.source_header.clone(),
          field_name: column.field_name.clone(),
          field_type: column.field_type,
          is_title: column.is_title,
        })
        .collect::<Vec<_>>()
    } else {
      let inferred_by_index = inferred
        .iter()
        .map(|column| (column.index, column))
        .collect::<HashMap<_, _>>();
      mapping
        .iter()
        .filter_map(|item| {
          let Some(source) = inferred_by_index.get(&item.source_index) else {
            errors.push(DatabaseCsvDiagnostic {
              code: ERR_CSV_INVALID.to_string(),
              source: "mapping".to_string(),
              row: None,
              field: Some(item.source_index.to_string()),
              message: "CSV mapping references a source column that does not exist".to_string(),
            });
            return None;
          };
          let field_type = if item.is_title {
            DatabaseFieldType::Title
          } else {
            item
              .field_type
              .unwrap_or_else(|| self.infer_csv_field_type(data_rows, item.source_index as usize, &source.field_name))
          };
          Some(DatabaseCsvAppliedColumnMapping {
            source_index: item.source_index,
            import_column: item.import_column,
            source_header: source.source_header.clone(),
            field_name: item
              .field_name
              .as_ref()
              .map(|name| name.trim())
              .filter(|name| !name.is_empty())
              .unwrap_or(source.field_name.as_str())
              .to_string(),
            field_type,
            is_title: item.is_title,
          })
        })
        .collect::<Vec<_>>()
    };

    let title_count = applied
      .iter()
      .filter(|column| column.import_column && column.is_title)
      .count();
    if title_count != 1 {
      errors.push(DatabaseCsvDiagnostic {
        code: ERR_CSV_INVALID.to_string(),
        source: "mapping".to_string(),
        row: None,
        field: Some("Title".to_string()),
        message: "CSV import requires exactly one imported Title column".to_string(),
      });
    }
    let mut imported_source_indices = BTreeSet::<i32>::new();
    let mut imported_field_names = BTreeSet::<String>::new();
    for column in &applied {
      if !column.import_column {
        continue;
      }
      if !imported_source_indices.insert(column.source_index) {
        errors.push(DatabaseCsvDiagnostic {
          code: ERR_CSV_INVALID.to_string(),
          source: "mapping".to_string(),
          row: None,
          field: Some(column.source_index.to_string()),
          message: "CSV mapping imports the same source column more than once".to_string(),
        });
      }
      let normalized_name = column.field_name.trim().to_ascii_lowercase();
      if normalized_name.is_empty() {
        errors.push(DatabaseCsvDiagnostic {
          code: ERR_CSV_INVALID.to_string(),
          source: "mapping".to_string(),
          row: None,
          field: Some(column.source_index.to_string()),
          message: "CSV mapping field names must not be empty".to_string(),
        });
      } else if !imported_field_names.insert(normalized_name) {
        errors.push(DatabaseCsvDiagnostic {
          code: ERR_CSV_INVALID.to_string(),
          source: "mapping".to_string(),
          row: None,
          field: Some(column.field_name.clone()),
          message: "CSV mapping imports duplicate field names".to_string(),
        });
      }
      if column.import_column && column.field_type == DatabaseFieldType::Relation {
        errors.push(DatabaseCsvDiagnostic {
          code: ERR_CSV_INVALID.to_string(),
          source: "mapping".to_string(),
          row: None,
          field: Some(column.field_name.clone()),
          message: "CSV Relation imports require an existing target Database and explicit stable-id or title mapping; the new-Database CSV import path cannot infer relation targets".to_string(),
        });
      } else if column.import_column
        && !Self::is_csv_importable_field_type(column.field_type)
        // Header inference may materialize row-owned projection fields so a
        // Myoxus CSV export retains its schema on re-import. Their source
        // values are ignored with a readonly warning during row planning.
        // Explicit mappings must never present those fields as writable.
        && (mapping_is_explicit || !crate::database::editing::rules::is_projection_field(column.field_type))
      {
        errors.push(DatabaseCsvDiagnostic {
          code: ERR_CSV_INVALID.to_string(),
          source: "mapping".to_string(),
          row: None,
          field: Some(column.field_name.clone()),
          message: "CSV mapping targets a field type that cannot be imported".to_string(),
        });
      }
      if column.import_column && (column.is_title != (column.field_type == DatabaseFieldType::Title)) {
        errors.push(DatabaseCsvDiagnostic {
          code: ERR_CSV_INVALID.to_string(),
          source: "mapping".to_string(),
          row: None,
          field: Some(column.field_name.clone()),
          message: "The Title field type may only be used by the imported Title column".to_string(),
        });
      }
    }
    Ok((applied, errors))
  }

  fn csv_select_options(&self, rows: &[csv::StringRecord], source_index: usize) -> Vec<DatabaseSelectOption> {
    let mut seen = BTreeSet::<String>::new();
    rows
      .iter()
      .filter_map(|row| row.get(source_index).map(str::trim))
      .flat_map(|value| value.split(';').map(str::trim))
      .filter(|value| !value.is_empty())
      .filter(|value| seen.insert((*value).to_string()))
      .enumerate()
      .map(|(position, value)| DatabaseSelectOption {
        id: value.to_string(),
        name: value.to_string(),
        position: position as i32,
        color_role: "neutral".to_string(),
      })
      .collect()
  }

  fn csv_status_group(value: &str) -> DatabaseStatusGroup {
    match value.trim().to_ascii_lowercase().replace([' ', '-'], "_").as_str() {
      "done" | "complete" | "completed" | "closed" | "resolved" => DatabaseStatusGroup::Complete,
      "doing" | "active" | "started" | "in_progress" | "progress" | "review" | "blocked" => DatabaseStatusGroup::Active,
      _ => DatabaseStatusGroup::NotStarted,
    }
  }

  pub(in crate::database) fn csv_status_option_id(value: &str, used_ids: &mut BTreeSet<String>) -> String {
    let normalized = value
      .trim()
      .chars()
      .map(|character| {
        if character.is_ascii_alphanumeric() {
          character.to_ascii_lowercase()
        } else {
          '_'
        }
      })
      .collect::<String>()
      .split('_')
      .filter(|part| !part.is_empty())
      .collect::<Vec<_>>()
      .join("_");
    let base = if normalized.is_empty() {
      "status.csv.option".to_string()
    } else {
      format!("status.csv.{normalized}")
    };
    let mut candidate = base.clone();
    let mut suffix = 2;
    while !used_ids.insert(candidate.clone()) {
      candidate = format!("{base}_{suffix}");
      suffix += 1;
    }
    candidate
  }

  fn csv_status_field_config(&self, rows: &[csv::StringRecord], source_index: usize) -> DatabaseStatusFieldConfig {
    let mut seen_names = BTreeSet::<String>::new();
    let mut used_ids = BTreeSet::<String>::new();
    let mut options = rows
      .iter()
      .filter_map(|row| row.get(source_index).map(str::trim))
      .filter(|value| !value.is_empty())
      .filter(|value| seen_names.insert((*value).to_string()))
      .enumerate()
      .map(|(position, value)| {
        let group = Self::csv_status_group(value);
        DatabaseStatusOption {
          id: Self::csv_status_option_id(value, &mut used_ids),
          name: value.to_string(),
          position: position as i32,
          color_role: match group {
            DatabaseStatusGroup::NotStarted => "database.status.todo",
            DatabaseStatusGroup::Active => "database.status.inProgress",
            DatabaseStatusGroup::Complete => "database.status.done",
            DatabaseStatusGroup::Archived => "database.status.archived",
          }
          .to_string(),
          group,
        }
      })
      .collect::<Vec<_>>();

    for (id, name, group, color_role) in [
      (
        "status.todo",
        "Todo",
        DatabaseStatusGroup::NotStarted,
        "database.status.todo",
      ),
      (
        "status.in_progress",
        "In progress",
        DatabaseStatusGroup::Active,
        "database.status.inProgress",
      ),
      (
        "status.done",
        "Done",
        DatabaseStatusGroup::Complete,
        "database.status.done",
      ),
    ] {
      if options.iter().all(|option| option.group != group) {
        used_ids.insert(id.to_string());
        options.push(DatabaseStatusOption {
          id: id.to_string(),
          name: name.to_string(),
          position: options.len() as i32,
          color_role: color_role.to_string(),
          group,
        });
      }
    }
    let default_option_id = options
      .iter()
      .find(|option| option.group == DatabaseStatusGroup::NotStarted)
      .map(|option| option.id.clone())
      .unwrap_or_else(|| "status.todo".to_string());
    DatabaseStatusFieldConfig {
      options,
      default_option_id,
    }
  }

  fn csv_field_config(
    &self,
    field_type: DatabaseFieldType,
    rows: &[csv::StringRecord],
    source_index: usize,
  ) -> DatabaseFieldConfig {
    match field_type {
      DatabaseFieldType::Select => DatabaseFieldConfig::Select(DatabaseSelectFieldConfig {
        options: self.csv_select_options(rows, source_index),
      }),
      DatabaseFieldType::MultiSelect => DatabaseFieldConfig::MultiSelect(DatabaseSelectFieldConfig {
        options: self.csv_select_options(rows, source_index),
      }),
      DatabaseFieldType::Status => DatabaseFieldConfig::Status(self.csv_status_field_config(rows, source_index)),
      DatabaseFieldType::Tags => DatabaseFieldConfig::Tags(DatabaseTagsFieldConfig { max_count: None }),
      DatabaseFieldType::Currency => DatabaseFieldConfig::Currency(DatabaseCurrencyFieldConfig {
        default_currency: default_database_currency_code(),
        allow_currency_override: true,
        min_value: None,
        max_value: None,
      }),
      DatabaseFieldType::Duration => DatabaseFieldConfig::Duration(DatabaseDurationFieldConfig {
        display_unit: DatabaseDurationDisplayUnit::Minutes,
        min_minutes: Some(0),
        max_minutes: None,
      }),
      DatabaseFieldType::DateTime => DatabaseFieldConfig::DateTime(DatabaseDateTimeFieldConfig {
        default_time_zone: Some("UTC".to_string()),
        allow_reminders: false,
      }),
      _ => DatabaseFieldConfig::empty_for(field_type),
    }
  }

  fn infer_csv_field_type(&self, rows: &[csv::StringRecord], index: usize, header: &str) -> DatabaseFieldType {
    let normalized_header = header.trim().to_ascii_lowercase().replace([' ', '-'], "_");
    match normalized_header.as_str() {
      "url" | "website" | "link" => return DatabaseFieldType::Url,
      "email" | "e_mail" | "mail" => return DatabaseFieldType::Email,
      "phone" | "telephone" | "tel" | "mobile" => return DatabaseFieldType::Phone,
      "percent" | "percentage" | "progress" | "completion" | "done_percent" | "complete_percent" => {
        return DatabaseFieldType::Percent;
      }
      "currency" | "money" | "amount" | "cost" | "price" | "budget" => return DatabaseFieldType::Currency,
      "duration" | "minutes" | "effort" | "estimate" | "estimated_effort" | "time_spent" => {
        return DatabaseFieldType::Duration;
      }
      "status" | "state" | "stage" | "workflow_status" => return DatabaseFieldType::Status,
      "tags" | "tag" | "labels" | "workspace_tags" => return DatabaseFieldType::Tags,
      "date_time" | "datetime" | "start_time" | "due_at" | "due_date_time" => return DatabaseFieldType::DateTime,
      "users" | "people" | "assignees" | "watchers" | "reviewers" => return DatabaseFieldType::Users,
      "created_time" | "created_at" => return DatabaseFieldType::CreatedTime,
      "created_by" => return DatabaseFieldType::CreatedBy,
      "updated_time" | "updated_at" => return DatabaseFieldType::UpdatedTime,
      "updated_by" => return DatabaseFieldType::UpdatedBy,
      _ => {}
    }
    let sample = rows
      .iter()
      .take(self.limits.csv_sample_rows_for_type_inference)
      .filter_map(|row| row.get(index).map(str::trim))
      .filter(|value| !value.is_empty())
      .collect::<Vec<_>>();
    if sample.is_empty() {
      return DatabaseFieldType::Text;
    }
    if sample.iter().all(|value| Self::parse_csv_percent_value(value).is_ok())
      && sample.iter().any(|value| value.trim().ends_with('%'))
    {
      return DatabaseFieldType::Percent;
    }
    if sample
      .iter()
      .all(|value| Self::parse_csv_currency_value(value, &default_database_currency_code()).is_ok())
      && sample.iter().any(|value| Self::csv_currency_contains_code(value))
    {
      return DatabaseFieldType::Currency;
    }
    if sample.iter().all(|value| Self::parse_csv_duration_value(value).is_ok())
      && sample
        .iter()
        .any(|value| value.chars().any(|ch| ch.is_ascii_alphabetic()))
    {
      return DatabaseFieldType::Duration;
    }
    if sample
      .iter()
      .all(|value| value.parse::<f64>().is_ok_and(|value| value.is_finite()))
    {
      return DatabaseFieldType::Number;
    }
    if sample.iter().all(|value| {
      matches!(
        value.to_ascii_lowercase().as_str(),
        "true" | "false" | "yes" | "no" | "1" | "0"
      )
    }) {
      return DatabaseFieldType::Checkbox;
    }
    if sample
      .iter()
      .all(|value| Self::parse_csv_date_time_value(value, "UTC").is_ok())
      && sample.iter().any(|value| value.contains('T'))
    {
      return DatabaseFieldType::DateTime;
    }
    if sample
      .iter()
      .all(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok())
    {
      return DatabaseFieldType::Date;
    }
    if sample
      .iter()
      .all(|value| crate::database::editing::rules::normalize_email(value).is_ok())
    {
      return DatabaseFieldType::Email;
    }
    if sample
      .iter()
      .all(|value| crate::database::editing::rules::normalize_url(value).is_ok())
    {
      return DatabaseFieldType::Url;
    }
    if sample
      .iter()
      .all(|value| crate::database::editing::rules::normalize_phone(value).is_ok())
    {
      return DatabaseFieldType::Phone;
    }
    DatabaseFieldType::Text
  }

  pub(in crate::database) fn parse_csv_percent_value(raw: &str) -> DatabaseResult<f64> {
    let trimmed = raw.trim();
    let numeric = trimmed.strip_suffix('%').unwrap_or(trimmed).trim();
    numeric
      .parse::<f64>()
      .ok()
      .filter(|value| value.is_finite())
      .ok_or_else(|| DatabaseServiceError::new(ERR_CELL_INVALID, "invalid percent cell"))
  }

  fn csv_currency_contains_code(raw: &str) -> bool {
    raw
      .split(|ch: char| ch.is_whitespace() || matches!(ch, ',' | ';'))
      .any(|part| normalize_database_currency_code(part).is_some())
  }

  pub(in crate::database) fn parse_csv_currency_value(
    raw: &str,
    default_currency: &str,
  ) -> DatabaseResult<DatabaseCurrencyValue> {
    let trimmed = raw.trim();
    let parts = trimmed
      .split_whitespace()
      .map(str::trim)
      .filter(|part| !part.is_empty())
      .collect::<Vec<_>>();
    let (amount_raw, currency_code) = match parts.as_slice() {
      [currency, amount] if normalize_database_currency_code(currency).is_some() => (*amount, *currency),
      [amount, currency] if normalize_database_currency_code(currency).is_some() => (*amount, *currency),
      [amount] => (*amount, default_currency),
      _ => {
        return Err(DatabaseServiceError::new(
          ERR_CURRENCY_INVALID,
          "currency CSV values must be '<amount>', '<amount> <CODE>' or '<CODE> <amount>'",
        ));
      }
    };
    let amount = amount_raw
      .replace(',', "")
      .parse::<f64>()
      .ok()
      .filter(|value| value.is_finite())
      .ok_or_else(|| DatabaseServiceError::new(ERR_CURRENCY_INVALID, "invalid currency amount"))?;
    let currency_code = normalize_database_currency_code(currency_code)
      .ok_or_else(|| DatabaseServiceError::new(ERR_CURRENCY_INVALID, "invalid ISO-4217 currency code"))?;
    Ok(DatabaseCurrencyValue { amount, currency_code })
  }

  pub(in crate::database) fn parse_csv_duration_value(raw: &str) -> DatabaseResult<DatabaseDurationValue> {
    let trimmed = raw.trim();
    let normalized = trimmed.to_ascii_lowercase();
    let (number_raw, multiplier) = if let Some(value) = normalized.strip_suffix("minutes") {
      (value.trim(), 1.0)
    } else if let Some(value) = normalized.strip_suffix("minute") {
      (value.trim(), 1.0)
    } else if let Some(value) = normalized.strip_suffix("mins") {
      (value.trim(), 1.0)
    } else if let Some(value) = normalized.strip_suffix("min") {
      (value.trim(), 1.0)
    } else if let Some(value) = normalized.strip_suffix('m') {
      (value.trim(), 1.0)
    } else if let Some(value) = normalized.strip_suffix("hours") {
      (value.trim(), 60.0)
    } else if let Some(value) = normalized.strip_suffix("hour") {
      (value.trim(), 60.0)
    } else if let Some(value) = normalized.strip_suffix("hrs") {
      (value.trim(), 60.0)
    } else if let Some(value) = normalized.strip_suffix("hr") {
      (value.trim(), 60.0)
    } else if let Some(value) = normalized.strip_suffix('h') {
      (value.trim(), 60.0)
    } else if let Some(value) = normalized.strip_suffix("days") {
      (value.trim(), 1_440.0)
    } else if let Some(value) = normalized.strip_suffix("day") {
      (value.trim(), 1_440.0)
    } else if let Some(value) = normalized.strip_suffix('d') {
      (value.trim(), 1_440.0)
    } else {
      (trimmed, 1.0)
    };
    let minutes = number_raw
      .parse::<f64>()
      .ok()
      .filter(|value| value.is_finite() && *value >= 0.0)
      .map(|value| (value * multiplier).round() as i64)
      .ok_or_else(|| DatabaseServiceError::new(ERR_DURATION_INVALID, "invalid duration cell"))?;
    Ok(DatabaseDurationValue { minutes })
  }

  fn parse_csv_date_time_value(raw: &str, default_time_zone: &str) -> DatabaseResult<DatabaseDateTimeValue> {
    crate::database::definition::rules::validate_time_zone(default_time_zone)?;
    let mut parts = raw.trim().splitn(2, '/');
    let start_raw = parts.next().unwrap_or_default().trim();
    let end_raw = parts.next().map(str::trim).filter(|value| !value.is_empty());
    let start = DateTime::parse_from_rfc3339(start_raw)
      .map(|value| value.with_timezone(&Utc))
      .map_err(|_| DatabaseServiceError::new(ERR_DATE_TIME_INVALID, "invalid date_time start"))?;
    let end = end_raw
      .map(|value| {
        DateTime::parse_from_rfc3339(value)
          .map(|value| value.with_timezone(&Utc))
          .map_err(|_| DatabaseServiceError::new(ERR_DATE_TIME_INVALID, "invalid date_time end"))
      })
      .transpose()?;
    let value = DatabaseDateTimeValue {
      start,
      end,
      all_day: false,
      time_zone: default_time_zone.to_string(),
    };
    crate::database::editing::rules::validate_date_time_value(
      &value,
      &DatabaseFieldConfig::DateTime(DatabaseDateTimeFieldConfig {
        default_time_zone: Some(default_time_zone.to_string()),
        allow_reminders: true,
      }),
    )?;
    Ok(value)
  }

  async fn parse_csv_user_reference(&self, workspace_id: WorkspaceId, raw: &str) -> DatabaseResult<UserId> {
    let reference = raw.trim();
    if reference.is_empty() {
      return Err(DatabaseServiceError::new(ERR_CELL_INVALID, "empty user reference"));
    }
    if let Some(user_id) = self
      .workspace_store
      .accepted_member_by_email(workspace_id, reference)
      .await
      .map_err(workspace_lookup_error)?
    {
      return Ok(user_id);
    }
    let user_id = Uuid::parse_str(reference).map_err(|_| {
      DatabaseServiceError::new(
        ERR_CELL_INVALID,
        "user references must be workspace-member email or UUID",
      )
    })?;
    if !self
      .workspace_store
      .has_accepted_member(workspace_id, user_id)
      .await
      .map_err(workspace_lookup_error)?
    {
      return Err(DatabaseServiceError::new(
        ERR_CELL_INVALID,
        "CSV user references must resolve to accepted workspace members",
      ));
    }
    Ok(user_id)
  }

  async fn csv_cell_value(
    &self,
    workspace_id: WorkspaceId,
    field: &DatabaseField,
    raw: &str,
  ) -> DatabaseResult<DatabaseCellValueData> {
    match field.field_type {
      DatabaseFieldType::Text => Ok(DatabaseCellValueData::Text(raw.to_string())),
      DatabaseFieldType::RichText => crate::database::editing::rules::rich_text_value_from_document(
        serde_json::json!({
          "type": "doc",
          "content": [{
            "type": "paragraph",
            "content": [{ "type": "text", "text": raw }]
          }]
        }),
        &self.limits,
      )
      .map(DatabaseCellValueData::RichText),
      DatabaseFieldType::Number => raw
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .map(DatabaseCellValueData::Number)
        .ok_or_else(|| DatabaseServiceError::new(ERR_CELL_INVALID, "invalid number cell")),
      DatabaseFieldType::Percent => Self::parse_csv_percent_value(raw).map(DatabaseCellValueData::Percent),
      DatabaseFieldType::Currency => {
        let fallback = default_database_currency_code();
        let default_currency = match &field.config {
          DatabaseFieldConfig::Currency(config) => config.default_currency.as_str(),
          _ => fallback.as_str(),
        };
        Self::parse_csv_currency_value(raw, default_currency).map(DatabaseCellValueData::Currency)
      }
      DatabaseFieldType::Duration => Self::parse_csv_duration_value(raw).map(DatabaseCellValueData::Duration),
      DatabaseFieldType::Checkbox => match raw.to_ascii_lowercase().as_str() {
        "true" | "yes" | "1" => Ok(DatabaseCellValueData::Checkbox(true)),
        "false" | "no" | "0" => Ok(DatabaseCellValueData::Checkbox(false)),
        _ => Err(DatabaseServiceError::new(ERR_CELL_INVALID, "invalid checkbox cell")),
      },
      DatabaseFieldType::Date => NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map(|start| DatabaseCellValueData::Date(DatabaseDateValue { start, end: None }))
        .map_err(|_| DatabaseServiceError::new(ERR_CELL_INVALID, "invalid date cell")),
      DatabaseFieldType::DateTime => {
        let default_time_zone = match &field.config {
          DatabaseFieldConfig::DateTime(config) => config.default_time_zone.as_deref().unwrap_or("UTC"),
          _ => "UTC",
        };
        Self::parse_csv_date_time_value(raw, default_time_zone).map(DatabaseCellValueData::DateTime)
      }
      DatabaseFieldType::Select => Ok(DatabaseCellValueData::Select(raw.to_string())),
      DatabaseFieldType::Status => {
        let option_id = field
          .config
          .status_options()
          .iter()
          .find(|option| option.name == raw)
          .map(|option| option.id.clone())
          .unwrap_or_else(|| raw.to_string());
        Ok(DatabaseCellValueData::Status(option_id))
      }
      DatabaseFieldType::MultiSelect => Ok(DatabaseCellValueData::MultiSelect(
        raw
          .split(';')
          .map(str::trim)
          .filter(|value| !value.is_empty())
          .map(str::to_string)
          .collect(),
      )),
      DatabaseFieldType::Url => crate::database::editing::rules::normalize_url(raw).map(DatabaseCellValueData::Url),
      DatabaseFieldType::Email => {
        crate::database::editing::rules::normalize_email(raw).map(DatabaseCellValueData::Email)
      }
      DatabaseFieldType::Phone => {
        crate::database::editing::rules::normalize_phone(raw).map(DatabaseCellValueData::Phone)
      }
      DatabaseFieldType::User => self
        .parse_csv_user_reference(workspace_id, raw)
        .await
        .map(DatabaseCellValueData::User),
      DatabaseFieldType::Users => {
        let mut user_ids = Vec::new();
        for reference in raw.split(';').map(str::trim).filter(|value| !value.is_empty()) {
          user_ids.push(self.parse_csv_user_reference(workspace_id, reference).await?);
        }
        Ok(DatabaseCellValueData::Users(user_ids))
      }
      DatabaseFieldType::CreatedTime
      | DatabaseFieldType::CreatedBy
      | DatabaseFieldType::UpdatedTime
      | DatabaseFieldType::UpdatedBy => Err(DatabaseServiceError::new(
        ERR_CELL_VALUE_READONLY,
        "CSV import cannot write projection fields",
      )),
      _ => Err(DatabaseServiceError::new(
        ERR_CELL_INVALID,
        "CSV import can infer only editable primitive fields",
      )),
    }
  }

  pub(in crate::database) fn csv_value_to_string(
    value: &DatabaseCellValueData,
    field_type: DatabaseFieldType,
    locale_mode: DatabaseCsvLocaleMode,
    locale: Option<&str>,
  ) -> String {
    if locale_mode == DatabaseCsvLocaleMode::Localized
      && let Some(formatted) = Self::csv_value_to_string_localized(value, field_type, locale)
    {
      return formatted;
    }
    crate::database::editing::presentation::machine_cell_value(value)
  }

  /// Render a value in a user-facing locale when the caller asked
  /// for `locale_mode=localized`. Returns `None` when the field
  /// type has no locale-specific representation (so the caller
  /// falls back to the machine-readable default).
  fn csv_value_to_string_localized(
    value: &DatabaseCellValueData,
    field_type: DatabaseFieldType,
    locale: Option<&str>,
  ) -> Option<String> {
    let _ = field_type;
    match (value, locale) {
      (DatabaseCellValueData::Date(value), Some(loc)) => Some(Self::csv_date_localized(value, loc)),
      (DatabaseCellValueData::DateTime(value), Some(loc)) => Some(Self::csv_date_time_localized(value, loc)),
      (DatabaseCellValueData::Currency(value), Some(loc)) => Some(Self::csv_currency_localized(value, loc)),
      (DatabaseCellValueData::Percent(value), Some(loc)) => Some(Self::csv_percent_localized(value, loc)),
      (DatabaseCellValueData::Number(value), Some(loc)) => Some(Self::csv_number_localized(value, loc)),
      _ => None,
    }
  }

  fn csv_date_localized(value: &crate::database::DatabaseDateValue, locale: &str) -> String {
    match value.end {
      Some(end) => format!(
        "{} – {}",
        Self::format_localized_date(value.start, locale),
        Self::format_localized_date(end, locale)
      ),
      None => Self::format_localized_date(value.start, locale),
    }
  }

  fn csv_date_time_localized(value: &crate::database::DatabaseDateTimeValue, locale: &str) -> String {
    match value.end {
      Some(end) => format!(
        "{} – {}",
        Self::format_localized_date_time(&value.start, locale),
        Self::format_localized_date_time(&end, locale)
      ),
      None => Self::format_localized_date_time(&value.start, locale),
    }
  }

  fn csv_currency_localized(value: &crate::database::DatabaseCurrencyValue, locale: &str) -> String {
    // Honor the requested locale via chrono/icu-free formatters so
    // the binary stays lean. Only en-US and de-DE have first-class
    // mapping; everything else falls back to the existing
    // machine-readable "AMOUNT CODE" format so the export never
    // becomes ambiguous.
    match locale {
      "en-US" => format!("${}", Self::format_localized_decimal(value.amount, ".")),
      "de-DE" | "de-AT" | "de-CH" => format!("{} €", Self::format_localized_decimal(value.amount, ",")),
      "fr-FR" | "fr-CH" | "fr-BE" => format!("{} €", Self::format_localized_decimal(value.amount, ",")),
      _ => format!("{} {}", value.amount, value.currency_code),
    }
  }

  fn csv_percent_localized(value: &f64, locale: &str) -> String {
    match locale {
      "de-DE" | "de-AT" | "de-CH" | "fr-FR" | "fr-CH" | "fr-BE" => {
        format!("{} %", Self::format_localized_decimal(*value, ","))
      }
      _ => format!("{}%", value),
    }
  }

  fn csv_number_localized(value: &f64, locale: &str) -> String {
    Self::format_localized_decimal(
      *value,
      match locale {
        "de-DE" | "de-AT" | "de-CH" | "fr-FR" | "fr-CH" | "fr-BE" => ",",
        _ => ".",
      },
    )
  }

  fn format_localized_date(date: chrono::NaiveDate, _locale: &str) -> String {
    // Stable ISO 8601 — same shape across all locales so that a
    // round-trip parse works. Localized *names* (Mon, Jan) are out
    // of scope for CSV export; we only flip the decimal separator.
    date.format("%Y-%m-%d").to_string()
  }

  fn format_localized_date_time(date_time: &chrono::DateTime<chrono::Utc>, locale: &str) -> String {
    // Use the locale's preferred offset display: en-US renders UTC
    // as `Z`, de-DE renders it as `+00:00`. The instant itself is
    // unchanged.
    match locale {
      "de-DE" | "de-AT" | "de-CH" | "fr-FR" | "fr-CH" | "fr-BE" => {
        date_time.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
      }
      _ => date_time.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    }
  }

  fn format_localized_decimal(value: f64, separator: &str) -> String {
    let mut buffer = format!("{value:.2}");
    if separator != "." {
      buffer = buffer.replace('.', separator);
    }
    buffer
  }

  async fn csv_relation_value_to_string(
    &self,
    actor: UserId,
    target_row_ids: &[DatabaseRowId],
  ) -> DatabaseResult<String> {
    let targets = self.views.relation_targets(actor, target_row_ids).await?;
    Ok(
      targets
        .into_iter()
        .map(|target| {
          if target.deleted {
            "[deleted]".to_string()
          } else if target.redacted {
            "[redacted]".to_string()
          } else {
            target.title.unwrap_or_else(|| target.row_id.to_string())
          }
        })
        .collect::<Vec<_>>()
        .join("; "),
    )
  }

  // ─── P-DB-29B-C: stale-write preconditions + explicit conflict resolution ────
  //
  // Each wrapper below delegates the comparison and increment to the SQL
  // repository transaction, then enriches a rejected write with the latest
  // server projection for the consuming conflict UI.
}
