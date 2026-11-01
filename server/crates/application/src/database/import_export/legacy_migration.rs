// SPDX-License-Identifier: AGPL-3.0-or-later

use crate::database::access;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::str::FromStr;

use crate::doc::DocSpaceKind;
use chrono::{DateTime, NaiveDate, Utc};
use myoxus_domain::database::{
  Database, DatabaseCalendarDateMode, DatabaseCalendarInitialRange, DatabaseCalendarViewConfig, DatabaseCardDensity,
  DatabaseCellValue, DatabaseCellValueData, DatabaseDateTimeFieldConfig, DatabaseDateTimeValue, DatabaseDateValue,
  DatabaseField, DatabaseFieldConfig, DatabaseFieldType, DatabaseFileReference, DatabaseFilesValue,
  DatabaseFilterConjunction, DatabaseFilterGroup, DatabaseFilterOperator, DatabaseFilterRule, DatabaseFilterValue,
  DatabaseGalleryCardDensity, DatabaseGalleryViewConfig, DatabaseGroupRule, DatabaseJsonImportMode,
  DatabaseKanbanViewConfig, DatabaseListDensity, DatabaseListViewConfig, DatabaseProfileKind,
  DatabaseProgressViewConfig, DatabaseRichTextValue, DatabaseRow, DatabaseRowKind, DatabaseRowRecord,
  DatabaseSelectFieldConfig, DatabaseSelectOption, DatabaseSortDirection, DatabaseSortRule, DatabaseTableViewConfig,
  DatabaseTimelineGroupBy, DatabaseTimelineOrder, DatabaseTimelineViewConfig, DatabaseTimelineZoom, DatabaseView,
  DatabaseViewConfig, DatabaseViewKind,
};
use myoxus_workspace_import::{
  WorkspaceImportDiagnostic, WorkspaceImportDiagnosticCode, WorkspaceImportDiagnosticSeverity, WorkspaceImportLimits,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use myoxus_domain::ids::{DocId, UserId, WorkspaceId};
use myoxus_domain::permission::WorkspaceAction;

use crate::database::{
  DatabaseImportExportService, DatabaseLimits, DatabaseResult, DatabaseServiceError, ERR_FIELD_INVALID, ERR_STORAGE,
};

#[derive(Debug, Clone)]
pub struct LegacyDatabaseDocumentSource {
  pub source_document_id: String,
  pub blocks: Vec<yjs::LegacyDatabaseBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDatabaseFieldPlan {
  pub source_id: String,
  pub target_id: Uuid,
  pub name: String,
  pub field_kind: String,
  pub config: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDatabaseViewPlan {
  pub source_id: String,
  pub target_id: Uuid,
  pub name: String,
  pub view_kind: String,
  pub config: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDatabaseRowPlan {
  pub source_id: String,
  pub target_id: Uuid,
  pub title: String,
  pub cells: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDatabasePlan {
  pub source_id: String,
  pub target_id: Uuid,
  pub title: String,
  pub fields: Vec<LegacyDatabaseFieldPlan>,
  pub views: Vec<LegacyDatabaseViewPlan>,
  pub rows: Vec<LegacyDatabaseRowPlan>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDatabaseBlockReferencePlan {
  pub source_document_id: String,
  pub block_id: String,
  pub target_database_id: Uuid,
  pub target_view_id: Option<Uuid>,
  pub already_migrated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDatabaseMigrationPlan {
  pub databases: Vec<LegacyDatabasePlan>,
  pub block_references: Vec<LegacyDatabaseBlockReferencePlan>,
  pub diagnostics: Vec<WorkspaceImportDiagnostic>,
  pub field_count: usize,
  pub row_count: usize,
  pub cell_count: usize,
  pub view_count: usize,
  pub apply_allowed: bool,
}

/// Build the single migration plan consumed by persisted-document dry-run and
/// complete workspace preview. The namespace is the durable import/migration
/// id, so retries produce the same target ids while a new request remains
/// independent.
pub fn plan_legacy_database_migration(
  namespace: Uuid,
  documents: &[LegacyDatabaseDocumentSource],
  limits: WorkspaceImportLimits,
) -> LegacyDatabaseMigrationPlan {
  plan_legacy_database_migration_with_limits(namespace, documents, limits, &DatabaseLimits::default())
}

/// Plan legacy Databases for a newly imported workspace.
///
/// A reference-only block in an existing Myoxus document already points at an
/// authoritative server Database and is therefore idempotent. The same source
/// block is not portable into a fresh workspace unless its referenced Database
/// payload is part of the import. This pass remaps such references through the
/// deterministic import plan and rejects external server references rather
/// than publishing cross-workspace ids the importing actor may not own.
pub fn plan_fresh_workspace_legacy_database_migration(
  namespace: Uuid,
  documents: &[LegacyDatabaseDocumentSource],
  limits: WorkspaceImportLimits,
) -> LegacyDatabaseMigrationPlan {
  let mut plan = plan_legacy_database_migration(namespace, documents, limits);
  let database_sources = plan
    .databases
    .iter()
    .enumerate()
    .filter_map(|(index, database)| {
      Uuid::parse_str(&database.source_id)
        .ok()
        .map(|source_id| (source_id, index))
    })
    .collect::<HashMap<_, _>>();
  let mut portability_diagnostics = Vec::new();

  for reference in plan
    .block_references
    .iter_mut()
    .filter(|reference| reference.already_migrated)
  {
    let Some(database_index) = database_sources.get(&reference.target_database_id).copied() else {
      portability_diagnostics.push(
        blocking(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseUnsupported,
          "server-backed Database reference is external to the imported workspace",
        )
        .with_property_path("/props/serverDatabaseId")
        .with_source_context(&reference.source_document_id, &reference.block_id),
      );
      continue;
    };
    let database = &plan.databases[database_index];
    let target_view_id = match reference.target_view_id {
      Some(source_view_id) => {
        let target = database
          .views
          .iter()
          .find(|view| Uuid::parse_str(&view.source_id).ok() == Some(source_view_id))
          .map(|view| view.target_id);
        if target.is_none() {
          portability_diagnostics.push(
            blocking(
              WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseUnsupported,
              "server-backed Database reference names a view missing from the imported workspace",
            )
            .with_property_path("/props/serverViewId")
            .with_source_context(&reference.source_document_id, &reference.block_id),
          );
        }
        target
      }
      None => None,
    };
    reference.target_database_id = database.target_id;
    reference.target_view_id = target_view_id;
    // The source block is reference-only, but its ids still require a rewrite
    // before the fresh document is first persisted.
    reference.already_migrated = false;
  }

  plan.diagnostics.extend(portability_diagnostics);
  plan.apply_allowed = plan
    .diagnostics
    .iter()
    .all(|diagnostic| diagnostic.severity != WorkspaceImportDiagnosticSeverity::Blocking);
  plan
}

pub fn plan_legacy_database_migration_with_limits(
  namespace: Uuid,
  documents: &[LegacyDatabaseDocumentSource],
  limits: WorkspaceImportLimits,
  database_limits: &DatabaseLimits,
) -> LegacyDatabaseMigrationPlan {
  let mut diagnostics = Vec::new();
  let mut databases = BTreeMap::<String, LegacyDatabasePlan>::new();
  let mut fingerprints = HashMap::<String, Value>::new();
  let mut block_references = Vec::new();

  for document in documents {
    let mut block_ids = HashSet::new();
    for block in &document.blocks {
      if !block_ids.insert(block.block_id.as_str()) {
        diagnostics.push(
          blocking(
            WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
            "workspace document contains duplicate Database block identities",
          )
          .with_source_context(&document.source_document_id, &block.block_id),
        );
        continue;
      }
      if block.server_database_id.is_some() {
        match parse_reference_only_block(document, block) {
          Ok(reference) => block_references.push(reference),
          Err(diagnostic) => diagnostics.push(
            diagnostic
              .with_property_path("/props")
              .with_source_context(&document.source_document_id, &block.block_id),
          ),
        }
        continue;
      }

      let source_database_id = block
        .source_database_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| format!("{}:{}", document.source_document_id, block.block_id));
      let target_database_id = target_id(namespace, "database", &source_database_id);
      match plan_database(target_database_id, &source_database_id, block, limits) {
        Ok((database, fingerprint, findings)) => {
          diagnostics.extend(
            findings
              .into_iter()
              .map(|diagnostic| diagnostic.with_source_context(&document.source_document_id, &block.block_id)),
          );
          if let Some(existing_fingerprint) = fingerprints.get(&source_database_id) {
            if existing_fingerprint != &fingerprint {
              diagnostics.push(
                blocking(
                  WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
                  "repeated source Database identity has conflicting payloads",
                )
                .with_source_context(&document.source_document_id, &block.block_id),
              );
              continue;
            }
          } else {
            fingerprints.insert(source_database_id.clone(), fingerprint);
            databases.insert(source_database_id.clone(), database.clone());
          }
          block_references.push(LegacyDatabaseBlockReferencePlan {
            source_document_id: document.source_document_id.clone(),
            block_id: block.block_id.clone(),
            target_database_id,
            target_view_id: database.views.first().map(|view| view.target_id),
            already_migrated: false,
          });
        }
        Err(diagnostic) => {
          diagnostics.push(diagnostic.with_source_context(&document.source_document_id, &block.block_id))
        }
      }
    }
  }

  let databases = databases.into_values().collect::<Vec<_>>();
  if databases.len() > limits.max_databases {
    diagnostics.push(blocking(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseUnsupported,
      "workspace import exceeds the configured Database limit",
    ));
  }
  for database in &databases {
    if build_database_bundle(Uuid::nil(), Uuid::nil(), database, &HashMap::new(), database_limits).is_err() {
      diagnostics.push(
        blocking(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
          "legacy Database cannot satisfy the canonical server model",
        )
        .with_source_context("workspace", &database.source_id),
      );
    }
  }
  let field_count = databases.iter().map(|database| database.fields.len()).sum();
  let row_count = databases.iter().map(|database| database.rows.len()).sum();
  let cell_count = databases
    .iter()
    .flat_map(|database| &database.rows)
    .map(|row| row.cells.len())
    .sum();
  let view_count = databases.iter().map(|database| database.views.len()).sum();
  block_references.sort_by(|left, right| {
    left
      .source_document_id
      .cmp(&right.source_document_id)
      .then_with(|| left.block_id.cmp(&right.block_id))
  });
  let apply_allowed = diagnostics
    .iter()
    .all(|diagnostic| diagnostic.severity != WorkspaceImportDiagnosticSeverity::Blocking);
  LegacyDatabaseMigrationPlan {
    databases,
    block_references,
    diagnostics,
    field_count,
    row_count,
    cell_count,
    view_count,
    apply_allowed,
  }
}

impl DatabaseImportExportService {
  /// Dry-run persisted Database migration through the canonical document read
  /// service. No repository or document writes occur in this path.
  pub async fn preview_legacy_database_migration(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    document_ids: &[DocId],
    limits: WorkspaceImportLimits,
  ) -> DatabaseResult<LegacyDatabaseMigrationPlan> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::CreateDoc).await?;
    let mut documents = Vec::with_capacity(document_ids.len());
    let mut extraction_diagnostics = Vec::new();
    let mut seen = HashSet::new();
    for document_id in document_ids {
      if !seen.insert(*document_id) {
        continue;
      }
      let update = self
        .doc_service
        .load_full_doc(workspace_id, *document_id)
        .await
        .map_err(|_| DatabaseServiceError::new(ERR_STORAGE, "workspace document cannot be loaded for migration"))?;
      match yjs::extract_legacy_database_blocks(&update) {
        Ok(blocks) => documents.push(LegacyDatabaseDocumentSource {
          source_document_id: document_id.to_string(),
          blocks,
        }),
        Err(_) => extraction_diagnostics.push(blocking(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportDocumentInvalid,
          "workspace document contains an unreadable Yjs Database payload",
        )),
      }
    }
    let namespace = Uuid::new_v5(&workspace_id, b"legacy-database-migration");
    let mut plan = plan_legacy_database_migration_with_limits(namespace, &documents, limits, &self.limits);
    plan.diagnostics.extend(extraction_diagnostics);
    plan.apply_allowed = plan
      .diagnostics
      .iter()
      .all(|diagnostic| diagnostic.severity != WorkspaceImportDiagnosticSeverity::Blocking);
    Ok(plan)
  }

  /// Materialize one deterministic legacy plan through the canonical Database
  /// repository and validators. Existing target ids are treated as an
  /// idempotent retry only when they belong to the same target workspace.
  pub async fn materialize_legacy_database_plan(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    plan: &LegacyDatabasePlan,
    asset_keys: &HashMap<String, String>,
  ) -> DatabaseResult<myoxus_domain::database::DatabaseRecord> {
    if let Some(existing) = self
      .schema_repo
      .get_database(plan.target_id)
      .await
      .map_err(DatabaseServiceError::from)?
    {
      if existing.database.workspace_id != workspace_id {
        return Err(DatabaseServiceError::new(
          ERR_STORAGE,
          "legacy Database target identity belongs to another workspace",
        ));
      }
      return Ok(existing);
    }
    let bundle = build_database_bundle(actor, workspace_id, plan, asset_keys, &self.limits)?;
    self
      .import_export_repo
      .apply_database_snapshot_import(
        DatabaseJsonImportMode::Create,
        None,
        None,
        bundle.database,
        bundle.fields,
        bundle.views,
        Vec::new(),
        Vec::new(),
        bundle.rows,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
        None,
        None,
      )
      .await
      .map_err(DatabaseServiceError::from)
  }

  /// Apply the persisted-document migration through normal document reads and
  /// append-only Yjs writes. A blocking dry-run creates no Database and writes
  /// no document update.
  #[tracing::instrument(skip(self, document_ids, limits), fields(%actor, %workspace_id, document_count = document_ids.len()))]
  pub async fn apply_legacy_database_migration(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    document_ids: &[DocId],
    limits: WorkspaceImportLimits,
  ) -> DatabaseResult<LegacyDatabaseMigrationApplyResult> {
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::CreateDoc).await?;
    let mut documents = Vec::new();
    let mut source_updates = HashMap::new();
    let mut seen = HashSet::new();
    for document_id in document_ids {
      if !seen.insert(*document_id) {
        continue;
      }
      let update = self
        .doc_service
        .load_full_doc(workspace_id, *document_id)
        .await
        .map_err(|_| DatabaseServiceError::new(ERR_STORAGE, "workspace document cannot be loaded for migration"))?;
      let blocks = yjs::extract_legacy_database_blocks(&update)
        .map_err(|_| DatabaseServiceError::new(ERR_STORAGE, "workspace document Database payload cannot be read"))?;
      documents.push(LegacyDatabaseDocumentSource {
        source_document_id: document_id.to_string(),
        blocks,
      });
      source_updates.insert(document_id.to_string(), update);
    }
    let namespace = Uuid::new_v5(&workspace_id, b"legacy-database-migration");
    let plan = plan_legacy_database_migration_with_limits(namespace, &documents, limits, &self.limits);
    if !plan.apply_allowed {
      return Ok(LegacyDatabaseMigrationApplyResult {
        plan,
        created_database_ids: Vec::new(),
        migrated_block_count: 0,
      });
    }

    // Validate every canonical bundle before the first product write. This is
    // the final domain gate, not a second conversion implementation.
    for database in &plan.databases {
      build_database_bundle(actor, workspace_id, database, &HashMap::new(), &self.limits)?;
    }
    let mut created_database_ids = Vec::new();
    for database in &plan.databases {
      self
        .materialize_legacy_database_plan(actor, workspace_id, database, &HashMap::new())
        .await?;
      created_database_ids.push(database.target_id);
    }

    let mut migrated_block_count = 0;
    for document in &documents {
      let references = plan
        .block_references
        .iter()
        .filter(|reference| reference.source_document_id == document.source_document_id && !reference.already_migrated)
        .map(|reference| yjs::LegacyDatabaseReferenceRewrite {
          block_id: reference.block_id.clone(),
          server_database_id: reference.target_database_id,
          server_view_id: reference.target_view_id,
        })
        .collect::<Vec<_>>();
      if references.is_empty() {
        continue;
      }
      let update = source_updates
        .get(&document.source_document_id)
        .ok_or_else(|| DatabaseServiceError::new(ERR_STORAGE, "workspace document migration state is missing"))?;
      let rewritten = yjs::rewrite_legacy_database_references(update, &references)
        .map_err(|_| DatabaseServiceError::new(ERR_STORAGE, "workspace document Database rewrite failed"))?;
      let document_id = Uuid::parse_str(&document.source_document_id)
        .map_err(|_| DatabaseServiceError::new(ERR_STORAGE, "workspace document identity is invalid"))?;
      self
        .doc_service
        .push_update_raw(
          workspace_id,
          document_id,
          rewritten.incremental_update,
          DocSpaceKind::Workspace,
        )
        .await
        .map_err(|_| {
          DatabaseServiceError::new(ERR_STORAGE, "workspace document migration update could not be appended")
        })?;
      migrated_block_count += rewritten.rewritten_block_count;
    }
    Ok(LegacyDatabaseMigrationApplyResult {
      plan,
      created_database_ids,
      migrated_block_count,
    })
  }

  /// Compensation-only removal for a Database created from a durable import
  /// plan. Interactive callers continue to use the ACL-aware delete methods.
  pub async fn delete_imported_database(
    &self,
    expected_workspace_id: WorkspaceId,
    database_id: Uuid,
  ) -> DatabaseResult<()> {
    let Some(existing) = self
      .schema_repo
      .get_database_for_lifecycle(database_id)
      .await
      .map_err(DatabaseServiceError::from)?
    else {
      return Ok(());
    };
    if existing.database.workspace_id != expected_workspace_id {
      // This import never created the colliding target. Compensation must not
      // delete another workspace's canonical Database.
      return Ok(());
    }
    let cleanup_actor = existing
      .database
      .created_by
      .or(existing.database.updated_by)
      .ok_or_else(|| DatabaseServiceError::new(ERR_STORAGE, "imported Database has no cleanup actor"))?;
    let purge_revision = if existing.database.deleted_at.is_none() {
      self
        .schema_repo
        .trash_database(
          database_id,
          cleanup_actor,
          myoxus_domain::database::DatabaseEditPrecondition::new(Some(existing.database.edit_revision), false),
        )
        .await
        .map_err(DatabaseServiceError::from)?
        .database
        .edit_revision
    } else {
      existing.database.edit_revision
    };
    self
      .schema_repo
      .purge_database(
        database_id,
        myoxus_domain::database::DatabaseEditPrecondition::new(Some(purge_revision), false),
      )
      .await
      .map_err(DatabaseServiceError::from)
  }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDatabaseMigrationApplyResult {
  pub plan: LegacyDatabaseMigrationPlan,
  pub created_database_ids: Vec<Uuid>,
  pub migrated_block_count: usize,
}

struct LegacyDatabaseBundle {
  database: Database,
  fields: Vec<DatabaseField>,
  views: Vec<DatabaseView>,
  rows: Vec<DatabaseRowRecord>,
}

fn build_database_bundle(
  actor: UserId,
  workspace_id: WorkspaceId,
  plan: &LegacyDatabasePlan,
  asset_keys: &HashMap<String, String>,
  limits: &DatabaseLimits,
) -> DatabaseResult<LegacyDatabaseBundle> {
  let now = Utc::now();
  let database = Database {
    system_role: None,
    managed_installation: None,

    id: plan.target_id,
    workspace_id,
    profile_kind: DatabaseProfileKind::Generic,
    profile_structure_preset: None,
    profile_config: serde_json::json!({}),
    title: crate::database::definition::rules::validate_title(&plan.title)?,
    description: None,
    created_by: Some(actor),
    updated_by: Some(actor),
    deleted_at: None,
    deleted_by: None,
    edit_revision: 1,
    created_at: now,
    updated_at: now,
  };
  let mut field_by_source = HashMap::new();
  let mut fields = Vec::with_capacity(plan.fields.len());
  for (position, field) in plan.fields.iter().enumerate() {
    let field_type = DatabaseFieldType::from_str(&field.field_kind)
      .map_err(|_| DatabaseServiceError::new(ERR_FIELD_INVALID, "legacy Database field kind is invalid"))?;
    let config = legacy_field_config(field_type, &field.config)?;
    crate::database::definition::rules::validate_field_config(field_type, &config)?;
    let field = DatabaseField {
      id: field.target_id,
      database_id: plan.target_id,
      name: crate::database::definition::rules::validate_title(&field.name)?,
      field_type,
      config,
      position: position as i32,
      required: field_type == DatabaseFieldType::Title,
      edit_revision: 1,
      created_at: now,
      updated_at: now,
    };
    field_by_source.insert(plan.fields[position].source_id.clone(), field.clone());
    fields.push(field);
  }
  if fields
    .iter()
    .filter(|field| field.field_type == DatabaseFieldType::Title)
    .count()
    != 1
  {
    return Err(DatabaseServiceError::new(
      ERR_FIELD_INVALID,
      "legacy Database requires exactly one title field",
    ));
  }
  let views = plan
    .views
    .iter()
    .enumerate()
    .map(|(position, view)| build_view(plan.target_id, position as i32, view, &fields, &field_by_source))
    .collect::<DatabaseResult<Vec<_>>>()?;
  for view in &views {
    crate::database::views::rules::validate_view_config(
      view.view_kind,
      &view.config,
      &fields,
      limits.max_fields_per_database,
    )?;
  }
  let mut rows = Vec::with_capacity(plan.rows.len());
  for (position, row) in plan.rows.iter().enumerate() {
    let mut cells = Vec::new();
    for (source_field_id, value) in &row.cells {
      let field = field_by_source.get(source_field_id).ok_or_else(|| {
        DatabaseServiceError::new(ERR_FIELD_INVALID, "legacy Database cell references an unknown field")
      })?;
      if field.field_type == DatabaseFieldType::Title || value.is_null() {
        continue;
      }
      let value = legacy_cell_value(field, value, asset_keys)?;
      crate::database::editing::rules::validate_cell_value(field, &value, limits)?;
      cells.push(DatabaseCellValue {
        row_id: row.target_id,
        field_id: field.id,
        field_type: field.field_type,
        value,
        updated_by: Some(actor),
        edit_revision: 1,
        updated_at: now,
      });
    }
    rows.push(DatabaseRowRecord {
      row: DatabaseRow {
        id: row.target_id,
        database_id: plan.target_id,
        content_document_id: None,
        row_kind: DatabaseRowKind::Record,
        title: crate::database::definition::rules::validate_title(&row.title)?,
        position: position as i32,
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
  Ok(LegacyDatabaseBundle {
    database,
    fields,
    views,
    rows,
  })
}

fn legacy_field_config(field_type: DatabaseFieldType, source: &Value) -> DatabaseResult<DatabaseFieldConfig> {
  let config = match field_type {
    DatabaseFieldType::Select | DatabaseFieldType::MultiSelect => {
      let options = source
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(position, option)| {
          let id = option
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| DatabaseServiceError::new(ERR_FIELD_INVALID, "legacy select option id is invalid"))?;
          let name = option
            .get("value")
            .or_else(|| option.get("name"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| DatabaseServiceError::new(ERR_FIELD_INVALID, "legacy select option name is invalid"))?;
          Ok(DatabaseSelectOption {
            id: id.to_string(),
            name: name.to_string(),
            position: position as i32,
            color_role: format!("database.option.{id}"),
          })
        })
        .collect::<DatabaseResult<Vec<_>>>()?;
      let config = DatabaseSelectFieldConfig { options };
      if field_type == DatabaseFieldType::Select {
        DatabaseFieldConfig::Select(config)
      } else {
        DatabaseFieldConfig::MultiSelect(config)
      }
    }
    DatabaseFieldType::DateTime => DatabaseFieldConfig::DateTime(DatabaseDateTimeFieldConfig {
      default_time_zone: Some("UTC".to_string()),
      allow_reminders: false,
    }),
    _ => DatabaseFieldConfig::empty_for(field_type),
  };
  Ok(config)
}

fn legacy_cell_value(
  field: &DatabaseField,
  source: &Value,
  asset_keys: &HashMap<String, String>,
) -> DatabaseResult<DatabaseCellValueData> {
  let invalid = || DatabaseServiceError::new(ERR_FIELD_INVALID, "legacy Database cell value is invalid");
  let value = match field.field_type {
    DatabaseFieldType::Text => DatabaseCellValueData::Text(source.as_str().ok_or_else(invalid)?.to_string()),
    DatabaseFieldType::RichText => {
      let plain_text = source.as_str().ok_or_else(invalid)?.to_string();
      DatabaseCellValueData::RichText(DatabaseRichTextValue {
        document: serde_json::json!({
          "type": "doc",
          "content": [{"type": "paragraph", "content": [{"type": "text", "text": plain_text}]}],
        }),
        plain_text,
      })
    }
    DatabaseFieldType::Number => DatabaseCellValueData::Number(source.as_f64().ok_or_else(invalid)?),
    DatabaseFieldType::Percent => {
      let raw = source.as_f64().ok_or_else(invalid)?;
      DatabaseCellValueData::Percent(if (0.0..=1.0).contains(&raw) { raw * 100.0 } else { raw })
    }
    DatabaseFieldType::Checkbox => DatabaseCellValueData::Checkbox(source.as_bool().ok_or_else(invalid)?),
    DatabaseFieldType::Date => {
      let raw = source.as_str().ok_or_else(invalid)?;
      let start = raw
        .get(..10)
        .and_then(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").ok())
        .ok_or_else(invalid)?;
      DatabaseCellValueData::Date(DatabaseDateValue { start, end: None })
    }
    DatabaseFieldType::DateTime => {
      let start = DateTime::parse_from_rfc3339(source.as_str().ok_or_else(invalid)?)
        .map_err(|_| invalid())?
        .with_timezone(&Utc);
      DatabaseCellValueData::DateTime(DatabaseDateTimeValue {
        start,
        end: None,
        all_day: false,
        time_zone: "UTC".to_string(),
      })
    }
    DatabaseFieldType::Select => DatabaseCellValueData::Select(source.as_str().ok_or_else(invalid)?.to_string()),
    DatabaseFieldType::MultiSelect => DatabaseCellValueData::MultiSelect(
      source
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .map(|value| value.as_str().map(str::to_string).ok_or_else(invalid))
        .collect::<DatabaseResult<Vec<_>>>()?,
    ),
    DatabaseFieldType::Users => DatabaseCellValueData::Users(
      source
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .map(|value| {
          value
            .as_str()
            .and_then(|value| Uuid::parse_str(value).ok())
            .ok_or_else(invalid)
        })
        .collect::<DatabaseResult<Vec<_>>>()?,
    ),
    DatabaseFieldType::Files => {
      let files = source
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .map(|value| {
          let source_key = value.as_str().ok_or_else(invalid)?;
          Ok(DatabaseFileReference {
            blob_key: asset_keys
              .get(source_key)
              .cloned()
              .unwrap_or_else(|| source_key.to_string()),
            name: None,
            mime: None,
            size: None,
            caption: None,
            cover: false,
          })
        })
        .collect::<DatabaseResult<Vec<_>>>()?;
      DatabaseCellValueData::Files(DatabaseFilesValue { files })
    }
    DatabaseFieldType::Url => DatabaseCellValueData::Url(source.as_str().ok_or_else(invalid)?.to_string()),
    DatabaseFieldType::CreatedTime => {
      let value = DateTime::parse_from_rfc3339(source.as_str().ok_or_else(invalid)?)
        .map_err(|_| invalid())?
        .with_timezone(&Utc);
      DatabaseCellValueData::CreatedTime(value)
    }
    _ => return Err(invalid()),
  };
  Ok(value)
}

fn build_view(
  database_id: Uuid,
  position: i32,
  source: &LegacyDatabaseViewPlan,
  fields: &[DatabaseField],
  field_by_source: &HashMap<String, DatabaseField>,
) -> DatabaseResult<DatabaseView> {
  let invalid = || DatabaseServiceError::new(ERR_FIELD_INVALID, "legacy Database view config is invalid");
  let view_kind = DatabaseViewKind::from_str(&source.view_kind).map_err(|_| invalid())?;
  let title_field_id = fields
    .iter()
    .find(|field| field.field_type == DatabaseFieldType::Title)
    .map(|field| field.id)
    .ok_or_else(invalid)?;
  let visible_field_ids = source
    .config
    .get("columns")
    .and_then(Value::as_array)
    .map(|columns| {
      columns
        .iter()
        .filter(|column| !column.get("hide").and_then(Value::as_bool).unwrap_or(false))
        .map(|column| {
          let source_id = column.get("id").and_then(Value::as_str).ok_or_else(invalid)?;
          field_by_source.get(source_id).map(|field| field.id).ok_or_else(invalid)
        })
        .collect::<DatabaseResult<Vec<_>>>()
    })
    .transpose()?
    .unwrap_or_else(|| fields.iter().map(|field| field.id).collect());
  let sort = source
    .config
    .get("sort")
    .and_then(|value| value.get("sortBy").or_else(|| value.as_array().map(|_| value)))
    .and_then(Value::as_array)
    .map(|rules| {
      rules
        .iter()
        .map(|rule| {
          let source_id = rule
            .get("ref")
            .and_then(|reference| reference.get("name"))
            .or_else(|| rule.get("columnId"))
            .or_else(|| rule.get("fieldId"))
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
          let field = field_by_source.get(source_id).ok_or_else(invalid)?;
          if !field.field_type.supports_saved_sort() {
            return Err(invalid());
          }
          let descending = rule
            .get("desc")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| rule.get("direction").and_then(Value::as_str) == Some("desc"));
          Ok(DatabaseSortRule {
            field_id: field.id,
            direction: if descending {
              DatabaseSortDirection::Desc
            } else {
              DatabaseSortDirection::Asc
            },
          })
        })
        .collect::<DatabaseResult<Vec<_>>>()
    })
    .transpose()?
    .unwrap_or_default();
  let group = source
    .config
    .get("groupBy")
    .and_then(Value::as_object)
    .map(|group| {
      let source_id = group.get("columnId").and_then(Value::as_str).ok_or_else(invalid)?;
      Ok::<DatabaseGroupRule, DatabaseServiceError>(DatabaseGroupRule {
        field_id: field_by_source
          .get(source_id)
          .map(|field| field.id)
          .ok_or_else(invalid)?,
        descending: group
          .get("sort")
          .and_then(|sort| sort.get("desc"))
          .and_then(Value::as_bool)
          .unwrap_or(false),
        show_empty_groups: !group.get("hideEmpty").and_then(Value::as_bool).unwrap_or(false),
      })
    })
    .transpose()?;
  let filter_tree = legacy_filter_group(source.config.get("filter"), field_by_source)?;
  let config = match view_kind {
    DatabaseViewKind::Table => DatabaseViewConfig::Table(DatabaseTableViewConfig {
      title_field_id,
      visible_field_ids,
      field_widths: BTreeMap::new(),
      search_field_ids: fields
        .iter()
        .filter(|field| field.field_type.supports_server_search())
        .map(|field| field.id)
        .collect(),
      sort,
      filter: Vec::new(),
      filter_tree: filter_tree.clone(),
      group,
      subgroup: None,
    }),
    DatabaseViewKind::Kanban => {
      let group_field_id = group.as_ref().map(|group| group.field_id).ok_or_else(invalid)?;
      DatabaseViewConfig::Kanban(DatabaseKanbanViewConfig {
        title_field_id,
        group_field_id,
        visible_field_ids,
        cover_field_id: None,
        card_density: DatabaseCardDensity::Default,
        sort,
        filter: Vec::new(),
        filter_tree: filter_tree.clone(),
      })
    }
    DatabaseViewKind::List => DatabaseViewConfig::List(DatabaseListViewConfig {
      title_field_id,
      visible_field_ids,
      sort,
      filter: Vec::new(),
      filter_tree: filter_tree.clone(),
      density: DatabaseListDensity::Default,
      show_field_labels: true,
      group,
      subgroup: None,
    }),
    DatabaseViewKind::Gallery => DatabaseViewConfig::Gallery(DatabaseGalleryViewConfig {
      title_field_id,
      visible_field_ids,
      cover_field_id: None,
      sort,
      filter: Vec::new(),
      filter_tree: filter_tree.clone(),
      card_density: DatabaseGalleryCardDensity::Default,
      show_empty_cover: true,
      group,
      subgroup: None,
    }),
    DatabaseViewKind::Calendar => {
      let date_field_id = fields
        .iter()
        .find(|field| matches!(field.field_type, DatabaseFieldType::Date | DatabaseFieldType::DateTime))
        .map(|field| field.id)
        .ok_or_else(invalid)?;
      DatabaseViewConfig::Calendar(DatabaseCalendarViewConfig {
        title_field_id,
        date_field_id,
        visible_field_ids,
        sort,
        filter: Vec::new(),
        filter_tree: filter_tree.clone(),
        date_mode: DatabaseCalendarDateMode::Month,
        initial_range: DatabaseCalendarInitialRange::CurrentMonth,
        group,
        subgroup: None,
      })
    }
    DatabaseViewKind::Timeline => {
      let start_field_id = fields
        .iter()
        .find(|field| matches!(field.field_type, DatabaseFieldType::Date | DatabaseFieldType::DateTime))
        .map(|field| field.id)
        .ok_or_else(invalid)?;
      DatabaseViewConfig::Timeline(DatabaseTimelineViewConfig {
        title_field_id,
        start_field_id,
        end_field_id: None,
        visible_field_ids,
        sort,
        filter: Vec::new(),
        filter_tree: filter_tree.clone(),
        group_by: DatabaseTimelineGroupBy::Month,
        order: DatabaseTimelineOrder::Asc,
        zoom: DatabaseTimelineZoom::Month,
      })
    }
    DatabaseViewKind::Gantt => {
      return Err(invalid());
    }
    DatabaseViewKind::Progress => {
      let progress_field_id = fields
        .iter()
        .find(|field| field.field_type == DatabaseFieldType::Percent)
        .map(|field| field.id)
        .ok_or_else(invalid)?;
      DatabaseViewConfig::Progress(DatabaseProgressViewConfig {
        title_field_id,
        progress_field_id,
        group_field_id: group.map(|group| group.field_id),
        visible_field_ids,
        sort,
        filter: Vec::new(),
        filter_tree,
      })
    }
  };
  Ok(DatabaseView {
    id: source.target_id,
    database_id,
    name: crate::database::definition::rules::validate_title(&source.name)?,
    view_kind,
    icon: None,
    config,
    position,
    edit_revision: 1,
    created_at: Utc::now(),
    updated_at: Utc::now(),
  })
}

/// Convert the persisted Virgultum filter expression without evaluating it in
/// the importer. Unsupported functions or operands fail the complete plan so a
/// saved view is never silently broadened during migration.
fn legacy_filter_group(
  source: Option<&Value>,
  fields: &HashMap<String, DatabaseField>,
) -> DatabaseResult<Option<DatabaseFilterGroup>> {
  let Some(source) = source.filter(|value| !value.is_null()) else {
    return Ok(None);
  };
  let object = source.as_object().ok_or_else(invalid_legacy_filter)?;
  if object.get("type").and_then(Value::as_str) != Some("group") {
    return Err(invalid_legacy_filter());
  }
  let conjunction = match object.get("op").and_then(Value::as_str).unwrap_or("and") {
    "and" => DatabaseFilterConjunction::And,
    "or" => DatabaseFilterConjunction::Or,
    _ => return Err(invalid_legacy_filter()),
  };
  let conditions = object
    .get("conditions")
    .and_then(Value::as_array)
    .ok_or_else(invalid_legacy_filter)?;
  let mut rules = Vec::new();
  let mut groups = Vec::new();
  for condition in conditions {
    match condition.get("type").and_then(Value::as_str) {
      Some("group") => {
        if let Some(group) = legacy_filter_group(Some(condition), fields)? {
          groups.push(group);
        }
      }
      Some("filter") => rules.push(legacy_filter_rule(condition, fields)?),
      _ => return Err(invalid_legacy_filter()),
    }
  }
  let group = DatabaseFilterGroup {
    conjunction,
    rules,
    groups,
  };
  Ok((!group.is_empty()).then_some(group))
}

fn legacy_filter_rule(source: &Value, fields: &HashMap<String, DatabaseField>) -> DatabaseResult<DatabaseFilterRule> {
  let object = source.as_object().ok_or_else(invalid_legacy_filter)?;
  let source_field_id = object
    .get("left")
    .filter(|left| left.get("type").and_then(Value::as_str) == Some("ref"))
    .and_then(|left| left.get("name"))
    .and_then(Value::as_str)
    .ok_or_else(invalid_legacy_filter)?;
  let field = fields.get(source_field_id).ok_or_else(invalid_legacy_filter)?;
  let function = object
    .get("function")
    .and_then(Value::as_str)
    .ok_or_else(invalid_legacy_filter)?;
  let arguments = object
    .get("args")
    .and_then(Value::as_array)
    .ok_or_else(invalid_legacy_filter)?
    .iter()
    .map(|argument| {
      if argument.get("type").and_then(Value::as_str) != Some("literal") {
        return Err(invalid_legacy_filter());
      }
      argument.get("value").cloned().ok_or_else(invalid_legacy_filter)
    })
    .collect::<DatabaseResult<Vec<_>>>()?;

  let (operator, value) = match function {
    "isEmpty" if arguments.is_empty() => (DatabaseFilterOperator::Empty, DatabaseFilterValue::None),
    "isNotEmpty" if arguments.is_empty() => (DatabaseFilterOperator::NotEmpty, DatabaseFilterValue::None),
    "isChecked" if arguments.is_empty() && field.field_type == DatabaseFieldType::Checkbox => {
      (DatabaseFilterOperator::Checked, DatabaseFilterValue::None)
    }
    "isUnchecked" if arguments.is_empty() && field.field_type == DatabaseFieldType::Checkbox => {
      (DatabaseFilterOperator::Unchecked, DatabaseFilterValue::None)
    }
    function
      if matches!(
        field.field_type,
        DatabaseFieldType::Title
          | DatabaseFieldType::Text
          | DatabaseFieldType::RichText
          | DatabaseFieldType::Url
          | DatabaseFieldType::Email
          | DatabaseFieldType::Phone
      ) =>
    {
      let operator = match function {
        "contains" => DatabaseFilterOperator::Contains,
        "doesNoContains" => DatabaseFilterOperator::DoesNotContain,
        "startsWith" => DatabaseFilterOperator::StartsWith,
        "endsWith" => DatabaseFilterOperator::EndsWith,
        "is" => DatabaseFilterOperator::Is,
        "isNot" => DatabaseFilterOperator::IsNot,
        _ => return Err(invalid_legacy_filter()),
      };
      (operator, DatabaseFilterValue::Text(single_string_argument(&arguments)?))
    }
    function if matches!(field.field_type, DatabaseFieldType::Number | DatabaseFieldType::Percent) => {
      let operator = match function {
        "equal" => DatabaseFilterOperator::Equals,
        "notEqual" => DatabaseFilterOperator::NotEquals,
        "greatThan" => DatabaseFilterOperator::Greater,
        "lessThan" => DatabaseFilterOperator::Less,
        "greatThanOrEqual" => DatabaseFilterOperator::GreaterOrEqual,
        "lessThanOrEqual" => DatabaseFilterOperator::LessOrEqual,
        _ => return Err(invalid_legacy_filter()),
      };
      let number = single_argument(&arguments)?
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(invalid_legacy_filter)?;
      (operator, DatabaseFilterValue::Number(number))
    }
    "isOneOf" if field.field_type == DatabaseFieldType::Select => (
      DatabaseFilterOperator::AnyOf,
      DatabaseFilterValue::Ids(single_string_array_argument(&arguments)?),
    ),
    "isNotOneOf" if field.field_type == DatabaseFieldType::Select => (
      DatabaseFilterOperator::NoneOf,
      DatabaseFilterValue::Ids(single_string_array_argument(&arguments)?),
    ),
    "containsOneOf" if field.field_type == DatabaseFieldType::MultiSelect => {
      let ids = single_string_array_argument(&arguments)?;
      let [id] = ids.as_slice() else {
        return Err(invalid_legacy_filter());
      };
      (
        DatabaseFilterOperator::Contains,
        DatabaseFilterValue::OptionId(id.clone()),
      )
    }
    "doesNotContainOneOf" if field.field_type == DatabaseFieldType::MultiSelect => {
      let ids = single_string_array_argument(&arguments)?;
      let [id] = ids.as_slice() else {
        return Err(invalid_legacy_filter());
      };
      (
        DatabaseFilterOperator::DoesNotContain,
        DatabaseFilterValue::OptionId(id.clone()),
      )
    }
    "containsAll" if field.field_type == DatabaseFieldType::MultiSelect => (
      DatabaseFilterOperator::ContainsAll,
      DatabaseFilterValue::Ids(single_string_array_argument(&arguments)?),
    ),
    function if matches!(field.field_type, DatabaseFieldType::Date | DatabaseFieldType::DateTime) => {
      let operator = match function {
        "before" => DatabaseFilterOperator::Before,
        "after" => DatabaseFilterOperator::After,
        _ => return Err(invalid_legacy_filter()),
      };
      let milliseconds = single_argument(&arguments)?
        .as_i64()
        .ok_or_else(invalid_legacy_filter)?;
      let instant = DateTime::<Utc>::from_timestamp_millis(milliseconds).ok_or_else(invalid_legacy_filter)?;
      let value = if field.field_type == DatabaseFieldType::Date {
        DatabaseFilterValue::Date(instant.date_naive())
      } else {
        DatabaseFilterValue::Instant(instant)
      };
      (operator, value)
    }
    _ => return Err(invalid_legacy_filter()),
  };
  Ok(DatabaseFilterRule {
    field_id: field.id,
    operator,
    value,
  })
}

fn single_argument(arguments: &[Value]) -> DatabaseResult<&Value> {
  let [argument] = arguments else {
    return Err(invalid_legacy_filter());
  };
  Ok(argument)
}

fn single_string_argument(arguments: &[Value]) -> DatabaseResult<String> {
  single_argument(arguments)?
    .as_str()
    .filter(|value| !value.trim().is_empty())
    .map(str::to_string)
    .ok_or_else(invalid_legacy_filter)
}

fn single_string_array_argument(arguments: &[Value]) -> DatabaseResult<Vec<String>> {
  let values = single_argument(arguments)?
    .as_array()
    .ok_or_else(invalid_legacy_filter)?;
  if values.is_empty() {
    return Err(invalid_legacy_filter());
  }
  values
    .iter()
    .map(|value| {
      value
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(invalid_legacy_filter)
    })
    .collect()
}

fn invalid_legacy_filter() -> DatabaseServiceError {
  DatabaseServiceError::new(ERR_FIELD_INVALID, "legacy Database view filter is not portable")
}

fn parse_reference_only_block(
  document: &LegacyDatabaseDocumentSource,
  block: &yjs::LegacyDatabaseBlock,
) -> Result<LegacyDatabaseBlockReferencePlan, WorkspaceImportDiagnostic> {
  if !block.is_reference_only() {
    return Err(blocking(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
      "server-backed Database reference still contains editor-local payload",
    ));
  }
  let target_database_id = block
    .server_database_id
    .as_deref()
    .and_then(|id| Uuid::parse_str(id).ok())
    .ok_or_else(|| {
      blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
        "server-backed Database reference has an invalid identity",
      )
    })?;
  let target_view_id = block
    .server_view_id
    .as_deref()
    .map(Uuid::parse_str)
    .transpose()
    .map_err(|_| {
      blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
        "server-backed Database reference has an invalid view identity",
      )
    })?;
  Ok(LegacyDatabaseBlockReferencePlan {
    source_document_id: document.source_document_id.clone(),
    block_id: block.block_id.clone(),
    target_database_id,
    target_view_id,
    already_migrated: true,
  })
}

fn plan_database(
  target_database_id: Uuid,
  source_database_id: &str,
  block: &yjs::LegacyDatabaseBlock,
  limits: WorkspaceImportLimits,
) -> Result<(LegacyDatabasePlan, Value, Vec<WorkspaceImportDiagnostic>), WorkspaceImportDiagnostic> {
  let columns = block.columns.as_array().ok_or_else(|| {
    blocking(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
      "legacy Database columns must be an array",
    )
    .with_property_path("/columns")
  })?;
  let mut field_ids = HashSet::new();
  let mut field_kinds = HashMap::new();
  let mut fields = Vec::with_capacity(columns.len().saturating_add(1));
  for (index, column) in columns.iter().enumerate() {
    let property_path = format!("/columns/{index}");
    let column = column
      .as_object()
      .ok_or_else(|| invalid_field().with_property_path(&property_path))?;
    let source_id = required_string(column.get("id"))
      .ok_or_else(|| invalid_field().with_property_path(format!("{property_path}/id")))?;
    if !field_ids.insert(source_id.clone()) {
      return Err(invalid_field().with_property_path(format!("{property_path}/id")));
    }
    let source_kind = required_string(column.get("type"))
      .ok_or_else(|| invalid_field().with_property_path(format!("{property_path}/type")))?;
    let field_kind = map_field_kind(&source_kind, column.get("data")).ok_or_else(|| {
      blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseUnsupported,
        "legacy Database contains an unsupported field kind",
      )
      .with_property_path(format!("{property_path}/type"))
    })?;
    fields.push(LegacyDatabaseFieldPlan {
      target_id: target_id(target_database_id, "field", &source_id),
      name: required_string(column.get("name")).unwrap_or_else(|| "Untitled field".to_string()),
      config: column.get("data").cloned().unwrap_or_else(|| serde_json::json!({})),
      source_id: source_id.clone(),
      field_kind: field_kind.to_string(),
    });
    field_kinds.insert(source_id, field_kind.to_string());
  }
  if !fields.iter().any(|field| field.field_kind == "title") {
    fields.insert(
      0,
      LegacyDatabaseFieldPlan {
        source_id: "title".to_string(),
        target_id: target_id(target_database_id, "field", "title"),
        name: "Name".to_string(),
        field_kind: "title".to_string(),
        config: serde_json::json!({}),
      },
    );
    field_ids.insert("title".to_string());
    field_kinds.insert("title".to_string(), "title".to_string());
  }
  if fields.len() > limits.max_fields_per_database {
    return Err(
      blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseUnsupported,
        "legacy Database exceeds the canonical field limit",
      )
      .with_property_path("/columns"),
    );
  }

  let views_value = block
    .views
    .as_array()
    .ok_or_else(|| invalid_view().with_property_path("/views"))?;
  let mut view_ids = HashSet::new();
  let mut views = Vec::with_capacity(views_value.len());
  for (index, view) in views_value.iter().enumerate() {
    let property_path = format!("/views/{index}");
    let view = view
      .as_object()
      .ok_or_else(|| invalid_view().with_property_path(&property_path))?;
    let source_id = required_string(view.get("id"))
      .ok_or_else(|| invalid_view().with_property_path(format!("{property_path}/id")))?;
    let view_kind = required_string(view.get("mode"))
      .ok_or_else(|| invalid_view().with_property_path(format!("{property_path}/mode")))?;
    if !view_ids.insert(source_id.clone()) || !is_supported_view_kind(&view_kind) {
      return Err(invalid_view().with_property_path(format!("{property_path}/mode")));
    }
    views.push(LegacyDatabaseViewPlan {
      target_id: target_id(target_database_id, "view", &source_id),
      name: required_string(view.get("name")).unwrap_or_else(|| "View".to_string()),
      config: Value::Object(view.clone()),
      source_id,
      view_kind,
    });
  }
  if views.is_empty() {
    return Err(invalid_view().with_property_path("/views"));
  }
  if views.len() > limits.max_views_per_database {
    return Err(
      blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseUnsupported,
        "legacy Database exceeds the canonical view limit",
      )
      .with_property_path("/views"),
    );
  }

  let cells = block.cells.as_object().ok_or_else(|| {
    blocking(
      WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
      "legacy Database cells must be an object",
    )
    .with_property_path("/cells")
  })?;
  let mut row_ids = HashSet::new();
  let mut row_aliases = HashMap::<String, String>::new();
  for row in &block.rows {
    if !row_ids.insert(row.source_id.as_str()) {
      return Err(
        blocking(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
          "legacy Database contains duplicate row identities",
        )
        .with_property_path("/rows"),
      );
    }
    for alias in [
      row.source_id.clone(),
      row.source_id.rsplit(':').next().unwrap_or(&row.source_id).to_string(),
    ] {
      if let Some(existing) = row_aliases.insert(alias, row.source_id.clone())
        && existing != row.source_id
      {
        return Err(
          blocking(
            WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
            "legacy Database contains ambiguous row identities",
          )
          .with_property_path("/rows"),
        );
      }
    }
  }
  for (cell_row_id, row_cells) in cells {
    if !row_aliases.contains_key(cell_row_id) || !row_cells.is_object() {
      return Err(
        blocking(
          WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
          "legacy Database cells reference an unknown or invalid row",
        )
        .with_property_path(format!("/cells/{cell_row_id}")),
      );
    }
  }

  let mut rows = Vec::with_capacity(block.rows.len());
  let mut omitted_value_count = 0_usize;
  for row in &block.rows {
    let row_cells = cells
      .get(&row.source_id)
      .or_else(|| row.source_id.rsplit(':').next().and_then(|suffix| cells.get(suffix)))
      .map(|value| value.as_object().expect("cell row shape validated above"))
      .cloned()
      .unwrap_or_default();
    let mut planned_cells = BTreeMap::new();
    for (field_id, cell) in row_cells {
      if !field_ids.contains(field_id.as_str()) {
        omitted_value_count += 1;
        continue;
      }
      let mut value = cell
        .as_object()
        .and_then(|cell| cell.get("value"))
        .cloned()
        .unwrap_or(Value::Null);
      let field_kind = field_kinds
        .get(&field_id)
        .expect("validated legacy Database field kind");
      if field_kind == "users" && !value.is_null() && !value.as_array().is_some_and(Vec::is_empty) {
        omitted_value_count += 1;
        continue;
      }
      if field_kind == "rich_text" && !value.is_null() {
        value = Value::String(yjs::snapshot_rich_text_plain_text(&value).map_err(|_| {
          blocking(
            WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
            "legacy Database rich-text cell has an invalid delta",
          )
          .with_property_path(format!("/cells/{}/{field_id}", row.source_id))
        })?);
      }
      planned_cells.insert(field_id, value);
    }
    rows.push(LegacyDatabaseRowPlan {
      target_id: target_id(target_database_id, "row", &row.source_id),
      source_id: row.source_id.clone(),
      title: if row.title.trim().is_empty() {
        "Untitled".to_string()
      } else {
        row.title.clone()
      },
      cells: planned_cells,
    });
  }
  if rows.len() > limits.max_rows_per_database
    || rows.iter().map(|row| row.cells.len()).sum::<usize>() > limits.max_cells_per_database
  {
    return Err(
      blocking(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseUnsupported,
        "legacy Database exceeds the configured row or cell limit",
      )
      .with_property_path("/rows"),
    );
  }

  let title = if block.title.trim().is_empty() {
    "Imported database".to_string()
  } else {
    block.title.clone()
  };
  let fingerprint = serde_json::json!({
    "fields": fields.iter().map(|field| (&field.source_id, &field.name, &field.field_kind, &field.config)).collect::<Vec<_>>(),
    "views": views.iter().map(|view| (&view.source_id, &view.name, &view.view_kind, &view.config)).collect::<Vec<_>>(),
    "rows": rows.iter().map(|row| (&row.title, &row.cells)).collect::<Vec<_>>(),
  });
  let diagnostics = (omitted_value_count > 0)
    .then(|| {
      WorkspaceImportDiagnostic::informational(
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseValuesOmitted,
        format!("{omitted_value_count} stale or account-bound Database values were omitted"),
      )
      .with_property_path("/cells")
    })
    .into_iter()
    .collect();
  Ok((
    LegacyDatabasePlan {
      source_id: source_database_id.to_string(),
      target_id: target_database_id,
      title,
      fields,
      views,
      rows,
    },
    fingerprint,
    diagnostics,
  ))
}

fn target_id(namespace: Uuid, kind: &str, source_id: &str) -> Uuid {
  Uuid::new_v5(&namespace, format!("{kind}:{source_id}").as_bytes())
}

fn required_string(value: Option<&Value>) -> Option<String> {
  value
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string)
}

fn map_field_kind(value: &str, config: Option<&Value>) -> Option<&'static str> {
  match value {
    "title" => Some("title"),
    "text" => Some("text"),
    "rich-text" => Some("rich_text"),
    "link" => Some("url"),
    "checkbox" => Some("checkbox"),
    "date"
      if config
        .and_then(|value| value.get("includeTime"))
        .and_then(Value::as_bool)
        == Some(true) =>
    {
      Some("date_time")
    }
    "date" => Some("date"),
    "multi-select" => Some("multi_select"),
    "number" => Some("number"),
    "progress" => Some("percent"),
    "select" => Some("select"),
    "image" | "file" | "files" => Some("files"),
    "created-time" => Some("created_time"),
    "user" | "member" => Some("users"),
    _ => None,
  }
}

fn is_supported_view_kind(value: &str) -> bool {
  matches!(
    value,
    "table" | "kanban" | "list" | "gallery" | "calendar" | "timeline" | "progress"
  )
}

fn invalid_field() -> WorkspaceImportDiagnostic {
  blocking(
    WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
    "legacy Database contains an invalid field definition",
  )
}

fn invalid_view() -> WorkspaceImportDiagnostic {
  blocking(
    WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
    "legacy Database contains an invalid view definition",
  )
}

fn blocking(code: WorkspaceImportDiagnosticCode, message: impl Into<String>) -> WorkspaceImportDiagnostic {
  WorkspaceImportDiagnostic::blocking(code, message)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn local_block() -> yjs::LegacyDatabaseBlock {
    yjs::LegacyDatabaseBlock {
      block_id: "block-1".to_string(),
      source_database_id: Some("database-1".to_string()),
      title: "Projects".to_string(),
      columns: serde_json::json!([{
        "id": "status",
        "name": "Status",
        "type": "select",
        "data": {"options": [{"id": "Open", "value": "Open"}]}
      }]),
      views: serde_json::json!([{"id": "view-1", "name": "Table", "mode": "table"}]),
      cells: serde_json::json!({"row-1": {"status": {"value": "Open"}}}),
      rows: vec![yjs::LegacyDatabaseRow {
        source_id: "row-1".to_string(),
        title: "First row".to_string(),
      }],
      server_database_id: None,
      server_view_id: None,
    }
  }

  fn plan(blocks: Vec<yjs::LegacyDatabaseBlock>) -> LegacyDatabaseMigrationPlan {
    plan_legacy_database_migration(
      Uuid::nil(),
      &[LegacyDatabaseDocumentSource {
        source_document_id: "doc-1".to_string(),
        blocks,
      }],
      WorkspaceImportLimits::default(),
    )
  }

  #[test]
  fn invalid_fields_rows_and_views_each_block_the_plan() {
    let mut invalid_field = local_block();
    invalid_field.columns = serde_json::json!([{"id": "status", "type": "unsupported"}]);
    let mut invalid_row = local_block();
    invalid_row.cells = serde_json::json!({"orphan-row": {"status": {"value": "Open"}}});
    let mut invalid_view = local_block();
    invalid_view.views = serde_json::json!([{"id": "view-1", "mode": "unsupported"}]);

    for (name, block, expected, expected_path) in [
      (
        "field",
        invalid_field,
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseUnsupported,
        "/columns/0/type",
      ),
      (
        "row",
        invalid_row,
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
        "/cells/orphan-row",
      ),
      (
        "view",
        invalid_view,
        WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid,
        "/views/0/mode",
      ),
    ] {
      let result = plan(vec![block]);
      assert!(!result.apply_allowed, "invalid {name} must block apply");
      let diagnostic = result
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.code == expected)
        .expect("expected typed diagnostic");
      let context = diagnostic.context.as_ref().expect("conversion location");
      assert_eq!(context.source_document_id.as_deref(), Some("doc-1"));
      assert_eq!(context.source_block_id.as_deref(), Some("block-1"));
      assert_eq!(context.property_path.as_deref(), Some(expected_path));
    }
  }

  #[test]
  fn stale_cells_and_account_members_are_omitted_without_blocking_portable_values() {
    let mut block = local_block();
    block.columns = serde_json::json!([
      {"id": "owner", "name": "Owner", "type": "member"},
      {"id": "notes", "name": "Notes", "type": "rich-text"},
      {"id": "url", "name": "Link", "type": "link"}
    ]);
    block.cells = serde_json::json!({
      "row-1": {
        "deleted-column": {"columnId": "deleted-column", "value": "stale"},
        "owner": {"columnId": "owner", "value": ["00000000-0000-0000-0000-000000000001"]},
        "notes": {"columnId": "notes", "value": {"$blocksuite:internal:text$": true, "delta": [{"insert": "Portable note"}]}},
        "url": {"columnId": "url"}
      }
    });
    block.rows[0].title.clear();

    let migration = plan(vec![block]);
    assert!(migration.apply_allowed, "omitted legacy residue must not block apply");
    let diagnostic = migration
      .diagnostics
      .iter()
      .find(|diagnostic| diagnostic.code == WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseValuesOmitted)
      .expect("typed omission diagnostic");
    assert_eq!(diagnostic.severity, WorkspaceImportDiagnosticSeverity::Informational);
    let database = &migration.databases[0];
    assert_eq!(database.rows[0].title, "Untitled");
    assert_eq!(
      database.rows[0].cells.get("notes"),
      Some(&Value::String("Portable note".to_string()))
    );
    assert_eq!(database.rows[0].cells.get("url"), Some(&Value::Null));
    assert!(!database.rows[0].cells.contains_key("owner"));
    assert!(!database.rows[0].cells.contains_key("deleted-column"));
    assert_eq!(
      database
        .fields
        .iter()
        .find(|field| field.source_id == "owner")
        .map(|field| field.field_kind.as_str()),
      Some("users")
    );
  }

  #[test]
  fn reference_only_blocks_are_idempotent_and_local_payload_is_rejected() {
    let database_id = Uuid::new_v4();
    let view_id = Uuid::new_v4();
    let reference = yjs::LegacyDatabaseBlock {
      block_id: "reference".to_string(),
      source_database_id: None,
      title: String::new(),
      columns: serde_json::json!([]),
      views: serde_json::json!([]),
      cells: serde_json::json!({}),
      rows: Vec::new(),
      server_database_id: Some(database_id.to_string()),
      server_view_id: Some(view_id.to_string()),
    };
    let result = plan(vec![reference.clone()]);
    assert!(result.apply_allowed);
    assert!(result.databases.is_empty());
    assert_eq!(result.block_references.len(), 1);
    assert!(result.block_references[0].already_migrated);
    assert_eq!(result.block_references[0].target_database_id, database_id);

    let mut invalid = reference;
    invalid.columns = serde_json::json!([{"id": "field", "type": "text"}]);
    assert!(!plan(vec![invalid]).apply_allowed);
  }

  #[test]
  fn fresh_workspace_remaps_imported_references_and_blocks_external_targets() {
    let source_database_id = Uuid::new_v4();
    let source_view_id = Uuid::new_v4();
    let mut local = local_block();
    local.source_database_id = Some(source_database_id.to_string());
    local.views = serde_json::json!([{
      "id": source_view_id,
      "name": "Table",
      "mode": "table"
    }]);
    let reference = yjs::LegacyDatabaseBlock {
      block_id: "reference".to_string(),
      source_database_id: None,
      title: String::new(),
      columns: serde_json::json!([]),
      views: serde_json::json!([]),
      cells: serde_json::json!({}),
      rows: Vec::new(),
      server_database_id: Some(source_database_id.to_string()),
      server_view_id: Some(source_view_id.to_string()),
    };
    let namespace = Uuid::new_v4();
    let imported = plan_fresh_workspace_legacy_database_migration(
      namespace,
      &[LegacyDatabaseDocumentSource {
        source_document_id: "doc-1".to_string(),
        blocks: vec![local, reference],
      }],
      WorkspaceImportLimits::default(),
    );
    assert!(imported.apply_allowed, "{:?}", imported.diagnostics);
    assert_eq!(imported.databases.len(), 1);
    let remapped = imported
      .block_references
      .iter()
      .find(|reference| reference.block_id == "reference")
      .expect("reference plan");
    assert!(!remapped.already_migrated);
    assert_eq!(remapped.target_database_id, imported.databases[0].target_id);
    assert_eq!(remapped.target_view_id, Some(imported.databases[0].views[0].target_id));

    let external = plan_fresh_workspace_legacy_database_migration(
      namespace,
      &[LegacyDatabaseDocumentSource {
        source_document_id: "doc-2".to_string(),
        blocks: vec![yjs::LegacyDatabaseBlock {
          block_id: "external".to_string(),
          source_database_id: None,
          title: String::new(),
          columns: serde_json::json!([]),
          views: serde_json::json!([]),
          cells: serde_json::json!({}),
          rows: Vec::new(),
          server_database_id: Some(Uuid::new_v4().to_string()),
          server_view_id: None,
        }],
      }],
      WorkspaceImportLimits::default(),
    );
    assert!(!external.apply_allowed);
    assert!(external.diagnostics.iter().any(|diagnostic| {
      diagnostic.code == WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseUnsupported
        && diagnostic
          .context
          .as_ref()
          .and_then(|context| context.property_path.as_deref())
          == Some("/props/serverDatabaseId")
    }));
  }

  #[test]
  fn duplicate_blocks_fail_while_repeated_database_references_share_one_plan() {
    let block = local_block();
    let duplicate = plan(vec![block.clone(), block.clone()]);
    assert!(!duplicate.apply_allowed);
    assert!(
      duplicate
        .diagnostics
        .iter()
        .any(|diagnostic| { diagnostic.code == WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid })
    );

    let mut second_reference = block;
    second_reference.block_id = "block-2".to_string();
    let repeated = plan(vec![local_block(), second_reference]);
    assert!(repeated.apply_allowed, "{:?}", repeated.diagnostics);
    assert_eq!(repeated.databases.len(), 1);
    assert_eq!(repeated.block_references.len(), 2);
    assert_eq!(
      repeated.block_references[0].target_database_id,
      repeated.block_references[1].target_database_id
    );
  }

  #[test]
  fn supported_nested_view_filters_are_preserved_as_typed_server_filters() {
    let mut block = local_block();
    block.views = serde_json::json!([{
      "id": "view-1",
      "name": "Filtered",
      "mode": "table",
      "filter": {
        "type": "group",
        "op": "or",
        "conditions": [
          {
            "type": "filter",
            "left": {"type": "ref", "name": "title"},
            "function": "contains",
            "args": [{"type": "literal", "value": "First"}]
          },
          {
            "type": "group",
            "op": "and",
            "conditions": [{
              "type": "filter",
              "left": {"type": "ref", "name": "status"},
              "function": "isOneOf",
              "args": [{"type": "literal", "value": ["Open"]}]
            }]
          }
        ]
      }
    }]);
    let migration = plan(vec![block]);
    assert!(
      migration.apply_allowed,
      "supported filter must remain portable: {:?}",
      migration.diagnostics
    );
    let bundle = build_database_bundle(
      Uuid::nil(),
      Uuid::nil(),
      &migration.databases[0],
      &HashMap::new(),
      &DatabaseLimits::default(),
    )
    .expect("canonical bundle");
    let DatabaseViewConfig::Table(config) = &bundle.views[0].config else {
      panic!("table view expected");
    };
    let filter = config.filter_tree.as_ref().expect("typed filter tree");
    assert_eq!(filter.conjunction, DatabaseFilterConjunction::Or);
    assert_eq!(filter.rules.len(), 1);
    assert_eq!(filter.rules[0].operator, DatabaseFilterOperator::Contains);
    assert_eq!(filter.groups.len(), 1);
    assert_eq!(filter.groups[0].rules[0].operator, DatabaseFilterOperator::AnyOf);
  }

  #[test]
  fn unsupported_view_filter_function_blocks_the_complete_plan() {
    let mut block = local_block();
    block.views = serde_json::json!([{
      "id": "view-1",
      "name": "Invalid filter",
      "mode": "table",
      "filter": {
        "type": "group",
        "op": "and",
        "conditions": [{
          "type": "filter",
          "left": {"type": "ref", "name": "status"},
          "function": "unknownFunction",
          "args": []
        }]
      }
    }]);
    let migration = plan(vec![block]);
    assert!(!migration.apply_allowed);
    assert!(
      migration
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == WorkspaceImportDiagnosticCode::MixWorkspaceImportDatabaseInvalid)
    );
  }
}
