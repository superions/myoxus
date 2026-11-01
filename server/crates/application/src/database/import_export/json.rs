// SPDX-License-Identifier: AGPL-3.0-or-later
use super::content::*;
use super::workspace_content::{WorkspaceContentDatabaseIdentityPlan, workspace_content_import_id};
use crate::database::access;
use crate::database::{
  DatabaseImportExportService, DatabaseResult, DatabaseRowRead, DatabaseServiceError, ERR_CELL_VALUE_READONLY,
  ERR_FIELD_INVALID, ERR_JSON_CONFLICT, ERR_JSON_DESTRUCTIVE_NOT_CONFIRMED, ERR_JSON_FIELD_MAPPING_INVALID,
  ERR_JSON_INVALID, ERR_JSON_MISSING_FILE, ERR_JSON_TARGET_REQUIRED, ERR_JSON_UNSUPPORTED_VERSION, ERR_NOT_FOUND,
  ERR_VIEW_INVALID,
};
use crate::workspace_tags::WorkspaceTagService;
use chrono::Utc;
use myoxus_domain::database::*;
use myoxus_domain::ids::*;
use myoxus_domain::permission::WorkspaceAction;
use myoxus_domain::repositories::PageRequest;
use myoxus_domain::workspace_tags::WorkspaceTag;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use uuid::Uuid;

#[derive(Debug)]
struct WorkspaceTagImportPlan {
  diagnostics: Vec<DatabaseWorkspaceTagImportDiagnostic>,
  source_to_target: HashMap<Uuid, Uuid>,
  create_tags: Vec<WorkspaceTag>,
}
pub(in crate::database) struct DatabaseSnapshotImportBundle {
  pub(in crate::database) database: Database,
  pub(in crate::database) fields: Vec<DatabaseField>,
  pub(in crate::database) views: Vec<DatabaseView>,
  pub(in crate::database) field_roles: Vec<DatabaseFieldRole>,
  pub(in crate::database) view_roles: Vec<DatabaseViewRole>,
  pub(in crate::database) rows: Vec<DatabaseRowRecord>,
  pub(in crate::database) updated_rows: Vec<DatabaseRowRecord>,
  pub(in crate::database) skipped_rows: Vec<DatabaseRowRecord>,
  pub(in crate::database) row_templates: Vec<DatabaseRowTemplate>,
  pub(in crate::database) row_sources: Vec<(DatabaseRowId, DatabaseTaskSource)>,
  pub(in crate::database) content_documents: Vec<PendingSnapshotContentDocument>,
  pub(in crate::database) row_template_contents: Vec<PendingSnapshotRowTemplateContent>,
  /// When Merge keeps target fields intact, this carries the
  /// target's pre-existing fields so the result payload can echo them
  /// back without going through `get_database` again.
  pub(in crate::database) existing_fields: Vec<DatabaseField>,
  pub(in crate::database) existing_views: Vec<DatabaseView>,
}
type FieldLocalMap = HashMap<DatabaseFieldId, String>;
type RowLocalMap = HashMap<DatabaseRowId, String>;
type ViewLocalMap = HashMap<DatabaseViewId, String>;
type ImportFieldMap = HashMap<String, DatabaseFieldId>;
type ImportRowMap = HashMap<String, DatabaseRowId>;
type ImportViewMap = HashMap<String, DatabaseViewId>;
impl DatabaseImportExportService {
  async fn plan_snapshot_workspace_tags(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    snapshot: &DatabaseSnapshot,
  ) -> DatabaseResult<WorkspaceTagImportPlan> {
    let mut references: HashMap<Uuid, (Vec<i32>, HashSet<String>)> = HashMap::new();
    let field_names = snapshot
      .database
      .fields
      .iter()
      .map(|field| (field.id.as_str(), field.name.as_str()))
      .collect::<HashMap<_, _>>();
    for (row_index, row) in snapshot.database.rows.iter().enumerate() {
      for cell in &row.cells {
        let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Tags(tag_ids)) = &cell.value else {
          continue;
        };
        for tag_id in tag_ids {
          let reference = references.entry(*tag_id).or_default();
          let source_row = row_index as i32 + 1;
          if !reference.0.contains(&source_row) {
            reference.0.push(source_row);
          }
          reference.1.insert(
            field_names
              .get(cell.field_id.as_str())
              .copied()
              .unwrap_or(&cell.field_id)
              .to_string(),
          );
        }
      }
    }
    for template in &snapshot.database.row_templates {
      for (field_id, value) in &template.initial_cell_values {
        let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Tags(tag_ids)) = value else {
          continue;
        };
        for tag_id in tag_ids {
          references.entry(*tag_id).or_default().1.insert(
            field_names
              .get(field_id.as_str())
              .copied()
              .unwrap_or(field_id)
              .to_string(),
          );
        }
      }
    }

    let manifests = snapshot
      .workspace_tags_manifest
      .iter()
      .map(|tag| (tag.id, tag))
      .collect::<HashMap<_, _>>();
    if references.is_empty() {
      return Ok(WorkspaceTagImportPlan {
        diagnostics: Vec::new(),
        source_to_target: HashMap::new(),
        create_tags: Vec::new(),
      });
    }
    let service = self.workspace_tags.as_ref().cloned().ok_or_else(|| {
      DatabaseServiceError::new(crate::database::ERR_STORAGE, "workspace tag service is not configured")
    })?;
    let existing = service
      .list_tags(actor, workspace_id, true)
      .await
      .map_err(|error| DatabaseServiceError::new(error.code, error.message))?;
    let existing_by_slug = existing
      .iter()
      .map(|tag| (tag.slug.as_str(), tag))
      .collect::<HashMap<_, _>>();
    let existing_by_id = existing.iter().map(|tag| (tag.id, tag)).collect::<HashMap<_, _>>();
    let now = Utc::now();
    let mut diagnostics = Vec::with_capacity(references.len());
    let mut source_to_target = HashMap::with_capacity(references.len());
    let mut create_tags = Vec::new();
    let mut planned_by_slug = HashMap::<String, (Uuid, String, bool)>::new();
    let mut referenced_ids = references.keys().copied().collect::<Vec<_>>();
    referenced_ids.sort_unstable();

    for source_id in referenced_ids {
      let (affected_rows, affected_fields) = references.remove(&source_id).unwrap_or_default();
      let mut affected_fields = affected_fields.into_iter().collect::<Vec<_>>();
      affected_fields.sort();
      let Some(source) = manifests.get(&source_id).copied() else {
        diagnostics.push(DatabaseWorkspaceTagImportDiagnostic {
          source_id: Some(source_id),
          target_id: None,
          name: source_id.to_string(),
          slug: String::new(),
          source_color: None,
          color_role: "tag.grey".to_string(),
          action: DatabaseWorkspaceTagImportAction::Rejected,
          affected_rows,
          affected_fields,
          message: "Tags cell references an id missing from workspaceTagsManifest".to_string(),
        });
        continue;
      };
      let name = match WorkspaceTag::normalize_name(&source.name) {
        Ok(name) => name,
        Err(error) => {
          diagnostics.push(DatabaseWorkspaceTagImportDiagnostic {
            source_id: Some(source_id),
            target_id: None,
            name: source.name.clone(),
            slug: source.slug.clone(),
            source_color: Some(source.color_role.clone()),
            color_role: "tag.grey".to_string(),
            action: DatabaseWorkspaceTagImportAction::Rejected,
            affected_rows,
            affected_fields,
            message: error.to_string(),
          });
          continue;
        }
      };
      let slug = WorkspaceTag::slug_base(&name)
        .map_err(|error| DatabaseServiceError::new(crate::database::ERR_CELL_INVALID, error.to_string()))?;
      let normalized_color = WorkspaceTagService::normalize_import_color(&source.color_role);
      if let Some(target) = existing_by_slug.get(slug.as_str()).copied() {
        source_to_target.insert(source_id, target.id);
        let action = if target.archived_at.is_some() {
          DatabaseWorkspaceTagImportAction::ArchivedReference
        } else {
          DatabaseWorkspaceTagImportAction::Reuse
        };
        diagnostics.push(DatabaseWorkspaceTagImportDiagnostic {
          source_id: Some(source_id),
          target_id: Some(target.id),
          name,
          slug,
          source_color: Some(source.color_role.clone()),
          color_role: target.color_role.to_string(),
          action,
          affected_rows,
          affected_fields,
          message: if target.archived_at.is_some() {
            "Reuses an archived workspace tag for historical imported references".to_string()
          } else {
            "Reuses an existing active workspace tag".to_string()
          },
        });
        continue;
      }

      let target_id = Uuid::new_v5(
        &workspace_id,
        format!("database-import-tag:{source_id}:{slug}").as_bytes(),
      );
      if let Some(target) = existing_by_id.get(&target_id).copied() {
        source_to_target.insert(source_id, target.id);
        diagnostics.push(DatabaseWorkspaceTagImportDiagnostic {
          source_id: Some(source_id),
          target_id: Some(target.id),
          name,
          slug,
          source_color: Some(source.color_role.clone()),
          color_role: target.color_role.to_string(),
          action: if target.archived_at.is_some() {
            DatabaseWorkspaceTagImportAction::ArchivedReference
          } else {
            DatabaseWorkspaceTagImportAction::Reuse
          },
          affected_rows,
          affected_fields,
          message: "Reuses the deterministic workspace tag created by an earlier import".to_string(),
        });
        continue;
      }
      if let Some((planned_id, planned_color, planned_archived)) = planned_by_slug.get(&slug).cloned() {
        source_to_target.insert(source_id, planned_id);
        diagnostics.push(DatabaseWorkspaceTagImportDiagnostic {
          source_id: Some(source_id),
          target_id: Some(planned_id),
          name,
          slug,
          source_color: Some(source.color_role.clone()),
          color_role: planned_color,
          action: if planned_archived {
            DatabaseWorkspaceTagImportAction::ArchivedReference
          } else {
            DatabaseWorkspaceTagImportAction::Reuse
          },
          affected_rows,
          affected_fields,
          message: "Reuses the same workspace tag planned earlier in this import".to_string(),
        });
        continue;
      }
      let archived_at = source.archived.then_some(now);
      create_tags.push(WorkspaceTag {
        id: target_id,
        workspace_id,
        name: name.clone(),
        slug: slug.clone(),
        color_role: normalized_color.role,
        description: None,
        archived_at,
        created_at: now,
        updated_at: now,
        created_by: Some(actor),
        updated_by: Some(actor),
      });
      planned_by_slug.insert(
        slug.clone(),
        (target_id, normalized_color.role.to_string(), source.archived),
      );
      source_to_target.insert(source_id, target_id);
      diagnostics.push(DatabaseWorkspaceTagImportDiagnostic {
        source_id: Some(source_id),
        target_id: Some(target_id),
        name,
        slug,
        source_color: Some(source.color_role.clone()),
        color_role: normalized_color.role.to_string(),
        action: if source.archived {
          DatabaseWorkspaceTagImportAction::ArchivedReference
        } else {
          DatabaseWorkspaceTagImportAction::Create
        },
        affected_rows,
        affected_fields,
        message: if normalized_color.normalized {
          format!(
            "Creates a workspace tag and normalizes color '{}' to '{}'",
            normalized_color.source, normalized_color.role
          )
        } else if source.archived {
          "Creates an archived workspace tag for historical imported references".to_string()
        } else {
          "Creates a new active workspace tag".to_string()
        },
      });
    }
    Ok(WorkspaceTagImportPlan {
      diagnostics,
      source_to_target,
      create_tags,
    })
  }

  pub(in crate::database) fn rewrite_snapshot_workspace_tag_ids(
    snapshot: &mut DatabaseSnapshot,
    id_map: &HashMap<Uuid, Uuid>,
  ) {
    let rewrite = |value: &mut DatabaseSnapshotCellValueData| {
      let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Tags(tag_ids)) = value else {
        return;
      };
      for tag_id in tag_ids.iter_mut() {
        if let Some(target_id) = id_map.get(tag_id) {
          *tag_id = *target_id;
        }
      }
      let mut seen = HashSet::new();
      tag_ids.retain(|id| seen.insert(*id));
    };
    for tag in &mut snapshot.workspace_tags_manifest {
      if let Some(target) = id_map.get(&tag.id) {
        tag.id = *target;
      }
    }
    let mut seen = HashSet::new();
    snapshot.workspace_tags_manifest.retain(|tag| seen.insert(tag.id));
    for row in &mut snapshot.database.rows {
      for cell in &mut row.cells {
        rewrite(&mut cell.value);
      }
    }
    for template in &mut snapshot.database.row_templates {
      for value in template.initial_cell_values.values_mut() {
        rewrite(value);
      }
    }
    let tag_fields = snapshot
      .database
      .fields
      .iter()
      .filter(|field| field.field_type == DatabaseFieldType::Tags)
      .map(|field| field.id.clone())
      .collect::<HashSet<_>>();
    Self::rewrite_snapshot_filter_ids(snapshot, |field, id| {
      if tag_fields.contains(field)
        && let Ok(source) = Uuid::parse_str(id)
        && let Some(target) = id_map.get(&source)
      {
        *id = target.to_string();
      }
    });
  }

  /// Only typed ID operands are rewritten. Text, numbers, operators and
  /// unrelated JSON keep their authored values in both saved filter forms.
  pub(in crate::database) fn rewrite_snapshot_filter_ids(
    snapshot: &mut DatabaseSnapshot,
    mut rewrite: impl FnMut(&str, &mut String),
  ) {
    fn rules(rules: &mut [DatabaseSnapshotFilterRule], rewrite: &mut impl FnMut(&str, &mut String)) {
      for rule in rules {
        match &mut rule.value {
          DatabaseFilterValue::OptionId(id) => rewrite(&rule.field_id, id),
          DatabaseFilterValue::Ids(ids) => {
            for id in ids.iter_mut() {
              rewrite(&rule.field_id, id);
            }
            let mut seen = HashSet::new();
            ids.retain(|id| seen.insert(id.clone()));
          }
          _ => {}
        }
      }
    }
    fn group(tree: &mut DatabaseSnapshotFilterGroup, rewrite: &mut impl FnMut(&str, &mut String)) {
      rules(&mut tree.rules, rewrite);
      for child in &mut tree.groups {
        group(child, rewrite);
      }
    }
    for view in &mut snapshot.database.views {
      let (flat, tree) = match &mut view.config {
        DatabaseSnapshotViewConfig::Table(c) => (&mut c.filter, &mut c.filter_tree),
        DatabaseSnapshotViewConfig::Kanban(c) => (&mut c.filter, &mut c.filter_tree),
        DatabaseSnapshotViewConfig::List(c) => (&mut c.filter, &mut c.filter_tree),
        DatabaseSnapshotViewConfig::Gallery(c) => (&mut c.filter, &mut c.filter_tree),
        DatabaseSnapshotViewConfig::Calendar(c) => (&mut c.filter, &mut c.filter_tree),
        DatabaseSnapshotViewConfig::Timeline(c) => (&mut c.filter, &mut c.filter_tree),
        DatabaseSnapshotViewConfig::Gantt(c) => (&mut c.filter, &mut c.filter_tree),
        DatabaseSnapshotViewConfig::Progress(c) => (&mut c.filter, &mut c.filter_tree),
      };
      rules(flat, &mut rewrite);
      if let Some(tree) = tree {
        group(tree, &mut rewrite);
      }
    }
  }

  /// Portable Row/Parent mappings must cover every admitted live Row, not
  /// merely the View owner's first bounded page. Keep the existing import cap.
  pub(in crate::database) async fn snapshot_rows(
    &self,
    actor: UserId,
    database_id: DatabaseId,
  ) -> DatabaseResult<Vec<DatabaseRowRead>> {
    let mut rows = Vec::new();
    let mut expected_total = None;
    let mut seen = HashSet::new();
    loop {
      let page = self
        .views
        .list_rows(
          actor,
          database_id,
          PageRequest {
            limit: self.limits.max_rows_per_page,
            offset: rows.len() as i64,
          },
        )
        .await?;
      if page.total_count > self.limits.csv_max_rows as i64 {
        return Err(DatabaseServiceError::new(
          ERR_JSON_INVALID,
          "Database snapshot exceeds Row import limit",
        ));
      }
      if expected_total.is_some_and(|count| count != page.total_count)
        || page.rows.iter().any(|row| !seen.insert(row.row.id))
      {
        return Err(DatabaseServiceError::new(
          ERR_JSON_CONFLICT,
          "Database Rows changed during snapshot read",
        ));
      }
      expected_total = Some(page.total_count);
      let finished = rows.len() as i64 + page.rows.len() as i64 >= page.total_count;
      if page.rows.is_empty() && !finished {
        return Err(DatabaseServiceError::new(
          ERR_JSON_CONFLICT,
          "Database Rows changed during snapshot read",
        ));
      }
      rows.extend(page.rows);
      if finished {
        return Ok(rows);
      }
    }
  }

  pub async fn export_json(&self, actor: UserId, database_id: DatabaseId) -> DatabaseResult<DatabaseJsonExport> {
    let snapshot = self.export_snapshot(actor, database_id).await?;
    let content = serde_json::to_string_pretty(&snapshot)
      .map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error.to_string()))?;
    Ok(DatabaseJsonExport {
      filename: format!("{}.database.json", Self::safe_filename(&snapshot.database.title)),
      content_type: "application/json".to_string(),
      content,
    })
  }

  pub async fn preview_json_import(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    content: &[u8],
  ) -> DatabaseResult<DatabaseJsonPreview> {
    self
      .preview_json_import_with_options(actor, workspace_id, content, DatabaseJsonImportOptions::default())
      .await
  }

  /// P-DB-28: extended preview that documents the import-mode /
  /// conflict-strategy defaults and reports missing file/media
  /// references without persisting anything.
  pub async fn preview_json_import_with_options(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    content: &[u8],
    options: DatabaseJsonImportOptions,
  ) -> DatabaseResult<DatabaseJsonPreview> {
    Self::validate_import_options_shape(&options)?;
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::CreateDoc).await?;
    let (snapshot, warnings, mut errors) = self.parse_snapshot(content)?;
    let tag_plan = self
      .plan_snapshot_workspace_tags(actor, workspace_id, &snapshot)
      .await?;
    for diagnostic in tag_plan
      .diagnostics
      .iter()
      .filter(|diagnostic| diagnostic.action == DatabaseWorkspaceTagImportAction::Rejected)
    {
      errors.push(Self::json_diag(
        "MIX_DATABASE_WORKSPACE_TAG_REJECTED",
        "$.workspaceTagsManifest",
        diagnostic.message.clone(),
      ));
    }
    if snapshot.database.profile_kind == DatabaseProfileKind::Project {
      if let Err(error) = self.build_import_bundle(actor, workspace_id, &snapshot, &mut Vec::new()) {
        // Descriptor admission also validates native contents. Keep graph failures
        // actionable instead of attributing them to the managed template.
        let relation_code = Self::task_relation_diagnostic_code(&error);
        let path = if relation_code.is_some() {
          "$.database.rows"
        } else {
          "$.database.managedTemplate"
        };
        errors.push(Self::json_diag(
          relation_code.unwrap_or_else(|| ERR_JSON_INVALID.to_string()),
          path,
          error.message,
        ));
      }
    }
    if matches!(
      options.mode,
      DatabaseJsonImportMode::Replace | DatabaseJsonImportMode::Merge
    ) {
      if let Some(target_id) = options.target_database_id {
        let target = access::get_database(&self.permission, &self.schema_repo, actor, target_id).await?;
        if target.database.workspace_id != workspace_id {
          return Err(DatabaseServiceError::new(
            ERR_JSON_TARGET_REQUIRED,
            "import target workspace mismatch",
          ));
        }
        if target.database.profile_kind == DatabaseProfileKind::Project {
          if let Err(error) = Self::resolve_merge_field_mapping(&snapshot, &target, &options.field_mapping) {
            errors.push(Self::json_diag(
              ERR_JSON_INVALID,
              "$.database.managedTemplate",
              error.message,
            ));
          }
        }
      }
    }
    if errors.is_empty() {
      let mut validation_warnings = Vec::new();
      // Preview historically validates the portable format, not every generic
      // import builder constraint. Resolve a proposal only for canonical Task
      // graph policy; Merge authority belongs to the actual target, not source roles.
      let proposal = if options.mode == DatabaseJsonImportMode::Merge {
        let target_id = options.target_database_id.expect("validated merge target");
        let target = access::get_database(&self.permission, &self.schema_repo, actor, target_id).await?;
        if target.database.profile_kind == DatabaseProfileKind::Project
          && target
            .field_roles
            .iter()
            .any(|role| matches!(role.role_key.as_str(), "task.parent" | "task.blockedBy"))
        {
          if target.database.workspace_id != workspace_id {
            return Err(DatabaseServiceError::new(
              ERR_JSON_TARGET_REQUIRED,
              "merge target workspace mismatch",
            ));
          }
          let (mapping, _) = Self::resolve_merge_field_mapping(&snapshot, &target, &options.field_mapping)?;
          Some(
            self
              .build_import_merge(
                actor,
                workspace_id,
                &snapshot,
                &target,
                &mapping,
                options.conflict_strategy,
                &mut validation_warnings,
                &mut Vec::new(),
              )
              .await,
          )
        } else {
          None
        }
      } else if snapshot.database.profile_kind == DatabaseProfileKind::Project
        && snapshot
          .database
          .field_roles
          .iter()
          .any(|role| matches!(role.role_key.as_str(), "task.parent" | "task.blockedBy"))
      {
        Some(self.build_import_bundle(actor, workspace_id, &snapshot, &mut validation_warnings))
      } else {
        None
      };
      if let Some(Err(error)) = proposal {
        let code = Self::task_relation_diagnostic_code(&error).unwrap_or_else(|| error.code.to_string());
        errors.push(Self::json_diag(code, "$.database.rows", error.message));
      }
    }
    let mut missing = Vec::new();
    for entry in &snapshot.files_manifest {
      // The blob is considered missing unless a previous import left
      // it in workspace storage. Import is responsible for proving the
      // blob's existence; preview treats every entry as missing for
      // honesty.
      missing.push(Self::json_diag(
        ERR_JSON_MISSING_FILE,
        format!("$.filesManifest[{}]", entry.blob_key),
        format!(
          "Snapshot references blob '{}' that is not carried in the snapshot payload",
          entry.blob_key
        ),
      ));
    }
    let mut all_warnings = warnings;
    all_warnings.extend(missing);
    Ok(DatabaseJsonPreview {
      schema_version: snapshot.schema_version,
      schema_version_supported: snapshot.schema_version > 0
        && snapshot.schema_version <= DATABASE_SNAPSHOT_SCHEMA_VERSION,
      title: snapshot.database.title.clone(),
      field_count: snapshot.database.fields.len() as i32,
      view_count: snapshot.database.views.len() as i32,
      row_count: snapshot.database.rows.len() as i32,
      template_count: snapshot.database.row_templates.len() as i32,
      file_manifest_count: snapshot.files_manifest.len() as i32,
      matched_page_count: 0,
      content_document_count: snapshot
        .database
        .rows
        .iter()
        .filter(|row| row.content_document.is_some())
        .count() as i32,
      empty_page_count: 0,
      body_block_count: 0,
      rewritten_internal_link_count: 0,
      export_actor: snapshot.source.exported_by.clone(),
      exported_at: Some(snapshot.exported_at),
      default_mode: options.mode,
      default_conflict_strategy: options.conflict_strategy,
      warnings: all_warnings,
      errors,
      workspace_tag_diagnostics: tag_plan.diagnostics,
    })
  }

  pub async fn import_json(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    content: &[u8],
  ) -> DatabaseResult<DatabaseJsonImportResult> {
    self
      .import_json_with_options(actor, workspace_id, content, DatabaseJsonImportOptions::default(), None)
      .await
  }

  /// P-DB-28: extended import that honours the import mode, conflict
  /// strategy, target Database id (Replace/Merge), dry-run flag and
  /// per-field mapping. The legacy `import_json` is preserved as a
  /// thin wrapper that calls this with `Create` + `Abort`.
  pub async fn import_json_with_options(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    content: &[u8],
    options: DatabaseJsonImportOptions,
    import_job_id: Option<DatabaseImportJobId>,
  ) -> DatabaseResult<DatabaseJsonImportResult> {
    Self::validate_import_options_shape(&options)?;
    if matches!(options.mode, DatabaseJsonImportMode::Replace) && !options.confirm_destructive {
      return Err(DatabaseServiceError::new(
        ERR_JSON_DESTRUCTIVE_NOT_CONFIRMED,
        "Replace mode requires explicit confirmDestructive=true",
      ));
    }
    if matches!(
      options.mode,
      DatabaseJsonImportMode::Replace | DatabaseJsonImportMode::Merge
    ) && options.target_database_id.is_none()
    {
      return Err(DatabaseServiceError::new(
        ERR_JSON_TARGET_REQUIRED,
        "Replace/Merge mode requires targetDatabaseId",
      ));
    }
    access::assert_workspace(&self.permission, actor, workspace_id, WorkspaceAction::CreateDoc).await?;
    let (mut snapshot, mut warnings, errors) = self.parse_snapshot(content)?;
    if let Some(reason) = errors
      .iter()
      .find_map(|error| DatabaseTaskRelationReason::from_diagnostic_code(&error.code))
    {
      return Err(reason.into());
    }
    if !errors.is_empty() {
      return Err(DatabaseServiceError::new(
        ERR_JSON_INVALID,
        "Database JSON import preview contains errors",
      ));
    }
    if snapshot.database.profile_kind == DatabaseProfileKind::Project {
      self.build_import_bundle(actor, workspace_id, &snapshot, &mut Vec::new())?;
    }
    let tag_plan = self
      .plan_snapshot_workspace_tags(actor, workspace_id, &snapshot)
      .await?;
    if tag_plan
      .diagnostics
      .iter()
      .any(|diagnostic| diagnostic.action == DatabaseWorkspaceTagImportAction::Rejected)
    {
      return Err(DatabaseServiceError::new(
        ERR_JSON_INVALID,
        "Database import contains rejected workspace tag references",
      ));
    }
    Self::rewrite_snapshot_workspace_tag_ids(&mut snapshot, &tag_plan.source_to_target);
    let workspace_tag_diagnostics = tag_plan.diagnostics.clone();
    let imported_workspace_tags = tag_plan.create_tags;
    let mut conflict_warnings: Vec<DatabaseJsonDiagnostic> = Vec::new();
    let mut missing_file_count: i32 = 0;
    for entry in &snapshot.files_manifest {
      missing_file_count += 1;
      warnings.push(Self::json_diag(
        ERR_JSON_MISSING_FILE,
        format!("$.filesManifest[{}]", entry.blob_key),
        format!(
          "Snapshot references blob '{}' that is not carried in the snapshot payload",
          entry.blob_key
        ),
      ));
    }
    let mut target_precondition = None;
    let mut bundle = match options.mode {
      DatabaseJsonImportMode::Create => self.build_import_bundle(actor, workspace_id, &snapshot, &mut warnings)?,
      DatabaseJsonImportMode::Replace => {
        let target_id = options.target_database_id.ok_or_else(|| {
          DatabaseServiceError::new(ERR_JSON_TARGET_REQUIRED, "Replace mode requires targetDatabaseId")
        })?;
        let target = access::get_database(&self.permission, &self.schema_repo, actor, target_id).await?;
        if target.database.workspace_id != workspace_id {
          return Err(DatabaseServiceError::new(
            ERR_JSON_TARGET_REQUIRED,
            "targetDatabaseId must live in the same workspace as the import request",
          ));
        }
        target_precondition = Some(
          DatabaseEditPrecondition::new(Some(target.database.edit_revision), false)
            .in_workspace(target.database.workspace_id),
        );
        if target.database.profile_kind == DatabaseProfileKind::Project {
          let (mapping, _) = Self::resolve_merge_field_mapping(&snapshot, &target, &options.field_mapping)?;
          let mut imported = self.build_import_bundle(actor, workspace_id, &snapshot, &mut warnings)?;
          let portable = snapshot
            .database
            .fields
            .iter()
            .zip(imported.fields.iter())
            .map(|(portable, native)| (native.id, mapping[&portable.id]))
            .collect::<BTreeMap<_, _>>();
          for row in &mut imported.rows {
            row.row.database_id = target.database.id;
            for cell in &mut row.cells {
              cell.field_id = *portable
                .get(&cell.field_id)
                .ok_or_else(|| DatabaseServiceError::new(ERR_JSON_INVALID, "managed content Cell mapping missing"))?;
            }
            for revision in &mut row.cell_revisions {
              revision.field_id = *portable.get(&revision.field_id).ok_or_else(|| {
                DatabaseServiceError::new(ERR_JSON_INVALID, "managed content revision mapping missing")
              })?;
            }
          }
          for template in &mut imported.row_templates {
            template.database_id = target.database.id;
            template.initial_cell_values = std::mem::take(&mut template.initial_cell_values)
              .into_iter()
              .map(|(field, value)| {
                portable
                  .get(&field)
                  .copied()
                  .map(|field| (field, value))
                  .ok_or_else(|| {
                    DatabaseServiceError::new(ERR_JSON_INVALID, "managed content template mapping missing")
                  })
              })
              .collect::<DatabaseResult<BTreeMap<_, _>>>()?;
          }
          imported.database = target.database.clone();
          imported.fields.clear();
          imported.views.clear();
          imported.field_roles.clear();
          imported.view_roles.clear();
          imported.existing_fields = target.fields.clone();
          imported.existing_views = target.views.clone();
          imported
        } else {
          let deleted_rows = target.row_count;
          warnings.push(Self::json_diag(
            "MIX_DATABASE_JSON_REPLACE_REPORT",
            "$.replace",
            format!("Replaced existing Database and dropped {deleted_rows} rows; rebuilt from snapshot"),
          ));
          self.build_import_bundle(actor, workspace_id, &snapshot, &mut warnings)?
        }
      }
      DatabaseJsonImportMode::Merge => {
        let target_id = options
          .target_database_id
          .ok_or_else(|| DatabaseServiceError::new(ERR_JSON_TARGET_REQUIRED, "Merge mode requires targetDatabaseId"))?;
        let target = access::get_database(&self.permission, &self.schema_repo, actor, target_id).await?;
        if target.database.workspace_id != workspace_id {
          return Err(DatabaseServiceError::new(
            ERR_JSON_TARGET_REQUIRED,
            "targetDatabaseId must live in the same workspace as the import request",
          ));
        }
        target_precondition = Some(
          DatabaseEditPrecondition::new(Some(target.database.edit_revision), false)
            .in_workspace(target.database.workspace_id),
        );
        let (resolutions, _) = Self::resolve_merge_field_mapping(&snapshot, &target, &options.field_mapping)?;
        self
          .build_import_merge(
            actor,
            workspace_id,
            &snapshot,
            &target,
            &resolutions,
            options.conflict_strategy,
            &mut warnings,
            &mut conflict_warnings,
          )
          .await?
      }
    };
    let created_field_count = bundle.fields.len() as i32;
    let created_view_count = bundle.views.len() as i32;
    let created_row_count = bundle.rows.len() as i32;
    let created_template_count = bundle.row_templates.len() as i32;
    let updated_row_count = bundle.updated_rows.len() as i32;
    let skipped_row_count = bundle.skipped_rows.len() as i32;
    if options.dry_run {
      // Roll back every alteration we made in memory; this branch
      // always returns without persisting.
      let dry_record = DatabaseRecord {
        managed_schema: None,

        database: bundle.database.clone(),
        fields: bundle.existing_fields.clone(),
        views: bundle.existing_views.clone(),
        field_roles: bundle.field_roles.clone(),
        view_roles: bundle.view_roles.clone(),
        row_count: bundle.rows.len() as i64,
      };
      return Ok(DatabaseJsonImportResult {
        database: dry_record,
        mode: options.mode,
        conflict_strategy: options.conflict_strategy,
        dry_run: true,
        created_field_count,
        created_view_count,
        created_row_count,
        updated_row_count,
        skipped_row_count,
        created_template_count,
        missing_file_count,
        warnings,
        conflict_warnings,
        workspace_tag_diagnostics,
      });
    }
    if matches!(options.conflict_strategy, DatabaseJsonConflictStrategy::Abort) {
      let conflict_count = conflict_warnings
        .iter()
        .filter(|diag| diag.code == ERR_JSON_CONFLICT)
        .count();
      if conflict_count > 0 {
        return Err(DatabaseServiceError::new(
          ERR_JSON_CONFLICT,
          format!("Database JSON merge encountered {conflict_count} conflict(s) and strategy=abort"),
        ));
      }
    }
    let written_rows = bundle
      .rows
      .iter()
      .chain(&bundle.updated_rows)
      .map(|row| row.row.id)
      .collect::<HashSet<_>>();
    bundle.row_sources.retain(|(row, _)| written_rows.contains(row));
    for (_, source) in &mut bundle.row_sources {
      if source.source_workspace_id != workspace_id
        || self.rows.capture_source_projection(actor, source).await?.is_none()
      {
        source.external_id.clear();
        source.block_id = None;
        source.selection_anchor = None;
      }
    }
    let materialization_plan = self
      .plan_snapshot_content_materialization(workspace_id, &bundle)
      .await?;
    let created_content_documents = self
      .materialize_snapshot_content_documents(actor, workspace_id, &mut bundle, &materialization_plan)
      .await?;
    let created_row_templates = match self
      .materialize_snapshot_row_templates(actor, workspace_id, &mut bundle, &materialization_plan)
      .await
    {
      Ok(created) => created,
      Err(error) => {
        self
          .compensate_snapshot_content_documents(workspace_id, &created_content_documents)
          .await;
        return Err(error);
      }
    };
    let database = match self
      .import_export_repo
      .apply_database_snapshot_import(
        options.mode,
        options.target_database_id,
        target_precondition,
        bundle.database,
        bundle.fields,
        bundle.views,
        bundle.field_roles,
        bundle.view_roles,
        bundle.rows,
        bundle.updated_rows,
        bundle.row_templates,
        bundle.row_sources,
        imported_workspace_tags,
        import_job_id,
        None,
      )
      .await
    {
      Ok(database) => database,
      Err(error) => {
        self
          .compensate_snapshot_row_templates(workspace_id, &created_row_templates)
          .await;
        self
          .compensate_snapshot_content_documents(workspace_id, &created_content_documents)
          .await;
        return Err(error.into());
      }
    };
    Ok(DatabaseJsonImportResult {
      database,
      mode: options.mode,
      conflict_strategy: options.conflict_strategy,
      dry_run: false,
      created_field_count,
      created_view_count,
      created_row_count,
      updated_row_count,
      skipped_row_count,
      created_template_count,
      missing_file_count,
      warnings,
      conflict_warnings,
      workspace_tag_diagnostics,
    })
  }

  fn validate_import_options_shape(options: &DatabaseJsonImportOptions) -> DatabaseResult<()> {
    if !matches!(options.mode, DatabaseJsonImportMode::Create) && options.target_database_id.is_none() {
      return Err(DatabaseServiceError::new(
        ERR_JSON_TARGET_REQUIRED,
        "Replace/Merge import requires a targetDatabaseId",
      ));
    }
    for raw in options.field_mapping.values() {
      if raw.is_empty() {
        return Err(DatabaseServiceError::new(
          ERR_JSON_FIELD_MAPPING_INVALID,
          "field mapping values must be non-empty",
        ));
      }
    }
    Ok(())
  }

  pub(super) async fn export_snapshot(
    &self,
    actor: UserId,
    database_id: DatabaseId,
  ) -> DatabaseResult<DatabaseSnapshot> {
    self.export_snapshot_with_mode(actor, database_id, false).await
  }

  pub(in crate::database) async fn export_snapshot_with_mode(
    &self,
    actor: UserId,
    database_id: DatabaseId,
    transfer: bool,
  ) -> DatabaseResult<DatabaseSnapshot> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let rows = self.snapshot_rows(actor, database_id).await?;
    let row_templates = self.row_repo.list_row_templates(database_id).await?;
    let mut tag_ids = Vec::new();
    let mut seen_tag_ids = HashSet::new();
    for row in &rows {
      for cell in &row.cells {
        if let DatabaseCellValueData::Tags(ids) = &cell.value {
          for tag_id in ids {
            if seen_tag_ids.insert(*tag_id) {
              tag_ids.push(*tag_id);
            }
          }
        }
      }
    }
    for template in &row_templates {
      for value in template.initial_cell_values.values() {
        if let DatabaseCellValueData::Tags(ids) = value {
          for tag_id in ids {
            if seen_tag_ids.insert(*tag_id) {
              tag_ids.push(*tag_id);
            }
          }
        }
      }
    }
    let tag_fields = record
      .fields
      .iter()
      .filter(|field| field.field_type == DatabaseFieldType::Tags)
      .map(|field| field.id)
      .collect::<HashSet<_>>();
    for view in &record.views {
      for id in workspace_content_view_tag_ids(&view.config, &tag_fields).map_err(|error| {
        DatabaseServiceError::new(
          ERR_JSON_INVALID,
          match error {
            DatabaseDomainError::Validation(message) => message,
            error => error.to_string(),
          },
        )
      })? {
        if seen_tag_ids.insert(id) {
          tag_ids.push(id);
        }
      }
    }
    let workspace_tags_manifest = if tag_ids.is_empty() {
      Vec::new()
    } else {
      let service = self.workspace_tags.as_ref().cloned().ok_or_else(|| {
        DatabaseServiceError::new(crate::database::ERR_STORAGE, "workspace tag service is not configured")
      })?;
      service
        .resolve_tags(actor, record.database.workspace_id, &tag_ids)
        .await
        .map_err(|error| DatabaseServiceError::new(error.code, error.message))?
        .into_iter()
        .map(|tag| DatabaseSnapshotWorkspaceTag {
          id: tag.id,
          name: tag.name,
          slug: tag.slug,
          color_role: tag.color_role.to_string(),
          archived: tag.archived_at.is_some(),
        })
        .collect()
    };
    let database_local_id = "database_0".to_string();
    let field_local_ids = record
      .fields
      .iter()
      .enumerate()
      .map(|(index, field)| (field.id, format!("field_{index}")))
      .collect::<FieldLocalMap>();
    let view_local_ids = record
      .views
      .iter()
      .enumerate()
      .map(|(index, view)| (view.id, format!("view_{index}")))
      .collect::<ViewLocalMap>();
    let row_local_ids = rows
      .iter()
      .enumerate()
      .map(|(index, row)| (row.row.id, format!("row_{index}")))
      .collect::<RowLocalMap>();
    let mut live_files_manifest = Self::collect_files_manifest(&record, &rows);
    live_files_manifest.sort_by(|left, right| left.blob_key.cmp(&right.blob_key));
    let asset_local_ids = live_files_manifest
      .iter()
      .enumerate()
      .map(|(index, entry)| (entry.blob_key.clone(), format!("asset_{index}")))
      .collect::<HashMap<_, _>>();
    let files_manifest = live_files_manifest
      .iter()
      .map(|entry| {
        let mut entry = entry.clone();
        entry.blob_key = asset_local_ids
          .get(&entry.blob_key)
          .expect("every live manifest entry receives a portable key")
          .clone();
        entry
      })
      .collect::<Vec<_>>();
    let mut document_local_ids = rows
      .iter()
      .enumerate()
      .filter_map(|(index, row)| {
        row
          .row
          .content_document_id
          .map(|document_id| (document_id, format!("row-content-{index}")))
      })
      .collect::<HashMap<_, _>>();
    for row in &rows {
      for cell in &row.cells {
        if let DatabaseCellValueData::DocumentLink(value) = &cell.value {
          document_local_ids
            .entry(value.doc_id)
            .or_insert_with(|| Self::opaque_snapshot_reference_key(&value.doc_id.to_string()));
        }
      }
    }
    let template_registry = self.template_registry.as_ref().cloned();
    let mut template_document_ids = HashMap::new();
    if let Some(registry) = &template_registry {
      for (index, template) in row_templates.iter().enumerate() {
        if let Some(document_id) = template.content_document_id {
          let key = format!("row-template-content-{index}");
          document_local_ids.insert(document_id, key.clone());
          template_document_ids.insert(template.id, (document_id, key));
          continue;
        }
        if let Some(instance) = registry
          .find_workspace_instance_for_binding(record.database.workspace_id, template.template_id)
          .await
          .map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error.to_string()))?
          && let Some(document_id) = instance.workspace_doc_id
        {
          let key = format!("row-template-content-{index}");
          document_local_ids.insert(document_id, key.clone());
          template_document_ids.insert(template.id, (document_id, key));
        }
      }
    }
    let mut snapshot_rows = rows
      .iter()
      .filter(|row| !row.redacted)
      .map(|row| {
        self.snapshot_row(
          row,
          &field_local_ids,
          &row_local_ids,
          &asset_local_ids,
          &document_local_ids,
        )
      })
      .collect::<Vec<_>>();
    let mut diagnostics = Vec::new();
    for blocked in [false, true] {
      if blocked && record.database.profile_kind != DatabaseProfileKind::Project {
        continue;
      }
      let role_iter = || {
        record
          .field_roles
          .iter()
          .map(|role| (role.role_key.as_str(), role.row_kind_scope.as_deref(), role.field_id))
      };
      let selected = if blocked {
        task_blocked_by_field(role_iter())
      } else {
        task_parent_field(role_iter())
      };
      if let Some(parent) = selected
        && record
          .fields
          .iter()
          .any(|field| field.id == parent && field.field_type == DatabaseFieldType::Relation)
        && !(if blocked {
          task_blocked_by_has_conflicting_task_role(parent, role_iter())
        } else {
          task_parent_has_conflicting_task_role(parent, role_iter())
        })
      {
        let exported = rows
          .iter()
          .filter(|row| !row.redacted)
          .map(|row| row.row.id)
          .collect::<HashSet<_>>();
        let lost = rows
          .iter()
          .filter(|row| row.row.row_kind == DatabaseRowKind::Task)
          .any(|row| {
            row.cells.iter().filter(|cell| cell.field_id == parent).any(|cell| {
              matches!(&cell.value,
          DatabaseCellValueData::Relation(targets) if targets.iter().any(|target|!exported.contains(target)))
            })
          })
          || row_templates
            .iter()
            .filter(|template| template.row_kind == DatabaseRowKind::Task)
            .any(|template| {
              matches!(template.initial_cell_values.get(&parent),Some(DatabaseCellValueData::Relation(targets))
            if targets.iter().any(|target|!exported.contains(target)))
            });
        if lost {
          diagnostics.push(Self::json_diag(
          if blocked { "MIX_DATABASE_JSON_BLOCKER_TARGET_OMITTED" } else { "MIX_DATABASE_JSON_PARENT_TARGET_OMITTED" },
          "$.database.rows",
          if blocked { "Blocker targets outside the exported live Rows were omitted; rematerialization is blocked until source recovery or explicit unlink" }
            else { "Parent targets outside the exported live Rows were omitted; original Cells are unchanged" },
        ));
        }
      }
    }
    let mut reverse_replacements = document_local_ids
      .iter()
      .map(|(document_id, key)| (document_id.to_string(), snapshot_document_uri(key)))
      .collect::<HashMap<_, _>>();
    reverse_replacements.extend(
      asset_local_ids
        .iter()
        .map(|(live_key, local_key)| (live_key.clone(), snapshot_asset_uri(local_key))),
    );
    for (row, snapshot_row) in rows.iter().filter(|row| !row.redacted).zip(snapshot_rows.iter_mut()) {
      if row.row.row_kind == DatabaseRowKind::Task
        && let Some((source, projection)) = self
          .rows
          .task_source(actor, record.database.workspace_id, row.row.id)
          .await?
      {
        let readable = projection.is_some();
        snapshot_row.source = Some(DatabaseSnapshotTaskSource {
          source_workspace_id: source.source_workspace_id,
          document_id: source.document_id,
          external_id: readable.then_some(source.external_id),
          block_id: source.block_id.filter(|_| readable),
          selection_anchor: source.selection_anchor.filter(|_| readable),
        });
      }
      let Some(content_document_id) = row.row.content_document_id else {
        continue;
      };
      let outcome = self
        .export_snapshot_content_document(
          actor,
          record.database.workspace_id,
          content_document_id,
          document_local_ids
            .get(&content_document_id)
            .expect("content document receives a portable key")
            .clone(),
          &row.row.title,
          &reverse_replacements,
          &asset_local_ids,
          transfer,
        )
        .await?;
      match outcome {
        SnapshotContentExportOutcome::Included(content) => snapshot_row.content_document = Some(content),
        SnapshotContentExportOutcome::Omitted(reason) => diagnostics.push(Self::json_diag(
          "MIX_DATABASE_JSON_CONTENT_DOCUMENT_OMITTED",
          format!("$.database.rows[{}].contentDocument", snapshot_row.id),
          format!("Row content was omitted because of {reason}"),
        )),
      }
    }
    let mut snapshot_row_templates = Vec::new();
    for template in row_templates {
      let Some(mut snapshot_template) = self.snapshot_row_template(template.clone(), &field_local_ids, &row_local_ids)
      else {
        continue;
      };
      if let Some((content_document_id, document_key)) = template_document_ids.get(&template.id) {
        let outcome = self
          .export_snapshot_content_document(
            actor,
            record.database.workspace_id,
            *content_document_id,
            document_key.clone(),
            &template.name,
            &reverse_replacements,
            &asset_local_ids,
            transfer,
          )
          .await?;
        match outcome {
          SnapshotContentExportOutcome::Included(content) => snapshot_template.content_document = Some(content),
          SnapshotContentExportOutcome::Omitted(reason) => diagnostics.push(Self::json_diag(
            "MIX_DATABASE_JSON_TEMPLATE_CONTENT_OMITTED",
            format!("$.database.rowTemplates[{}].contentDocument", snapshot_template.id),
            format!("Row-template content was omitted because of {reason}"),
          )),
        }
      }
      snapshot_row_templates.push(snapshot_template);
    }
    let snapshot_database =
      DatabaseSnapshotDatabase {
        managed_template: record.database.managed_installation.as_ref().map(|installed| {
          DatabaseManagedTemplateSource {
            template_id: installed.template_id.clone(),
            template_version: installed.template_version.clone(),
            template_digest: installed.template_digest.clone(),
            variant: installed.variant.clone(),
            field_keys: installed
              .field_bindings
              .iter()
              .filter_map(|(key, id)| field_local_ids.get(id).map(|local| (key.clone(), local.clone())))
              .collect(),
            view_keys: installed
              .view_bindings
              .iter()
              .filter_map(|(key, id)| view_local_ids.get(id).map(|local| (key.clone(), local.clone())))
              .collect(),
          }
        }),
        id: database_local_id.clone(),
        profile_kind: record.database.profile_kind,
        profile_structure_preset: record.database.profile_structure_preset.clone(),
        profile_config: record.database.profile_config.clone(),
        title: record.database.title.clone(),
        description: record.database.description.clone(),
        fields: record
          .fields
          .iter()
          .filter_map(|field| self.snapshot_field(field, &database_local_id, &field_local_ids))
          .collect(),
        views: record
          .views
          .iter()
          .filter_map(|view| self.snapshot_view(view, &field_local_ids, &view_local_ids))
          .collect(),
        field_roles: record
          .field_roles
          .iter()
          .filter_map(|role| {
            Some(DatabaseSnapshotFieldRole {
              profile_kind: role.profile_kind,
              role_key: role.role_key.clone(),
              row_kind_scope: role.row_kind_scope.clone(),
              field_id: field_local_ids.get(&role.field_id)?.clone(),
              required: role.required,
              config: role.config.clone(),
            })
          })
          .collect(),
        view_roles: record
          .view_roles
          .iter()
          .filter_map(|role| {
            Some(DatabaseSnapshotViewRole {
              profile_kind: role.profile_kind,
              role_key: role.role_key.clone(),
              view_id: view_local_ids.get(&role.view_id)?.clone(),
              required: role.required,
            })
          })
          .collect(),
        rows: snapshot_rows,
        row_templates: snapshot_row_templates,
      };
    Ok(DatabaseSnapshot {
      schema_version: DATABASE_SNAPSHOT_SCHEMA_VERSION,
      exported_at: Utc::now(),
      source: DatabaseSnapshotSource {
        product: "myoxus".to_string(),
        format: "database-json-snapshot".to_string(),
        database_id: Some(record.database.id.to_string()),
        exported_by: Some(actor.to_string()),
      },
      database: snapshot_database.clone(),
      databases: vec![snapshot_database],
      files_manifest,
      workspace_tags_manifest,
      diagnostics,
    })
  }

  /// P-DB-28: walk every Files cell on every row + template and emit
  /// one `DatabaseSnapshotFileManifestEntry` per distinct `blob_key`.
  /// De-duplication is by blob_key; field/row context is preserved
  /// per entry for diagnostics.
  pub(in crate::database) fn collect_files_manifest(
    record: &DatabaseRecord,
    rows: &[DatabaseRowRead],
  ) -> Vec<DatabaseSnapshotFileManifestEntry> {
    let field_by_id: HashMap<DatabaseFieldId, &str> = record
      .fields
      .iter()
      .filter(|field| matches!(field.field_type, DatabaseFieldType::Files))
      .map(|field| (field.id, field.name.as_str()))
      .collect();
    let mut manifest: Vec<DatabaseSnapshotFileManifestEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for row in rows {
      let local_row_id = format!("row_{}", row.row.position);
      for cell in &row.cells {
        let Some(field_name) = field_by_id.get(&cell.field_id).copied() else {
          continue;
        };
        let DatabaseCellValueData::Files(value) = &cell.value else {
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
            field_name: Some(field_name.to_string()),
            row_id: Some(local_row_id.clone()),
          });
        }
      }
    }
    manifest
  }

  /// Legacy snapshots keep Record semantics; native kinds use the existing
  /// Project preset capabilities rather than admitting invisible hierarchy rows.
  fn snapshot_row_kind_allowed(profile: DatabaseProfileKind, structure: Option<&str>, kind: DatabaseRowKind) -> bool {
    if profile == DatabaseProfileKind::Generic {
      return kind == DatabaseRowKind::Record;
    }
    let structure = structure.and_then(|value| value.parse::<DatabaseProjectStructurePreset>().ok());
    match kind {
      DatabaseRowKind::Record | DatabaseRowKind::Task => true,
      DatabaseRowKind::Phase => structure.is_some_and(DatabaseProjectStructurePreset::has_phases),
      DatabaseRowKind::Milestone => structure.is_some_and(DatabaseProjectStructurePreset::has_milestones),
    }
  }

  // Preview copy selects its translation through typed context, never messages.
  fn blocked_snapshot_error(reason: DatabaseTaskRelationReason) -> DatabaseServiceError {
    let mut error = DatabaseServiceError::from(reason);
    error.task_relation_role = Some("task.blockedBy");
    error
  }

  /// The same admission boundary applies to JSON preview/import and operation publication.
  pub(in crate::database) fn validate_snapshot_row_origins(
    snapshot: &DatabaseSnapshot,
    errors: &mut Vec<DatabaseJsonDiagnostic>,
  ) {
    for (index, row) in snapshot.database.rows.iter().enumerate() {
      if !Self::snapshot_row_kind_allowed(
        snapshot.database.profile_kind,
        snapshot.database.profile_structure_preset.as_deref(),
        row.row_kind,
      ) {
        errors.push(Self::json_diag(
          ERR_JSON_INVALID,
          format!("$.database.rows[{index}].rowKind"),
          "Row kind is unavailable in the Database profile structure",
        ));
      }
      if row.source.is_some() && row.row_kind != DatabaseRowKind::Task {
        errors.push(Self::json_diag(
          ERR_JSON_INVALID,
          format!("$.database.rows[{index}].source"),
          "source association requires a Task Row",
        ));
      }
      if let Some(source) = &row.source {
        if source.external_id.as_ref().is_some_and(|key| key.len() > 512)
          || source.block_id.as_ref().is_some_and(|id| id.len() > 512)
          || source
            .selection_anchor
            .as_ref()
            .is_some_and(|anchor| anchor.len() > 8192)
        {
          errors.push(Self::json_diag(
            ERR_JSON_INVALID,
            format!("$.database.rows[{index}].source"),
            "source association exceeds native limits",
          ));
        }
      }
    }
    // Canonical Task graphs cannot use generic lossy unknown-Relation mapping.
    // Preserve the existing physical/other-Task owner of malformed aliases.
    for blocked in [false, true] {
      if blocked && snapshot.database.profile_kind != DatabaseProfileKind::Project {
        continue;
      }
      let role_key = if blocked { "task.blockedBy" } else { "task.parent" };
      let diagnostic_code = || {
        if blocked {
          DatabaseTaskRelationReason::UnavailableTarget.blocked_by_diagnostic_code()
        } else {
          DatabaseTaskRelationReason::UnavailableTarget.diagnostic_code()
        }
      };
      let parent = snapshot
        .database
        .field_roles
        .iter()
        .filter(|role| role.role_key == role_key)
        .min_by_key(|role| {
          (
            role.row_kind_scope.as_deref() != Some("task"),
            role.row_kind_scope.as_deref().unwrap_or(""),
            role.field_id.as_str(),
          )
        });
      if let Some(parent) = parent
        && snapshot
          .database
          .fields
          .iter()
          .any(|field| field.id == parent.field_id && field.field_type == DatabaseFieldType::Relation)
        && !snapshot.database.field_roles.iter().any(|other| {
          other.field_id == parent.field_id
            && other.role_key != role_key
            && other.row_kind_scope.as_deref() == Some("task")
        })
      {
        let ids = snapshot
          .database
          .rows
          .iter()
          .map(|row| row.id.as_str())
          .collect::<HashSet<_>>();
        for (index, row) in snapshot.database.rows.iter().enumerate() {
          if row.row_kind != DatabaseRowKind::Task
            && snapshot.database.field_roles.iter().any(|other| {
              other.field_id == parent.field_id
                && other.role_key != role_key
                && other.row_kind_scope.as_deref() == Some(row.row_kind.as_str())
            })
          {
            continue;
          }
          for cell in row.cells.iter().filter(|cell| cell.field_id == parent.field_id) {
            if let DatabaseSnapshotCellValueData::Relation(targets) = &cell.value
              && targets.iter().any(|target| !ids.contains(target.as_str()))
            {
              errors.push(Self::json_diag(
                diagnostic_code(),
                format!("$.database.rows[{index}].cells"),
                DatabaseTaskRelationReason::UnavailableTarget.validation_message(),
              ));
            }
          }
        }
        for template in &snapshot.database.row_templates {
          if template.row_kind != DatabaseRowKind::Task
            && snapshot.database.field_roles.iter().any(|other| {
              other.field_id == parent.field_id
                && other.role_key != role_key
                && other.row_kind_scope.as_deref() == Some(template.row_kind.as_str())
            })
          {
            continue;
          }
          if let Some(DatabaseSnapshotCellValueData::Relation(targets)) =
            template.initial_cell_values.get(&parent.field_id)
            && targets.iter().any(|target| !ids.contains(target.as_str()))
          {
            errors.push(Self::json_diag(
              diagnostic_code(),
              "$.database.rowTemplates",
              DatabaseTaskRelationReason::UnavailableTarget.validation_message(),
            ));
          }
        }
      }
    }
  }

  fn parse_snapshot(
    &self,
    content: &[u8],
  ) -> DatabaseResult<(
    DatabaseSnapshot,
    Vec<DatabaseJsonDiagnostic>,
    Vec<DatabaseJsonDiagnostic>,
  )> {
    if content.len() > self.limits.csv_max_bytes {
      return Err(DatabaseServiceError::new(
        ERR_JSON_INVALID,
        "Database JSON snapshot exceeds import size limit",
      ));
    }
    let snapshot: DatabaseSnapshot = serde_json::from_slice(content)
      .map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error.to_string()))?;
    let mut warnings = snapshot.diagnostics.clone();
    let mut errors = Vec::new();
    Self::validate_snapshot_schema_version(snapshot.schema_version, &mut errors);
    if snapshot.database.title.trim().is_empty() {
      errors.push(Self::json_diag(
        ERR_JSON_INVALID,
        "$.database.title",
        "Database title is required",
      ));
    }
    if snapshot.database.fields.is_empty() {
      errors.push(Self::json_diag(
        ERR_FIELD_INVALID,
        "$.database.fields",
        "Database snapshot must contain fields",
      ));
    }
    if snapshot.database.rows.len() > self.limits.csv_max_rows {
      errors.push(Self::json_diag(
        ERR_JSON_INVALID,
        "$.database.rows",
        "Database snapshot row count exceeds import limit",
      ));
    }
    for diagnostic in snapshot
      .diagnostics
      .iter()
      .filter(|diagnostic| diagnostic.code == "MIX_DATABASE_JSON_BLOCKER_TARGET_OMITTED")
    {
      errors.push(Self::json_diag(
        DatabaseTaskRelationReason::UnavailableTarget.blocked_by_diagnostic_code(),
        "$.database.rows",
        diagnostic.message.clone(),
      ));
    }
    Self::validate_snapshot_row_origins(&snapshot, &mut errors);
    let title_count = snapshot
      .database
      .fields
      .iter()
      .filter(|field| field.field_type == DatabaseFieldType::Title)
      .count();
    if title_count != 1 {
      errors.push(Self::json_diag(
        ERR_FIELD_INVALID,
        "$.database.fields",
        "Database snapshot requires exactly one title field",
      ));
    }
    Self::validate_unique_snapshot_ids(
      "$.database.fields",
      snapshot.database.fields.iter().map(|field| field.id.as_str()),
      &mut errors,
    );
    Self::validate_unique_snapshot_ids(
      "$.database.views",
      snapshot.database.views.iter().map(|view| view.id.as_str()),
      &mut errors,
    );
    Self::validate_unique_snapshot_ids(
      "$.database.fieldRoles",
      snapshot.database.field_roles.iter().map(|role| role.role_key.as_str()),
      &mut errors,
    );
    Self::validate_unique_snapshot_ids(
      "$.database.viewRoles",
      snapshot.database.view_roles.iter().map(|role| role.role_key.as_str()),
      &mut errors,
    );
    let snapshot_field_ids = snapshot
      .database
      .fields
      .iter()
      .map(|field| field.id.as_str())
      .collect::<HashSet<_>>();
    let snapshot_views = snapshot
      .database
      .views
      .iter()
      .map(|view| (view.id.as_str(), view.view_kind))
      .collect::<HashMap<_, _>>();
    if snapshot.database.profile_kind == DatabaseProfileKind::Generic
      && (!snapshot.database.field_roles.is_empty() || !snapshot.database.view_roles.is_empty())
    {
      errors.push(Self::json_diag(
        ERR_JSON_INVALID,
        "$.database.profileKind",
        "Generic Database snapshots cannot contain profile roles",
      ));
    }
    if snapshot.database.profile_kind == DatabaseProfileKind::Project
      && snapshot.database.profile_structure_preset.is_none()
    {
      errors.push(Self::json_diag(
        ERR_JSON_INVALID,
        "$.database.profileStructurePreset",
        "Project snapshots require a structure preset",
      ));
    }
    for role in &snapshot.database.field_roles {
      if role.profile_kind != snapshot.database.profile_kind || !snapshot_field_ids.contains(role.field_id.as_str()) {
        errors.push(Self::json_diag(
          ERR_FIELD_INVALID,
          format!("$.database.fieldRoles[{}]", role.role_key),
          "Field role profile or portable field reference is invalid",
        ));
      }
    }
    for role in &snapshot.database.view_roles {
      let expected_kind = DatabaseViewRole::expected_kind_for_role_key(&role.role_key);
      if role.profile_kind != snapshot.database.profile_kind
        || snapshot_views.get(role.view_id.as_str()).copied() != expected_kind
      {
        errors.push(Self::json_diag(
          ERR_VIEW_INVALID,
          format!("$.database.viewRoles[{}]", role.role_key),
          "View role profile, portable view reference or view kind is invalid",
        ));
      }
    }
    Self::validate_unique_snapshot_ids(
      "$.database.rows",
      snapshot.database.rows.iter().map(|row| row.id.as_str()),
      &mut errors,
    );
    self.validate_snapshot_content_documents(&snapshot, &mut errors);
    for field in &snapshot.database.fields {
      if field.read_only {
        warnings.push(Self::json_diag(
          ERR_CELL_VALUE_READONLY,
          format!("$.database.fields[{}]", field.id),
          format!("Read-only field '{}' is exported as schema only", field.name),
        ));
      }
    }
    Ok((snapshot, warnings, errors))
  }

  fn build_import_bundle(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    snapshot: &DatabaseSnapshot,
    warnings: &mut Vec<DatabaseJsonDiagnostic>,
  ) -> DatabaseResult<DatabaseSnapshotImportBundle> {
    self.build_import_bundle_with_identity(actor, workspace_id, snapshot, warnings, None)
  }

  pub(in crate::database) fn build_import_bundle_with_identity(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    snapshot: &DatabaseSnapshot,
    warnings: &mut Vec<DatabaseJsonDiagnostic>,
    identity: Option<&WorkspaceContentDatabaseIdentityPlan>,
  ) -> DatabaseResult<DatabaseSnapshotImportBundle> {
    let now = Utc::now();
    let database_id = identity.map_or_else(Uuid::new_v4, |identity| identity.database_id);
    let field_ids = snapshot
      .database
      .fields
      .iter()
      .map(|field| {
        Ok((
          field.id.clone(),
          workspace_content_import_id(identity.map(|identity| &identity.field_ids), &field.id, "Field")?,
        ))
      })
      .collect::<DatabaseResult<ImportFieldMap>>()?;
    let mut fields = Vec::new();
    for snapshot_field in &snapshot.database.fields {
      let field_id = *field_ids
        .get(&snapshot_field.id)
        .ok_or_else(|| DatabaseServiceError::new(ERR_FIELD_INVALID, "snapshot field id was not allocated"))?;
      let config = self.import_field_config(snapshot_field, database_id, &field_ids, warnings)?;
      crate::database::definition::rules::validate_field_config(snapshot_field.field_type, &config)?;
      fields.push(DatabaseField {
        id: field_id,
        database_id,
        name: crate::database::definition::rules::validate_title(&snapshot_field.name)?,
        field_type: snapshot_field.field_type,
        config,
        position: snapshot_field.position,
        required: snapshot_field.required,
        edit_revision: 1,
        created_at: now,
        updated_at: now,
      });
    }
    let title_field_count = fields
      .iter()
      .filter(|field| field.field_type == DatabaseFieldType::Title)
      .count();
    if title_field_count != 1 {
      return Err(DatabaseServiceError::new(
        ERR_FIELD_INVALID,
        "Database JSON import requires exactly one imported title field",
      ));
    }
    let view_ids = snapshot
      .database
      .views
      .iter()
      .map(|view| {
        Ok((
          view.id.clone(),
          workspace_content_import_id(identity.map(|identity| &identity.view_ids), &view.id, "View")?,
        ))
      })
      .collect::<DatabaseResult<ImportViewMap>>()?;
    let mut views = Vec::new();
    for snapshot_view in &snapshot.database.views {
      if let Some(icon) = &snapshot_view.icon {
        icon
          .validate()
          .map_err(|error| DatabaseServiceError::new(ERR_VIEW_INVALID, error.to_string()))?;
      }
      let Some(config) = self.import_view_config(snapshot_view, &field_ids, warnings)? else {
        continue;
      };
      crate::database::views::rules::validate_view_config(
        snapshot_view.view_kind,
        &config,
        &fields,
        self.limits.max_fields_per_database,
      )?;
      views.push(DatabaseView {
        id: *view_ids
          .get(&snapshot_view.id)
          .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_INVALID, "snapshot view id was not allocated"))?,
        database_id,
        name: crate::database::definition::rules::validate_title(&snapshot_view.name)?,
        view_kind: snapshot_view.view_kind,
        icon: snapshot_view.icon.clone(),
        config,
        position: snapshot_view.position,
        edit_revision: 1,
        created_at: now,
        updated_at: now,
      });
    }
    if views.is_empty() {
      let title_field_id = fields
        .iter()
        .find(|field| field.field_type == DatabaseFieldType::Title)
        .map(|field| field.id)
        .ok_or_else(|| DatabaseServiceError::new(ERR_FIELD_INVALID, "Database JSON import requires a title field"))?;
      views.push(DatabaseView {
        id: identity.map_or_else(Uuid::new_v4, |identity| identity.fallback_view_id),
        database_id,
        name: "Table".to_string(),
        view_kind: DatabaseViewKind::Table,
        icon: None,
        config: DatabaseViewConfig::Table(DatabaseTableViewConfig {
          title_field_id,
          visible_field_ids: fields.iter().map(|field| field.id).collect(),
          field_widths: BTreeMap::new(),
          search_field_ids: fields
            .iter()
            .filter(|field| field.field_type.supports_server_search())
            .map(|field| field.id)
            .collect(),
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
      });
    }
    let field_roles = snapshot
      .database
      .field_roles
      .iter()
      .map(|role| {
        let field_id = *field_ids.get(&role.field_id).ok_or_else(|| {
          DatabaseServiceError::new(
            ERR_FIELD_INVALID,
            format!(
              "database field role {} references an unknown portable field id",
              role.role_key
            ),
          )
        })?;
        if role.profile_kind != snapshot.database.profile_kind {
          return Err(DatabaseServiceError::new(
            ERR_FIELD_INVALID,
            format!("database field role {} has the wrong profile kind", role.role_key),
          ));
        }
        Ok(DatabaseFieldRole {
          database_id,
          profile_kind: role.profile_kind,
          role_key: role.role_key.clone(),
          row_kind_scope: role.row_kind_scope.clone(),
          field_id,
          required: role.required,
          config: role.config.clone(),
          created_at: now,
          updated_at: now,
        })
      })
      .collect::<DatabaseResult<Vec<_>>>()?;
    let views_by_id = views.iter().map(|view| (view.id, view)).collect::<HashMap<_, _>>();
    let view_roles = snapshot
      .database
      .view_roles
      .iter()
      .map(|role| {
        let view_id = *view_ids.get(&role.view_id).ok_or_else(|| {
          DatabaseServiceError::new(
            ERR_VIEW_INVALID,
            format!(
              "database view role {} references an unknown portable view id",
              role.role_key
            ),
          )
        })?;
        let expected_kind = DatabaseViewRole::expected_kind_for_role_key(&role.role_key).ok_or_else(|| {
          DatabaseServiceError::new(
            ERR_VIEW_INVALID,
            format!("unknown database view role {}", role.role_key),
          )
        })?;
        if role.profile_kind != snapshot.database.profile_kind
          || views_by_id
            .get(&view_id)
            .is_none_or(|view| view.view_kind != expected_kind)
        {
          return Err(DatabaseServiceError::new(
            ERR_VIEW_INVALID,
            format!(
              "database view role {} is incompatible with its target view",
              role.role_key
            ),
          ));
        }
        Ok(DatabaseViewRole {
          database_id,
          profile_kind: role.profile_kind,
          role_key: role.role_key.clone(),
          view_id,
          required: role.required,
          created_at: now,
          updated_at: now,
        })
      })
      .collect::<DatabaseResult<Vec<_>>>()?;
    let row_ids = snapshot
      .database
      .rows
      .iter()
      .map(|row| {
        Ok((
          row.id.clone(),
          workspace_content_import_id(identity.map(|identity| &identity.row_ids), &row.id, "Row")?,
        ))
      })
      .collect::<DatabaseResult<ImportRowMap>>()?;
    let field_map = fields.iter().map(|field| (field.id, field)).collect::<HashMap<_, _>>();
    let mut rows = snapshot
      .database
      .rows
      .iter()
      .map(|row| {
        self.import_row(
          row,
          database_id,
          actor,
          now,
          &field_ids,
          &row_ids,
          &field_map,
          &field_roles,
          snapshot.database.profile_kind,
          warnings,
          identity.is_some(),
        )
      })
      .collect::<DatabaseResult<Vec<_>>>()?;
    if let Some(identity) = identity {
      for (snapshot_row, row) in snapshot.database.rows.iter().zip(rows.iter_mut()) {
        if let Some(content) = &snapshot_row.content_document {
          row.row.content_document_id = Some(*identity.content_document_ids.get(&content.document_key).ok_or_else(
            || {
              DatabaseServiceError::new(
                ERR_JSON_INVALID,
                "workspace content Database Row content identity is missing",
              )
            },
          )?);
        }
      }
    }
    let content_documents = snapshot
      .database
      .rows
      .iter()
      .filter_map(|row| {
        Some(PendingSnapshotContentDocument {
          row_id: *row_ids.get(&row.id)?,
          content: row.content_document.clone()?,
        })
      })
      .collect();
    let row_template_ids = snapshot
      .database
      .row_templates
      .iter()
      .map(|template| {
        Ok((
          template.id.clone(),
          workspace_content_import_id(
            identity.map(|identity| &identity.row_template_ids),
            &template.id,
            "Row template",
          )?,
        ))
      })
      .collect::<DatabaseResult<HashMap<_, _>>>()?;
    let mut row_templates = snapshot
      .database
      .row_templates
      .iter()
      .filter_map(|template| {
        self
          .import_row_template(
            template,
            *row_template_ids.get(&template.id)?,
            workspace_id,
            database_id,
            actor,
            now,
            &field_ids,
            &row_ids,
            &field_map,
            &field_roles,
            snapshot.database.profile_kind,
            warnings,
            identity.is_some(),
          )
          .transpose()
      })
      .collect::<DatabaseResult<Vec<_>>>()?;
    if let Some(identity) = identity {
      for (portable, template) in snapshot.database.row_templates.iter().zip(&mut row_templates) {
        if let Some(content) = &portable.content_document {
          template.content_document_id = Some(
            *identity
              .content_document_ids
              .get(&content.document_key)
              .ok_or_else(|| DatabaseServiceError::new(ERR_JSON_INVALID, "owned template body mapping missing"))?,
          );
        }
      }
    }
    let row_template_contents = snapshot
      .database
      .row_templates
      .iter()
      .filter_map(|template| {
        Some(PendingSnapshotRowTemplateContent {
          row_template_id: *row_template_ids.get(&template.id)?,
          content: template.content_document.clone()?,
        })
      })
      .collect();
    let profile_config = match &snapshot.database.profile_config {
      Value::Object(_) => snapshot.database.profile_config.clone(),
      // Schema v2 snapshots predate the explicit profile contract. Missing
      // profile configuration therefore means the canonical empty object.
      Value::Null => serde_json::json!({}),
      _ => {
        return Err(DatabaseServiceError::new(
          ERR_JSON_INVALID,
          "Database profileConfig must be an object",
        ));
      }
    };
    validate_task_parent_rows(
      database_id,
      snapshot.database.profile_kind,
      &fields,
      &field_roles,
      &[],
      &rows,
      &row_templates,
    )?;
    validate_task_blocked_by_rows(
      database_id,
      snapshot.database.profile_kind,
      &fields,
      &field_roles,
      &[],
      &rows,
      &row_templates,
    )
    .map_err(Self::blocked_snapshot_error)?;
    let mut bundle = DatabaseSnapshotImportBundle {
      database: Database {
        system_role: None,
        managed_installation: None,

        id: database_id,
        workspace_id,
        profile_kind: snapshot.database.profile_kind,
        profile_structure_preset: snapshot.database.profile_structure_preset.clone(),
        profile_config,
        title: crate::database::definition::rules::validate_title(&snapshot.database.title)?,
        description: snapshot
          .database
          .description
          .as_ref()
          .map(|description| description.trim().to_string())
          .filter(|description| !description.is_empty()),
        created_by: Some(actor),
        updated_by: Some(actor),
        deleted_at: None,
        deleted_by: None,
        edit_revision: 1,
        created_at: now,
        updated_at: now,
      },
      fields,
      views,
      field_roles,
      view_roles,
      row_sources: snapshot
        .database
        .rows
        .iter()
        .filter_map(|row| {
          if row.row_kind != DatabaseRowKind::Task {
            return None;
          }
          let source = row.source.as_ref()?;
          Some((
            *row_ids.get(&row.id)?,
            DatabaseTaskSource {
              source_workspace_id: source.source_workspace_id,
              document_id: source.document_id,
              external_id: source.external_id.clone().unwrap_or_default(),
              block_id: source.block_id.clone().filter(|_| source.external_id.is_some()),
              selection_anchor: source.selection_anchor.clone().filter(|_| source.external_id.is_some()),
            },
          ))
        })
        .collect(),
      rows,
      updated_rows: Vec::new(),
      skipped_rows: Vec::new(),
      row_templates,
      content_documents,
      row_template_contents,
      existing_fields: Vec::new(),
      existing_views: Vec::new(),
    };
    if bundle.database.profile_kind == DatabaseProfileKind::Project {
      let source = snapshot.database.managed_template.as_ref().ok_or_else(|| {
        DatabaseServiceError::new(ERR_JSON_INVALID, "Project import requires native managed source facts")
      })?;
      let (version, digest) = self
        .starter_templates
        .current_source(&source.template_id)
        .ok_or_else(|| DatabaseServiceError::new(ERR_JSON_INVALID, "Project source unavailable"))?;
      if version != source.template_version || digest != source.template_digest {
        return Err(DatabaseServiceError::new(
          ERR_JSON_INVALID,
          "Project source version is not currently admitted",
        ));
      }
      let fields = source
        .field_keys
        .iter()
        .map(|(key, local)| {
          field_ids
            .get(local)
            .copied()
            .map(|id| (key.clone(), id))
            .ok_or_else(|| DatabaseServiceError::new(ERR_JSON_INVALID, "managed source Field binding missing"))
        })
        .collect::<DatabaseResult<BTreeMap<_, _>>>()?;
      let views = source
        .view_keys
        .iter()
        .map(|(key, local)| {
          view_ids
            .get(local)
            .copied()
            .map(|id| (key.clone(), id))
            .ok_or_else(|| DatabaseServiceError::new(ERR_JSON_INVALID, "managed source View binding missing"))
        })
        .collect::<DatabaseResult<BTreeMap<_, _>>>()?;
      bundle.database.managed_installation = Some(DatabaseManagedSchemaInstallation {
        template_id: source.template_id.clone(),
        template_version: source.template_version.clone(),
        template_digest: source.template_digest.clone(),
        variant: source.variant.clone(),
        schema_revision: 1,
        field_bindings: fields,
        view_bindings: views,
        readiness: DatabaseManagedSchemaReadiness::Ready,
        reason_code: None,
      });
      let record = DatabaseRecord {
        database: bundle.database.clone(),
        fields: bundle.fields.clone(),
        views: bundle.views.clone(),
        field_roles: bundle.field_roles.clone(),
        view_roles: bundle.view_roles.clone(),
        row_count: 0,
        managed_schema: None,
      };
      let current = self
        .starter_templates
        .current_source(&source.template_id)
        .ok_or_else(|| DatabaseServiceError::new(ERR_JSON_INVALID, "managed source current version missing"))?
        .0;
      let expected =
        crate::database::definition::managed_schema::expected_state_at(&self.starter_templates, &record, current)?;
      let expected_record = DatabaseRecord {
        database: expected.database.clone(),
        fields: expected.fields,
        views: expected.views,
        field_roles: expected.roles,
        view_roles: expected.view_roles,
        row_count: 0,
        managed_schema: None,
      };
      if crate::database::definition::managed_schema::structural_value(&record)
        != crate::database::definition::managed_schema::structural_value(&expected_record)
      {
        return Err(DatabaseServiceError::new(
          ERR_JSON_INVALID,
          "portable Project schema does not match its server descriptor",
        ));
      }
      bundle.database.managed_installation = expected.database.managed_installation;
    } else if snapshot.database.managed_template.is_some() {
      return Err(DatabaseServiceError::new(
        ERR_JSON_INVALID,
        "Generic import cannot install managed source facts",
      ));
    }
    Ok(bundle)
  }

  fn resolve_merge_field_mapping(
    snapshot: &DatabaseSnapshot,
    target: &DatabaseRecord,
    field_mapping: &BTreeMap<String, String>,
  ) -> DatabaseResult<(BTreeMap<String, DatabaseFieldId>, Vec<DatabaseField>)> {
    if target.database.profile_kind == DatabaseProfileKind::Project {
      let source = snapshot.database.managed_template.as_ref().ok_or_else(|| {
        DatabaseServiceError::new(ERR_JSON_INVALID, "managed content import requires native source facts")
      })?;
      let installed = target
        .database
        .managed_installation
        .as_ref()
        .ok_or_else(|| DatabaseServiceError::new(ERR_JSON_INVALID, "managed target unavailable"))?;
      if installed.readiness != DatabaseManagedSchemaReadiness::Ready
        || source.template_id != installed.template_id
        || source.template_version != installed.template_version
        || source.template_digest != installed.template_digest
        || source.variant != installed.variant
        || !field_mapping.is_empty()
      {
        return Err(DatabaseServiceError::new(
          ERR_JSON_INVALID,
          "managed content import source/target descriptor mismatch",
        ));
      }
      let resolutions = source
        .field_keys
        .iter()
        .map(|(key, local)| {
          installed
            .field_bindings
            .get(key)
            .copied()
            .map(|id| (local.clone(), id))
            .ok_or_else(|| DatabaseServiceError::new(ERR_JSON_INVALID, "managed content Field binding unavailable"))
        })
        .collect::<DatabaseResult<BTreeMap<_, _>>>()?;
      if resolutions.len() != snapshot.database.fields.len() {
        return Err(DatabaseServiceError::new(
          ERR_JSON_INVALID,
          "managed content import cannot discard or introduce Fields",
        ));
      }
      return Ok((resolutions, Vec::new()));
    }
    let mut resolutions: BTreeMap<String, DatabaseFieldId> = BTreeMap::new();
    let mut new_fields: Vec<DatabaseField> = Vec::new();
    let target_by_name: HashMap<&str, &DatabaseField> =
      target.fields.iter().map(|field| (field.name.as_str(), field)).collect();
    let snapshot_by_id: HashMap<&str, &DatabaseSnapshotField> = snapshot
      .database
      .fields
      .iter()
      .map(|field| (field.id.as_str(), field))
      .collect();
    for (snapshot_field_id, target_spec) in field_mapping {
      let snapshot_field = snapshot_by_id.get(snapshot_field_id.as_str()).copied().ok_or_else(|| {
        DatabaseServiceError::new(
          ERR_JSON_FIELD_MAPPING_INVALID,
          format!("Snapshot field id '{snapshot_field_id}' is not present in the snapshot"),
        )
      })?;
      let parsed = DatabaseJsonImportOptions::parse_field_target(target_spec);
      match parsed {
        DatabaseJsonImportFieldTarget::Existing(existing_id) => {
          if !target.fields.iter().any(|field| field.id == existing_id) {
            return Err(DatabaseServiceError::new(
              ERR_JSON_FIELD_MAPPING_INVALID,
              format!("Target field id '{existing_id}' is not present on the target Database"),
            ));
          }
          resolutions.insert(snapshot_field.id.clone(), existing_id);
        }
        DatabaseJsonImportFieldTarget::New(new_name) => {
          // If a field with that name already exists, reuse it; only
          // allocate a fresh one when no match exists.
          let canonical_name = crate::database::definition::rules::validate_title(&new_name)?;
          if let Some(existing) = target_by_name.get(canonical_name.as_str()) {
            resolutions.insert(snapshot_field.id.clone(), existing.id);
          } else {
            new_fields.push(DatabaseField {
              id: Uuid::new_v4(),
              database_id: target.database.id,
              name: canonical_name,
              field_type: snapshot_field.field_type,
              config: Self::domain_field_config(snapshot_field),
              position: snapshot_field.position,
              required: snapshot_field.required,
              edit_revision: 1,
              created_at: Utc::now(),
              updated_at: Utc::now(),
            });
          }
        }
      }
    }
    Ok((resolutions, new_fields))
  }

  fn domain_field_config(snapshot_field: &DatabaseSnapshotField) -> DatabaseFieldConfig {
    match &snapshot_field.config {
      DatabaseSnapshotFieldConfig::Domain(config) => config.clone(),
      DatabaseSnapshotFieldConfig::Relation(_)
      | DatabaseSnapshotFieldConfig::Rollup(_)
      | DatabaseSnapshotFieldConfig::Formula(_) => DatabaseFieldConfig::Text(DatabaseTextFieldConfig::default()),
    }
  }

  #[expect(
    clippy::too_many_arguments,
    reason = "snapshot merge keeps immutable input and mutable diagnostics explicit"
  )]
  async fn build_import_merge(
    &self,
    actor: UserId,
    _workspace_id: WorkspaceId,
    snapshot: &DatabaseSnapshot,
    target: &DatabaseRecord,
    resolutions: &BTreeMap<String, DatabaseFieldId>,
    conflict_strategy: DatabaseJsonConflictStrategy,
    _warnings: &mut Vec<DatabaseJsonDiagnostic>,
    conflict_warnings: &mut Vec<DatabaseJsonDiagnostic>,
  ) -> DatabaseResult<DatabaseSnapshotImportBundle> {
    let now = Utc::now();
    let target_id = target.database.id;
    if snapshot.database.rows.iter().any(|row| {
      !Self::snapshot_row_kind_allowed(
        target.database.profile_kind,
        target.database.profile_structure_preset.as_deref(),
        row.row_kind,
      )
    }) {
      return Err(DatabaseServiceError::new(
        ERR_JSON_INVALID,
        "Row kind is unavailable in the merge target profile structure",
      ));
    }
    let now_utc = Utc::now();
    // P-DB-28: rows that have a stable UniqueId are reconciled on
    // (unique_id_field_id, unique_id_display). Other rows are
    // appended. Existing target rows with the same UniqueId are
    // either overwritten, renamed (kept under a new id) or reported
    // as a conflict depending on `conflict_strategy`.
    // The repository layer does not pre-load rows on `get_database`,
    // so for the purposes of conflict detection the merge import
    // reads the live target rows through a lightweight lookup. When
    // the target has no rows we short-circuit to an empty map so the
    // merge behaves like a pure append.
    let target_rows = self.snapshot_rows(actor, target_id).await?;
    let unique_index: BTreeMap<(DatabaseFieldId, String), DatabaseRowId> = target_rows
      .iter()
      .filter_map(|row_read| {
        let unique_cell = row_read.cells.iter().find(|cell| {
          matches!(cell.field_type, DatabaseFieldType::UniqueId)
            && matches!(cell.value, DatabaseCellValueData::UniqueId(_))
        })?;
        if let DatabaseCellValueData::UniqueId(value) = &unique_cell.value {
          Some(((unique_cell.field_id, value.display.clone()), row_read.row.id))
        } else {
          None
        }
      })
      .collect();

    // Resolve field ids that the caller did not include in the
    // field_mapping by reusing existing target fields (by name).
    let mut resolutions = resolutions.clone();
    let mut fallback_resolutions: Vec<(DatabaseFieldId, DatabaseFieldId)> = Vec::new();
    let target_by_name: HashMap<String, DatabaseFieldId> = target
      .fields
      .iter()
      .map(|field| (field.name.clone(), field.id))
      .collect();
    let snapshot_by_id: HashMap<&str, &DatabaseSnapshotField> = snapshot
      .database
      .fields
      .iter()
      .map(|field| (field.id.as_str(), field))
      .collect();
    let unmapped: Vec<&DatabaseSnapshotField> = snapshot
      .database
      .fields
      .iter()
      .filter(|field| !resolutions.contains_key(field.id.as_str()) && !field.read_only)
      .collect();
    for field in unmapped {
      if let Some(existing_id) = target_by_name.get(field.name.as_str()) {
        resolutions.insert(field.id.clone(), *existing_id);
        fallback_resolutions.push((field.id.parse().unwrap_or_default(), *existing_id));
      }
    }
    let _ = snapshot_by_id; // keep mapping table referenced; silence unused warning
    let _ = fallback_resolutions;

    // Build field-id -> target field-id lookup for cell re-mapping.
    let mut field_id_map: HashMap<String, DatabaseFieldId> = HashMap::new();
    for (snapshot_field_id, target_field_id) in &resolutions {
      field_id_map.insert(snapshot_field_id.clone(), *target_field_id);
    }
    let field_map: HashMap<DatabaseFieldId, &DatabaseField> =
      target.fields.iter().map(|field| (field.id, field)).collect();

    let collision_for = |row: &DatabaseSnapshotRow| {
      row.cells.iter().chain(&row.projections).find_map(|cell| {
        let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::UniqueId(value)) = &cell.value else {
          return None;
        };
        if cell.field_type != DatabaseFieldType::UniqueId {
          return None;
        }
        field_id_map
          .get(&cell.field_id)
          .and_then(|field| unique_index.get(&(*field, value.display.clone())))
          .copied()
      })
    };
    // Allocate the actual conflict-plan identities before any Relation is
    // decoded. Rename gets a new identity; Overwrite keeps the matched Row.
    let row_ids = snapshot
      .database
      .rows
      .iter()
      .map(|row| {
        let id = match (collision_for(row), conflict_strategy) {
          (Some(existing), DatabaseJsonConflictStrategy::Overwrite | DatabaseJsonConflictStrategy::Abort) => existing,
          _ => Uuid::new_v4(),
        };
        (row.id.clone(), id)
      })
      .collect::<ImportRowMap>();
    let mut row_sources = Vec::new();
    let mut new_rows: Vec<DatabaseRowRecord> = Vec::new();
    let mut updated_rows: Vec<DatabaseRowRecord> = Vec::new();
    let mut skipped_rows: Vec<DatabaseRowRecord> = Vec::new();
    let mut content_documents = Vec::new();
    for row in &snapshot.database.rows {
      let source_for = |id| {
        row
          .source
          .as_ref()
          .filter(|_| row.row_kind == DatabaseRowKind::Task)
          .map(|source| {
            (
              id,
              DatabaseTaskSource {
                source_workspace_id: source.source_workspace_id,
                document_id: source.document_id,
                external_id: source.external_id.clone().unwrap_or_default(),
                block_id: source.block_id.clone().filter(|_| source.external_id.is_some()),
                selection_anchor: source.selection_anchor.clone().filter(|_| source.external_id.is_some()),
              },
            )
          })
      };
      let collision = collision_for(row);
      let row_kind = if conflict_strategy == DatabaseJsonConflictStrategy::Overwrite {
        collision
          .and_then(|id| {
            target_rows
              .iter()
              .find(|target| target.row.id == id)
              .map(|target| target.row.row_kind)
          })
          .unwrap_or(row.row_kind)
      } else {
        row.row_kind
      };
      let mut cells: Vec<DatabaseCellValue> = Vec::new();
      for cell in &row.cells {
        let Some(target_field_id) = field_id_map.get(&cell.field_id).copied() else {
          continue;
        };
        let Some(field) = field_map.get(&target_field_id).copied() else {
          continue;
        };
        let blocked_owner = target.database.profile_kind == DatabaseProfileKind::Project
          && task_blocked_by_owns_cell(field, row_kind, &target.field_roles);
        // Resolve the semantic owner after explicit field mapping, before the
        // portable decoder can omit an unresolved local Relation target.
        if (task_parent_owns_cell(field, row_kind, &target.field_roles) || blocked_owner)
          && let DatabaseSnapshotCellValueData::Relation(targets) = &cell.value
          && targets.iter().any(|target| !row_ids.contains_key(target))
        {
          return Err(if blocked_owner {
            Self::blocked_snapshot_error(DatabaseTaskRelationReason::UnavailableTarget)
          } else {
            DatabaseTaskRelationReason::UnavailableTarget.into()
          });
        }
        let Some(value) = self.import_cell_value(&cell.value, field, &row_ids, _warnings, false, blocked_owner)? else {
          continue;
        };
        if !matches!(&value, DatabaseCellValueData::Relation(_))
          || !(task_parent_owns_cell(field, row_kind, &target.field_roles) || blocked_owner)
        {
          crate::database::editing::rules::validate_cell_value(field, &value, &self.limits)?;
        }
        cells.push(DatabaseCellValue {
          row_id: row_ids[&row.id],
          field_id: target_field_id,
          field_type: field.field_type,
          value,
          updated_by: Some(actor),
          edit_revision: 1,
          updated_at: now_utc,
        });
      }
      let row_record = DatabaseRowRecord {
        row: DatabaseRow {
          id: row_ids[&row.id],
          database_id: target_id,
          content_document_id: None,
          row_kind,
          title: crate::database::editing::rules::clean_title(Some(row.title.clone())),
          position: row.position,
          created_by: Some(actor),
          updated_by: Some(actor),
          edit_revision: 1,
          created_at: now,
          updated_at: now,
          deleted_at: None,
        },
        cells,
        cell_revisions: Vec::new(),
      };
      if let Some(existing_id) = collision {
        match conflict_strategy {
          DatabaseJsonConflictStrategy::Abort => {
            conflict_warnings.push(Self::json_diag(
              ERR_JSON_CONFLICT,
              format!("$.database.rows[{}]", row.id),
              format!("Snapshot row collides with existing row '{existing_id}'; strategy=abort"),
            ));
            skipped_rows.push(row_record);
          }
          DatabaseJsonConflictStrategy::Rename => {
            let renamed = row_record.clone();
            // The first pass already fixed this Rename identity for all edges.
            if let Some(content) = row.content_document.clone() {
              content_documents.push(PendingSnapshotContentDocument {
                row_id: renamed.row.id,
                content,
              });
            }
            row_sources.extend(source_for(renamed.row.id));
            new_rows.push(renamed);
            conflict_warnings.push(Self::json_diag(
              ERR_JSON_CONFLICT,
              format!("$.database.rows[{}]", row.id),
              format!("Snapshot row collides with existing row '{existing_id}'; strategy=rename kept both"),
            ));
          }
          DatabaseJsonConflictStrategy::Overwrite => {
            if row.source.is_some()
              && target_rows
                .iter()
                .find(|target| target.row.id == existing_id)
                .is_none_or(|target| target.row.row_kind != DatabaseRowKind::Task)
            {
              return Err(DatabaseServiceError::new(
                ERR_JSON_INVALID,
                "source association requires an existing Task Row",
              ));
            }
            let mut updated = row_record.clone();
            updated.row.id = existing_id;
            updated.row.row_kind = target_rows
              .iter()
              .find(|target| target.row.id == existing_id)
              .expect("resolved merge conflict Row")
              .row
              .row_kind;
            if let Some(content) = row.content_document.clone() {
              content_documents.push(PendingSnapshotContentDocument {
                row_id: existing_id,
                content,
              });
            }
            row_sources.extend(source_for(updated.row.id));
            updated_rows.push(updated);
            conflict_warnings.push(Self::json_diag(
              ERR_JSON_CONFLICT,
              format!("$.database.rows[{}]", row.id),
              format!("Snapshot row overwrote existing row '{existing_id}'"),
            ));
          }
        }
      } else {
        if let Some(content) = row.content_document.clone() {
          content_documents.push(PendingSnapshotContentDocument {
            row_id: row_record.row.id,
            content,
          });
        }
        row_sources.extend(source_for(row_record.row.id));
        new_rows.push(row_record);
      }
    }

    let before = target_rows
      .iter()
      .map(|row| DatabaseRowRecord {
        row: row.row.clone(),
        cells: row.cells.clone(),
        cell_revisions: row.cell_revisions.clone(),
      })
      .collect::<Vec<_>>();
    let proposals = new_rows.iter().chain(&updated_rows).cloned().collect::<Vec<_>>();
    validate_task_parent_rows(
      target_id,
      target.database.profile_kind,
      &target.fields,
      &target.field_roles,
      &before,
      &proposals,
      &[],
    )?;
    validate_task_blocked_by_rows(
      target_id,
      target.database.profile_kind,
      &target.fields,
      &target.field_roles,
      &before,
      &proposals,
      &[],
    )
    .map_err(Self::blocked_snapshot_error)?;
    Ok(DatabaseSnapshotImportBundle {
      database: Database {
        system_role: None,
        managed_installation: None,

        id: target_id,
        workspace_id: target.database.workspace_id,
        profile_kind: target.database.profile_kind,
        profile_structure_preset: target.database.profile_structure_preset.clone(),
        profile_config: target.database.profile_config.clone(),
        title: target.database.title.clone(),
        description: target.database.description.clone(),
        created_by: target.database.created_by,
        updated_by: Some(actor),
        deleted_at: None,
        deleted_by: None,
        edit_revision: 1,
        created_at: target.database.created_at,
        updated_at: now,
      },
      fields: Vec::new(),
      views: Vec::new(),
      field_roles: target.field_roles.clone(),
      view_roles: target.view_roles.clone(),
      row_sources,
      rows: new_rows,
      updated_rows,
      skipped_rows,
      row_templates: Vec::new(),
      content_documents,
      row_template_contents: Vec::new(),
      existing_fields: target.fields.clone(),
      existing_views: target.views.clone(),
    })
  }

  pub(in crate::database) fn snapshot_field(
    &self,
    field: &DatabaseField,
    database_local_id: &str,
    field_local_ids: &FieldLocalMap,
  ) -> Option<DatabaseSnapshotField> {
    let id = field_local_ids.get(&field.id)?.clone();
    let config = match &field.config {
      DatabaseFieldConfig::Relation(config) => {
        DatabaseSnapshotFieldConfig::Relation(DatabaseSnapshotRelationFieldConfig {
          target_database_id: if config.target_database_id == field.database_id {
            database_local_id.to_string()
          } else {
            config.target_database_id.to_string()
          },
          allow_multiple: config.allow_multiple,
          reciprocal_field_id: config
            .reciprocal_field_id
            .and_then(|field_id| field_local_ids.get(&field_id).cloned()),
          max_targets: config.max_targets,
        })
      }
      DatabaseFieldConfig::Rollup(config) => DatabaseSnapshotFieldConfig::Rollup(DatabaseSnapshotRollupFieldConfig {
        source_relation_field_id: field_local_ids
          .get(&config.source_relation_field_id)
          .cloned()
          .unwrap_or_else(|| config.source_relation_field_id.to_string()),
        target_field_id: field_local_ids
          .get(&config.target_field_id)
          .cloned()
          .unwrap_or_else(|| config.target_field_id.to_string()),
        aggregate: config.aggregate,
        empty_value: config.empty_value.clone(),
        stale_policy: config.stale_policy,
      }),
      DatabaseFieldConfig::Formula(config) => {
        DatabaseSnapshotFieldConfig::Formula(DatabaseSnapshotFormulaFieldConfig {
          expression: config.expression.clone(),
          result_type: config.result_type,
          dependency_field_ids: config
            .dependency_field_ids
            .iter()
            .filter_map(|field_id| field_local_ids.get(field_id).cloned())
            .collect(),
          stale_policy: config.stale_policy,
          format: config.format.clone(),
        })
      }
      config => DatabaseSnapshotFieldConfig::Domain(config.clone()),
    };
    Some(DatabaseSnapshotField {
      id,
      name: field.name.clone(),
      field_type: field.field_type,
      config,
      position: field.position,
      required: field.required,
      read_only: Self::snapshot_field_is_read_only(field.field_type),
    })
  }

  fn snapshot_row(
    &self,
    row: &DatabaseRowRead,
    field_local_ids: &FieldLocalMap,
    row_local_ids: &RowLocalMap,
    asset_local_ids: &HashMap<String, String>,
    document_local_ids: &HashMap<DocId, String>,
  ) -> DatabaseSnapshotRow {
    let mut cells = Vec::new();
    let mut projections = Vec::new();
    for cell in &row.cells {
      let Some(field_id) = field_local_ids.get(&cell.field_id).cloned() else {
        continue;
      };
      let snapshot_value = match &cell.value {
        DatabaseCellValueData::Relation(target_row_ids) => DatabaseSnapshotCellValueData::Relation(
          target_row_ids
            .iter()
            .filter_map(|target_row_id| row_local_ids.get(target_row_id).cloned())
            .collect(),
        ),
        DatabaseCellValueData::DocumentLink(value) => {
          let key = document_local_ids
            .get(&value.doc_id)
            .cloned()
            .unwrap_or_else(|| Self::opaque_snapshot_reference_key(&value.doc_id.to_string()));
          DatabaseSnapshotCellValueData::DocumentLink {
            doc_id: snapshot_document_uri(&key),
            workspace_id: value.workspace_id,
          }
        }
        DatabaseCellValueData::Files(value) => {
          let mut value = value.clone();
          for file in &mut value.files {
            if let Some(local_key) = asset_local_ids.get(&file.blob_key) {
              file.blob_key = local_key.clone();
            }
          }
          DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Files(value))
        }
        value => DatabaseSnapshotCellValueData::Domain(value.clone()),
      };
      let snapshot_cell = DatabaseSnapshotCellValue {
        field_id,
        field_type: cell.field_type,
        value: snapshot_value,
      };
      if Self::snapshot_cell_is_projection(cell.field_type) {
        projections.push(snapshot_cell);
      } else {
        cells.push(snapshot_cell);
      }
    }
    DatabaseSnapshotRow {
      id: row_local_ids
        .get(&row.row.id)
        .cloned()
        .unwrap_or_else(|| row.row.id.to_string()),
      title: row.row.title.clone(),
      position: row.row.position,
      content_document: None,
      row_kind: row.row.row_kind,
      source: None,
      cells,
      projections,
    }
  }

  pub(super) fn opaque_snapshot_reference_key(raw_document_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(raw_document_id.as_bytes());
    format!("external-{}", &hex::encode(digest.finalize())[..24])
  }

  fn snapshot_field_is_read_only(field_type: DatabaseFieldType) -> bool {
    matches!(
      field_type,
      DatabaseFieldType::CreatedTime
        | DatabaseFieldType::CreatedBy
        | DatabaseFieldType::UpdatedTime
        | DatabaseFieldType::UpdatedBy
        | DatabaseFieldType::UniqueId
    )
  }

  pub(in crate::database) fn snapshot_cell_is_projection(field_type: DatabaseFieldType) -> bool {
    Self::snapshot_field_is_read_only(field_type)
      || matches!(
        field_type,
        DatabaseFieldType::Rollup | DatabaseFieldType::Formula | DatabaseFieldType::DocumentLink
      )
  }

  fn snapshot_row_template(
    &self,
    template: DatabaseRowTemplate,
    field_local_ids: &FieldLocalMap,
    row_local_ids: &RowLocalMap,
  ) -> Option<DatabaseSnapshotRowTemplate> {
    let mut values = BTreeMap::new();
    for (field_id, value) in template.initial_cell_values {
      let Some(local_field_id) = field_local_ids.get(&field_id).cloned() else {
        continue;
      };
      let snapshot_value = match value {
        DatabaseCellValueData::Relation(target_row_ids) => DatabaseSnapshotCellValueData::Relation(
          target_row_ids
            .iter()
            .filter_map(|target_row_id| row_local_ids.get(target_row_id).cloned())
            .collect(),
        ),
        DatabaseCellValueData::DocumentLink(value) => DatabaseSnapshotCellValueData::DocumentLink {
          doc_id: value.doc_id.to_string(),
          workspace_id: value.workspace_id,
        },
        value => DatabaseSnapshotCellValueData::Domain(value),
      };
      values.insert(local_field_id, snapshot_value);
    }
    Some(DatabaseSnapshotRowTemplate {
      id: template.id.to_string(),
      template_id: template.template_id,
      row_kind: template.row_kind,
      name: template.name,
      description: template.description,
      position: template.position,
      enabled: template.enabled,
      is_default: template.is_default,
      content_document: None,
      initial_cell_values: values,
    })
  }

  pub(in crate::database) fn snapshot_view(
    &self,
    view: &DatabaseView,
    field_local_ids: &FieldLocalMap,
    view_local_ids: &ViewLocalMap,
  ) -> Option<DatabaseSnapshotView> {
    let config = match &view.config {
      DatabaseViewConfig::Table(config) => DatabaseSnapshotViewConfig::Table(DatabaseSnapshotTableViewConfig {
        title_field_id: field_local_ids.get(&config.title_field_id)?.clone(),
        visible_field_ids: Self::snapshot_field_ids(&config.visible_field_ids, field_local_ids),
        field_widths: config
          .field_widths
          .iter()
          .filter_map(|(field_id, width)| field_local_ids.get(field_id).map(|id| (id.clone(), *width)))
          .collect(),
        search_field_ids: Self::snapshot_field_ids(&config.search_field_ids, field_local_ids),
        sort: Self::snapshot_sort_rules(&config.sort, field_local_ids),
        filter: Self::snapshot_filter_rules(&config.filter, field_local_ids),
        filter_tree: Self::snapshot_filter_group(config.filter_tree.as_ref(), field_local_ids),
        group: Self::snapshot_group_rule(&config.group, field_local_ids),
        subgroup: Self::snapshot_group_rule(&config.subgroup, field_local_ids),
      }),
      DatabaseViewConfig::Kanban(config) => DatabaseSnapshotViewConfig::Kanban(DatabaseSnapshotKanbanViewConfig {
        title_field_id: field_local_ids.get(&config.title_field_id)?.clone(),
        group_field_id: field_local_ids.get(&config.group_field_id)?.clone(),
        visible_field_ids: Self::snapshot_field_ids(&config.visible_field_ids, field_local_ids),
        cover_field_id: config.cover_field_id.and_then(|id| field_local_ids.get(&id).cloned()),
        card_density: config.card_density,
        sort: Self::snapshot_sort_rules(&config.sort, field_local_ids),
        filter: Self::snapshot_filter_rules(&config.filter, field_local_ids),
        filter_tree: Self::snapshot_filter_group(config.filter_tree.as_ref(), field_local_ids),
      }),
      DatabaseViewConfig::List(config) => DatabaseSnapshotViewConfig::List(DatabaseSnapshotListViewConfig {
        title_field_id: field_local_ids.get(&config.title_field_id)?.clone(),
        visible_field_ids: Self::snapshot_field_ids(&config.visible_field_ids, field_local_ids),
        sort: Self::snapshot_sort_rules(&config.sort, field_local_ids),
        filter: Self::snapshot_filter_rules(&config.filter, field_local_ids),
        filter_tree: Self::snapshot_filter_group(config.filter_tree.as_ref(), field_local_ids),
        density: config.density,
        show_field_labels: config.show_field_labels,
        group: Self::snapshot_group_rule(&config.group, field_local_ids),
        subgroup: Self::snapshot_group_rule(&config.subgroup, field_local_ids),
      }),
      DatabaseViewConfig::Gallery(config) => DatabaseSnapshotViewConfig::Gallery(DatabaseSnapshotGalleryViewConfig {
        title_field_id: field_local_ids.get(&config.title_field_id)?.clone(),
        visible_field_ids: Self::snapshot_field_ids(&config.visible_field_ids, field_local_ids),
        cover_field_id: config.cover_field_id.and_then(|id| field_local_ids.get(&id).cloned()),
        sort: Self::snapshot_sort_rules(&config.sort, field_local_ids),
        filter: Self::snapshot_filter_rules(&config.filter, field_local_ids),
        filter_tree: Self::snapshot_filter_group(config.filter_tree.as_ref(), field_local_ids),
        card_density: config.card_density,
        show_empty_cover: config.show_empty_cover,
        group: Self::snapshot_group_rule(&config.group, field_local_ids),
        subgroup: Self::snapshot_group_rule(&config.subgroup, field_local_ids),
      }),
      DatabaseViewConfig::Calendar(config) => {
        DatabaseSnapshotViewConfig::Calendar(DatabaseSnapshotCalendarViewConfig {
          title_field_id: field_local_ids.get(&config.title_field_id)?.clone(),
          date_field_id: field_local_ids.get(&config.date_field_id)?.clone(),
          visible_field_ids: Self::snapshot_field_ids(&config.visible_field_ids, field_local_ids),
          sort: Self::snapshot_sort_rules(&config.sort, field_local_ids),
          filter: Self::snapshot_filter_rules(&config.filter, field_local_ids),
          filter_tree: Self::snapshot_filter_group(config.filter_tree.as_ref(), field_local_ids),
          date_mode: config.date_mode,
          initial_range: config.initial_range,
          group: Self::snapshot_group_rule(&config.group, field_local_ids),
          subgroup: Self::snapshot_group_rule(&config.subgroup, field_local_ids),
        })
      }
      DatabaseViewConfig::Timeline(config) => {
        DatabaseSnapshotViewConfig::Timeline(DatabaseSnapshotTimelineViewConfig {
          title_field_id: field_local_ids.get(&config.title_field_id)?.clone(),
          start_field_id: field_local_ids.get(&config.start_field_id)?.clone(),
          end_field_id: config.end_field_id.and_then(|id| field_local_ids.get(&id).cloned()),
          visible_field_ids: Self::snapshot_field_ids(&config.visible_field_ids, field_local_ids),
          sort: Self::snapshot_sort_rules(&config.sort, field_local_ids),
          filter: Self::snapshot_filter_rules(&config.filter, field_local_ids),
          filter_tree: Self::snapshot_filter_group(config.filter_tree.as_ref(), field_local_ids),
          group_by: config.group_by,
          order: config.order,
          zoom: config.zoom,
        })
      }
      DatabaseViewConfig::Gantt(config) => DatabaseSnapshotViewConfig::Gantt(DatabaseSnapshotGanttViewConfig {
        title_field_id: field_local_ids.get(&config.title_field_id)?.clone(),
        start_field_id: field_local_ids.get(&config.start_field_id)?.clone(),
        end_field_id: config.end_field_id.and_then(|id| field_local_ids.get(&id).cloned()),
        visible_field_ids: Self::snapshot_field_ids(&config.visible_field_ids, field_local_ids),
        sort: Self::snapshot_sort_rules(&config.sort, field_local_ids),
        filter: Self::snapshot_filter_rules(&config.filter, field_local_ids),
        filter_tree: Self::snapshot_filter_group(config.filter_tree.as_ref(), field_local_ids),
        group: Self::snapshot_group_rule(&config.group, field_local_ids),
        zoom: config.zoom,
        dependency_field_id: config
          .dependency_field_id
          .and_then(|id| field_local_ids.get(&id).cloned()),
      }),
      DatabaseViewConfig::Progress(config) => {
        DatabaseSnapshotViewConfig::Progress(DatabaseSnapshotProgressViewConfig {
          title_field_id: field_local_ids.get(&config.title_field_id)?.clone(),
          progress_field_id: field_local_ids.get(&config.progress_field_id)?.clone(),
          group_field_id: config.group_field_id.and_then(|id| field_local_ids.get(&id).cloned()),
          visible_field_ids: Self::snapshot_field_ids(&config.visible_field_ids, field_local_ids),
          sort: Self::snapshot_sort_rules(&config.sort, field_local_ids),
          filter: Self::snapshot_filter_rules(&config.filter, field_local_ids),
          filter_tree: Self::snapshot_filter_group(config.filter_tree.as_ref(), field_local_ids),
        })
      }
    };
    Some(DatabaseSnapshotView {
      id: view_local_ids.get(&view.id)?.clone(),
      name: view.name.clone(),
      view_kind: view.view_kind,
      icon: view.icon.clone(),
      config,
      position: view.position,
    })
  }

  fn import_field_config(
    &self,
    field: &DatabaseSnapshotField,
    database_id: DatabaseId,
    field_ids: &ImportFieldMap,
    warnings: &mut Vec<DatabaseJsonDiagnostic>,
  ) -> DatabaseResult<DatabaseFieldConfig> {
    match &field.config {
      DatabaseSnapshotFieldConfig::Domain(config) => Ok(config.clone()),
      DatabaseSnapshotFieldConfig::Relation(config) => {
        if config.target_database_id != "database_0" {
          warnings.push(Self::json_diag(
            ERR_FIELD_INVALID,
            format!("$.database.fields[{}].config", field.id),
            "External relation target was remapped to the imported Database only when portable",
          ));
        }
        Ok(DatabaseFieldConfig::Relation(DatabaseRelationFieldConfig {
          target_database_id: database_id,
          allow_multiple: config.allow_multiple,
          reciprocal_field_id: config
            .reciprocal_field_id
            .as_ref()
            .and_then(|id| field_ids.get(id).copied()),
          max_targets: config.max_targets,
        }))
      }
      DatabaseSnapshotFieldConfig::Rollup(config) => Ok(DatabaseFieldConfig::Rollup(DatabaseRollupFieldConfig {
        source_relation_field_id: field_ids
          .get(&config.source_relation_field_id)
          .copied()
          .ok_or_else(|| DatabaseServiceError::new(ERR_FIELD_INVALID, "rollup source field missing in snapshot"))?,
        target_field_id: field_ids
          .get(&config.target_field_id)
          .copied()
          .ok_or_else(|| DatabaseServiceError::new(ERR_FIELD_INVALID, "rollup target field missing in snapshot"))?,
        aggregate: config.aggregate,
        empty_value: config.empty_value.clone(),
        stale_policy: config.stale_policy,
      })),
      DatabaseSnapshotFieldConfig::Formula(config) => Ok(DatabaseFieldConfig::Formula(DatabaseFormulaFieldConfig {
        expression: config.expression.clone(),
        result_type: config.result_type,
        dependency_field_ids: config
          .dependency_field_ids
          .iter()
          .filter_map(|id| field_ids.get(id).copied())
          .collect(),
        stale_policy: config.stale_policy,
        format: config.format.clone(),
      })),
    }
  }

  fn import_view_config(
    &self,
    view: &DatabaseSnapshotView,
    field_ids: &ImportFieldMap,
    warnings: &mut Vec<DatabaseJsonDiagnostic>,
  ) -> DatabaseResult<Option<DatabaseViewConfig>> {
    let missing = |path: String, warnings: &mut Vec<DatabaseJsonDiagnostic>| {
      warnings.push(Self::json_diag(
        ERR_VIEW_INVALID,
        path,
        "Snapshot view referenced a field that is not imported; the view was skipped",
      ));
      Ok(None)
    };
    let config = match &view.config {
      DatabaseSnapshotViewConfig::Table(config) => DatabaseViewConfig::Table(DatabaseTableViewConfig {
        title_field_id: *field_ids
          .get(&config.title_field_id)
          .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_INVALID, "table view title field missing"))?,
        visible_field_ids: Self::import_field_ids(&config.visible_field_ids, field_ids),
        field_widths: config
          .field_widths
          .iter()
          .filter_map(|(field_id, width)| field_ids.get(field_id).map(|id| (*id, *width)))
          .collect(),
        search_field_ids: Self::import_field_ids(&config.search_field_ids, field_ids),
        sort: Self::import_sort_rules(&config.sort, field_ids),
        filter: Self::import_filter_rules(&config.filter, field_ids),
        filter_tree: Self::import_filter_group(config.filter_tree.as_ref(), field_ids),
        group: Self::import_group_rule(&config.group, field_ids, warnings, &view.id, "group")?,
        subgroup: Self::import_group_rule(&config.subgroup, field_ids, warnings, &view.id, "subgroup")?,
      }),
      DatabaseSnapshotViewConfig::Kanban(config) => {
        let Some(group_field_id) = field_ids.get(&config.group_field_id).copied() else {
          return missing(format!("$.database.views[{}].config.groupFieldId", view.id), warnings);
        };
        DatabaseViewConfig::Kanban(DatabaseKanbanViewConfig {
          title_field_id: *field_ids
            .get(&config.title_field_id)
            .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_INVALID, "kanban view title field missing"))?,
          group_field_id,
          visible_field_ids: Self::import_field_ids(&config.visible_field_ids, field_ids),
          cover_field_id: config.cover_field_id.as_ref().and_then(|id| field_ids.get(id).copied()),
          card_density: config.card_density,
          sort: Self::import_sort_rules(&config.sort, field_ids),
          filter: Self::import_filter_rules(&config.filter, field_ids),
          filter_tree: Self::import_filter_group(config.filter_tree.as_ref(), field_ids),
        })
      }
      DatabaseSnapshotViewConfig::List(config) => DatabaseViewConfig::List(DatabaseListViewConfig {
        title_field_id: *field_ids
          .get(&config.title_field_id)
          .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_INVALID, "list view title field missing"))?,
        visible_field_ids: Self::import_field_ids(&config.visible_field_ids, field_ids),
        sort: Self::import_sort_rules(&config.sort, field_ids),
        filter: Self::import_filter_rules(&config.filter, field_ids),
        filter_tree: Self::import_filter_group(config.filter_tree.as_ref(), field_ids),
        density: config.density,
        show_field_labels: config.show_field_labels,
        group: Self::import_group_rule(&config.group, field_ids, warnings, &view.id, "group")?,
        subgroup: Self::import_group_rule(&config.subgroup, field_ids, warnings, &view.id, "subgroup")?,
      }),
      DatabaseSnapshotViewConfig::Gallery(config) => DatabaseViewConfig::Gallery(DatabaseGalleryViewConfig {
        title_field_id: *field_ids
          .get(&config.title_field_id)
          .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_INVALID, "gallery view title field missing"))?,
        visible_field_ids: Self::import_field_ids(&config.visible_field_ids, field_ids),
        cover_field_id: config.cover_field_id.as_ref().and_then(|id| field_ids.get(id).copied()),
        sort: Self::import_sort_rules(&config.sort, field_ids),
        filter: Self::import_filter_rules(&config.filter, field_ids),
        filter_tree: Self::import_filter_group(config.filter_tree.as_ref(), field_ids),
        card_density: config.card_density,
        show_empty_cover: config.show_empty_cover,
        group: Self::import_group_rule(&config.group, field_ids, warnings, &view.id, "group")?,
        subgroup: Self::import_group_rule(&config.subgroup, field_ids, warnings, &view.id, "subgroup")?,
      }),
      DatabaseSnapshotViewConfig::Calendar(config) => {
        let Some(date_field_id) = field_ids.get(&config.date_field_id).copied() else {
          return missing(format!("$.database.views[{}].config.dateFieldId", view.id), warnings);
        };
        DatabaseViewConfig::Calendar(DatabaseCalendarViewConfig {
          title_field_id: *field_ids
            .get(&config.title_field_id)
            .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_INVALID, "calendar view title field missing"))?,
          date_field_id,
          visible_field_ids: Self::import_field_ids(&config.visible_field_ids, field_ids),
          sort: Self::import_sort_rules(&config.sort, field_ids),
          filter: Self::import_filter_rules(&config.filter, field_ids),
          filter_tree: Self::import_filter_group(config.filter_tree.as_ref(), field_ids),
          date_mode: config.date_mode,
          initial_range: config.initial_range,
          group: Self::import_group_rule(&config.group, field_ids, warnings, &view.id, "group")?,
          subgroup: Self::import_group_rule(&config.subgroup, field_ids, warnings, &view.id, "subgroup")?,
        })
      }
      DatabaseSnapshotViewConfig::Timeline(config) => {
        let Some(start_field_id) = field_ids.get(&config.start_field_id).copied() else {
          return missing(format!("$.database.views[{}].config.startFieldId", view.id), warnings);
        };
        DatabaseViewConfig::Timeline(DatabaseTimelineViewConfig {
          title_field_id: *field_ids
            .get(&config.title_field_id)
            .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_INVALID, "timeline view title field missing"))?,
          start_field_id,
          end_field_id: config.end_field_id.as_ref().and_then(|id| field_ids.get(id).copied()),
          visible_field_ids: Self::import_field_ids(&config.visible_field_ids, field_ids),
          sort: Self::import_sort_rules(&config.sort, field_ids),
          filter: Self::import_filter_rules(&config.filter, field_ids),
          filter_tree: Self::import_filter_group(config.filter_tree.as_ref(), field_ids),
          group_by: config.group_by,
          order: config.order,
          zoom: config.zoom,
        })
      }
      DatabaseSnapshotViewConfig::Gantt(config) => {
        let Some(start_field_id) = field_ids.get(&config.start_field_id).copied() else {
          return missing(format!("$.database.views[{}].config.startFieldId", view.id), warnings);
        };
        DatabaseViewConfig::Gantt(DatabaseGanttViewConfig {
          title_field_id: *field_ids
            .get(&config.title_field_id)
            .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_INVALID, "gantt view title field missing"))?,
          start_field_id,
          end_field_id: config.end_field_id.as_ref().and_then(|id| field_ids.get(id).copied()),
          visible_field_ids: Self::import_field_ids(&config.visible_field_ids, field_ids),
          sort: Self::import_sort_rules(&config.sort, field_ids),
          filter: Self::import_filter_rules(&config.filter, field_ids),
          filter_tree: Self::import_filter_group(config.filter_tree.as_ref(), field_ids),
          group: Self::import_group_rule(&config.group, field_ids, warnings, &view.id, "group")?,
          zoom: config.zoom,
          dependency_field_id: config
            .dependency_field_id
            .as_ref()
            .and_then(|id| field_ids.get(id).copied()),
        })
      }
      DatabaseSnapshotViewConfig::Progress(config) => {
        let Some(progress_field_id) = field_ids.get(&config.progress_field_id).copied() else {
          return missing(
            format!("$.database.views[{}].config.progressFieldId", view.id),
            warnings,
          );
        };
        DatabaseViewConfig::Progress(DatabaseProgressViewConfig {
          title_field_id: *field_ids
            .get(&config.title_field_id)
            .ok_or_else(|| DatabaseServiceError::new(ERR_VIEW_INVALID, "progress view title field missing"))?,
          progress_field_id,
          group_field_id: config.group_field_id.as_ref().and_then(|id| field_ids.get(id).copied()),
          visible_field_ids: Self::import_field_ids(&config.visible_field_ids, field_ids),
          sort: Self::import_sort_rules(&config.sort, field_ids),
          filter: Self::import_filter_rules(&config.filter, field_ids),
          filter_tree: Self::import_filter_group(config.filter_tree.as_ref(), field_ids),
        })
      }
    };
    Ok(Some(config))
  }

  #[allow(clippy::too_many_arguments)]
  fn import_row(
    &self,
    row: &DatabaseSnapshotRow,
    database_id: DatabaseId,
    actor: UserId,
    now: chrono::DateTime<Utc>,
    field_ids: &ImportFieldMap,
    row_ids: &ImportRowMap,
    field_map: &HashMap<DatabaseFieldId, &DatabaseField>,
    field_roles: &[DatabaseFieldRole],
    profile_kind: DatabaseProfileKind,
    warnings: &mut Vec<DatabaseJsonDiagnostic>,
    operation_admitted: bool,
  ) -> DatabaseResult<DatabaseRowRecord> {
    let row_id = *row_ids
      .get(&row.id)
      .ok_or_else(|| DatabaseServiceError::new(ERR_NOT_FOUND, "snapshot row id was not allocated"))?;
    let mut cells = Vec::new();
    for cell in &row.cells {
      let Some(field_id) = field_ids.get(&cell.field_id).copied() else {
        warnings.push(Self::json_diag(
          ERR_FIELD_INVALID,
          format!("$.database.rows[{}].cells", row.id),
          "Cell referenced a skipped field and was ignored",
        ));
        continue;
      };
      let Some(field) = field_map.get(&field_id).copied() else {
        continue;
      };
      let blocked_owner =
        profile_kind == DatabaseProfileKind::Project && task_blocked_by_owns_cell(field, row.row_kind, field_roles);
      let Some(value) =
        self.import_cell_value(&cell.value, field, row_ids, warnings, operation_admitted, blocked_owner)?
      else {
        continue;
      };
      if !matches!(&value, DatabaseCellValueData::Relation(_))
        || !(task_parent_owns_cell(field, row.row_kind, field_roles) || blocked_owner)
      {
        crate::database::editing::rules::validate_cell_value(field, &value, &self.limits)?;
      }
      cells.push(DatabaseCellValue {
        row_id,
        field_id,
        field_type: field.field_type,
        value,
        updated_by: Some(actor),
        edit_revision: 1,
        updated_at: now,
      });
    }
    Ok(DatabaseRowRecord {
      row: DatabaseRow {
        id: row_id,
        database_id,
        content_document_id: None,
        row_kind: row.row_kind,
        title: crate::database::editing::rules::clean_title(Some(row.title.clone())),
        position: row.position,
        created_by: Some(actor),
        updated_by: Some(actor),
        edit_revision: 1,
        created_at: now,
        updated_at: now,
        deleted_at: None,
      },
      cells,
      cell_revisions: Vec::new(),
    })
  }

  #[allow(clippy::too_many_arguments)]
  fn import_row_template(
    &self,
    template: &DatabaseSnapshotRowTemplate,
    row_template_id: Uuid,
    workspace_id: WorkspaceId,
    database_id: DatabaseId,
    actor: UserId,
    now: chrono::DateTime<Utc>,
    field_ids: &ImportFieldMap,
    row_ids: &ImportRowMap,
    field_map: &HashMap<DatabaseFieldId, &DatabaseField>,
    field_roles: &[DatabaseFieldRole],
    profile_kind: DatabaseProfileKind,
    warnings: &mut Vec<DatabaseJsonDiagnostic>,
    operation_admitted: bool,
  ) -> DatabaseResult<Option<DatabaseRowTemplate>> {
    let mut values = BTreeMap::new();
    for (local_field_id, value) in &template.initial_cell_values {
      let Some(field_id) = field_ids.get(local_field_id).copied() else {
        continue;
      };
      let Some(field) = field_map.get(&field_id).copied() else {
        continue;
      };
      let blocked_owner = profile_kind == DatabaseProfileKind::Project
        && task_blocked_by_owns_cell(field, template.row_kind, field_roles);
      let Some(value) = self.import_cell_value(value, field, row_ids, warnings, operation_admitted, blocked_owner)?
      else {
        continue;
      };
      if !matches!(&value, DatabaseCellValueData::Relation(_))
        || !(task_parent_owns_cell(field, template.row_kind, field_roles) || blocked_owner)
      {
        crate::database::editing::rules::validate_cell_value(field, &value, &self.limits)?;
      }
      values.insert(field_id, value);
    }
    Ok(Some(DatabaseRowTemplate {
      edit_revision: 1,
      content_document_id: None,
      id: row_template_id,
      workspace_id,
      database_id,
      template_id: template.template_id,
      row_kind: template.row_kind,
      name: crate::database::definition::rules::validate_title(&template.name)?,
      description: template.description.clone(),
      position: template.position,
      enabled: template.enabled,
      is_default: template.is_default,
      initial_cell_values: values,
      created_by: Some(actor),
      updated_by: Some(actor),
      created_at: now,
      updated_at: now,
    }))
  }

  fn import_cell_value(
    &self,
    value: &DatabaseSnapshotCellValueData,
    field: &DatabaseField,
    row_ids: &ImportRowMap,
    warnings: &mut Vec<DatabaseJsonDiagnostic>,
    operation_admitted: bool,
    blocked_owner: bool,
  ) -> DatabaseResult<Option<DatabaseCellValueData>> {
    match value {
      DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Relation(targets))
        if blocked_owner && !operation_admitted =>
      {
        // Ordinary input UUIDs are only portable Row keys. An existing target
        // UUID is not an operation mapping and cannot bypass import admission.
        let targets = targets
          .iter()
          .map(|target| {
            row_ids
              .get(&target.to_string())
              .copied()
              .ok_or_else(|| Self::blocked_snapshot_error(DatabaseTaskRelationReason::UnavailableTarget))
          })
          .collect::<DatabaseResult<Vec<_>>>()?;
        Ok(Some(DatabaseCellValueData::Relation(targets)))
      }

      DatabaseSnapshotCellValueData::Domain(value)
        if operation_admitted
          && matches!(
            value,
            DatabaseCellValueData::DocumentLink(_) | DatabaseCellValueData::Relation(_)
          ) =>
      {
        // The Row/template caller applies the actual semantic owner after
        // decoding; generic limits must not preempt typed Parent diagnostics.
        Ok(Some(value.clone()))
      }
      DatabaseSnapshotCellValueData::Domain(value) => {
        crate::database::editing::rules::normalize_editable_cell_value(field.field_type, value.clone(), &self.limits)
      }
      DatabaseSnapshotCellValueData::Relation(targets) => {
        if blocked_owner && targets.iter().any(|target| !row_ids.contains_key(target)) {
          return Err(Self::blocked_snapshot_error(
            DatabaseTaskRelationReason::UnavailableTarget,
          ));
        }
        if field.field_type != DatabaseFieldType::Relation {
          return Err(DatabaseServiceError::new(
            ERR_JSON_INVALID,
            "relation snapshot value does not target a relation field",
          ));
        }
        Ok(Some(DatabaseCellValueData::Relation(
          targets
            .iter()
            .filter_map(|local_id| row_ids.get(local_id).copied())
            .collect(),
        )))
      }
      DatabaseSnapshotCellValueData::DocumentLink { .. } => {
        warnings.push(Self::json_diag(
          ERR_CELL_VALUE_READONLY,
          "$.database.rows.cells",
          "Document-link cells are not imported from JSON snapshots because document IDs are not portable",
        ));
        Ok(None)
      }
    }
  }

  fn snapshot_field_ids(field_ids: &[DatabaseFieldId], local_ids: &FieldLocalMap) -> Vec<String> {
    field_ids
      .iter()
      .filter_map(|field_id| local_ids.get(field_id).cloned())
      .collect()
  }

  fn import_field_ids(field_ids: &[String], imported_ids: &ImportFieldMap) -> Vec<DatabaseFieldId> {
    field_ids
      .iter()
      .filter_map(|field_id| imported_ids.get(field_id).copied())
      .collect()
  }

  fn snapshot_sort_rules(rules: &[DatabaseSortRule], field_local_ids: &FieldLocalMap) -> Vec<DatabaseSnapshotSortRule> {
    rules
      .iter()
      .filter_map(|rule| {
        field_local_ids
          .get(&rule.field_id)
          .map(|field_id| DatabaseSnapshotSortRule {
            field_id: field_id.clone(),
            direction: rule.direction,
          })
      })
      .collect()
  }

  fn import_sort_rules(rules: &[DatabaseSnapshotSortRule], field_ids: &ImportFieldMap) -> Vec<DatabaseSortRule> {
    rules
      .iter()
      .filter_map(|rule| {
        field_ids.get(&rule.field_id).map(|field_id| DatabaseSortRule {
          field_id: *field_id,
          direction: rule.direction,
        })
      })
      .collect()
  }

  fn snapshot_group_rule(
    rule: &Option<DatabaseGroupRule>,
    field_local_ids: &FieldLocalMap,
  ) -> Option<DatabaseSnapshotGroupRule> {
    let rule = rule.as_ref()?;
    Some(DatabaseSnapshotGroupRule {
      field_id: field_local_ids.get(&rule.field_id)?.clone(),
      descending: rule.descending,
      show_empty_groups: rule.show_empty_groups,
    })
  }

  fn import_group_rule(
    rule: &Option<DatabaseSnapshotGroupRule>,
    field_ids: &ImportFieldMap,
    warnings: &mut Vec<DatabaseJsonDiagnostic>,
    view_id: &str,
    path: &str,
  ) -> DatabaseResult<Option<DatabaseGroupRule>> {
    let Some(rule) = rule else {
      return Ok(None);
    };
    let Some(field_id) = field_ids.get(&rule.field_id).copied() else {
      warnings.push(Self::json_diag(
        ERR_VIEW_INVALID,
        format!("$.database.views[{view_id}].config.{path}.fieldId"),
        "Snapshot view group referenced a field that is not imported; the group was skipped",
      ));
      return Ok(None);
    };
    Ok(Some(DatabaseGroupRule {
      field_id,
      descending: rule.descending,
      show_empty_groups: rule.show_empty_groups,
    }))
  }

  fn snapshot_filter_rules(
    rules: &[DatabaseFilterRule],
    field_local_ids: &FieldLocalMap,
  ) -> Vec<DatabaseSnapshotFilterRule> {
    rules
      .iter()
      .filter_map(|rule| {
        field_local_ids
          .get(&rule.field_id)
          .map(|field_id| DatabaseSnapshotFilterRule {
            field_id: field_id.clone(),
            operator: rule.operator,
            value: rule.value.clone(),
          })
      })
      .collect()
  }

  fn import_filter_rules(rules: &[DatabaseSnapshotFilterRule], field_ids: &ImportFieldMap) -> Vec<DatabaseFilterRule> {
    rules
      .iter()
      .filter_map(|rule| {
        field_ids.get(&rule.field_id).map(|field_id| DatabaseFilterRule {
          field_id: *field_id,
          operator: rule.operator,
          value: rule.value.clone(),
        })
      })
      .collect()
  }

  fn snapshot_filter_group(
    group: Option<&DatabaseFilterGroup>,
    field_local_ids: &FieldLocalMap,
  ) -> Option<DatabaseSnapshotFilterGroup> {
    group.map(|group| DatabaseSnapshotFilterGroup {
      conjunction: group.conjunction,
      rules: Self::snapshot_filter_rules(&group.rules, field_local_ids),
      groups: group
        .groups
        .iter()
        .filter_map(|child| Self::snapshot_filter_group(Some(child), field_local_ids))
        .collect(),
    })
  }

  fn import_filter_group(
    group: Option<&DatabaseSnapshotFilterGroup>,
    field_ids: &ImportFieldMap,
  ) -> Option<DatabaseFilterGroup> {
    group.map(|group| DatabaseFilterGroup {
      conjunction: group.conjunction,
      rules: Self::import_filter_rules(&group.rules, field_ids),
      groups: group
        .groups
        .iter()
        .filter_map(|child| Self::import_filter_group(Some(child), field_ids))
        .collect(),
    })
  }

  fn validate_unique_snapshot_ids<'a>(
    path: &'static str,
    ids: impl Iterator<Item = &'a str>,
    errors: &mut Vec<DatabaseJsonDiagnostic>,
  ) {
    let mut seen = HashSet::new();
    for id in ids {
      if id.trim().is_empty() || !seen.insert(id.to_string()) {
        errors.push(Self::json_diag(
          ERR_JSON_INVALID,
          path,
          "Snapshot local IDs must be non-empty and unique",
        ));
        return;
      }
    }
  }

  pub(in crate::database) fn validate_snapshot_schema_version(
    schema_version: u32,
    errors: &mut Vec<DatabaseJsonDiagnostic>,
  ) {
    if schema_version == 0 || schema_version > DATABASE_SNAPSHOT_SCHEMA_VERSION {
      errors.push(Self::json_diag(
        ERR_JSON_UNSUPPORTED_VERSION,
        "$.schemaVersion",
        format!("Unsupported Database snapshot schema version {schema_version}"),
      ));
    }
  }

  fn task_relation_diagnostic_code(error: &DatabaseServiceError) -> Option<String> {
    error.task_relation_reason.map(|reason| {
      if error.task_relation_role == Some("task.blockedBy") {
        reason.blocked_by_diagnostic_code()
      } else {
        reason.diagnostic_code()
      }
    })
  }

  pub(super) fn json_diag(
    code: impl Into<String>,
    path: impl Into<String>,
    message: impl Into<String>,
  ) -> DatabaseJsonDiagnostic {
    DatabaseJsonDiagnostic {
      code: code.into(),
      source: "json".to_string(),
      path: Some(path.into()),
      message: message.into(),
    }
  }

  fn safe_filename(value: &str) -> String {
    let candidate = value
      .trim()
      .chars()
      .map(|ch| {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
          ch
        } else {
          '-'
        }
      })
      .collect::<String>()
      .trim_matches('-')
      .to_string();
    if candidate.is_empty() {
      "database".to_string()
    } else {
      candidate
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn transfer_tag_map_preserves_order_and_only_rewrites_typed_classifications() {
    let (a, b, c, target, other) = (
      Uuid::new_v4(),
      Uuid::new_v4(),
      Uuid::new_v4(),
      Uuid::new_v4(),
      Uuid::new_v4(),
    );
    let field = Uuid::new_v4().to_string();
    let cfg = serde_json::json!({
      "kind":"table", "titleFieldId":"title",
      "filter":[{"fieldId":field,"operator":"contains","value":{"kind":"option_id","value":a}},
        {"fieldId":"title","operator":"contains","value":{"kind":"text","value":a.to_string()}}],
      "filterTree":{"conjunction":"or","rules":[],"groups":[{"conjunction":"and","rules":[
        {"fieldId":field,"operator":"contains_all","value":{"kind":"ids","value":[b,a,b]}}
      ],"groups":[]}]}
    });
    let manifest = [a,b,c].into_iter().enumerate().map(|(index,id)|serde_json::json!({"id":id,"name":if index==2 { "Other label" } else { "Label" },"slug":id.to_string(),"colorRole":"tag.blue"})).collect::<Vec<_>>();
    let mut snapshot: DatabaseSnapshot = serde_json::from_value(serde_json::json!({
      "schemaVersion":DATABASE_SNAPSHOT_SCHEMA_VERSION,"exportedAt":Utc::now(),
      "source":{"product":"myoxus","format":"database-json"},
      "database":{"id":"db","title":"Classifications","fields":[
        {"id":field,"name":"Tags","fieldType":"tags","config":DatabaseFieldConfig::Tags(Default::default()),"position":0,"required":false,"readOnly":false},
        {"id":"title","name":"Title","fieldType":"title","config":DatabaseFieldConfig::Title,"position":1,"required":false,"readOnly":false}
      ],"views":[{"id":"view","name":"Saved predicates","viewKind":"table","position":0,"config":cfg}],
      "rows":[{"id":"row","title":"Data","position":0,"cells":[
        {"fieldId":field,"fieldType":"tags","value":{"kind":"domain","value":{"kind":"tags","value":[b,a,b,c]}}}
      ]}],"rowTemplates":[{"id":"template","templateId":Uuid::new_v4(),"name":"Defaults","position":0,"enabled":true,"isDefault":false,
        "initialCellValues":{field.clone():{"kind":"domain","value":{"kind":"tags","value":[c,a,b]}}}}]},
      "workspaceTagsManifest":manifest
    })).unwrap();
    let mut native = cfg.clone();
    let title = Uuid::new_v4();
    native["titleFieldId"] = serde_json::json!(title);
    native["filter"][1]["fieldId"] = serde_json::json!(title);
    let native: DatabaseViewConfig = serde_json::from_value(native).unwrap();
    assert_eq!(
      workspace_content_view_tag_ids(&native, &HashSet::from([Uuid::parse_str(&field).unwrap()])).unwrap(),
      vec![a, b]
    );
    DatabaseImportExportService::rewrite_snapshot_workspace_tag_ids(
      &mut snapshot,
      &HashMap::from([(a, target), (b, target), (c, other)]),
    );
    let value = serde_json::to_value(snapshot).unwrap();
    assert_eq!(
      value.pointer("/database/rows/0/cells/0/value/value/value").unwrap(),
      &serde_json::json!([target, other])
    );
    assert_eq!(
      value["database"]["rowTemplates"][0]["initialCellValues"][&field]["value"]["value"],
      serde_json::json!([other, target])
    );
    assert_eq!(
      value["workspaceTagsManifest"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].clone())
        .collect::<Vec<_>>(),
      vec![serde_json::json!(target), serde_json::json!(other)]
    );
    let view = &value["database"]["views"][0]["config"];
    assert_eq!(view["filter"][0]["value"]["value"], serde_json::json!(target));
    assert_eq!(
      view["filter"][1]["value"]["value"],
      serde_json::json!(a.to_string()),
      "literal UUIDs in text are not Tag operands"
    );
    let nested = &view["filterTree"]["groups"][0]["rules"][0];
    assert_eq!(nested["operator"], "contains_all");
    assert_eq!(nested["value"]["value"], serde_json::json!([target]));
    assert_eq!(view["filterTree"]["conjunction"], "or");
  }

  #[test]
  fn json_snapshot_unknown_major_schema_version_is_rejected() {
    let mut errors = Vec::new();

    DatabaseImportExportService::validate_snapshot_schema_version(DATABASE_SNAPSHOT_SCHEMA_VERSION + 1, &mut errors);

    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].code, ERR_JSON_UNSUPPORTED_VERSION);
    assert_eq!(errors[0].path.as_deref(), Some("$.schemaVersion"));
  }
}
