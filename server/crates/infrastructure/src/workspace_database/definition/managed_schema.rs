// SPDX-License-Identifier: AGPL-3.0-or-later

//! Locked managed-definition persistence; only this owner admits structural updates.
use super::*;
#[path = "select_updates.rs"]
mod select_updates;

impl PgDatabaseRepository {
  pub(crate) async fn ensure_workspace_tasks_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    catalog: &myoxus_application::database::DatabaseStarterTemplateCatalog,
    state: DatabaseInitialState,
  ) -> RepoResult<DatabaseId> {
    Self::capture_catalog_admission(tx, catalog).await?;
    if state.database.system_role != Some(DatabaseSystemRole::WorkspaceTasks) {
      return Err(RepositoryError::Validation(
        "canonical initializer requires Workspace Tasks state".into(),
      ));
    }
    sqlx::query("SELECT id FROM workspaces WHERE id=$1 AND deleted_at IS NULL FOR UPDATE")
      .bind(state.database.workspace_id)
      .fetch_optional(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?
      .ok_or(RepositoryError::NotFound("workspace"))?;
    if let Some(id) =
      sqlx::query_scalar("SELECT id FROM workspace_databases WHERE workspace_id=$1 AND system_role='workspace_tasks'")
        .bind(state.database.workspace_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(Self::map_sqlx_error)?
    {
      return Ok(id);
    }
    Ok(Self::insert_initial_state_in_tx(tx, state, None).await?.database.id)
  }

  pub(in crate::workspace_database) async fn commit_managed_schema_in_tx(
    &self,
    database_id: DatabaseId,
    expected_source: &DatabaseRecord,
    replacement: Option<DatabaseInitialState>,
    installation: DatabaseManagedSchemaInstallation,
  ) -> RepoResult<Vec<DatabaseRowId>> {
    let mut tx = self.pool.begin().await.map_err(Self::map_sqlx_error)?;
    let root = sqlx::query(
      "SELECT d.system_role,d.managed_installation,d.id,d.workspace_id,
      COALESCE(p.profile_kind,'generic') AS profile_kind,p.structure_preset AS profile_structure_preset,
      COALESCE(p.config_json,'{}'::jsonb) AS profile_config,d.title,d.description,d.created_by,d.updated_by,
      d.deleted_at,d.deleted_by,d.edit_revision,d.created_at,d.updated_at
      FROM workspace_databases d LEFT JOIN database_profiles p ON p.database_id=d.id
      WHERE d.id=$1 FOR UPDATE OF d",
    )
    .bind(database_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let database = Self::map_database(root)?;
    let current = database
      .managed_installation
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("managed schema is not installed".into()))?;
    let expected = expected_source
      .database
      .managed_installation
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("managed source fence missing".into()))?;
    // Readiness/reason are also projected locally by old nodes; fence only the
    // persisted identity, bindings and revision, plus the exact native structure.
    if database.id != expected_source.database.id
      || database.workspace_id != expected_source.database.workspace_id
      || database.system_role != expected_source.database.system_role
      || database.edit_revision != expected_source.database.edit_revision
      || database.deleted_at != expected_source.database.deleted_at
      || current.template_id != expected.template_id
      || current.template_version != expected.template_version
      || current.template_digest != expected.template_digest
      || current.variant != expected.variant
      || current.schema_revision != expected.schema_revision
      || current.field_bindings != expected.field_bindings
      || current.view_bindings != expected.view_bindings
      || database.profile_kind != expected_source.database.profile_kind
      || database.profile_structure_preset != expected_source.database.profile_structure_preset
      || database.profile_config != expected_source.database.profile_config
    {
      return Err(RepositoryError::Conflict("managed schema source fence"));
    }
    // Match normal root-before-definition locking. No Rows, templates or personal
    // state are read/reseeded for structural-only transitions.
    sqlx::query("SELECT id FROM workspace_database_fields WHERE database_id=$1 ORDER BY id FOR UPDATE")
      .bind(database_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    sqlx::query("SELECT id FROM workspace_database_views WHERE database_id=$1 ORDER BY id FOR UPDATE")
      .bind(database_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let fields = Self::list_fields_for(&mut *tx, database_id).await?;
    let views = Self::list_views_for(&mut *tx, database_id).await?;
    let roles = Self::list_field_roles_for(&mut *tx, database_id).await?;
    let view_roles = Self::list_view_roles_for(&mut *tx, database_id).await?;
    macro_rules! equal_source {
      ($actual:expr, $expected:expr) => {
        serde_json::to_value($actual).map_err(|error| RepositoryError::Validation(error.to_string()))?
          == serde_json::to_value($expected).map_err(|error| RepositoryError::Validation(error.to_string()))?
      };
    }
    if !equal_source!(&fields, &expected_source.fields)
      || !equal_source!(&views, &expected_source.views)
      || !equal_source!(&roles, &expected_source.field_roles)
      || !equal_source!(&view_roles, &expected_source.view_roles)
    {
      return Err(RepositoryError::Conflict("managed schema structure fence"));
    }
    if current.template_id != installation.template_id || current.variant != installation.variant {
      return Err(RepositoryError::Validation(
        "managed schema identity or variant cannot change".into(),
      ));
    }
    let locally_known = self
      .database_templates
      .version_source(&current.template_id, &current.template_version)
      .is_some_and(|(_, digest)| digest == current.template_digest);
    if !locally_known
      || self
        .database_templates
        .update_route(&current.template_id, &current.template_version)
        .is_none()
    {
      return Err(RepositoryError::Validation(
        "managed source unavailable on this node".into(),
      ));
    }
    if replacement.is_some() {
      let (edge, _) = self
        .database_templates
        .inventory()
        .update_from(&current.template_id, &current.template_version)
        .ok_or_else(|| RepositoryError::Validation("managed transition edge unavailable".into()))?;
      if edge.source.sha256 != current.template_digest
        || edge.target.version != installation.template_version
        || edge.target.sha256 != installation.template_digest
        || installation.schema_revision != current.schema_revision + 1
      {
        return Err(RepositoryError::Conflict("managed transition edge fence"));
      }
      let final_target = self
        .database_templates
        .current_source(&installation.template_id)
        .is_some_and(|(version, digest)| {
          version == installation.template_version && digest == installation.template_digest
        });
      if (installation.readiness == DatabaseManagedSchemaReadiness::Ready) != final_target {
        return Err(RepositoryError::Validation(
          "intermediate managed transition cannot be ready".into(),
        ));
      }
    } else if installation.template_version != current.template_version
      || installation.template_digest != current.template_digest
      || installation.schema_revision != current.schema_revision
      || installation.field_bindings != current.field_bindings
      || installation.view_bindings != current.view_bindings
    {
      return Err(RepositoryError::Validation(
        "readiness update cannot change managed source".into(),
      ));
    }
    sqlx::query("SELECT set_config('myoxus.managed_schema_write','on',true)")
      .execute(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    let mut affected_rows = std::collections::BTreeSet::new();
    if let Some(state) = replacement {
      if state.database.id != database_id
        || installation.schema_revision != current.schema_revision + 1
        || !state.rows.is_empty()
      {
        return Err(RepositoryError::Validation("invalid structural transition".into()));
      }
      let (edge, _) = self
        .database_templates
        .inventory()
        .update_from(&current.template_id, &current.template_version)
        .ok_or_else(|| RepositoryError::Validation("managed transition edge unavailable".into()))?;
      let selection = DatabaseTemplateSelection {
        priority: current.variant.priority,
        complexity: current.variant.complexity,
        structure: current.variant.structure,
      };
      let source_spec = self
        .database_templates
        .select_version(&current.template_id, &current.template_version, selection)
        .ok_or_else(|| RepositoryError::Validation("managed source variant unavailable".into()))?;
      let target_spec = self
        .database_templates
        .select_version(&current.template_id, &installation.template_version, selection)
        .ok_or_else(|| RepositoryError::Validation("managed target variant unavailable".into()))?;
      affected_rows.extend(
        Self::apply_select_updates_in_tx(
          &mut tx,
          expected_source,
          &state,
          source_spec,
          target_spec,
          &edge.operations,
        )
        .await?,
      );
      for field in state.fields {
        let config = Self::map_field_config_to_json(&field.config)?;
        if let Some(old) = fields.iter().find(|old| old.id == field.id) {
          if old.field_type != field.field_type || old.required != field.required {
            return Err(RepositoryError::Validation(
              "managed transition requires reviewed Field conversion".into(),
            ));
          }
          if old.name == field.name && old.config == field.config && old.position == field.position {
            continue;
          }
          let changed=sqlx::query("UPDATE workspace_database_fields SET name=$3,config_json=$4,position=$5,edit_revision=edit_revision+1,updated_at=now() WHERE id=$1 AND database_id=$2 AND ROW(name,config_json,position) IS DISTINCT FROM ROW($3,$4,$5)")
            .bind(field.id).bind(database_id).bind(field.name).bind(config).bind(field.position).execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
          if changed.rows_affected() != 1 {
            return Err(RepositoryError::Conflict("managed schema structure fence"));
          }
        } else {
          sqlx::query("INSERT INTO workspace_database_fields(id,database_id,name,field_type,config_json,position,required,edit_revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,now(),now())")
            .bind(field.id).bind(database_id).bind(field.name).bind(field.field_type.as_str()).bind(config).bind(field.position).bind(field.required)
            .execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
        }
      }
      for view in state.views {
        let icon = view
          .icon
          .as_ref()
          .map(serde_json::to_value)
          .transpose()
          .map_err(|error| RepositoryError::Validation(error.to_string()))?;
        let config =
          serde_json::to_value(&view.config).map_err(|error| RepositoryError::Validation(error.to_string()))?;
        if let Some(old) = views.iter().find(|old| old.id == view.id) {
          if old.name == view.name
            && old.view_kind == view.view_kind
            && old.icon == view.icon
            && old.config == view.config
            && old.position == view.position
          {
            continue;
          }
          let changed=sqlx::query("UPDATE workspace_database_views SET name=$3,view_kind=$4,icon_json=$5,config_json=$6,position=$7,edit_revision=edit_revision+1,updated_at=now() WHERE id=$1 AND database_id=$2 AND ROW(name,view_kind,icon_json,config_json,position) IS DISTINCT FROM ROW($3,$4,$5,$6,$7)")
            .bind(view.id).bind(database_id).bind(view.name).bind(view.view_kind.as_str()).bind(icon).bind(config).bind(view.position).execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
          if changed.rows_affected() != 1 {
            return Err(RepositoryError::Conflict("managed schema structure fence"));
          }
        } else {
          sqlx::query("INSERT INTO workspace_database_views(id,database_id,name,view_kind,icon_json,config_json,position,edit_revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,1,now(),now())")
            .bind(view.id).bind(database_id).bind(view.name).bind(view.view_kind.as_str()).bind(icon).bind(config).bind(view.position).execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
        }
      }
      if roles.iter().any(|old| {
        !state
          .roles
          .iter()
          .any(|role| role.role_key == old.role_key && role.row_kind_scope == old.row_kind_scope)
      }) {
        return Err(RepositoryError::Validation(
          "managed update cannot remove native role".into(),
        ));
      }
      for role in state.roles {
        if let Some(old) = roles
          .iter()
          .find(|old| old.role_key == role.role_key && old.row_kind_scope == role.row_kind_scope)
        {
          if old.field_id != role.field_id || old.required != role.required || old.config != role.config {
            return Err(RepositoryError::Validation(
              "managed update cannot change native role policy".into(),
            ));
          }
          continue;
        }
        sqlx::query("INSERT INTO database_field_roles(database_id,profile_kind,role_key,row_kind_scope,field_id,required,config_json,created_at,updated_at) VALUES($1,'project',$2,$3,$4,$5,$6,now(),now())")
          .bind(database_id).bind(role.role_key).bind(role.row_kind_scope).bind(role.field_id).bind(role.required).bind(role.config).execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
      }
      if view_roles
        .iter()
        .any(|old| !state.view_roles.iter().any(|role| role.role_key == old.role_key))
      {
        return Err(RepositoryError::Validation(
          "managed update cannot remove native View role".into(),
        ));
      }
      for role in state.view_roles {
        if let Some(old) = view_roles.iter().find(|old| old.role_key == role.role_key) {
          if old.view_id == role.view_id && old.required == role.required {
            continue;
          }
          sqlx::query("UPDATE database_view_roles SET view_id=$3,required=$4,updated_at=now() WHERE database_id=$1 AND role_key=$2 AND ROW(view_id,required) IS DISTINCT FROM ROW($3,$4)")
            .bind(database_id).bind(role.role_key).bind(role.view_id).bind(role.required).execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
        } else {
          sqlx::query("INSERT INTO database_view_roles(database_id,profile_kind,role_key,view_id,required,created_at,updated_at) VALUES($1,'project',$2,$3,$4,now(),now())")
            .bind(database_id).bind(role.role_key).bind(role.view_id).bind(role.required).execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
        }
      }
      if database.profile_structure_preset != state.database.profile_structure_preset
        || database.profile_config != state.database.profile_config
      {
        sqlx::query("UPDATE database_profiles SET structure_preset=$2,config_json=$3,updated_at=now() WHERE database_id=$1 AND ROW(structure_preset,config_json) IS DISTINCT FROM ROW($2,$3)")
          .bind(database_id).bind(state.database.profile_structure_preset).bind(state.database.profile_config).execute(&mut *tx).await.map_err(Self::map_sqlx_error)?;
      }
      sqlx::query("UPDATE workspace_databases SET edit_revision=edit_revision+1,updated_at=now() WHERE id=$1")
        .bind(database_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?;
    }
    // A persisted intermediate/unavailable source is the existing durable
    // recovery fact. Final readiness refreshes live Rows so a failed earlier
    // inline refresh cannot leave pre-conversion text after restart.
    if current.readiness != DatabaseManagedSchemaReadiness::Ready
      && installation.readiness == DatabaseManagedSchemaReadiness::Ready
    {
      let rows = sqlx::query_scalar::<_, DatabaseRowId>(
        "SELECT id FROM workspace_database_rows WHERE database_id=$1 AND deleted_at IS NULL ORDER BY id",
      )
      .bind(database_id)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_sqlx_error)?;
      affected_rows.extend(rows);
    }
    let installation =
      serde_json::to_value(installation).map_err(|error| RepositoryError::Validation(error.to_string()))?;
    sqlx::query(
      "UPDATE workspace_databases SET managed_installation=$2 WHERE id=$1 AND managed_installation IS DISTINCT FROM $2",
    )
    .bind(database_id)
    .bind(installation)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    tx.commit().await.map_err(Self::map_sqlx_error)?;
    Ok(affected_rows.into_iter().collect())
  }
}
