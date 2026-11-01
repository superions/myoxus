// SPDX-License-Identifier: AGPL-3.0-or-later
//! Database publication effects retain their caller's cross-resource transaction.
use super::*;
use crate::workspace_content_operation::{
  MOVE_DATABASE_OWNERSHIP_TABLES, PgWorkspaceContentOperationRepository, move_conflict, publication_database_error,
  publication_failure,
};
use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::database::WorkspaceContentDatabasePublicationBundle;
use myoxus_domain::workspace_content_operation::WorkspaceContentErrorCode;

impl PgDatabaseRepository {
  pub(crate) async fn publish_workspace_content_database_identity(
    tx: &mut Transaction<'_, Postgres>,
    source_workspace_id: Uuid,
    source_database_id: Option<Uuid>,
    bundle: &WorkspaceContentDatabasePublicationBundle,
  ) -> AuthResult<()> {
    let mut database = bundle.database.clone();
    if let Some(target) = database.managed_installation.as_mut() {
      // Portable snapshots do not author revisions. The verified native
      // source, locked through publication, supplies this trusted fact.
      let source_id =
        source_database_id.ok_or_else(|| AuthError::InvalidInput("managed copy source unavailable".into()))?;
      let source: Option<serde_json::Value> = sqlx::query_scalar("SELECT managed_installation FROM workspace_databases WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL FOR SHARE")
                .bind(source_id).bind(source_workspace_id).fetch_one(&mut **tx).await.map_err(PgWorkspaceContentOperationRepository::storage)?;
      let source: myoxus_domain::database::DatabaseManagedSchemaInstallation = serde_json::from_value(
        source.ok_or_else(|| AuthError::InvalidInput("managed copy source unavailable".into()))?,
      )
      .map_err(|_| AuthError::InvalidInput("managed copy source invalid".into()))?;
      if source.template_id != target.template_id
        || source.template_version != target.template_version
        || source.template_digest != target.template_digest
        || source.variant != target.variant
        || source.readiness != myoxus_domain::database::DatabaseManagedSchemaReadiness::Ready
      {
        return Err(AuthError::InvalidInput("managed copy source changed".into()));
      }
      target.schema_revision = source.schema_revision;
    }
    database.system_role = None;
    // Publish every schema and Row identity before the content pass:
    // cross-Database references may target a later object in this batch.
    PgDatabaseRepository::insert_database_bundle(
      tx,
      database,
      bundle.fields.clone(),
      bundle.views.clone(),
      bundle.field_roles.clone(),
      bundle.view_roles.clone(),
    )
    .await
    .map_err(publication_database_error)?;
    PgDatabaseRepository::insert_snapshot_rows(tx, bundle.database.id, &bundle.rows, None)
      .await
      .map_err(publication_database_error)?;
    Ok(())
  }
  pub(crate) async fn publish_workspace_content_database_contents(
    tx: &mut Transaction<'_, Postgres>,
    target_workspace_id: Uuid,
    actor_id: Uuid,
    bundle: &WorkspaceContentDatabasePublicationBundle,
  ) -> AuthResult<()> {
    let mut rows = bundle.rows.clone();
    for row in &mut rows {
      if row
        .cells
        .iter()
        .any(|cell| cell.field_type == myoxus_domain::database::DatabaseFieldType::UniqueId)
      {
        return Err(AuthError::InvalidInput(
          WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into(),
        ));
      }
      // A copied Row owns a new native display identity. Source readonly
      // projections never seed the target counter or become editable data.
      row.cells.extend(
        PgDatabaseRepository::allocate_unique_id_cells(tx, bundle.database.id, row.row.id, actor_id)
          .await
          .map_err(publication_database_error)?,
      );
    }
    PgDatabaseRepository::insert_snapshot_cells_and_templates(
      tx,
      bundle.database.id,
      actor_id,
      &rows,
      &bundle.row_templates,
    )
    .await
    .map_err(publication_database_error)?;
    PgDatabaseRepository::insert_snapshot_sources(tx, bundle.database.id, &bundle.row_sources)
      .await
      .map_err(publication_database_error)?;
    Self::omit_broken_database_document_links(tx, target_workspace_id, bundle.database.id).await?;
    Ok(())
  }
  pub(crate) async fn move_workspace_content_database_owner(
    tx: &mut Transaction<'_, Postgres>,
    source_workspace_id: Uuid,
    target_workspace_id: Uuid,
    id: Uuid,
    parent_edit_revision: i64,
    ownership_row_counts: &BTreeMap<String, u64>,
  ) -> AuthResult<()> {
    let moved = sqlx::query(
      "UPDATE workspace_databases
           SET workspace_id = $2,
               edit_revision = edit_revision + 1,
               updated_at = now()
           WHERE workspace_id = $1 AND id = $3 AND deleted_at IS NULL
             AND edit_revision = $4",
    )
    .bind(source_workspace_id)
    .bind(target_workspace_id)
    .bind(id)
    .bind(parent_edit_revision)
    .execute(&mut **tx)
    .await
    .map_err(move_conflict)?
    .rows_affected();
    if moved != 1 {
      return Err(AuthError::NotFound(
        WorkspaceContentErrorCode::SourceDatabaseMissing.as_str().to_string(),
      ));
    }
    for table in MOVE_DATABASE_OWNERSHIP_TABLES {
      let updated = sqlx::query(&format!(
        "UPDATE {table} SET workspace_id = $2 WHERE workspace_id = $1 AND database_id = $3"
      ))
      .bind(source_workspace_id)
      .bind(target_workspace_id)
      .bind(id)
      .execute(&mut **tx)
      .await
      .map_err(move_conflict)?
      .rows_affected();
      if ownership_row_counts.get(*table).copied() != Some(updated) {
        return Err(publication_failure(
          WorkspaceContentErrorCode::MoveDatabaseChildOwnershipChanged,
        ));
      }
    }
    Ok(())
  }
  pub(crate) async fn publish_workspace_content_database_references(
    tx: &mut Transaction<'_, Postgres>,
    source_workspace_id: Uuid,
    target_workspace_id: Uuid,
    id: Uuid,
    source_documents: &[(Uuid, String, String)],
    documents: &HashMap<Uuid, Uuid>,
    blobs: &HashMap<String, String>,
  ) -> AuthResult<()> {
    for (document_id, source_external_id, target_external_id) in source_documents {
      sqlx::query("UPDATE database_row_source_links source SET source_workspace_id=$1, source_external_id=$2 FROM workspace_database_rows row WHERE source.row_id=row.id AND row.database_id=$3 AND source.source_workspace_id=$4 AND source.source_document_id=$5 AND source.source_external_id=$6")
        .bind(target_workspace_id).bind(target_external_id).bind(id)
        .bind(source_workspace_id).bind(document_id).bind(source_external_id)
        .execute(&mut **tx).await.map_err(move_conflict)?;
    }
    let fields = sqlx::query("SELECT id,field_type FROM workspace_database_fields WHERE database_id=$1 AND field_type IN ('files','document_link') ORDER BY id")
      .bind(id).fetch_all(&mut **tx).await.map_err(move_conflict)?;
    let mut file_fields = std::collections::HashSet::new();
    for field in fields {
      let field_id: Uuid = field.get("id");
      let kind = match field.get::<String, _>("field_type").as_str() {
        "files" => {
          file_fields.insert(field_id);
          DatabaseFieldType::Files
        }
        "document_link" => DatabaseFieldType::DocumentLink,
        _ => unreachable!("typed SQL selection"),
      };
      for cell in sqlx::query("SELECT row_id,value_json FROM workspace_database_cell_values WHERE database_id=$1 AND field_id=$2 AND value_json IS NOT NULL ORDER BY row_id FOR UPDATE")
        .bind(id).bind(field_id).fetch_all(&mut **tx).await.map_err(move_conflict)?
      {
        let original: serde_json::Value = cell.get("value_json");
        let mut value = PgDatabaseRepository::map_cell_value_from_json(kind, original.clone())
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into()))?;
        rewrite_workspace_content_value(&mut value, source_workspace_id, target_workspace_id, documents, blobs)
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::OwnedBlobMappingMissing.as_str().into()))?;
        let rewritten = PgDatabaseRepository::map_cell_value_to_json(&value)
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into()))?;
        if original != rewritten {
          sqlx::query("UPDATE workspace_database_cell_values SET value_json=$4,edit_revision=edit_revision+1,updated_at=now() WHERE database_id=$1 AND row_id=$2 AND field_id=$3")
            .bind(id).bind(cell.get::<Uuid,_>("row_id")).bind(field_id).bind(rewritten)
            .execute(&mut **tx).await.map_err(move_conflict)?;
        }
      }
      for template in sqlx::query("SELECT id, initial_cell_values_json -> $2::text AS value FROM workspace_database_row_templates WHERE database_id=$1 AND initial_cell_values_json ? $2::text ORDER BY id FOR UPDATE")
        .bind(id).bind(field_id.to_string()).fetch_all(&mut **tx).await.map_err(move_conflict)?
      {
        let original: serde_json::Value = template.get("value");
        if original.is_null() { continue; }
        let mut value = PgDatabaseRepository::map_cell_value_from_json(kind, original.clone())
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into()))?;
        rewrite_workspace_content_value(&mut value, source_workspace_id, target_workspace_id, documents, blobs)
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::OwnedBlobMappingMissing.as_str().into()))?;
        let rewritten = PgDatabaseRepository::map_cell_value_to_json(&value)
          .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into()))?;
        if original != rewritten {
          sqlx::query("UPDATE workspace_database_row_templates SET initial_cell_values_json=jsonb_set(initial_cell_values_json, ARRAY[$2::text], $3, false),edit_revision=edit_revision+1,updated_at=now() WHERE id=$1")
            .bind(template.get::<Uuid,_>("id")).bind(field_id.to_string()).bind(rewritten)
            .execute(&mut **tx).await.map_err(move_conflict)?;
        }
      }
    }
    for view in
      sqlx::query("SELECT id,config_json FROM workspace_database_views WHERE database_id=$1 ORDER BY id FOR UPDATE")
        .bind(id)
        .fetch_all(&mut **tx)
        .await
        .map_err(move_conflict)?
    {
      let original: serde_json::Value = view.get("config_json");
      let mut config: DatabaseViewConfig = serde_json::from_value(original.clone())
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into()))?;
      rewrite_workspace_content_view_blobs(&mut config, &file_fields, blobs);
      let rewritten = serde_json::to_value(config)
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::EncodingFailed.as_str().into()))?;
      if original != rewritten {
        sqlx::query("UPDATE workspace_database_views SET config_json=$2,edit_revision=edit_revision+1,updated_at=now() WHERE id=$1")
          .bind(view.get::<Uuid,_>("id")).bind(rewritten).execute(&mut **tx).await.map_err(move_conflict)?;
      }
    }
    Self::omit_broken_database_document_links(tx, target_workspace_id, id).await?;
    for row_id in sqlx::query_scalar::<_, Uuid>(
      "SELECT id FROM workspace_database_rows WHERE database_id=$1 AND deleted_at IS NULL ORDER BY id",
    )
    .bind(id)
    .fetch_all(&mut **tx)
    .await
    .map_err(move_conflict)?
    {
      PgDatabaseRepository::replace_document_references(tx, target_workspace_id, id, row_id)
        .await
        .map_err(|_| AuthError::Storage(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into()))?;
    }

    Ok(())
  }
  /// Database links carry SQL UUIDs. Only canonical absence/deletion clears a
  /// contained value; a live denied/unproved target remains for the guarded reader.
  async fn omit_broken_database_document_links(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
    database_id: Uuid,
  ) -> AuthResult<()> {
    use crate::workspace_database::PgDatabaseRepository;
    use myoxus_domain::database::{DatabaseCellValueData, DatabaseFieldType};
    let fields = sqlx::query_scalar::<_, Uuid>(
      "SELECT id FROM workspace_database_fields WHERE database_id=$1 AND field_type='document_link' ORDER BY id",
    )
    .bind(database_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(move_conflict)?;
    let mut changed_rows = BTreeSet::new();
    for field_id in fields {
      let cells = sqlx::query("SELECT row_id,value_json FROM workspace_database_cell_values WHERE database_id=$1 AND field_id=$2 AND value_json IS NOT NULL ORDER BY row_id FOR UPDATE")
      .bind(database_id).bind(field_id).fetch_all(&mut **tx).await.map_err(move_conflict)?;
      for cell in cells {
        let value =
          PgDatabaseRepository::map_cell_value_from_json(DatabaseFieldType::DocumentLink, cell.get("value_json"))
            .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into()))?;
        let DatabaseCellValueData::DocumentLink(link) = value else {
          continue;
        };
        let live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id=$1 AND deleted_at IS NULL)")
          .bind(link.doc_id)
          .fetch_one(&mut **tx)
          .await
          .map_err(move_conflict)?;
        if !live {
          let row_id: Uuid = cell.get("row_id");
          sqlx::query("UPDATE workspace_database_cell_values SET value_json=NULL,edit_revision=edit_revision+1,updated_at=now() WHERE database_id=$1 AND row_id=$2 AND field_id=$3")
          .bind(database_id).bind(row_id).bind(field_id).execute(&mut **tx).await.map_err(move_conflict)?;
          changed_rows.insert(row_id);
        }
      }
      for template in sqlx::query("SELECT id,initial_cell_values_json -> $2::text AS value FROM workspace_database_row_templates WHERE database_id=$1 AND initial_cell_values_json ? $2::text ORDER BY id FOR UPDATE")
      .bind(database_id).bind(field_id.to_string()).fetch_all(&mut **tx).await.map_err(move_conflict)? {
      let json: serde_json::Value = template.get("value");
      if json.is_null() { continue; }
      let value = PgDatabaseRepository::map_cell_value_from_json(DatabaseFieldType::DocumentLink,json)
        .map_err(|_| AuthError::InvalidInput(WorkspaceContentErrorCode::DatabaseSnapshotInvalid.as_str().into()))?;
      let DatabaseCellValueData::DocumentLink(link) = value else { continue };
      let live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM docs WHERE id=$1 AND deleted_at IS NULL)")
        .bind(link.doc_id).fetch_one(&mut **tx).await.map_err(move_conflict)?;
      if !live {
        sqlx::query("UPDATE workspace_database_row_templates SET initial_cell_values_json=initial_cell_values_json - $2::text,edit_revision=edit_revision+1,updated_at=now() WHERE id=$1")
          .bind(template.get::<Uuid,_>("id")).bind(field_id.to_string()).execute(&mut **tx).await.map_err(move_conflict)?;
      }
    }
    }
    for row_id in changed_rows {
      PgDatabaseRepository::replace_document_references(tx, workspace_id, database_id, row_id)
        .await
        .map_err(publication_database_error)?;
    }
    Ok(())
  }

  pub(crate) async fn publish_workspace_content_tag_cell(
    tx: &mut Transaction<'_, Postgres>,
    database_id: Uuid,
    row_id: Uuid,
    field_id: Uuid,
    target_ids: &[Uuid],
  ) -> AuthResult<()> {
    let changed = sqlx::query(
      "UPDATE workspace_database_cell_values SET value_json=$4, edit_revision=edit_revision+1,updated_at=now()
           WHERE database_id=$1 AND row_id=$2 AND field_id=$3",
    )
    .bind(database_id)
    .bind(row_id)
    .bind(field_id)
    .bind(serde_json::json!(target_ids))
    .execute(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .rows_affected();
    if changed != 1 {
      return Err(publication_failure(WorkspaceContentErrorCode::MovedTagCellDisappeared));
    }
    Ok(())
  }
  pub(crate) async fn publish_workspace_content_tag_template(
    tx: &mut Transaction<'_, Postgres>,
    workspace_id: Uuid,
    database_id: Uuid,
    template_id: Uuid,
    field_id: Uuid,
    target_ids: &[Uuid],
  ) -> AuthResult<()> {
    let changed = sqlx::query(
          "UPDATE workspace_database_row_templates
           SET initial_cell_values_json=jsonb_set(initial_cell_values_json,ARRAY[$4::text],$5,false), edit_revision=edit_revision+1, updated_at=now()
           WHERE workspace_id=$1 AND database_id=$2 AND id=$3",
        )
        .bind(workspace_id)
        .bind(database_id)
        .bind(template_id)
        .bind(field_id.to_string())
        .bind(serde_json::json!(target_ids))
        .execute(&mut **tx)
        .await
        .map_err(PgWorkspaceContentOperationRepository::storage)?
        .rows_affected();
    if changed != 1 {
      return Err(publication_failure(
        WorkspaceContentErrorCode::MovedTagTemplateDisappeared,
      ));
    }
    Ok(())
  }
  pub(crate) async fn workspace_content_view_for_update(
    tx: &mut Transaction<'_, Postgres>,
    database_id: Uuid,
    view_id: Uuid,
  ) -> AuthResult<Value> {
    let config = sqlx::query_scalar::<_, serde_json::Value>(
      "SELECT config_json FROM workspace_database_views WHERE database_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(database_id)
    .bind(view_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(PgWorkspaceContentOperationRepository::storage)?
    .ok_or_else(|| publication_failure(WorkspaceContentErrorCode::MovedTagFilterDisappeared))?;
    Ok(config)
  }
  pub(crate) async fn publish_workspace_content_view_tags(
    tx: &mut Transaction<'_, Postgres>,
    database_id: Uuid,
    view_id: Uuid,
    config: &Value,
  ) -> AuthResult<()> {
    sqlx::query("UPDATE workspace_database_views SET config_json=$3, edit_revision=edit_revision+1, updated_at=now() WHERE database_id=$1 AND id=$2")
      .bind(database_id).bind(view_id).bind(config).execute(&mut **tx).await
      .map_err(PgWorkspaceContentOperationRepository::storage)?;
    Ok(())
  }
  pub(crate) async fn workspace_content_row_ids(
    tx: &mut Transaction<'_, Postgres>,
    database_id: Uuid,
  ) -> AuthResult<Vec<Uuid>> {
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM workspace_database_rows WHERE database_id=$1")
      .bind(database_id)
      .fetch_all(&mut **tx)
      .await
      .map_err(move_conflict)
  }
}
