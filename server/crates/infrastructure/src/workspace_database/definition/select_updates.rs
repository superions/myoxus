// SPDX-License-Identifier: AGPL-3.0-or-later

//! Finite Select conversion inside the existing root-locked schema transaction.
use crate::workspace_database::*;
use myoxus_domain::database::{
  DatabaseSelectOptionMapping, DatabaseSelectUpdateError, DatabaseSelectUpdateReason, DatabaseTemplateFieldConfig,
  DatabaseTemplateSpec, DatabaseTemplateUpdateOperation, map_select_filter_group, map_select_view_group_keys,
};
use std::collections::BTreeSet;

struct SelectUpdate {
  field_id: DatabaseFieldId,
  field_type: DatabaseFieldType,
  mapping: DatabaseSelectOptionMapping,
  config_changed: bool,
}

fn value_error(path: String) -> RepositoryError {
  RepositoryError::Validation(
    DatabaseSelectUpdateError {
      reason: DatabaseSelectUpdateReason::IncompatibleValueType,
      path,
    }
    .validation_message(),
  )
}

impl PgDatabaseRepository {
  /// Root/Fields/Views are already locked and compared with the exact source.
  /// Native operations come only from that source's admitted outgoing edge.
  pub(super) async fn apply_select_updates_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    source: &DatabaseRecord,
    target: &DatabaseInitialState,
    source_spec: &DatabaseTemplateSpec,
    target_spec: &DatabaseTemplateSpec,
    operations: &[DatabaseTemplateUpdateOperation],
  ) -> RepoResult<Vec<DatabaseRowId>> {
    let installed = source
      .database
      .managed_installation
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("managed source unavailable".into()))?;
    let target_install = target
      .database
      .managed_installation
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("managed target unavailable".into()))?;
    let mut explicit = BTreeMap::new();
    for operation in operations {
      let DatabaseTemplateUpdateOperation::MapSelectOptions { field_key, mapping } = operation;
      if explicit.insert(field_key.as_str(), mapping).is_some() {
        return Err(RepositoryError::Validation("repeated native Select mapping".into()));
      }
    }
    let mut updates = Vec::new();
    for old in &source.fields {
      let next = target
        .fields
        .iter()
        .find(|field| field.id == old.id)
        .ok_or_else(|| RepositoryError::Validation("managed update cannot remove a Field".into()))?;
      if old.field_type != next.field_type || old.required != next.required {
        return Err(RepositoryError::Validation(
          "managed update cannot reinterpret Field type or requiredness".into(),
        ));
      }
      let key = installed
        .field_bindings
        .iter()
        .find_map(|(key, id)| (*id == old.id).then_some(key))
        .ok_or_else(|| RepositoryError::Validation("managed source Field binding missing".into()))?;
      if target_install.field_bindings.get(key) != Some(&old.id) {
        return Err(RepositoryError::Validation(
          "managed target Field binding changed".into(),
        ));
      }
      let mapping = explicit.remove(key.as_str());
      let config_changed = old.config != next.config;
      if !config_changed && mapping.is_none() {
        continue;
      }
      let before = source_spec
        .fields
        .iter()
        .find(|field| field.key == *key)
        .ok_or_else(|| RepositoryError::Validation("admitted source Field missing".into()))?;
      let after = target_spec
        .fields
        .iter()
        .find(|field| field.key == *key)
        .ok_or_else(|| RepositoryError::Validation("admitted target Field missing".into()))?;
      let (DatabaseTemplateFieldConfig::Direct(before_config), DatabaseTemplateFieldConfig::Direct(after_config)) =
        (&before.config, &after.config)
      else {
        return Err(RepositoryError::Validation(
          "only native Select configuration may change".into(),
        ));
      };
      if before.field_type != old.field_type
        || after.field_type != next.field_type
        || before_config != &old.config
        || after_config != &next.config
      {
        return Err(RepositoryError::Conflict("managed Select configuration fence"));
      }
      let mapping = DatabaseSelectOptionMapping::new(&old.config, &next.config, mapping.cloned().unwrap_or_default())
        .map_err(RepositoryError::Validation)?;
      updates.push(SelectUpdate {
        field_id: old.id,
        field_type: old.field_type,
        mapping,
        config_changed,
      });
    }
    if !explicit.is_empty() {
      return Err(RepositoryError::Validation("unbound native Select operation".into()));
    }
    if updates.is_empty() {
      return Ok(Vec::new());
    }
    let database_id = source.database.id;
    let rows = sqlx::query(
      "SELECT id,deleted_at IS NULL AS live FROM workspace_database_rows WHERE database_id=$1 ORDER BY id FOR UPDATE",
    )
    .bind(database_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let mut live = BTreeSet::new();
    let mut all_rows = Vec::new();
    for row in rows {
      let id: Uuid = row.try_get("id").map_err(Self::map_sqlx_error)?;
      all_rows.push(id);
      if row.try_get::<bool, _>("live").map_err(Self::map_sqlx_error)? {
        live.insert(id);
      }
    }
    let mut changed_rows = BTreeSet::new();
    let mut derived = BTreeSet::new();
    for update in &updates {
      let cells=sqlx::query("SELECT row_id,value_json FROM workspace_database_cell_values WHERE database_id=$1 AND field_id=$2 ORDER BY row_id FOR UPDATE")
        .bind(database_id).bind(update.field_id).fetch_all(&mut **tx).await.map_err(Self::map_sqlx_error)?;
      for cell in cells {
        let row_id: Uuid = cell.try_get("row_id").map_err(Self::map_sqlx_error)?;
        let raw: Option<Value> = cell.try_get("value_json").map_err(Self::map_sqlx_error)?;
        let Some(raw) = raw.filter(|value| !value.is_null()) else {
          continue;
        };
        let path = format!("rows/{row_id}/cells/{}", update.field_id);
        let value =
          Self::map_cell_value_from_json(update.field_type, raw.clone()).map_err(|_| value_error(path.clone()))?;
        let mapped = update
          .mapping
          .map_value(&value)
          .map_err(|error| RepositoryError::Validation(error.at_path(path).validation_message()))?;
        let mapped = Self::map_cell_value_to_json(&mapped)?;
        if mapped != raw {
          sqlx::query("UPDATE workspace_database_cell_values SET value_json=$3,edit_revision=edit_revision+1 WHERE row_id=$1 AND field_id=$2")
            .bind(row_id).bind(update.field_id).bind(mapped).execute(&mut **tx).await.map_err(Self::map_sqlx_error)?;
          changed_rows.insert(row_id);
          derived.insert((row_id, update.field_id));
        }
      }
      // Config changes can invalidate source hashes even when stable option IDs
      // leave stored content unchanged. Do not invent Row revisions/search text.
      if update.config_changed {
        for row in &all_rows {
          derived.insert((*row, update.field_id));
        }
      }
    }
    let templates=sqlx::query("SELECT id,initial_cell_values_json FROM workspace_database_row_templates WHERE database_id=$1 ORDER BY id FOR UPDATE")
      .bind(database_id).fetch_all(&mut **tx).await.map_err(Self::map_sqlx_error)?;
    for template in templates {
      let id: Uuid = template.try_get("id").map_err(Self::map_sqlx_error)?;
      let original: Value = template
        .try_get("initial_cell_values_json")
        .map_err(Self::map_sqlx_error)?;
      let mut next = original.clone();
      let object = next
        .as_object_mut()
        .ok_or_else(|| value_error(format!("rowTemplates/{id}/initialCellValues")))?;
      for update in &updates {
        let key = update.field_id.to_string();
        let Some(raw) = object.get(&key).filter(|value| !value.is_null()).cloned() else {
          continue;
        };
        let path = format!("rowTemplates/{id}/initialCellValues/{key}");
        let value = Self::map_cell_value_from_json(update.field_type, raw).map_err(|_| value_error(path.clone()))?;
        let mapped = update
          .mapping
          .map_value(&value)
          .map_err(|error| RepositoryError::Validation(error.at_path(path).validation_message()))?;
        object.insert(key, Self::map_cell_value_to_json(&mapped)?);
      }
      if next != original {
        sqlx::query("UPDATE workspace_database_row_templates SET initial_cell_values_json=$2,edit_revision=edit_revision+1 WHERE id=$1")
          .bind(id).bind(next).execute(&mut **tx).await.map_err(Self::map_sqlx_error)?;
      }
    }
    let states=sqlx::query("SELECT state.* FROM database_view_user_states state JOIN workspace_database_views v ON v.id=state.view_id WHERE v.database_id=$1 ORDER BY state.view_id,state.user_id FOR UPDATE OF state")
      .bind(database_id).fetch_all(&mut **tx).await.map_err(Self::map_sqlx_error)?;
    for row in states {
      let mut state = Self::map_view_user_state(row)?;
      let before_filter = state.filter_tree.clone();
      let before_groups = state.collapsed_group_keys.clone();
      let view = source
        .views
        .iter()
        .find(|view| view.id == state.view_id)
        .ok_or_else(|| RepositoryError::Validation("personal View source unavailable".into()))?;
      for update in &updates {
        if let Some(tree) = state.filter_tree.as_mut() {
          map_select_filter_group(tree, update.field_id, &update.mapping).map_err(|error| {
            RepositoryError::Validation(
              error
                .at_path(format!(
                  "viewUserStates/{}/{}/filterTree/{}",
                  state.view_id, state.user_id, update.field_id
                ))
                .validation_message(),
            )
          })?;
        }
      }
      state.collapsed_group_keys = map_select_view_group_keys(
        &before_groups,
        &view.config,
        &source.fields,
        &updates
          .iter()
          .map(|update| (update.field_id, &update.mapping))
          .collect::<Vec<_>>(),
      )
      .map_err(|error| {
        RepositoryError::Validation(
          error
            .at_path(format!(
              "viewUserStates/{}/{}/collapsedGroupKeys",
              state.view_id, state.user_id
            ))
            .validation_message(),
        )
      })?;
      if state.filter_tree != before_filter || state.collapsed_group_keys != before_groups {
        let filter = state
          .filter_tree
          .map(serde_json::to_value)
          .transpose()
          .map_err(|error| RepositoryError::Validation(error.to_string()))?;
        let groups = serde_json::to_value(state.collapsed_group_keys)
          .map_err(|error| RepositoryError::Validation(error.to_string()))?;
        sqlx::query("UPDATE database_view_user_states SET filter_tree_json=$3,collapsed_group_keys_json=$4,edit_revision=nextval('database_view_user_state_edit_revision_seq') WHERE view_id=$1 AND user_id=$2")
          .bind(state.view_id).bind(state.user_id).bind(filter).bind(groups).execute(&mut **tx).await.map_err(Self::map_sqlx_error)?;
      }
    }
    if !changed_rows.is_empty() {
      sqlx::query(
        "UPDATE workspace_database_rows SET edit_revision=edit_revision+1 WHERE database_id=$1 AND id=ANY($2)",
      )
      .bind(database_id)
      .bind(changed_rows.iter().copied().collect::<Vec<_>>())
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    }
    for (row, field) in derived {
      Self::mark_rollups_stale_for_target_cell_change(tx, row, field).await?;
      Self::mark_formulas_stale_for_cell_change(tx, row, field).await?;
    }
    Ok(changed_rows.into_iter().filter(|row| live.contains(row)).collect())
  }
}
