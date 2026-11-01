// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::database::access;
use crate::database::{DatabaseImportExportService, DatabaseResult, DatabaseServiceError, ERR_JSON_INVALID};
use myoxus_domain::database::*;
use myoxus_domain::ids::*;
use myoxus_domain::repositories::PageRequest;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use uuid::Uuid;

const WORKSPACE_CONTENT_STAGING_EXPORTED_AT: &str = "1970-01-01T00:00:00Z";
pub(super) fn workspace_content_import_id(
  planned: Option<&HashMap<String, Uuid>>,
  key: &str,
  kind: &str,
) -> DatabaseResult<Uuid> {
  match planned {
    Some(planned) => planned.get(key).copied().ok_or_else(|| {
      DatabaseServiceError::new(
        ERR_JSON_INVALID,
        format!("workspace content Database {kind} identity is missing"),
      )
    }),
    None => Ok(Uuid::new_v4()),
  }
}
impl DatabaseImportExportService {
  /// Target reuse uses the ordinary readable Database inventory, which excludes
  /// the protected default container; source transfer inventory is separate.
  pub(crate) async fn workspace_content_target_catalog(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
  ) -> DatabaseResult<Vec<(DatabaseSummary, Value)>> {
    let mut result = Vec::new();
    let mut offset = 0;
    loop {
      let page = self
        .views
        .list_databases(
          actor,
          workspace_id,
          PageRequest { limit: 100, offset },
          DatabaseInventoryFilter::default(),
        )
        .await?;
      if page.is_empty() {
        break;
      }
      let page_len = page.len() as i64;
      for summary in page {
        let schema = self.workspace_content_schema(actor, summary.id).await?;
        result.push((summary, schema));
      }
      offset += page_len;
      if page_len < 100 {
        break;
      }
    }
    Ok(result)
  }

  /// Export the canonical Database snapshot plus server-only live identities
  /// needed by a cross-workspace publication.
  ///
  /// The normal JSON export intentionally replaces live IDs with portable
  /// local IDs. XWS staging must retain a typed, permission-checked mapping so
  /// Fields, Views, Rows, assets, and cross-Database Relations can receive
  /// deterministic target identities without rediscovering them from display
  /// text or silently dropping an external relation.
  pub async fn export_workspace_content_snapshot(
    &self,
    actor: UserId,
    database_id: DatabaseId,
  ) -> DatabaseResult<Value> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let rows = self.snapshot_rows(actor, database_id).await?;
    let row_templates = self.row_repo.list_row_templates(database_id).await?;
    let mut files = Self::collect_files_manifest(&record, &rows);
    files.sort_by(|left, right| left.blob_key.cmp(&right.blob_key));
    if rows.iter().any(|row| row.redacted) {
      return Err(DatabaseServiceError::new(
        crate::database::ERR_FORBIDDEN,
        "workspace content row is not readable",
      ));
    }
    let mut snapshot = self.export_snapshot_with_mode(actor, database_id, true).await?;
    // Internal transfer snapshots carry canonical typed cells. Public JSON
    // portability/redaction and its readonly DocumentLink policy remain separate.
    let field_locals = record
      .fields
      .iter()
      .enumerate()
      .map(|(index, field)| (field.id, format!("field_{index}")))
      .collect::<HashMap<_, _>>();
    for (portable, live) in snapshot.database.fields.iter_mut().zip(&record.fields) {
      if matches!(
        live.config,
        DatabaseFieldConfig::Relation(_) | DatabaseFieldConfig::Rollup(_)
      ) {
        portable.config = DatabaseSnapshotFieldConfig::Domain(live.config.clone());
      }
    }
    for (portable, live) in snapshot.database.rows.iter_mut().zip(&rows) {
      portable.cells = live
        .cells
        .iter()
        .filter(|cell| {
          !Self::snapshot_cell_is_projection(cell.field_type) || cell.field_type == DatabaseFieldType::DocumentLink
        })
        .map(|cell| DatabaseSnapshotCellValue {
          field_id: field_locals[&cell.field_id].clone(),
          field_type: cell.field_type,
          value: DatabaseSnapshotCellValueData::Domain(cell.value.clone()),
        })
        .collect();
    }
    for (portable, live) in snapshot.database.row_templates.iter_mut().zip(&row_templates) {
      portable.initial_cell_values = live
        .initial_cell_values
        .iter()
        .map(|(field, value)| {
          (
            field_locals[field].clone(),
            DatabaseSnapshotCellValueData::Domain(value.clone()),
          )
        })
        .collect();
      for value in live.initial_cell_values.values() {
        if let DatabaseCellValueData::Files(value) = value {
          for file in &value.files {
            if !files.iter().any(|entry| entry.blob_key == file.blob_key) {
              files.push(DatabaseSnapshotFileManifestEntry {
                blob_key: file.blob_key.clone(),
                name: file.name.clone(),
                mime: file.mime.clone(),
                size: file.size,
                field_name: None,
                row_id: None,
              });
            }
          }
        }
      }
    }
    files.sort_by(|left, right| left.blob_key.cmp(&right.blob_key));
    snapshot.files_manifest = files.clone();
    let fields = record
      .fields
      .iter()
      .enumerate()
      .map(|(index, field)| (format!("field_{index}"), field.id.to_string()))
      .collect::<BTreeMap<_, _>>();
    let views = record
      .views
      .iter()
      .enumerate()
      .map(|(index, view)| (format!("view_{index}"), view.id.to_string()))
      .collect::<BTreeMap<_, _>>();
    let row_ids = rows
      .iter()
      .enumerate()
      .map(|(index, row)| (format!("row_{index}"), row.row.id.to_string()))
      .collect::<BTreeMap<_, _>>();
    let row_content_documents = rows
      .iter()
      .enumerate()
      .filter_map(|(index, row)| {
        row
          .row
          .content_document_id
          .map(|document_id| (format!("row-content-{index}"), document_id.to_string()))
      })
      .collect::<BTreeMap<_, _>>();
    let mut template_content_documents = BTreeMap::new();
    for (index, template) in row_templates.iter().enumerate() {
      let document_id = if let Some(id) = template.content_document_id {
        Some(id)
      } else {
        match self.template_registry.as_ref() {
          Some(registry) => registry
            .find_workspace_instance_for_binding(record.database.workspace_id, template.template_id)
            .await
            .map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error.to_string()))?
            .and_then(|instance| instance.workspace_doc_id),
          None => None,
        }
      };
      if let Some(id) = document_id {
        template_content_documents.insert(format!("row-template-content-{index}"), id.to_string());
      }
    }
    let assets = files
      .iter()
      .enumerate()
      .map(|(index, file)| (format!("asset_{index}"), file.blob_key.clone()))
      .collect::<BTreeMap<_, _>>();
    let relation_fields = record
      .fields
      .iter()
      .filter_map(|field| {
        let DatabaseFieldConfig::Relation(config) = &field.config else {
          return None;
        };
        Some(serde_json::json!({
          "fieldId": field.id,
          "targetDatabaseId": config.target_database_id,
          "reciprocalFieldId": config.reciprocal_field_id,
        }))
      })
      .collect::<Vec<_>>();
    let relation_cells = rows
      .iter()
      .flat_map(|row| {
        row.cells.iter().filter_map(move |cell| {
          let DatabaseCellValueData::Relation(target_row_ids) = &cell.value else {
            return None;
          };
          Some(serde_json::json!({
            "rowId": row.row.id,
            "fieldId": cell.field_id,
            "targetRowIds": target_row_ids,
          }))
        })
      })
      .collect::<Vec<_>>();
    let row_template_ids = row_templates
      .iter()
      .map(|template| template.id.to_string())
      .collect::<Vec<_>>();
    snapshot.databases = vec![snapshot.database.clone()];
    let mut payload =
      serde_json::to_value(snapshot).map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error.to_string()))?;
    let payload_object = payload
      .as_object_mut()
      .expect("DatabaseSnapshot serializes as an object");
    // XWS retries must reproduce byte-identical staging data. The user-facing
    // JSON export keeps its real timestamp; only this server-internal
    // publication projection replaces the volatile export instant.
    payload_object.insert(
      "exportedAt".to_string(),
      Value::String(WORKSPACE_CONTENT_STAGING_EXPORTED_AT.to_string()),
    );
    payload_object.insert(
      "workspaceContentIdentityManifest".to_string(),
      serde_json::json!({
        "databaseId": record.database.id,
        "fields": fields,
        "views": views,
        "rows": row_ids,
        "rowTemplates": row_template_ids,
        "rowContentDocuments": row_content_documents,
        "templateContentDocuments": template_content_documents,
        "assets": assets,
        "relationFields": relation_fields,
        "relationCells": relation_cells,
      }),
    );
    Ok(payload)
  }

  /// Return the normalized, content-free schema used for XWS reuse.
  ///
  /// Live UUIDs and timestamps are replaced with portable local identities, so
  /// independently created but structurally equal Databases compare equal
  /// without exporting their Rows.
  pub async fn workspace_content_schema(&self, actor: UserId, database_id: DatabaseId) -> DatabaseResult<Value> {
    let record = access::get_database(&self.permission, &self.schema_repo, actor, database_id).await?;
    let database_local_id = "database_0".to_string();
    let field_local_ids = record
      .fields
      .iter()
      .enumerate()
      .map(|(index, field)| (field.id, format!("field_{index}")))
      .collect::<HashMap<DatabaseFieldId, String>>();
    let view_local_ids = record
      .views
      .iter()
      .enumerate()
      .map(|(index, view)| (view.id, format!("view_{index}")))
      .collect::<HashMap<DatabaseViewId, String>>();
    Ok(serde_json::json!({
      "profileKind": record.database.profile_kind,
      "profileStructurePreset": record.database.profile_structure_preset,
      "profileConfig": record.database.profile_config,
      "managedSchema": record.database.managed_installation.as_ref().map(|installed| serde_json::json!({
        "templateId":installed.template_id,"templateVersion":installed.template_version,"templateDigest":installed.template_digest,
        "variant":installed.variant,"schemaRevision":installed.schema_revision,
      })),
      "fields": record.fields.iter()
        .filter_map(|field| self.snapshot_field(field, &database_local_id, &field_local_ids))
        .collect::<Vec<_>>(),
      "views": record.views.iter()
        .filter_map(|view| self.snapshot_view(view, &field_local_ids, &view_local_ids))
        .collect::<Vec<_>>(),
      "fieldRoles": record.field_roles.iter().filter_map(|role| {
        Some(DatabaseSnapshotFieldRole {
          profile_kind: role.profile_kind,
          role_key: role.role_key.clone(),
          row_kind_scope: role.row_kind_scope.clone(),
          field_id: field_local_ids.get(&role.field_id)?.clone(),
          required: role.required,
          config: role.config.clone(),
        })
      }).collect::<Vec<_>>(),
      "viewRoles": record.view_roles.iter().filter_map(|role| {
        Some(DatabaseSnapshotViewRole {
          profile_kind: role.profile_kind,
          role_key: role.role_key.clone(),
          view_id: view_local_ids.get(&role.view_id)?.clone(),
          required: role.required,
        })
      }).collect::<Vec<_>>(),
    }))
  }

  /// Convert a verified XWS snapshot into the canonical repository bundle
  /// using only identities fixed by the operation manifest.
  pub fn prepare_workspace_content_publication(
    &self,
    actor: UserId,
    workspace_id: WorkspaceId,
    payload: &Value,
    identity: &WorkspaceContentDatabaseIdentityPlan,
    workspace_tag_ids: &HashMap<Uuid, Uuid>,
  ) -> DatabaseResult<WorkspaceContentDatabasePublicationBundle> {
    let mut snapshot: DatabaseSnapshot = serde_json::from_value(payload.clone())
      .map_err(|error| DatabaseServiceError::new(ERR_JSON_INVALID, error.to_string()))?;
    if snapshot.diagnostics.iter().any(|diagnostic| {
      matches!(
        diagnostic.code.as_str(),
        "MIX_DATABASE_JSON_PARENT_TARGET_OMITTED" | "MIX_DATABASE_JSON_BLOCKER_TARGET_OMITTED"
      )
    }) {
      return Err(DatabaseTaskRelationReason::UnavailableTarget.into());
    }
    let mut origin_errors = Vec::new();
    Self::validate_snapshot_row_origins(&snapshot, &mut origin_errors);
    if let Some(reason) = origin_errors
      .iter()
      .find_map(|error| DatabaseTaskRelationReason::from_diagnostic_code(&error.code))
    {
      return Err(reason.into());
    }
    if !origin_errors.is_empty() {
      return Err(DatabaseServiceError::new(
        ERR_JSON_INVALID,
        "invalid Task/source snapshot contract",
      ));
    }
    if snapshot
      .workspace_tags_manifest
      .iter()
      .any(|tag| !workspace_tag_ids.contains_key(&tag.id))
    {
      return Err(DatabaseServiceError::new(
        ERR_JSON_INVALID,
        "workspace content Tag mapping is incomplete",
      ));
    }
    Self::rewrite_snapshot_workspace_tag_ids(&mut snapshot, workspace_tag_ids);
    Self::rewrite_workspace_content_snapshot(&mut snapshot, identity, workspace_id)?;
    let mut warnings = Vec::new();
    let bundle =
      self.build_import_bundle_with_identity(actor, workspace_id, &snapshot, &mut warnings, Some(identity))?;
    if !warnings.is_empty() {
      return Err(DatabaseServiceError::new(
        ERR_JSON_INVALID,
        "workspace content Database publication produced fidelity warnings",
      ));
    }
    Ok(WorkspaceContentDatabasePublicationBundle {
      database: bundle.database,
      fields: bundle.fields,
      views: bundle.views,
      field_roles: bundle.field_roles,
      view_roles: bundle.view_roles,
      rows: bundle.rows,
      row_templates: bundle.row_templates,
      row_sources: bundle.row_sources,
    })
  }

  /// Apply operation-admitted, kind-specific addresses; ordinary JSON import
  /// cannot opt into this path. Labels, operators and unrelated JSON are inert.
  fn rewrite_workspace_content_snapshot(
    snapshot: &mut DatabaseSnapshot,
    identity: &WorkspaceContentDatabaseIdentityPlan,
    target_workspace: WorkspaceId,
  ) -> DatabaseResult<()> {
    let required_uuid = |family: &str, source: Uuid| -> DatabaseResult<Uuid> {
      identity
        .nested_ids
        .get(&(family.to_string(), source))
        .copied()
        .ok_or_else(|| {
          DatabaseServiceError::new(ERR_JSON_INVALID, format!("workspace content {family} mapping missing"))
        })
    };
    for row in &mut snapshot.database.rows {
      if let Some(source) = &mut row.source
        && source.source_workspace_id == identity.source_workspace_id
        && let (Some(document_id), Some(external_id)) = (
          identity.document_ids.get(&source.document_id),
          identity.document_external_ids.get(&source.document_id),
        )
        && source.external_id.as_deref() == Some(external_id.0.as_str())
      {
        source.source_workspace_id = target_workspace;
        source.document_id = *document_id;
        source.external_id = Some(external_id.1.clone());
        // Native copy preserves block IDs and native selection coordinates.
      }
    }
    for field in &mut snapshot.database.fields {
      match &mut field.config {
        DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Relation(config)) => {
          config.target_database_id = *identity
            .database_ids
            .get(&config.target_database_id)
            .ok_or_else(|| DatabaseServiceError::new(ERR_JSON_INVALID, "relation target outside selection"))?;
          config.reciprocal_field_id = config
            .reciprocal_field_id
            .map(|id| required_uuid("fields", id))
            .transpose()?;
        }
        DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Rollup(config)) => {
          config.source_relation_field_id = required_uuid("fields", config.source_relation_field_id)?;
          config.target_field_id = required_uuid("fields", config.target_field_id)?;
        }
        _ => {}
      }
    }
    let rewrite = |value: &mut DatabaseSnapshotCellValueData| -> DatabaseResult<()> {
      let DatabaseSnapshotCellValueData::Domain(value) = value else {
        return Ok(());
      };
      rewrite_workspace_content_value(
        value,
        identity.source_workspace_id,
        target_workspace,
        &identity.document_ids,
        &identity.blob_keys,
      )
      .map_err(|error| {
        DatabaseServiceError::new(
          ERR_JSON_INVALID,
          match error {
            DatabaseDomainError::Validation(message) => message,
            error => error.to_string(),
          },
        )
      })?;
      match value {
        DatabaseCellValueData::Relation(rows) => {
          for row in rows {
            *row = required_uuid("rows", *row)?;
          }
        }
        _ => {}
      }
      Ok(())
    };
    for row in &mut snapshot.database.rows {
      for cell in &mut row.cells {
        rewrite(&mut cell.value)?;
      }
    }
    for template in &mut snapshot.database.row_templates {
      for value in template.initial_cell_values.values_mut() {
        rewrite(value)?;
      }
    }
    let kinds = snapshot
      .database
      .fields
      .iter()
      .map(|field| (field.id.clone(), field.field_type))
      .collect::<HashMap<_, _>>();
    Self::rewrite_snapshot_filter_ids(snapshot, |field, id| {
      let replacement = match kinds.get(field) {
        Some(DatabaseFieldType::Files) => identity.blob_keys.get(id).cloned(),
        Some(DatabaseFieldType::Relation) => Uuid::parse_str(id)
          .ok()
          .and_then(|uuid| identity.nested_ids.get(&("rows".into(), uuid)).map(Uuid::to_string)),
        Some(DatabaseFieldType::DocumentLink) => Uuid::parse_str(id)
          .ok()
          .and_then(|uuid| identity.document_ids.get(&uuid).map(Uuid::to_string)),
        _ => None,
      };
      if let Some(replacement) = replacement {
        *id = replacement;
      }
    });
    Ok(())
  }
}

#[derive(Debug, Clone)]
pub struct WorkspaceContentDatabaseIdentityPlan {
  pub source_workspace_id: WorkspaceId,
  pub database_ids: HashMap<DatabaseId, DatabaseId>,
  pub nested_ids: HashMap<(String, Uuid), Uuid>,
  pub document_ids: HashMap<DocId, DocId>,
  pub document_external_ids: HashMap<DocId, (String, String)>,
  pub blob_keys: HashMap<String, String>,
  pub database_id: DatabaseId,
  pub fallback_view_id: DatabaseViewId,
  pub field_ids: HashMap<String, DatabaseFieldId>,
  pub view_ids: HashMap<String, DatabaseViewId>,
  pub row_ids: HashMap<String, DatabaseRowId>,
  pub row_template_ids: HashMap<String, Uuid>,
  pub content_document_ids: HashMap<String, DocId>,
}
#[derive(Debug, Clone)]
pub struct WorkspaceContentDatabasePublicationBundle {
  pub database: Database,
  pub fields: Vec<DatabaseField>,
  pub views: Vec<DatabaseView>,
  pub field_roles: Vec<DatabaseFieldRole>,
  pub view_roles: Vec<DatabaseViewRole>,
  pub rows: Vec<DatabaseRowRecord>,
  pub row_templates: Vec<DatabaseRowTemplate>,
  pub row_sources: Vec<(DatabaseRowId, DatabaseTaskSource)>,
}
#[cfg(test)]
mod tests {
  use super::*;
  use chrono::Utc;

  #[test]
  fn transfer_document_links_use_sql_identity_and_only_typed_filter_operands() {
    let source_workspace = Uuid::new_v4();
    let target_workspace = Uuid::new_v4();
    let foreign_workspace = Uuid::new_v4();
    let source_doc = Uuid::new_v4();
    let target_doc = Uuid::new_v4();
    let outgoing_doc = Uuid::new_v4();
    let mut snapshot: DatabaseSnapshot = serde_json::from_value(serde_json::json!({
      "schemaVersion": DATABASE_SNAPSHOT_SCHEMA_VERSION, "exportedAt": Utc::now(),
      "source": {"product": "myoxus", "format": "database-json"},
      "database": {"id": "db", "title": source_doc.to_string(),
        "fields": [{"id":"link", "name":"Document", "fieldType":"document_link",
          "config":DatabaseFieldConfig::DocumentLink, "position":0, "required":false, "readOnly":true}],
        "views": [{"id":"view", "name":source_doc.to_string(), "viewKind":"table", "position":0,
          "config":{"kind":"table", "titleFieldId":"title",
            "filter":[{"fieldId":"link", "operator":"contains", "value":{"kind":"option_id", "value":source_doc}}],
            "filterTree":{"conjunction":"and", "groups":[], "rules":[
              {"fieldId":"link", "operator":"contains_all", "value":{"kind":"ids", "value":[source_doc, outgoing_doc]}},
              {"fieldId":"title", "operator":"contains", "value":{"kind":"text", "value":source_doc.to_string()}}
            ]}}}],
        "rows": [
          {"id":"selected", "title":source_doc.to_string(), "position":0,
            "cells":[{"fieldId":"link", "fieldType":"document_link", "value":{"kind":"domain", "value":{"kind":"document_link", "value":{"docId":source_doc}}}}]},
          {"id":"outgoing", "title":"Outgoing", "position":1,
            "cells":[{"fieldId":"link", "fieldType":"document_link", "value":{"kind":"domain", "value":{"kind":"document_link", "value":{"docId":outgoing_doc}}}}]},
          {"id":"foreign", "title":"Foreign", "position":2,
            "cells":[{"fieldId":"link", "fieldType":"document_link", "value":{"kind":"domain", "value":{"kind":"document_link", "value":{"docId":source_doc, "workspaceId":foreign_workspace}}}}]}
        ], "rowTemplates":[]}
    })).unwrap();
    let identity = WorkspaceContentDatabaseIdentityPlan {
      source_workspace_id: source_workspace,
      database_ids: HashMap::new(),
      nested_ids: HashMap::new(),
      document_external_ids: HashMap::new(),
      document_ids: HashMap::from([(source_doc, target_doc)]),
      blob_keys: HashMap::new(),
      database_id: Uuid::new_v4(),
      fallback_view_id: Uuid::new_v4(),
      field_ids: HashMap::new(),
      view_ids: HashMap::new(),
      row_ids: HashMap::new(),
      row_template_ids: HashMap::new(),
      content_document_ids: HashMap::new(),
    };
    DatabaseImportExportService::rewrite_workspace_content_snapshot(&mut snapshot, &identity, target_workspace)
      .unwrap();
    let value = serde_json::to_value(snapshot).unwrap();
    let rows = &value["database"]["rows"];
    assert_eq!(
      rows[0]["cells"][0]["value"]["value"]["value"],
      serde_json::json!({"docId":target_doc,"workspaceId":target_workspace})
    );
    assert_eq!(
      rows[1]["cells"][0]["value"]["value"]["value"],
      serde_json::json!({"docId":outgoing_doc,"workspaceId":source_workspace})
    );
    assert_eq!(
      rows[2]["cells"][0]["value"]["value"]["value"],
      serde_json::json!({"docId":source_doc,"workspaceId":foreign_workspace})
    );
    assert_eq!(rows[0]["title"], source_doc.to_string());
    assert_eq!(value["database"]["title"], source_doc.to_string());
    let view = &value["database"]["views"][0];
    assert_eq!(view["name"], source_doc.to_string());
    assert_eq!(view["config"]["filter"][0]["value"]["value"], target_doc.to_string());
    assert_eq!(
      view["config"]["filterTree"]["rules"][0]["value"]["value"],
      serde_json::json!([target_doc, outgoing_doc])
    );
    assert_eq!(
      view["config"]["filterTree"]["rules"][1]["value"]["value"],
      source_doc.to_string()
    );
  }
}
