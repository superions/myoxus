// SPDX-License-Identifier: AGPL-3.0-or-later
//! Native prerequisite locks and facts share the caller's Task write transaction.
use crate::workspace_automation::PgWorkspaceAutomationRepository;
use crate::workspace_database::*;
use myoxus_domain::{assistant_package::AssistantTaskReference, workspace_automation::*};
use sqlx::PgConnection;

impl PgDatabaseRepository {
  pub(crate) async fn lock_handover_prerequisites(
    tx: &mut PgConnection,
    plan: &PreparedTaskHandover,
  ) -> RepoResult<()> {
    let mut databases = plan
      .prerequisites
      .iter()
      .map(|task| task.database_id)
      .collect::<std::collections::BTreeSet<_>>();
    // Lock the destination as part of the same ordered root set, before any
    // prerequisite Row; the final capture must never acquire a new root later.
    databases.insert(plan.destination_database_id);
    for database in databases {
      sqlx::query("SELECT id FROM workspace_databases WHERE id=$1 AND deleted_at IS NULL FOR NO KEY UPDATE")
        .bind(database)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_sqlx_error)?
        .ok_or(RepositoryError::NotFound("handover Task container"))?;
    }
    let mut rows = plan.prerequisites.iter().map(|task| task.row_id).collect::<Vec<_>>();
    rows.sort();
    sqlx::query("SELECT id FROM workspace_database_rows WHERE id=ANY($1) ORDER BY id FOR UPDATE")
      .bind(rows)
      .fetch_all(tx)
      .await
      .map_err(Self::map_sqlx_error)?;
    Ok(())
  }
  pub(crate) async fn handover_task_state(
    tx: &mut PgConnection,
    workspace: WorkspaceId,
    task: &AssistantTaskReference,
  ) -> RepoResult<Option<DatabaseStatusGroup>> {
    let row=sqlx::query("SELECT r.database_id,r.deleted_at,r.row_kind,d.workspace_id,d.deleted_at AS database_deleted,p.profile_kind,d.managed_installation FROM workspace_database_rows r JOIN workspace_databases d ON d.id=r.database_id LEFT JOIN database_profiles p ON p.database_id=d.id WHERE r.id=$1")
      .bind(task.row_id).fetch_optional(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    let Some(row) = row else { return Ok(None) };
    if row.try_get::<Uuid, _>("database_id").map_err(Self::map_sqlx_error)? != task.database_id
      || row.try_get::<Uuid, _>("workspace_id").map_err(Self::map_sqlx_error)? != workspace
      || row
        .try_get::<Option<DateTime<Utc>>, _>("deleted_at")
        .map_err(Self::map_sqlx_error)?
        .is_some()
      || row
        .try_get::<Option<DateTime<Utc>>, _>("database_deleted")
        .map_err(Self::map_sqlx_error)?
        .is_some()
      || row.try_get::<String, _>("row_kind").map_err(Self::map_sqlx_error)? != "task"
      || row
        .try_get::<Option<String>, _>("profile_kind")
        .map_err(Self::map_sqlx_error)?
        .as_deref()
        != Some("project")
    {
      return Ok(None);
    }
    let installation: DatabaseManagedSchemaInstallation = serde_json::from_value(
      row
        .try_get::<Option<Value>, _>("managed_installation")
        .map_err(Self::map_sqlx_error)?
        .ok_or_else(|| RepositoryError::Validation("handover Task schema unavailable".into()))?,
    )
    .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    if installation.readiness != DatabaseManagedSchemaReadiness::Ready {
      return Ok(None);
    }
    let cell=sqlx::query("SELECT f.config_json,c.value_json FROM database_field_roles role JOIN workspace_database_fields f ON f.id=role.field_id LEFT JOIN workspace_database_cell_values c ON c.field_id=f.id AND c.row_id=$2 WHERE role.database_id=$1 AND role.role_key='task.status' AND role.row_kind_scope='task'")
      .bind(task.database_id).bind(task.row_id).fetch_optional(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    let Some(cell) = cell else { return Ok(None) };
    let config: DatabaseFieldConfig =
      serde_json::from_value(cell.try_get("config_json").map_err(Self::map_sqlx_error)?)
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    let DatabaseFieldConfig::Status(config) = config else {
      return Ok(None);
    };
    let value: Option<Value> = cell.try_get("value_json").map_err(Self::map_sqlx_error)?;
    let id = value
      .as_ref()
      .and_then(Value::as_str)
      .or(Some(config.default_option_id.as_str()));
    Ok(
      config
        .options
        .iter()
        .find(|option| Some(option.id.as_str()) == id)
        .map(|option| option.group),
    )
  }
  pub(crate) async fn assert_handover_effect(
    tx: &mut PgConnection,
    accepted: &AcceptedAutomationRun,
  ) -> RepoResult<()> {
    let handover = accepted
      .task_handover
      .as_ref()
      .ok_or_else(|| RepositoryError::Validation("handover acceptance unavailable".into()))?;
    Self::lock_handover_prerequisites(tx, &handover.plan).await?;
    let state = PgWorkspaceAutomationRepository::record_handover_tasks(
      tx,
      accepted,
      &handover
        .plan
        .prerequisites
        .iter()
        .map(|task| task.row_id)
        .collect::<Vec<_>>(),
    )
    .await?;
    if state.invalid_reason.is_some()
      || state.expired_at.is_some()
      || state.completions.len() != handover.plan.prerequisites.len()
    {
      return Err(RepositoryError::Validation("handover prerequisites unavailable".into()));
    }
    let member:Option<Uuid>=sqlx::query_scalar("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='Accepted' FOR SHARE NOWAIT").bind(accepted.workspace_id).bind(handover.plan.responsible_id).fetch_optional(&mut *tx).await.map_err(Self::map_sqlx_error)?;
    if member.is_none() {
      return Err(RepositoryError::Validation(
        "handover responsible member unavailable".into(),
      ));
    }
    Ok(())
  }
}
