// SPDX-License-Identifier: AGPL-3.0-or-later
use crate::workspace_database::*;

impl PgDatabaseRepository {
  pub(in crate::workspace_database) async fn insert_task_recurrence_completion_intents(
    tx: &mut Transaction<'_, Postgres>,
    database: DatabaseId,
    changes: &[DatabaseCommittedCellChange],
  ) -> RepoResult<()> {
    if !changes.iter().any(|change| {
      matches!(change.previous_value, Some(DatabaseCellValueData::Status(_)))
        || matches!(change.value, Some(DatabaseCellValueData::Status(_)))
    }) {
      return Ok(());
    }
    let fields = DATABASE_FIELDS_TABLE;
    let role = sqlx::query(&format!("SELECT r.field_id,f.config_json FROM database_field_roles r JOIN {fields} f ON f.id=r.field_id AND f.database_id=r.database_id WHERE r.database_id=$1 AND r.profile_kind='project' AND r.row_kind_scope='task' AND r.role_key='task.status' AND f.field_type='status'"))
      .bind(database).fetch_optional(&mut **tx).await.map_err(Self::map_sqlx_error)?;
    let Some(role) = role else {
      return Ok(());
    };
    let field: Uuid = role.try_get("field_id").map_err(Self::map_sqlx_error)?;
    let config: DatabaseFieldConfig =
      serde_json::from_value(role.try_get("config_json").map_err(Self::map_sqlx_error)?)
        .map_err(|_| RepositoryError::Validation("Task status configuration unavailable".into()))?;
    let DatabaseFieldConfig::Status(config) = config else {
      return Ok(());
    };
    let group = |value: Option<&DatabaseCellValueData>| {
      let key = match value {
        Some(DatabaseCellValueData::Status(id)) => id.as_str(),
        None => config.default_option_id.as_str(),
        _ => return None,
      };
      config
        .options
        .iter()
        .find(|option| option.id == key)
        .map(|option| option.group)
    };
    for change in changes.iter().filter(|change| change.field_id == field) {
      if group(change.previous_value.as_ref()) != Some(DatabaseStatusGroup::Complete)
        && group(change.value.as_ref()) == Some(DatabaseStatusGroup::Complete)
      {
        crate::recurrence::advance_completed_member_in(tx, change.row_id).await?;
      }
    }
    Ok(())
  }
  /// Capture valid automation preimages without widening notification repair guards.
  pub(in crate::workspace_database) async fn previous_cell_value(
    tx: &mut Transaction<'_, Postgres>,
    row_id: DatabaseRowId,
    field_id: DatabaseFieldId,
    value: Option<&DatabaseCellValueData>,
  ) -> RepoResult<Option<DatabaseCellValueData>> {
    let row = sqlx::query(
      "SELECT f.field_type,c.value_json,
         EXISTS (SELECT 1 FROM workspace_database_rows r
           JOIN database_profiles p ON p.database_id=r.database_id AND p.profile_kind='project'
           JOIN database_field_roles role ON role.database_id=r.database_id AND role.field_id=f.id
             AND role.profile_kind='project' AND role.row_kind_scope='task'
           WHERE r.id=$1 AND r.row_kind='task' AND f.database_id=r.database_id
             AND ((role.role_key='task.status' AND f.field_type='status')
               OR (role.role_key='task.dueDate' AND f.field_type='date_time')))
         AS notification_required
       FROM workspace_database_fields f
       LEFT JOIN workspace_database_cell_values c ON c.field_id=f.id AND c.row_id=$1
       WHERE f.id=$2",
    )
    .bind(row_id)
    .bind(field_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let Some(row) = row else {
      return Ok(None);
    };
    let kind: String = row.try_get("field_type").map_err(Self::map_sqlx_error)?;
    let kind =
      DatabaseFieldType::from_str(&kind).map_err(|_| RepositoryError::Storage("unknown native field kind".into()))?;
    let notification_required: bool = row.try_get("notification_required").map_err(Self::map_sqlx_error)?;
    let required = (kind == DatabaseFieldType::Users && matches!(value, Some(DatabaseCellValueData::Users(_))))
      || notification_required;
    let raw: Option<Value> = row.try_get("value_json").map_err(Self::map_sqlx_error)?;
    let Some(raw) = raw.filter(|value| !value.is_null()) else {
      return Ok(None);
    };
    match Self::map_cell_value_from_json(kind, raw) {
      Ok(value) => Ok(Some(value)),
      // Only notification-required preimages must reject malformed stored values.
      // Other fields must remain repairable; an undecodable value is not a typed
      // automation preimage. SQL/schema failures are never suppressed here.
      Err(RepositoryError::Validation(_)) if !required => Ok(None),
      Err(error) => Err(error),
    }
  }

  /// Insert one IDs-only intent per changed Task inside the original write
  /// transaction. Source Rows are already locked; recipients use final Cells,
  /// while actual additions/transitions use their locked committed preimages.
  pub(in crate::workspace_database) async fn insert_task_notification_intents(
    tx: &mut Transaction<'_, Postgres>,
    database_id: DatabaseId,
    actor: UserId,
    changes: &[DatabaseCommittedCellChange],
    creation: bool,
  ) -> RepoResult<()> {
    let workspace = sqlx::query_scalar::<_, WorkspaceId>(
      r#"
      SELECT d.workspace_id FROM workspace_databases d
      JOIN database_profiles p ON p.database_id=d.id AND p.profile_kind='project'
      WHERE d.id=$1 AND d.deleted_at IS NULL
    "#,
    )
    .bind(database_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let Some(workspace_id) = workspace else {
      return Ok(());
    };
    let roles = sqlx::query(
      r#"
      SELECT role.role_key,role.field_id,field.field_type,
        EXISTS (SELECT 1 FROM database_field_roles other WHERE other.database_id=role.database_id
          AND other.field_id=role.field_id AND other.row_kind_scope='task' AND other.role_key<>role.role_key) AS aliased
      FROM database_field_roles role JOIN workspace_database_fields field ON field.id=role.field_id AND field.database_id=role.database_id
      WHERE role.database_id=$1 AND role.row_kind_scope='task' AND role.profile_kind='project'
        AND role.role_key IN ('task.assignees','task.watchers','task.status','task.dueDate')
      "#,
    )
    .bind(database_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(Self::map_sqlx_error)?;
    let mut fields = HashMap::new();
    for role in roles {
      let key: String = role.try_get("role_key").map_err(Self::map_sqlx_error)?;
      let kind: String = role.try_get("field_type").map_err(Self::map_sqlx_error)?;
      let aliased: bool = role.try_get("aliased").map_err(Self::map_sqlx_error)?;
      let valid = match key.as_str() {
        "task.assignees" => kind == "users",
        "task.watchers" => kind == "users" && !aliased,
        "task.status" => kind == "status",
        "task.dueDate" => kind == "date_time",
        _ => false,
      };
      if valid {
        fields.insert(
          key,
          role
            .try_get::<DatabaseFieldId, _>("field_id")
            .map_err(Self::map_sqlx_error)?,
        );
      }
    }
    for row_id in changes.iter().map(|change| change.row_id).collect::<BTreeSet<_>>() {
      let live: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workspace_database_rows
         WHERE id=$1 AND database_id=$2 AND row_kind='task' AND deleted_at IS NULL)",
      )
      .bind(row_id)
      .bind(database_id)
      .fetch_one(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
      if !live {
        continue;
      }
      let mut added = BTreeSet::new();
      let mut transitions = false;
      let mut revisions = BTreeMap::new();
      for change in changes.iter().filter(|change| change.row_id == row_id) {
        if fields.get("task.assignees") == Some(&change.field_id) {
          let before = match &change.previous_value {
            Some(DatabaseCellValueData::Users(users)) => users.as_slice(),
            _ => &[],
          };
          if let Some(DatabaseCellValueData::Users(users)) = &change.value {
            added.extend(
              users
                .iter()
                .copied()
                .filter(|user| *user != actor && !before.contains(user)),
            );
          }
          if change.previous_value != change.value {
            revisions.insert(change.field_id, change.edit_revision);
          }
        }
        if !creation
          && change.previous_value != change.value
          && (fields.get("task.status") == Some(&change.field_id)
            || fields.get("task.dueDate") == Some(&change.field_id))
        {
          transitions = true;
          revisions.insert(change.field_id, change.edit_revision);
        }
      }
      let mut recipients = added
        .iter()
        .map(|user_id| (*user_id, DatabaseTaskNotificationKind::Assignment))
        .collect::<BTreeMap<_, _>>();
      if transitions {
        for role in ["task.assignees", "task.watchers"] {
          let Some(field) = fields.get(role) else {
            continue;
          };
          let raw = sqlx::query_scalar::<_, Option<Value>>(
            "SELECT value_json FROM workspace_database_cell_values WHERE row_id=$1 AND field_id=$2",
          )
          .bind(row_id)
          .bind(field)
          .fetch_optional(&mut **tx)
          .await
          .map_err(Self::map_sqlx_error)?
          .flatten();
          if let Some(raw) = raw.filter(|raw| !raw.is_null()) {
            match serde_json::from_value::<Vec<UserId>>(raw) {
              Ok(users) => {
                for user in users.into_iter().filter(|user| *user != actor) {
                  recipients.entry(user).or_insert(DatabaseTaskNotificationKind::Changed);
                }
              }
              Err(_) => tracing::warn!(%database_id,%row_id,role,"unreadable task notification recipient cell"),
            }
          }
        }
      }
      if recipients.is_empty() {
        continue;
      }
      let intent = DatabaseTaskNotificationIntent {
        workspace_id,
        database_id,
        row_id,
        actor_id: actor,
        revisions: revisions
          .into_iter()
          .map(|(field_id, edit_revision)| DatabaseTaskNotificationRevision {
            field_id,
            edit_revision,
          })
          .collect(),
        recipients: recipients
          .into_iter()
          .map(|(user_id, kind)| DatabaseTaskNotificationRecipient { user_id, kind })
          .collect(),
      };
      sqlx::query(
        "INSERT INTO outbox_events(id,aggregate_type,aggregate_id,event_type,payload,created_at)
         VALUES($1,'database_task',$2,'database_task_notification',$3,now())",
      )
      .bind(Uuid::new_v4())
      .bind(row_id.to_string())
      .bind(serde_json::json!({"intent":intent,"deliveries":{},"deliveryComplete":false}))
      .execute(&mut **tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    }
    Ok(())
  }
}
