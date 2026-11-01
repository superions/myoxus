//! SQLx-backed workspace store implementation.
//!
//! [`SqlxWorkspaceStore`] implements the [`WorkspaceStore`] application port
//! against PostgreSQL. It handles workspace creation and soft-deletion,
//! membership management (upsert, role update, removal), invite-link
//! generation and redemption, and member listing with full user details.

mod starter;
mod starter_documents;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use myoxus_application::auth::{AuthError, AuthResult};
use myoxus_application::workspace::{
  UpdateWorkspace, WorkspaceLifecycleOwnerKind, WorkspaceLifecycleState, WorkspaceName, WorkspaceOwnerTarget,
  WorkspaceStore,
};
use myoxus_domain::entities::{
  AccountStatus, MembershipStatus, User, Workspace, WorkspaceInviteLink, WorkspaceMember, WorkspaceRole,
};
use myoxus_domain::ids::{InviteLinkId, OrganizationUnitId, UserId, WorkspaceId, WorkspaceImportId};
use sqlx::{PgConnection, PgPool, Row};
use tracing::{debug, error, info, instrument, trace};
use uuid::Uuid;

/// PostgreSQL-backed implementation of [`WorkspaceStore`].
#[derive(Debug, Clone)]
pub struct SqlxWorkspaceStore {
  /// Database connection pool.
  pool: PgPool,
  database_templates: std::sync::Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>,
}

impl SqlxWorkspaceStore {
  /// Read the same native fields for user patches and lifecycle publication.
  pub(crate) fn overview_from_row(
    row: &sqlx::postgres::PgRow,
  ) -> AuthResult<(myoxus_domain::workspace_overview::WorkspaceOverviewSettings, i64)> {
    let settings: sqlx::types::Json<myoxus_domain::workspace_overview::WorkspaceOverviewSettings> =
      row.try_get("overview_settings").map_err(Self::map_db_err)?;
    Ok((settings.0, row.try_get("overview_revision").map_err(Self::map_db_err)?))
  }

  /// The caller owns lifecycle admission; Extract's unpublished target uses
  /// this same row lock inside its existing publication transaction.
  pub(crate) async fn lock_overview_in_transaction(
    tx: &mut PgConnection,
    workspace_id: Uuid,
  ) -> AuthResult<(myoxus_domain::workspace_overview::WorkspaceOverviewSettings, i64)> {
    let row = sqlx::query(
      "SELECT overview_settings, overview_revision FROM workspaces
       WHERE id=$1 AND deleted_at IS NULL FOR NO KEY UPDATE",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::NotFound("workspace".into()))?;
    Self::overview_from_row(&row)
  }

  /// One revision CAS for user patches and operation-owned lifecycle changes.
  /// No caller can restore an old counter or replace other workspace settings.
  pub(crate) async fn write_overview_in_transaction(
    tx: &mut PgConnection,
    workspace_id: Uuid,
    expected_revision: i64,
    settings: &myoxus_domain::workspace_overview::WorkspaceOverviewSettings,
  ) -> AuthResult<i64> {
    use myoxus_domain::workspace_overview::OverviewSettingsError;
    let revision = expected_revision
      .checked_add(1)
      .ok_or(OverviewSettingsError::InvalidInput("revision exhausted"))?;
    let changed = sqlx::query(
      "UPDATE workspaces SET overview_settings=$2, overview_revision=$3, updated_at=now()
       WHERE id=$1 AND overview_revision=$4 AND deleted_at IS NULL",
    )
    .bind(workspace_id)
    .bind(sqlx::types::Json(settings))
    .bind(revision)
    .bind(expected_revision)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .rows_affected();
    if changed != 1 {
      return Err(
        OverviewSettingsError::RevisionConflict {
          current_revision: expected_revision,
        }
        .into(),
      );
    }
    Ok(revision)
  }

  /// Fence permanent deletion against admitted transfer work. Terminal receipts
  /// survive as historical IDs because surviving documents still need lineage.
  #[instrument(skip_all)]
  pub(crate) async fn guard_hard_delete_in_transaction(
    tx: &mut PgConnection,
    workspace_ids: &[Uuid],
  ) -> AuthResult<()> {
    // Admission/reactivation takes KEY SHARE on these same parents before its
    // operation write. UUID ordering also serializes multi-workspace deletion.
    sqlx::query("SELECT id FROM workspaces WHERE id=ANY($1) ORDER BY id FOR UPDATE")
      .bind(workspace_ids)
      .fetch_all(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    let unfinished: bool = sqlx::query_scalar(
      "SELECT EXISTS(SELECT 1 FROM workspace_content_operations o
       WHERE (o.source_workspace_id=ANY($1) OR o.target_workspace_id=ANY($1))
          AND (o.status NOT IN ('succeeded','cancelled','failed')
            OR EXISTS(SELECT 1 FROM workspace_content_extract_targets e WHERE e.operation_id=o.id AND e.git_sync_pending)
           OR (o.status <> 'succeeded' AND (
             EXISTS(SELECT 1 FROM workspace_content_operation_staging s
               WHERE s.operation_id=o.id AND s.publication_status IN ('staged','cleanup_required'))
             OR EXISTS(SELECT 1 FROM workspace_content_operation_compensations c
               WHERE c.operation_id=o.id AND c.completed_at IS NULL)
             OR EXISTS(SELECT 1 FROM workspace_content_extract_targets e
               WHERE e.operation_id=o.id AND e.published_at IS NULL)))))",
    )
    .bind(workspace_ids)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if unfinished {
      return Err(AuthError::InvalidInput(
        "workspace has unfinished content operations".into(),
      ));
    }
    let profiles: Vec<Uuid> =
      sqlx::query_scalar("SELECT id FROM git_sync_profiles WHERE workspace_id = ANY($1) ORDER BY id")
        .bind(workspace_ids)
        .fetch_all(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    crate::git_sync::store::rehome_credentials_before_profile_deletion(tx, &profiles)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Construct a `SqlxWorkspaceStore` from an existing pool.
  pub fn new(
    pool: PgPool,
    database_templates: std::sync::Arc<myoxus_application::database::DatabaseStarterTemplateCatalog>,
  ) -> Self {
    Self {
      pool,
      database_templates,
    }
  }

  fn map_db_err(err: sqlx::Error) -> AuthError {
    if crate::auth::is_terminal_account_error(&err) {
      return AuthError::NotFound("user".into());
    }
    error!(error = %err, "database error in workspace store");
    AuthError::Storage(err.to_string())
  }

  pub(crate) async fn lock_name_principal(
    tx: &mut PgConnection,
    principal_type: &str,
    principal_id: Uuid,
  ) -> AuthResult<()> {
    let found = match principal_type {
      "user" => {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE id = $1 AND status <> 'deleted' FOR UPDATE")
          .bind(principal_id)
          .fetch_optional(&mut *tx)
          .await
      }
      "ou" => {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM organization_unit WHERE id = $1 FOR UPDATE")
          .bind(principal_id)
          .fetch_optional(&mut *tx)
          .await
      }
      _ => {
        return Err(AuthError::InvalidInput(
          "workspace owner principal cannot reserve names".to_string(),
        ));
      }
    }
    .map_err(Self::map_db_err)?;
    found
      .map(|_| ())
      .ok_or_else(|| AuthError::NotFound("workspace owner principal".to_string()))
  }

  async fn name_is_reserved(
    tx: &mut PgConnection,
    principal_type: &str,
    principal_id: Uuid,
    name: &WorkspaceName,
    exclude_workspace_id: Option<WorkspaceId>,
  ) -> AuthResult<bool> {
    sqlx::query_scalar(
      r#"
      SELECT EXISTS(
        SELECT 1
          FROM workspaces
         WHERE owner_principal_type::text = $1
           AND owner_principal_id = $2
           AND deleted_at IS NULL
           AND ($4::uuid IS NULL OR id <> $4)
           AND COALESCE(
                 name_normalized,
                 lower(normalize(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g'), NFC))
               ) = $3
      )
      "#,
    )
    .bind(principal_type)
    .bind(principal_id)
    .bind(name.normalized())
    .bind(exclude_workspace_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)
  }

  async fn next_available_name(
    tx: &mut PgConnection,
    principal_type: &str,
    principal_id: Uuid,
    requested: &WorkspaceName,
    exclude_workspace_id: Option<WorkspaceId>,
  ) -> AuthResult<WorkspaceName> {
    if !Self::name_is_reserved(tx, principal_type, principal_id, requested, exclude_workspace_id).await? {
      return Ok(requested.clone());
    }
    for suffix in 2..=10_000 {
      let candidate = requested
        .with_suffix(suffix)
        .map_err(|error| AuthError::InvalidInput(error.to_string()))?;
      if !Self::name_is_reserved(tx, principal_type, principal_id, &candidate, exclude_workspace_id).await? {
        return Ok(candidate);
      }
    }
    Err(AuthError::InvalidInput(
      "workspace name suffix space is exhausted".to_string(),
    ))
  }

  pub(crate) async fn require_available_name(
    tx: &mut PgConnection,
    principal_type: &str,
    principal_id: Uuid,
    requested: &WorkspaceName,
    exclude_workspace_id: Option<WorkspaceId>,
  ) -> AuthResult<()> {
    let available =
      Self::next_available_name(tx, principal_type, principal_id, requested, exclude_workspace_id).await?;
    if available == *requested {
      Ok(())
    } else {
      Err(AuthError::WorkspaceNameConflict {
        suggestion: available.display().to_string(),
      })
    }
  }

  async fn create_user_workspace(
    &self,
    owner_id: UserId,
    name: WorkspaceName,
    personal: bool,
  ) -> AuthResult<Workspace> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::lock_name_principal(&mut tx, "user", owner_id).await?;
    let owner_is_active: bool = sqlx::query_scalar("SELECT status = 'active' FROM users WHERE id = $1")
      .bind(owner_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    if !owner_is_active {
      return Err(AuthError::InvalidInput(
        "workspace owner must be an active user".to_string(),
      ));
    }
    Self::require_available_name(&mut tx, "user", owner_id, &name, None).await?;
    let row = sqlx::query(
      r#"
      INSERT INTO workspaces (
        owner_user_id, owner_principal_type, owner_principal_id,
        created_by_user_id, is_personal_workspace, name, name_normalized, public
      )
      VALUES ($1, 'user'::owner_principal_type, $1, $1, $2, $3, $4, false)
      RETURNING id, owner_user_id, name, description, avatar_key, public, enable_ai,
                enable_sharing, enable_url_preview, enable_doc_embedding,
                created_at, updated_at, initial_content_policy, overview_settings, overview_revision
      "#,
    )
    .bind(owner_id)
    .bind(personal)
    .bind(name.display())
    .bind(name.normalized())
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let workspace_id: Uuid = row.get("id");

    sqlx::query(
      r#"
      INSERT INTO docs (id, workspace_id, title, is_workspace_root, created_by, updated_by)
      VALUES ($1, $1, $2, true, $3, $3)
      "#,
    )
    .bind(workspace_id)
    .bind(name.display())
    .bind(owner_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    sqlx::query(
      r#"
      INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
      VALUES ($1, $2, 'Owner', 'Accepted', now())
      "#,
    )
    .bind(workspace_id)
    .bind(owner_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    let state = myoxus_application::workspace::tasks::workspace_tasks_initial_state(
      &self.database_templates,
      workspace_id,
      Some(owner_id),
    )
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    crate::workspace_database::PgDatabaseRepository::ensure_workspace_tasks_in_tx(
      &mut tx,
      &self.database_templates,
      state,
    )
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    tx.commit().await.map_err(Self::map_db_err)?;
    info!(%workspace_id, %owner_id, personal, "user-owned workspace transaction committed");
    map_workspace_row(row).map_err(Self::map_db_err)
  }

  /// Apply a principal ownership transfer under one workspace row lock.
  ///
  /// `expected_user_owner` is used by the authenticated API path to retain its
  /// compare-and-swap contract. The trusted operator CLI passes no expectation
  /// and can therefore repair OU- or system-owned workspaces as well.
  async fn transfer_workspace_owner_transaction(
    &self,
    workspace_id: WorkspaceId,
    target: WorkspaceOwnerTarget,
    expected_user_owner: Option<UserId>,
  ) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let previous_management_unit =
      Self::transfer_workspace_owner_in_transaction(&mut tx, workspace_id, target, expected_user_owner).await?;
    tx.commit().await.map_err(Self::map_db_err)?;
    info!(%workspace_id, ?target, ?previous_management_unit, "workspace ownership transfer committed");
    Ok(())
  }

  /// Run the canonical ownership transfer inside an aggregate transaction.
  /// The caller owns commit so related aggregate writes cannot escape it.
  pub(crate) async fn transfer_workspace_owner_in_transaction(
    tx: &mut PgConnection,
    workspace_id: WorkspaceId,
    target: WorkspaceOwnerTarget,
    expected_user_owner: Option<UserId>,
  ) -> AuthResult<Option<Uuid>> {
    let current = sqlx::query_as::<_, (String, Option<Uuid>, String, bool, Option<Uuid>)>(
      r#"
      SELECT owner_principal_type::text, owner_principal_id, name,
             is_personal_workspace, management_unit_id
        FROM workspaces
       WHERE id = $1 AND lifecycle_state = 'active' AND deleted_at IS NULL
       FOR UPDATE
      "#,
    )
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::NotFound("workspace".to_string()))?;
    let (current_type, current_id, current_name, personal, current_management_unit) = current;

    if personal {
      return Err(AuthError::InvalidInput(
        "personal workspace ownership cannot be transferred".to_string(),
      ));
    }
    if let Some(expected) = expected_user_owner
      && (current_type != "user" || current_id != Some(expected))
    {
      return Err(AuthError::InvalidInput("workspace ownership changed".to_string()));
    }
    let name = WorkspaceName::parse(&current_name).map_err(|error| AuthError::InvalidInput(error.to_string()))?;

    match target {
      WorkspaceOwnerTarget::User(new_owner_id) => {
        let active =
          sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE")
            .bind(new_owner_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(Self::map_db_err)?;
        if active.is_none() {
          return Err(AuthError::InvalidInput(
            "workspace owner must be an active user".to_string(),
          ));
        }
        Self::require_available_name(tx, "user", new_owner_id, &name, Some(workspace_id)).await?;

        if current_type == "ou" {
          sqlx::query(
            "DELETE FROM organization_unit_workspace
              WHERE workspace_id = $1 AND relationship = 'owner'",
          )
          .bind(workspace_id)
          .execute(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
        }
        sqlx::query(
          r#"
          UPDATE workspaces
             SET owner_user_id = $2,
                 owner_principal_type = 'user'::owner_principal_type,
                 owner_principal_id = $2,
                 management_unit_id = CASE
                   WHEN $3::text = 'ou' AND management_unit_id = $4 THEN NULL
                   ELSE management_unit_id
                 END,
                 is_personal_workspace = FALSE,
                 updated_at = NOW()
           WHERE id = $1
          "#,
        )
        .bind(workspace_id)
        .bind(new_owner_id)
        .bind(&current_type)
        .bind(current_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        sqlx::query(
          "UPDATE workspace_memberships
              SET role = 'Admin', updated_at = NOW()
            WHERE workspace_id = $1 AND role = 'Owner' AND user_id <> $2",
        )
        .bind(workspace_id)
        .bind(new_owner_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        sqlx::query(
          r#"
          INSERT INTO workspace_memberships
            (workspace_id, user_id, role, status, joined_at)
          VALUES ($1, $2, 'Owner', 'Accepted', NOW())
          ON CONFLICT (workspace_id, user_id) DO UPDATE
            SET role = 'Owner', status = 'Accepted',
                joined_at = COALESCE(workspace_memberships.joined_at, NOW()),
                updated_at = NOW()
          "#,
        )
        .bind(workspace_id)
        .bind(new_owner_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      }
      WorkspaceOwnerTarget::OrganizationUnit(new_owner_unit_id) => {
        let can_own = sqlx::query_scalar::<_, Uuid>(
          r#"
          SELECT ou.id
            FROM organization_unit ou
            JOIN organization_unit_type out ON out.id = ou.unit_type_id
           WHERE ou.id = $1 AND ou.status = 'active' AND out.can_own_workspaces = TRUE
           FOR UPDATE OF ou
          "#,
        )
        .bind(new_owner_unit_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        if can_own.is_none() {
          return Err(AuthError::InvalidInput(
            "organization unit cannot own workspaces".to_string(),
          ));
        }
        Self::require_available_name(tx, "ou", new_owner_unit_id, &name, Some(workspace_id)).await?;

        if current_type == "ou"
          && let Some(previous_owner_unit_id) = current_id
          && previous_owner_unit_id != new_owner_unit_id
        {
          let created_at = sqlx::query_scalar::<_, Option<DateTime<Utc>>>(
            "SELECT MIN(created_at) FROM organization_unit_workspace
              WHERE unit_id = $1 AND workspace_id = $2",
          )
          .bind(previous_owner_unit_id)
          .bind(workspace_id)
          .fetch_one(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
          sqlx::query("DELETE FROM organization_unit_workspace WHERE unit_id = $1 AND workspace_id = $2")
            .bind(previous_owner_unit_id)
            .bind(workspace_id)
            .execute(&mut *tx)
            .await
            .map_err(Self::map_db_err)?;
          sqlx::query(
            r#"
            INSERT INTO organization_unit_workspace
              (unit_id, workspace_id, relationship, created_at, updated_at)
            VALUES (
              $1, $2, 'managed'::organization_unit_workspace_relationship,
              COALESCE($3, NOW()), NOW()
            )
            "#,
          )
          .bind(previous_owner_unit_id)
          .bind(workspace_id)
          .bind(created_at)
          .execute(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
        }
        sqlx::query("DELETE FROM organization_unit_workspace WHERE unit_id = $1 AND workspace_id = $2")
          .bind(new_owner_unit_id)
          .bind(workspace_id)
          .execute(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
        sqlx::query(
          r#"
          INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship)
          VALUES ($1, $2, 'owner'::organization_unit_workspace_relationship)
          "#,
        )
        .bind(new_owner_unit_id)
        .bind(workspace_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        sqlx::query(
          r#"
          UPDATE workspaces
             SET owner_user_id = NULL,
                 owner_principal_type = 'ou'::owner_principal_type,
                 owner_principal_id = $2,
                 management_unit_id = $2,
                 is_personal_workspace = FALSE,
                 updated_at = NOW()
           WHERE id = $1
          "#,
        )
        .bind(workspace_id)
        .bind(new_owner_unit_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        sqlx::query(
          "UPDATE workspace_memberships
              SET role = 'Admin', updated_at = NOW()
            WHERE workspace_id = $1 AND role = 'Owner'",
        )
        .bind(workspace_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        let admin_count: i64 = sqlx::query_scalar(
          "SELECT COUNT(*)
             FROM workspace_memberships membership
             JOIN users member ON member.id = membership.user_id AND member.status = 'active'
            WHERE membership.workspace_id = $1
              AND membership.role = 'Admin' AND membership.status = 'Accepted'",
        )
        .bind(workspace_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
        if admin_count == 0 {
          return Err(AuthError::InvalidInput(
            "OU-owned workspace requires an active administrator".to_string(),
          ));
        }
      }
    }

    Ok(current_management_unit)
  }
}

#[async_trait]
impl WorkspaceStore for SqlxWorkspaceStore {
  async fn has_accepted_starter_package(
    &self,
    actor: UserId,
    package: &myoxus_domain::assistant_package::AssistantPackageIdentity,
  ) -> AuthResult<bool> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_starter_applications a JOIN workspaces w ON w.id=a.workspace_id JOIN workspace_memberships m ON m.workspace_id=w.id AND m.user_id=a.actor_id WHERE a.actor_id=$1 AND a.operation IN ('create_workspace','create_project','prepare_documents') AND ((a.package_id=$2 AND a.package_version=$3 AND a.package_digest=$4) OR (a.operation='create_workspace' AND a.workspace_plan->'project'->'package'->>'id'=$2 AND a.workspace_plan->'project'->'package'->>'version'=$3 AND a.workspace_plan->'project'->'package'->>'digest'=$4) OR (a.operation='create_workspace' AND a.workspace_plan->'setup'->'package'->>'id'=$2 AND a.workspace_plan->'setup'->'package'->>'version'=$3 AND a.workspace_plan->'setup'->'package'->>'digest'=$4)) AND w.deleted_at IS NULL AND w.lifecycle_state='active' AND m.status='Accepted')")
      .bind(actor).bind(&package.id).bind(&package.version).bind(&package.digest)
      .fetch_one(&self.pool).await.map_err(Self::map_db_err)
  }
  async fn has_accepted_member(&self, workspace_id: WorkspaceId, user_id: UserId) -> AuthResult<bool> {
    sqlx::query_scalar::<_, bool>(
      r#"
        SELECT EXISTS(
          SELECT 1
            FROM workspace_memberships membership
            JOIN workspaces workspace ON workspace.id = membership.workspace_id
             AND workspace.lifecycle_state = 'active'
             AND workspace.deleted_at IS NULL
           WHERE membership.workspace_id = $1
             AND membership.user_id = $2
             AND membership.status = 'Accepted'
        )
      "#,
    )
    .bind(workspace_id)
    .bind(user_id)
    .fetch_one(&self.pool)
    .await
    .map_err(|_| AuthError::Storage("workspace member lookup failed".into()))
  }

  async fn accepted_member_by_email(&self, workspace_id: WorkspaceId, email: &str) -> AuthResult<Option<UserId>> {
    sqlx::query_scalar::<_, UserId>(
      r#"
        SELECT u.id
        FROM workspace_memberships wm
        JOIN users u ON u.id = wm.user_id
        JOIN workspaces w ON w.id = wm.workspace_id
          AND w.lifecycle_state = 'active'
          AND w.deleted_at IS NULL
        WHERE wm.workspace_id = $1
          AND wm.status = 'Accepted'
          AND lower(u.email) = lower($2)
        LIMIT 1
      "#,
    )
    .bind(workspace_id)
    .bind(email.trim())
    .fetch_optional(&self.pool)
    .await
    .map_err(|_| AuthError::Storage("workspace member lookup failed".into()))
  }

  async fn accepted_members_for_lookup(
    &self,
    workspace_id: WorkspaceId,
  ) -> AuthResult<Vec<myoxus_domain::entities::WorkspaceMemberLookupRow>> {
    // Pull every accepted member's name + email into a lightweight
    // projection. The result is small enough (one row per accepted
    // member) that we don't need paging; the Notion matching pass is
    // an O(N×M) loop where N is the row count of the imported
    // database and M is the member count.
    let rows: Vec<(UserId, String, String)> = sqlx::query_as(
      r#"
        SELECT u.id, u.name, u.email
        FROM workspace_memberships wm
        JOIN users u ON u.id = wm.user_id
        JOIN workspaces w ON w.id = wm.workspace_id
          AND w.lifecycle_state = 'active'
          AND w.deleted_at IS NULL
        WHERE wm.workspace_id = $1
          AND wm.status = 'Accepted'
        ORDER BY lower(u.name) ASC
      "#,
    )
    .bind(workspace_id)
    .fetch_all(&self.pool)
    .await
    .map_err(|_| AuthError::Storage("workspace member lookup failed".into()))?;
    Ok(
      rows
        .into_iter()
        .map(
          |(user_id, name, email)| myoxus_domain::entities::WorkspaceMemberLookupRow {
            user_id,
            display_name: name,
            handle: Some(email),
          },
        )
        .collect(),
    )
  }

  #[instrument(skip_all)]
  async fn read_owner_principal(
    &self,
    workspace_id: WorkspaceId,
  ) -> AuthResult<Option<(myoxus_domain::entities::OwnerPrincipalType, Uuid)>> {
    let row = sqlx::query_as::<_, (String, Option<Uuid>)>(
      "SELECT owner_principal_type::text, owner_principal_id
       FROM workspaces WHERE id = $1 AND deleted_at IS NULL AND lifecycle_state = 'active'",
    )
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    // This projection must not log owner identifiers or raw provider errors.
    .map_err(|_| AuthError::Storage("workspace owner read failed".into()))?;
    Ok(row.and_then(|(kind, id)| Some((myoxus_domain::entities::OwnerPrincipalType::parse(&kind)?, id?))))
  }
  async fn get_workspace_starter(
    &self,
    actor: UserId,
    request_id: Uuid,
    expected_fingerprint: Option<&str>,
  ) -> myoxus_application::workspace::WorkspaceStarterResult<
    Option<myoxus_application::workspace::WorkspaceStarterAllocation>,
  > {
    self
      .read_workspace_starter(actor, request_id, expected_fingerprint)
      .await
  }
  async fn allocate_workspace_starter(
    &self,
    receipt: myoxus_application::workspace::WorkspaceStarterReceipt,
    root_update: Vec<u8>,
  ) -> myoxus_application::workspace::WorkspaceStarterResult<myoxus_application::workspace::WorkspaceStarterAllocation>
  {
    self.insert_workspace_starter(receipt, root_update).await
  }
  async fn bind_workspace_setup(
    &self,
    accepted: &myoxus_application::workspace::assistant_packages::AcceptedWorkspaceSetup,
    plan: myoxus_domain::assistant_package::AssistantPreparedWorkspaceSetup,
  ) -> myoxus_application::workspace::WorkspaceStarterResult<
    myoxus_application::workspace::assistant_packages::AcceptedWorkspaceSetup,
  > {
    self.bind_setup(accepted, plan).await
  }
  async fn publish_workspace_setup_database(
    &self,
    accepted: &myoxus_application::workspace::assistant_packages::AcceptedWorkspaceSetup,
    component: &str,
    state: myoxus_domain::database::DatabaseInitialState,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> myoxus_application::workspace::WorkspaceStarterResult<()> {
    self.publish_setup_database(accepted, component, state, fence).await
  }
  async fn finish_workspace_setup(
    &self,
    accepted: &myoxus_application::workspace::assistant_packages::AcceptedWorkspaceSetup,
    fence: myoxus_domain::workspace_automation::AutomationEffectFence,
  ) -> myoxus_application::workspace::WorkspaceStarterResult<()> {
    self.finish_setup(accepted, fence).await
  }
  async fn workspace_setup_package(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
  ) -> AuthResult<Option<myoxus_application::workspace::WorkspaceSetupAssistanceReceipt>> {
    use myoxus_application::workspace::{WorkspaceSetupAssistanceDocument, WorkspaceSetupAssistanceReceipt};
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::project_authority(
      &mut tx,
      actor,
      workspace,
      myoxus_domain::permission::WorkspaceAction::Read,
    )
    .await?;
    let row = sqlx::query("SELECT * FROM workspace_starter_applications WHERE operation='create_workspace' AND workspace_id=$1 AND workspace_plan->'setup' IS NOT NULL")
      .bind(workspace).fetch_optional(&mut *tx).await.map_err(Self::map_db_err)?;
    // Decode the canonical receipt before projecting only source identities and
    // Created ACKs. The creator's answers never cross this read port.
    let receipt = row.as_ref().map(Self::setup_from_row).transpose()?.flatten();
    let receipt = receipt.map(|accepted| {
      let metadata = &accepted.original.document_metadata;
      let documents = metadata
        .iter()
        .filter(|document| {
          metadata
            .iter()
            .filter(|candidate| {
              candidate.source.template_id == document.source.template_id
                && candidate.source.version == document.source.version
                && candidate.source.digest == document.source.digest
            })
            .count()
            == 1
        })
        .filter_map(|document| {
          accepted
            .document_progress
            .documents
            .get(&document.source.component_id)
            .map(|created| WorkspaceSetupAssistanceDocument {
              source: document.source.clone(),
              created: created.clone(),
            })
        })
        .collect();
      WorkspaceSetupAssistanceReceipt {
        package: accepted.original.package,
        documents,
      }
    });
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(receipt)
  }
  async fn get_context_documents(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
    fingerprint: Option<&str>,
  ) -> myoxus_application::workspace::ContextDocumentStarterResult<
    Option<myoxus_application::workspace::AcceptedContextDocuments>,
  > {
    self
      .read_context_documents(actor, workspace, request, fingerprint)
      .await
  }
  async fn accept_context_documents(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
    fingerprint: &str,
    plan: myoxus_domain::assistant_package::AssistantPreparedContextDocuments,
    admission: myoxus_application::workspace::ContextDocumentAdmission,
    definition: myoxus_domain::workspace_automation::AcceptedAutomationDefinition,
  ) -> myoxus_application::workspace::ContextDocumentStarterResult<
    myoxus_application::workspace::AcceptedContextDocuments,
  > {
    self
      .insert_context_documents(actor, workspace, request, fingerprint, plan, admission, definition)
      .await
  }
  async fn review_context_documents(
    &self,
    accepted: &myoxus_application::workspace::AcceptedContextDocuments,
    admission: myoxus_application::workspace::ContextDocumentAdmission,
  ) -> myoxus_application::workspace::ContextDocumentStarterResult<
    myoxus_application::workspace::AcceptedContextDocuments,
  > {
    self.update_context_documents(accepted, Some(admission), false).await
  }
  async fn stop_context_documents(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
  ) -> myoxus_application::workspace::ContextDocumentStarterResult<
    myoxus_application::workspace::AcceptedContextDocuments,
  > {
    let accepted = self
      .read_context_documents(actor, workspace, request, None)
      .await?
      .ok_or(AuthError::ActionForbidden)?;
    self.update_context_documents(&accepted, None, true).await
  }
  async fn get_project_starter(
    &self,
    actor: UserId,
    operation: myoxus_application::workspace::StarterOperation,
    workspace: WorkspaceId,
    request: Uuid,
    fingerprint: Option<&str>,
  ) -> myoxus_application::workspace::ProjectStarterResult<Option<myoxus_application::workspace::AcceptedProjectStarter>>
  {
    self
      .read_project_starter(actor, operation, workspace, request, fingerprint)
      .await
  }
  async fn accept_project_starter(
    &self,
    actor: UserId,
    workspace: WorkspaceId,
    request: Uuid,
    fingerprint: &str,
    plan: myoxus_domain::assistant_package::AssistantPreparedProject,
    admission: myoxus_application::workspace::ProjectStarterAdmission,
  ) -> myoxus_application::workspace::ProjectStarterResult<myoxus_application::workspace::AcceptedProjectStarter> {
    self
      .insert_project_starter(actor, workspace, request, fingerprint, plan, admission)
      .await
  }
  async fn publish_project_starter(
    &self,
    actor: UserId,
    operation: myoxus_application::workspace::StarterOperation,
    workspace: WorkspaceId,
    request: Uuid,
    fingerprint: &str,
    admission: myoxus_application::workspace::ProjectStarterAdmission,
    review: myoxus_domain::assistant_package::AssistantPreparedProject,
    state: myoxus_domain::database::DatabaseInitialState,
  ) -> myoxus_application::workspace::ProjectStarterResult<(
    myoxus_application::workspace::AcceptedProjectStarter,
    myoxus_domain::database::DatabaseRecord,
  )> {
    self
      .commit_project_starter(
        actor,
        operation,
        workspace,
        request,
        fingerprint,
        admission,
        review,
        state,
      )
      .await
  }
  async fn stop_project_starter(
    &self,
    actor: UserId,
    operation: myoxus_application::workspace::StarterOperation,
    workspace: WorkspaceId,
    request: Uuid,
  ) -> myoxus_application::workspace::ProjectStarterResult<myoxus_application::workspace::AcceptedProjectStarter> {
    self.stop_accepted_project(actor, operation, workspace, request).await
  }
  /// Create a new workspace and add the creator as its `Owner`.
  #[instrument(skip(self))]
  async fn create_workspace(&self, owner_id: UserId, name: WorkspaceName) -> AuthResult<Workspace> {
    trace!(%owner_id, "db create_workspace");
    self.create_user_workspace(owner_id, name, false).await
  }

  #[instrument(skip(self))]
  async fn create_personal_workspace(&self, owner_id: UserId, name: WorkspaceName) -> AuthResult<Workspace> {
    trace!(%owner_id, "db create_personal_workspace");
    self.create_user_workspace(owner_id, name, true).await
  }

  #[instrument(skip(self, root_update))]
  async fn create_shared_workspace(
    &self,
    owner_unit_id: OrganizationUnitId,
    creator_id: UserId,
    name: WorkspaceName,
    root_update: Vec<u8>,
  ) -> AuthResult<Workspace> {
    if root_update.is_empty() {
      return Err(AuthError::InvalidInput(
        "shared workspace root update must not be empty".to_string(),
      ));
    }
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    // The key-share lock closes the race with permanent OU deletion. It is
    // held until the workspace owner and relationship rows commit together.
    let owner_is_active = sqlx::query_scalar::<_, OrganizationUnitId>(
      "SELECT id FROM organization_unit WHERE id = $1 AND status = 'active' FOR UPDATE",
    )
    .bind(owner_unit_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if owner_is_active.is_none() {
      return Err(AuthError::InvalidInput(
        "organization unit cannot own workspaces".to_string(),
      ));
    }
    let creator_is_active =
      sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE")
        .bind(creator_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
    if creator_is_active.is_none() {
      return Err(AuthError::InvalidInput(
        "shared workspace administrator must be an active user".to_string(),
      ));
    }
    Self::require_available_name(&mut tx, "ou", owner_unit_id, &name, None).await?;
    let row = sqlx::query(
      r#"
      INSERT INTO workspaces (
        owner_user_id, owner_principal_type, owner_principal_id,
        management_unit_id, created_by_user_id, is_personal_workspace,
        name, name_normalized, public
      )
      SELECT NULL, 'ou'::owner_principal_type, ou.id, ou.id, $2, FALSE, $3, $4, FALSE
        FROM organization_unit ou
        JOIN organization_unit_type out ON out.id = ou.unit_type_id
       WHERE ou.id = $1
         AND ou.status = 'active'
         AND out.can_own_workspaces = TRUE
      RETURNING id, owner_user_id, name, description, avatar_key, public, enable_ai,
                enable_sharing, enable_url_preview, enable_doc_embedding,
                created_at, updated_at, initial_content_policy, overview_settings, overview_revision
      "#,
    )
    .bind(owner_unit_id)
    .bind(creator_id)
    .bind(name.display())
    .bind(name.normalized())
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::InvalidInput("organization unit cannot own workspaces".to_string()))?;
    let workspace_id: Uuid = row.get("id");

    sqlx::query(
      r#"
      INSERT INTO docs (id, workspace_id, title, is_workspace_root, created_by, updated_by)
      VALUES ($1, $1, $2, true, $3, $3)
      "#,
    )
    .bind(workspace_id)
    .bind(name.display())
    .bind(creator_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    sqlx::query(
      r#"
      INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
      VALUES ($1, $1, $2, 1)
      "#,
    )
    .bind(workspace_id)
    .bind(root_update)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    sqlx::query(
      r#"
      INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
      VALUES ($1, $2, 'Admin', 'Accepted', now())
      "#,
    )
    .bind(workspace_id)
    .bind(creator_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    sqlx::query(
      r#"
      INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship)
      VALUES ($1, $2, 'owner'::organization_unit_workspace_relationship)
      "#,
    )
    .bind(owner_unit_id)
    .bind(workspace_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    let state = myoxus_application::workspace::tasks::workspace_tasks_initial_state(
      &self.database_templates,
      workspace_id,
      Some(creator_id),
    )
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    crate::workspace_database::PgDatabaseRepository::ensure_workspace_tasks_in_tx(
      &mut tx,
      &self.database_templates,
      state,
    )
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    tx.commit().await.map_err(Self::map_db_err)?;
    info!(%workspace_id, %owner_unit_id, %creator_id, "shared workspace transaction committed");
    map_workspace_row(row).map_err(Self::map_db_err)
  }

  #[instrument(skip(self), fields(%owner_id, %workspace_id))]
  async fn create_importing_workspace(
    &self,
    import_id: WorkspaceImportId,
    owner_id: UserId,
    workspace_id: WorkspaceId,
    name: WorkspaceName,
  ) -> AuthResult<Workspace> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    Self::lock_name_principal(&mut tx, "user", owner_id).await?;
    // A replay owns the same preallocated target and therefore excludes it
    // from the reservation check. A different workspace with the same name
    // still produces the normal structured conflict.
    Self::require_available_name(&mut tx, "user", owner_id, &name, Some(workspace_id)).await?;
    let row = sqlx::query(
      r#"
      INSERT INTO workspaces (
        id, owner_user_id, name, name_normalized, public, lifecycle_state,
        lifecycle_owner_kind, lifecycle_owner_id
      )
      VALUES ($1, $2, $3, $4, false, 'importing', 'import', $5)
      ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
      WHERE workspaces.owner_user_id = EXCLUDED.owner_user_id
        AND workspaces.lifecycle_state = 'importing'
        AND workspaces.lifecycle_owner_kind = 'import'
        AND workspaces.lifecycle_owner_id = EXCLUDED.lifecycle_owner_id
        AND workspaces.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM workspace_memberships WHERE workspace_id = EXCLUDED.id
        )
      RETURNING id, owner_user_id, name, description, avatar_key, public, enable_ai,
                enable_sharing, enable_url_preview, enable_doc_embedding,
                created_at, updated_at, initial_content_policy, overview_settings, overview_revision
      "#,
    )
    .bind(workspace_id)
    .bind(owner_id)
    .bind(name.display())
    .bind(name.normalized())
    .bind(import_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::InvalidInput("workspace import target identity conflicts".to_string()))?;
    sqlx::query(
      r#"
      INSERT INTO docs (id, workspace_id, title, is_workspace_root, created_by, updated_by)
      VALUES ($1, $1, $2, true, $3, $3)
      ON CONFLICT (id) DO NOTHING
      "#,
    )
    .bind(workspace_id)
    .bind(name.display())
    .bind(owner_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    let state = myoxus_application::workspace::tasks::workspace_tasks_initial_state(
      &self.database_templates,
      workspace_id,
      Some(owner_id),
    )
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    crate::workspace_database::PgDatabaseRepository::ensure_workspace_tasks_in_tx(
      &mut tx,
      &self.database_templates,
      state,
    )
    .await
    .map_err(|error| AuthError::Storage(error.to_string()))?;
    tx.commit().await.map_err(Self::map_db_err)?;
    map_workspace_row(row).map_err(Self::map_db_err)
  }

  #[instrument(skip(self), fields(%workspace_id, %owner_id))]
  async fn publish_importing_workspace(
    &self,
    import_id: WorkspaceImportId,
    workspace_id: WorkspaceId,
    owner_id: UserId,
  ) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let activated = sqlx::query(
      "UPDATE workspaces
          SET lifecycle_state = 'active',
              lifecycle_owner_kind = NULL,
              lifecycle_owner_id = NULL,
              updated_at = now()
        WHERE id = $1
          AND owner_user_id = $2
          AND lifecycle_state = 'importing'
          AND lifecycle_owner_kind = 'import'
          AND lifecycle_owner_id = $3
          AND deleted_at IS NULL",
    )
    .bind(workspace_id)
    .bind(owner_id)
    .bind(import_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if activated.rows_affected() != 1 {
      return Err(AuthError::NotFound("workspace import target".to_string()));
    }
    sqlx::query(
      r#"
      INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
      VALUES ($1, $2, 'Owner', 'Accepted', now())
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET
        role = 'Owner', status = 'Accepted', joined_at = COALESCE(workspace_memberships.joined_at, now())
      "#,
    )
    .bind(workspace_id)
    .bind(owner_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)
  }

  #[instrument(skip(self), fields(%workspace_id))]
  async fn hard_delete_importing_workspace(
    &self,
    import_id: WorkspaceImportId,
    workspace_id: WorkspaceId,
  ) -> AuthResult<()> {
    let result = sqlx::query(
      r#"
      DELETE FROM workspaces w
      WHERE w.id = $1
        AND w.lifecycle_state = 'importing'
        AND w.lifecycle_owner_kind = 'import'
        AND w.lifecycle_owner_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM workspace_memberships m WHERE m.workspace_id = w.id
        )
      "#,
    )
    .bind(workspace_id)
    .bind(import_id)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    if result.rows_affected() > 1 {
      return Err(AuthError::Storage(
        "workspace import cleanup deleted an invalid number of targets".to_string(),
      ));
    }
    if result.rows_affected() == 1 {
      return Ok(());
    }

    // A missing target means an earlier compensation attempt already removed
    // it. A target that still exists failed the safety predicate and must keep
    // the import in cleanup_required; treating both cases as success would
    // complete the durable ledger while leaking a partial workspace.
    let target_still_exists = sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM workspaces WHERE id = $1)")
      .bind(workspace_id)
      .fetch_one(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    if target_still_exists {
      return Err(AuthError::Storage(
        "workspace import cleanup target is not safe to delete".to_string(),
      ));
    }
    Ok(())
  }

  /// Fetch a workspace by ID, returning `None` when not found.
  #[instrument(skip(self))]
  async fn get_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<Option<Workspace>> {
    trace!(%workspace_id, "db get_workspace");
    let row = sqlx::query(
            r#"
            SELECT id, owner_user_id, name, description, avatar_key, public, enable_ai, enable_sharing, enable_url_preview, enable_doc_embedding, created_at, updated_at, initial_content_policy, overview_settings, overview_revision
            FROM workspaces
            WHERE id = $1 AND deleted_at IS NULL AND lifecycle_state = 'active'
            "#
        )
        .bind(workspace_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(Self::map_db_err)?;

    Ok(row.map(map_workspace_row).transpose().map_err(Self::map_db_err)?)
  }

  #[instrument(skip(self))]
  async fn workspace_classification(
    &self,
    workspace_id: WorkspaceId,
  ) -> AuthResult<Option<myoxus_application::workspace::WorkspaceClassification>> {
    let classification = sqlx::query_scalar::<_, String>(
      r#"SELECT CASE
           WHEN is_personal_workspace THEN 'personal'
           WHEN owner_principal_type = 'ou' THEN 'shared'
           ELSE 'user_owned'
         END
         FROM workspaces
         WHERE id = $1 AND deleted_at IS NULL AND lifecycle_state = 'active'"#,
    )
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(classification.map(|value| match value.as_str() {
      "personal" => myoxus_application::workspace::WorkspaceClassification::Personal,
      "shared" => myoxus_application::workspace::WorkspaceClassification::Shared,
      _ => myoxus_application::workspace::WorkspaceClassification::UserOwned,
    }))
  }

  #[instrument(skip(self))]
  async fn get_internal_workspace(
    &self,
    workspace_id: WorkspaceId,
    lifecycle_state: WorkspaceLifecycleState,
    owner_kind: WorkspaceLifecycleOwnerKind,
    owner_id: Uuid,
  ) -> AuthResult<Option<Workspace>> {
    if lifecycle_state == WorkspaceLifecycleState::Active {
      return Err(AuthError::InvalidInput(
        "active workspaces must use the normal lookup".to_string(),
      ));
    }
    let row = sqlx::query(
      r#"
      SELECT id, owner_user_id, name, description, avatar_key, public, enable_ai,
             enable_sharing, enable_url_preview, enable_doc_embedding,
             created_at, updated_at, initial_content_policy, overview_settings, overview_revision
        FROM workspaces
       WHERE id = $1
         AND deleted_at IS NULL
         AND lifecycle_state = $2
         AND lifecycle_owner_kind = $3
         AND lifecycle_owner_id = $4
      "#,
    )
    .bind(workspace_id)
    .bind(lifecycle_state.as_str())
    .bind(owner_kind.as_str())
    .bind(owner_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.map(map_workspace_row).transpose().map_err(Self::map_db_err)?)
  }

  /// List all workspaces where the user has an accepted membership.
  #[instrument(skip(self))]
  async fn list_user_workspaces(&self, user_id: UserId) -> AuthResult<Vec<Workspace>> {
    trace!(%user_id, "db list_user_workspaces");
    let rows = sqlx::query(
            r#"
            SELECT w.id, w.owner_user_id, w.name, w.description, w.avatar_key, w.public, w.enable_ai, w.enable_sharing, w.enable_url_preview, w.enable_doc_embedding, w.created_at, w.updated_at, w.initial_content_policy, w.overview_settings, w.overview_revision
            FROM workspaces w
            JOIN workspace_memberships m ON w.id = m.workspace_id
            WHERE m.user_id = $1 AND m.status = 'Accepted' AND w.deleted_at IS NULL AND w.lifecycle_state = 'active'
            "#
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(Self::map_db_err)?;

    rows
      .into_iter()
      .map(map_workspace_row)
      .collect::<Result<Vec<_>, _>>()
      .map_err(Self::map_db_err)
  }

  #[instrument(skip(self))]
  async fn has_managed_workspace(&self, user_id: UserId) -> AuthResult<bool> {
    sqlx::query_scalar(
      r#"SELECT EXISTS(
           SELECT 1
           FROM workspace_memberships membership
           JOIN workspaces workspace ON workspace.id = membership.workspace_id
             AND workspace.lifecycle_state = 'active'
             AND workspace.deleted_at IS NULL
           WHERE membership.user_id = $1
             AND membership.role IN ('Admin', 'Owner')
             AND membership.status = 'Accepted'
         )"#,
    )
    .bind(user_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)
  }

  /// Partial-update workspace metadata.
  ///
  /// All `Option` fields use COALESCE — `None` leaves the column unchanged.
  /// `storage_quota_update` uses a CASE WHEN pattern to distinguish between
  /// "leave unchanged", "clear to NULL", and "set to a specific value".
  /// COALESCE cannot express the clear intent because COALESCE($n, col) can
  /// never produce NULL when col is non-NULL.
  #[instrument(skip_all)]
  async fn update_workspace(&self, workspace_id: WorkspaceId, update: UpdateWorkspace) -> AuthResult<Workspace> {
    use myoxus_application::workspace::QuotaUpdate;

    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    if let Some(name) = &update.name {
      let owner = sqlx::query(
        r#"
        SELECT owner_principal_type::text AS principal_type, owner_principal_id
          FROM workspaces
         WHERE id = $1 AND deleted_at IS NULL AND lifecycle_state = 'active'
         FOR UPDATE
        "#,
      )
      .bind(workspace_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?
      .ok_or_else(|| AuthError::NotFound("workspace".to_string()))?;
      let principal_type: String = owner.get("principal_type");
      let principal_id: Option<Uuid> = owner.get("owner_principal_id");
      let principal_id = principal_id
        .ok_or_else(|| AuthError::InvalidInput("workspace owner principal cannot reserve names".to_string()))?;
      Self::lock_name_principal(&mut tx, &principal_type, principal_id).await?;
      Self::require_available_name(&mut tx, &principal_type, principal_id, name, Some(workspace_id)).await?;
    }

    // Both settings patches and content publication share this row/revision
    // fence; the remaining partial UPDATE cannot replace overview data.
    if let Some(patch) = &update.overview {
      let (current, revision) = Self::lock_overview_in_transaction(&mut tx, workspace_id).await?;
      let (settings, _) = patch.apply(workspace_id, &current, revision).map_err(AuthError::from)?;
      Self::write_overview_in_transaction(&mut tx, workspace_id, revision, &settings).await?;
    }

    // Decompose QuotaUpdate into (apply: bool, value: Option<i64>) for CASE WHEN.
    let (apply_quota, quota_bytes_value): (bool, Option<i64>) = match update.storage_quota_update {
      QuotaUpdate::Unchanged => (false, None),
      QuotaUpdate::Clear => (true, None),
      QuotaUpdate::Set(b) => (true, Some(b)),
    };

    trace!(
      %workspace_id,
      apply_quota,
      quota_bytes_value = ?quota_bytes_value,
      "update_workspace: executing partial UPDATE"
    );

    let row = sqlx::query(
      r#"
      UPDATE workspaces
      SET
          name                = COALESCE($2,  name),
          name_normalized     = COALESCE($3,  name_normalized),
          description         = COALESCE($4,  description),
          avatar_key          = COALESCE($5,  avatar_key),
          public              = COALESCE($6,  public),
          enable_ai           = COALESCE($7,  enable_ai),
          enable_sharing      = COALESCE($8,  enable_sharing),
          enable_url_preview  = COALESCE($9,  enable_url_preview),
          enable_doc_embedding= COALESCE($10, enable_doc_embedding),
          storage_quota_bytes = CASE WHEN $11 THEN $12 ELSE storage_quota_bytes END,
          updated_at          = now()
      WHERE id = $1 AND deleted_at IS NULL AND lifecycle_state = 'active'
      RETURNING id, owner_user_id, name, description, avatar_key, public, enable_ai, enable_sharing,
                enable_url_preview, enable_doc_embedding, created_at, updated_at, initial_content_policy, overview_settings, overview_revision
      "#,
    )
    .bind(workspace_id)
    .bind(update.name.as_ref().map(WorkspaceName::display))
    .bind(update.name.as_ref().map(WorkspaceName::normalized))
    .bind(update.description)
    .bind(update.avatar_key)
    .bind(update.public)
    .bind(update.enable_ai)
    .bind(update.enable_sharing)
    .bind(update.enable_url_preview)
    .bind(update.enable_doc_embedding)
    .bind(apply_quota)
    .bind(quota_bytes_value)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    tx.commit().await.map_err(Self::map_db_err)?;
    map_workspace_row(row).map_err(Self::map_db_err)
  }

  /// Soft-delete a workspace by setting `deleted_at`.
  #[instrument(skip(self))]
  async fn delete_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<()> {
    sqlx::query("UPDATE workspaces SET deleted_at = now() WHERE id = $1")
      .bind(workspace_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Restore a deleted workspace only after revalidating its owner and name.
  #[instrument(skip(self))]
  async fn undelete_workspace(&self, workspace_id: WorkspaceId) -> AuthResult<Workspace> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let current = sqlx::query_as::<_, (String, Option<Uuid>, String, bool, Option<DateTime<Utc>>)>(
      r#"
      SELECT owner_principal_type::text, owner_principal_id, name,
             is_personal_workspace, deleted_at
        FROM workspaces
       WHERE id = $1 AND lifecycle_state = 'active'
       FOR UPDATE
      "#,
    )
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::NotFound("workspace".to_string()))?;
    let (owner_type, owner_id, current_name, personal, deleted_at) = current;
    if deleted_at.is_some() {
      let owner_id = owner_id.ok_or_else(|| {
        AuthError::InvalidInput("ownerless workspace cannot be restored through the lifecycle CLI".to_string())
      })?;
      let name = WorkspaceName::parse(&current_name).map_err(|error| AuthError::InvalidInput(error.to_string()))?;
      match owner_type.as_str() {
        "user" => {
          let active =
            sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE")
              .bind(owner_id)
              .fetch_optional(&mut *tx)
              .await
              .map_err(Self::map_db_err)?;
          if active.is_none() {
            return Err(AuthError::InvalidInput(
              "workspace owner must be an active user".to_string(),
            ));
          }
          Self::require_available_name(&mut tx, "user", owner_id, &name, Some(workspace_id)).await?;
          if personal {
            let another_personal: bool = sqlx::query_scalar(
              r#"
              SELECT EXISTS(
                SELECT 1 FROM workspaces
                 WHERE owner_user_id = $1 AND is_personal_workspace = TRUE
                   AND deleted_at IS NULL AND id <> $2
              )
              "#,
            )
            .bind(owner_id)
            .bind(workspace_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(Self::map_db_err)?;
            if another_personal {
              return Err(AuthError::InvalidInput(
                "user already has an active personal workspace".to_string(),
              ));
            }
          }
          let owner_membership: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM workspace_memberships
              WHERE workspace_id = $1 AND user_id = $2
                AND role = 'Owner' AND status = 'Accepted')",
          )
          .bind(workspace_id)
          .bind(owner_id)
          .fetch_one(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
          if !owner_membership {
            return Err(AuthError::InvalidInput(
              "user-owned workspace requires its accepted Owner membership".to_string(),
            ));
          }
        }
        "ou" => {
          let active_owner_link: bool = sqlx::query_scalar(
            r#"
            SELECT EXISTS(
              SELECT 1
                FROM organization_unit ou
                JOIN organization_unit_type out ON out.id = ou.unit_type_id
                JOIN organization_unit_workspace ouw
                  ON ouw.unit_id = ou.id AND ouw.workspace_id = $2
                 AND ouw.relationship = 'owner'
               WHERE ou.id = $1 AND ou.status = 'active'
                 AND out.can_own_workspaces = TRUE
            )
            "#,
          )
          .bind(owner_id)
          .bind(workspace_id)
          .fetch_one(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
          if !active_owner_link {
            return Err(AuthError::InvalidInput(
              "OU-owned workspace requires its active owner relationship".to_string(),
            ));
          }
          Self::require_available_name(&mut tx, "ou", owner_id, &name, Some(workspace_id)).await?;
          let admin_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*)
               FROM workspace_memberships membership
               JOIN users member ON member.id = membership.user_id AND member.status = 'active'
              WHERE membership.workspace_id = $1
                AND membership.role = 'Admin' AND membership.status = 'Accepted'",
          )
          .bind(workspace_id)
          .fetch_one(&mut *tx)
          .await
          .map_err(Self::map_db_err)?;
          if admin_count == 0 {
            return Err(AuthError::InvalidInput(
              "OU-owned workspace requires an active administrator".to_string(),
            ));
          }
        }
        _ => {
          return Err(AuthError::InvalidInput(
            "ownerless workspace cannot be restored through the lifecycle CLI".to_string(),
          ));
        }
      }
    }

    let row = sqlx::query(
      r#"
      UPDATE workspaces
         SET deleted_at = NULL,
             updated_at = CASE WHEN deleted_at IS NULL THEN updated_at ELSE NOW() END
       WHERE id = $1
       RETURNING id, owner_user_id, name, description, avatar_key, public, enable_ai,
                 enable_sharing, enable_url_preview, enable_doc_embedding,
                 created_at, updated_at, deleted_at, initial_content_policy, overview_settings, overview_revision
      "#,
    )
    .bind(workspace_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    map_workspace_row(row).map_err(Self::map_db_err)
  }

  #[instrument(skip(self))]
  async fn transfer_workspace_owner(&self, workspace_id: WorkspaceId, target: WorkspaceOwnerTarget) -> AuthResult<()> {
    self
      .transfer_workspace_owner_transaction(workspace_id, target, None)
      .await
  }

  /// Keep the scalar management projection and the OU relationship in sync.
  #[instrument(skip(self))]
  async fn set_management_unit(
    &self,
    workspace_id: WorkspaceId,
    management_unit_id: Option<OrganizationUnitId>,
  ) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    let current = sqlx::query_as::<_, (String, Option<Uuid>, Option<Uuid>)>(
      r#"
      SELECT owner_principal_type::text, owner_principal_id, management_unit_id
        FROM workspaces
       WHERE id = $1 AND lifecycle_state = 'active' AND deleted_at IS NULL
       FOR UPDATE
      "#,
    )
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::NotFound("workspace".to_string()))?;
    let (owner_type, owner_id, previous_unit_id) = current;

    if let Some(unit_id) = management_unit_id {
      let active = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM organization_unit WHERE id = $1 AND status = 'active' FOR UPDATE",
      )
      .bind(unit_id)
      .fetch_optional(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if active.is_none() {
        return Err(AuthError::InvalidInput("management unit must be active".to_string()));
      }
    }

    if let Some(previous_unit_id) = previous_unit_id
      && !(owner_type == "ou" && owner_id == Some(previous_unit_id))
      && Some(previous_unit_id) != management_unit_id
    {
      sqlx::query(
        "DELETE FROM organization_unit_workspace
          WHERE unit_id = $1 AND workspace_id = $2 AND relationship = 'managed'",
      )
      .bind(previous_unit_id)
      .bind(workspace_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }
    if let Some(unit_id) = management_unit_id
      && !(owner_type == "ou" && owner_id == Some(unit_id))
    {
      sqlx::query("DELETE FROM organization_unit_workspace WHERE unit_id = $1 AND workspace_id = $2")
        .bind(unit_id)
        .bind(workspace_id)
        .execute(&mut *tx)
        .await
        .map_err(Self::map_db_err)?;
      sqlx::query(
        r#"
        INSERT INTO organization_unit_workspace (unit_id, workspace_id, relationship)
        VALUES ($1, $2, 'managed'::organization_unit_workspace_relationship)
        "#,
      )
      .bind(unit_id)
      .bind(workspace_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    }
    sqlx::query("UPDATE workspaces SET management_unit_id = $2, updated_at = NOW() WHERE id = $1")
      .bind(workspace_id)
      .bind(management_unit_id)
      .execute(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  /// List accepted members in total creation-time/user-ID order for offset pagination.
  /// The tie-breaker stabilizes equal timestamps, not membership changes between pages.
  #[instrument(skip(self))]
  async fn list_workspace_members(
    &self,
    workspace_id: WorkspaceId,
    skip: i64,
    take: i64,
    query: Option<String>,
  ) -> AuthResult<Vec<WorkspaceMember>> {
    let q = format!("%{}%", query.unwrap_or_default());
    let rows = sqlx::query(
            r#"
            SELECT
                u.id as user_id, u.name as user_name, u.email as user_email, u.email_verified_at as user_email_verified_at,
                u.avatar_key as user_avatar_key, u.created_at as user_created_at, u.updated_at as user_updated_at,
                (u.password_hash IS NOT NULL) AS user_has_password, u.status as user_status, u.is_admin as user_is_admin,
                m.invited_by_user_id as member_inviter_id, m.id as member_invite_id, m.role as member_role, m.status as member_status, m.workspace_id as member_workspace_id
            FROM workspace_memberships m
            JOIN users u ON m.user_id = u.id AND u.status <> 'deleted'
            JOIN workspaces w ON w.id = m.workspace_id
              AND w.lifecycle_state = 'active'
              AND w.deleted_at IS NULL
            WHERE m.workspace_id = $1 AND m.status = 'Accepted' AND (u.email ILIKE $2 OR u.name ILIKE $2)
            ORDER BY u.created_at ASC, u.id ASC
            LIMIT $3 OFFSET $4
            "#
        )
        .bind(workspace_id)
        .bind(q)
        .bind(take)
        .bind(skip)
        .fetch_all(&self.pool)
        .await
        .map_err(Self::map_db_err)?;

    rows
      .into_iter()
      .map(map_member_row)
      .collect::<Result<Vec<_>, _>>()
      .map_err(Self::map_db_err)
  }

  /// Count accepted members in a workspace.
  #[instrument(skip(self))]
  async fn count_workspace_members(&self, workspace_id: WorkspaceId) -> AuthResult<i64> {
    let row = sqlx::query(
      r#"
      SELECT COUNT(*)
        FROM workspace_memberships m
        JOIN workspaces w ON w.id = m.workspace_id
         AND w.lifecycle_state = 'active'
         AND w.deleted_at IS NULL
       WHERE m.workspace_id = $1 AND m.status = 'Accepted'
      "#,
    )
    .bind(workspace_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.get(0))
  }

  /// Fetch the user who holds the `Owner` role in a workspace.
  #[instrument(skip(self))]
  async fn get_workspace_owner(&self, workspace_id: WorkspaceId) -> AuthResult<Option<User>> {
    let row = sqlx::query(
      r#"
            SELECT u.id, u.name, u.email, u.email_verified_at, u.avatar_key, u.created_at, u.updated_at,
                   (u.password_hash IS NOT NULL) AS has_password, u.status, u.is_admin
            FROM workspaces w
            JOIN users u ON w.owner_user_id = u.id AND u.status <> 'deleted'
            WHERE w.id = $1 AND w.deleted_at IS NULL AND w.lifecycle_state = 'active'
            "#,
    )
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.map(map_user_row_from_users).transpose().map_err(Self::map_db_err)?)
  }

  /// Insert or update a workspace membership (upserts on `(workspace_id, user_id)`).
  #[instrument(skip(self))]
  async fn add_or_update_member(
    &self,
    workspace_id: WorkspaceId,
    user_id: UserId,
    role: WorkspaceRole,
    status: MembershipStatus,
    inviter_id: Option<UserId>,
  ) -> AuthResult<WorkspaceMember> {
    let role_str = match role {
      WorkspaceRole::Owner => "Owner",
      WorkspaceRole::Admin => "Admin",
      WorkspaceRole::Manager => "Manager",
      WorkspaceRole::Collaborator => "Collaborator",
      WorkspaceRole::Commenter => "Commenter",
      WorkspaceRole::Reader => "Reader",
      WorkspaceRole::External => "External",
    };
    let status_str = match status {
      MembershipStatus::Pending => "Pending",
      MembershipStatus::UnderReview => "UnderReview",
      MembershipStatus::AllocatingSeat => "AllocatingSeat",
      MembershipStatus::NeedMoreSeat => "NeedMoreSeat",
      MembershipStatus::Accepted => "Accepted",
      MembershipStatus::Revoked => "Revoked",
    };

    let row = sqlx::query(
      r#"
            INSERT INTO workspace_memberships (workspace_id, user_id, role, status, invited_by_user_id, joined_at)
            SELECT w.id, $2, $3, $4, $5, CASE WHEN $4 = 'Accepted' THEN now() ELSE NULL END
              FROM workspaces w
             WHERE w.id = $1
               AND w.lifecycle_state = 'active'
               AND w.deleted_at IS NULL
            ON CONFLICT (workspace_id, user_id) DO UPDATE SET
                role = EXCLUDED.role,
                status = EXCLUDED.status,
                invited_by_user_id = COALESCE(EXCLUDED.invited_by_user_id, workspace_memberships.invited_by_user_id),
                joined_at = COALESCE(workspace_memberships.joined_at, EXCLUDED.joined_at),
                updated_at = now()
            RETURNING id
            "#,
    )
    .bind(workspace_id)
    .bind(user_id)
    .bind(role_str)
    .bind(status_str)
    .bind(inviter_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    let invite_id: Uuid = row.get("id");
    self
      .get_member_by_invite_id(invite_id)
      .await?
      .ok_or_else(|| AuthError::Storage("Member not found after upsert".into()))
  }

  /// Fetch a single workspace member record, returning `None` when not found.
  #[instrument(skip(self))]
  async fn get_member(&self, workspace_id: WorkspaceId, user_id: UserId) -> AuthResult<Option<WorkspaceMember>> {
    let row = sqlx::query(
            r#"
            SELECT
                u.id as user_id, u.name as user_name, u.email as user_email, u.email_verified_at as user_email_verified_at,
                u.avatar_key as user_avatar_key, u.created_at as user_created_at, u.updated_at as user_updated_at,
                (u.password_hash IS NOT NULL) AS user_has_password, u.status as user_status, u.is_admin as user_is_admin,
                m.invited_by_user_id as member_inviter_id, m.id as member_invite_id, m.role as member_role, m.status as member_status, m.workspace_id as member_workspace_id
            FROM workspace_memberships m
            JOIN users u ON m.user_id = u.id AND u.status <> 'deleted'
            JOIN workspaces w ON w.id = m.workspace_id
              AND w.lifecycle_state = 'active'
              AND w.deleted_at IS NULL
            WHERE m.workspace_id = $1 AND m.user_id = $2
            "#
        )
        .bind(workspace_id)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(Self::map_db_err)?;

    Ok(row.map(map_member_row).transpose().map_err(Self::map_db_err)?)
  }

  /// Fetch a workspace member by their invite UUID.
  #[instrument(skip(self))]
  async fn get_member_by_invite_id(&self, invite_id: InviteLinkId) -> AuthResult<Option<WorkspaceMember>> {
    let row = sqlx::query(
            r#"
            SELECT
                u.id as user_id, u.name as user_name, u.email as user_email, u.email_verified_at as user_email_verified_at,
                u.avatar_key as user_avatar_key, u.created_at as user_created_at, u.updated_at as user_updated_at,
                (u.password_hash IS NOT NULL) AS user_has_password, u.status as user_status, u.is_admin as user_is_admin,
                m.invited_by_user_id as member_inviter_id, m.id as member_invite_id, m.role as member_role, m.status as member_status, m.workspace_id as member_workspace_id
            FROM workspace_memberships m
            JOIN users u ON m.user_id = u.id AND u.status <> 'deleted'
            JOIN workspaces w ON w.id = m.workspace_id
              AND w.lifecycle_state = 'active'
              AND w.deleted_at IS NULL
            WHERE m.id = $1
            "#
        )
        .bind(invite_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(Self::map_db_err)?;

    Ok(row.map(map_member_row).transpose().map_err(Self::map_db_err)?)
  }

  /// Hard-delete a workspace member row.
  #[instrument(skip(self))]
  async fn delete_member(&self, workspace_id: WorkspaceId, user_id: UserId) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    // Membership metadata triggers update Docs. Keep governance serialized
    // without blocking a Doc writer's FK KEY SHARE on this unchanged parent key.
    let owner_type = sqlx::query_scalar::<_, String>(
      "SELECT owner_principal_type::text FROM workspaces
        WHERE id = $1 AND lifecycle_state = 'active' AND deleted_at IS NULL
        FOR NO KEY UPDATE",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::NotFound("workspace".to_string()))?;
    let target = sqlx::query_as::<_, (String, String)>(
      "SELECT role::text, status::text FROM workspace_memberships
        WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::InvalidInput("MemberNotFoundInSpace".to_string()))?;
    if target.0 == "Owner" {
      return Err(AuthError::InvalidInput(
        "workspace owner must be transferred before removal".to_string(),
      ));
    }
    if owner_type == "ou" && target.0 == "Admin" && target.1 == "Accepted" {
      let other_admins: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
           FROM workspace_memberships membership
           JOIN users member ON member.id = membership.user_id AND member.status = 'active'
          WHERE membership.workspace_id = $1 AND membership.user_id <> $2
            AND membership.role = 'Admin' AND membership.status = 'Accepted'",
      )
      .bind(workspace_id)
      .bind(user_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if other_admins == 0 {
        return Err(AuthError::InvalidInput(
          "OU-owned workspace requires an active administrator".to_string(),
        ));
      }
    }
    sqlx::query(
      r#"
      DELETE FROM workspace_memberships m
       USING workspaces w
       WHERE m.workspace_id = $1
         AND m.user_id = $2
         AND w.id = m.workspace_id
         AND w.lifecycle_state = 'active'
         AND w.deleted_at IS NULL
      "#,
    )
    .bind(workspace_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Update a member's role within the workspace.
  ///
  /// This changes only `workspace_memberships.role`. Organization-unit roles
  /// and manager capabilities are separate governance axes and must not be
  /// inferred from this row or silently synchronized here.
  #[instrument(skip(self))]
  async fn update_member_role(
    &self,
    workspace_id: WorkspaceId,
    user_id: UserId,
    role: WorkspaceRole,
  ) -> AuthResult<()> {
    if role == WorkspaceRole::Owner {
      return Err(AuthError::InvalidInput(
        "workspace owner changes must use ownership transfer".to_string(),
      ));
    }
    let role_str = match role {
      WorkspaceRole::Owner => unreachable!("Owner role rejected above"),
      WorkspaceRole::Admin => "Admin",
      WorkspaceRole::Manager => "Manager",
      WorkspaceRole::Collaborator => "Collaborator",
      WorkspaceRole::Commenter => "Commenter",
      WorkspaceRole::Reader => "Reader",
      WorkspaceRole::External => "External",
    };

    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;
    // Membership metadata triggers update Docs. Keep governance serialized
    // without blocking a Doc writer's FK KEY SHARE on this unchanged parent key.
    let owner_type = sqlx::query_scalar::<_, String>(
      "SELECT owner_principal_type::text FROM workspaces
        WHERE id = $1 AND lifecycle_state = 'active' AND deleted_at IS NULL
        FOR NO KEY UPDATE",
    )
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::NotFound("workspace".to_string()))?;
    let target = sqlx::query_as::<_, (String, String)>(
      "SELECT role::text, status::text FROM workspace_memberships
        WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(workspace_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::InvalidInput("MemberNotFoundInSpace".to_string()))?;
    if target.0 == "Owner" {
      return Err(AuthError::InvalidInput(
        "workspace owner changes must use ownership transfer".to_string(),
      ));
    }
    if owner_type == "ou" && target.0 == "Admin" && target.1 == "Accepted" && role != WorkspaceRole::Admin {
      let other_admins: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)
           FROM workspace_memberships membership
           JOIN users member ON member.id = membership.user_id AND member.status = 'active'
          WHERE membership.workspace_id = $1 AND membership.user_id <> $2
            AND membership.role = 'Admin' AND membership.status = 'Accepted'",
      )
      .bind(workspace_id)
      .bind(user_id)
      .fetch_one(&mut *tx)
      .await
      .map_err(Self::map_db_err)?;
      if other_admins == 0 {
        return Err(AuthError::InvalidInput(
          "OU-owned workspace requires an active administrator".to_string(),
        ));
      }
    }
    let updated = sqlx::query(
      r#"
      UPDATE workspace_memberships m
         SET role = $3, updated_at = now()
        FROM workspaces w
       WHERE m.workspace_id = $1
         AND m.user_id = $2
         AND w.id = m.workspace_id
         AND w.lifecycle_state = 'active'
         AND w.deleted_at IS NULL
      "#,
    )
    .bind(workspace_id)
    .bind(user_id)
    .bind(role_str)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;
    if updated.rows_affected() != 1 {
      return Err(AuthError::InvalidInput("MemberNotFoundInSpace".to_string()));
    }
    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Transfer workspace ownership atomically: demote the current owner to
  /// `Admin` and promote the new owner to `Owner`.
  #[instrument(skip(self))]
  async fn transfer_ownership(
    &self,
    workspace_id: WorkspaceId,
    current_owner_id: UserId,
    new_owner_id: UserId,
  ) -> AuthResult<()> {
    self
      .transfer_workspace_owner_transaction(
        workspace_id,
        WorkspaceOwnerTarget::User(new_owner_id),
        Some(current_owner_id),
      )
      .await
  }

  #[instrument(skip(self))]
  async fn list_orphaned_workspaces(&self, skip: i64, take: i64) -> AuthResult<Vec<Workspace>> {
    // A workspace is "orphaned" when it is not soft-deleted AND any of:
    //   1. it is system-owned (has no owner principal)
    //   2. its user owner no longer exists
    //   3. workspace has zero accepted memberships (fully abandoned)
    let rows = sqlx::query(
      r#"
      SELECT w.id, w.owner_user_id, w.name, w.description, w.avatar_key, w.public, w.enable_ai,
             w.enable_sharing, w.enable_url_preview, w.enable_doc_embedding,
             w.created_at, w.updated_at, w.initial_content_policy, w.overview_settings, w.overview_revision
      FROM workspaces w
      WHERE w.deleted_at IS NULL AND w.lifecycle_state = 'active'
        AND w.owner_principal_type <> 'ou'
        AND (
          w.owner_principal_type = 'system'
          OR (
            w.owner_principal_type = 'user'
            AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = w.owner_user_id)
          )
          OR NOT EXISTS (
            SELECT 1 FROM workspace_memberships m
            WHERE m.workspace_id = w.id AND m.status = 'Accepted'
          )
        )
      ORDER BY w.created_at DESC
      LIMIT $1 OFFSET $2
      "#,
    )
    .bind(take)
    .bind(skip)
    .fetch_all(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    rows
      .into_iter()
      .map(map_workspace_row)
      .collect::<Result<Vec<_>, _>>()
      .map_err(Self::map_db_err)
  }

  #[instrument(skip_all)]
  async fn count_orphaned_workspaces(&self) -> AuthResult<i64> {
    let row = sqlx::query(
      r#"
      SELECT COUNT(*)
      FROM workspaces w
      WHERE w.deleted_at IS NULL AND w.lifecycle_state = 'active'
        AND w.owner_principal_type <> 'ou'
        AND (
          w.owner_principal_type = 'system'
          OR (
            w.owner_principal_type = 'user'
            AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = w.owner_user_id)
          )
          OR NOT EXISTS (
            SELECT 1 FROM workspace_memberships m
            WHERE m.workspace_id = w.id AND m.status = 'Accepted'
          )
        )
      "#,
    )
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(row.get(0))
  }

  #[instrument(skip(self))]
  async fn reassign_workspace_owner(&self, workspace_id: WorkspaceId, new_owner_id: UserId) -> AuthResult<()> {
    let mut tx = self.pool.begin().await.map_err(Self::map_db_err)?;

    Self::lock_name_principal(&mut tx, "user", new_owner_id).await?;
    let current = sqlx::query(
      r#"
      SELECT name
        FROM workspaces
       WHERE id = $1
         AND owner_principal_type = 'system'
         AND lifecycle_state = 'active'
         AND deleted_at IS NULL
       FOR UPDATE
      "#,
    )
    .bind(workspace_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(Self::map_db_err)?
    .ok_or_else(|| AuthError::InvalidInput("workspace is not server-classified as ownerless".to_string()))?;
    let name = WorkspaceName::parse(current.get("name")).map_err(|error| AuthError::InvalidInput(error.to_string()))?;
    Self::require_available_name(&mut tx, "user", new_owner_id, &name, Some(workspace_id)).await?;

    let result = sqlx::query(
      r#"
      UPDATE workspaces
      SET owner_user_id = $2,
          owner_principal_type = 'user',
          owner_principal_id = $2,
          updated_at = now()
      WHERE id = $1
        AND owner_principal_type = 'system'
        AND lifecycle_state = 'active'
        AND deleted_at IS NULL
      "#,
    )
    .bind(workspace_id)
    .bind(new_owner_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    if result.rows_affected() != 1 {
      return Err(AuthError::InvalidInput(
        "workspace is not server-classified as ownerless".to_string(),
      ));
    }

    // Upsert membership: add new owner with Owner role if not already a member
    sqlx::query(
      r#"
      INSERT INTO workspace_memberships (workspace_id, user_id, role, status, joined_at)
      VALUES ($1, $2, 'Owner', 'Accepted', now())
      ON CONFLICT (workspace_id, user_id) DO UPDATE
        SET role = 'Owner', status = 'Accepted', updated_at = now()
      "#,
    )
    .bind(workspace_id)
    .bind(new_owner_id)
    .execute(&mut *tx)
    .await
    .map_err(Self::map_db_err)?;

    tx.commit().await.map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Persist an invitation using the deployed opaque-token representation.
  ///
  /// The historical `token_hash` name is retained; the supplied value is stored
  /// unchanged and excluded from spans. Revocation remains a separate owner.
  #[instrument(skip(self, token_hash))]
  async fn create_invite_link(
    &self,
    workspace_id: WorkspaceId,
    inviter_id: UserId,
    token_hash: &str,
    expire_at: DateTime<Utc>,
  ) -> AuthResult<WorkspaceInviteLink> {
    let row = sqlx::query(
      r#"
            INSERT INTO workspace_invite_links (workspace_id, created_by_user_id, token_hash, expires_at)
            VALUES ($1, $2, $3, $4)
            RETURNING id, workspace_id, created_by_user_id, token_hash, expires_at, revoked_at, created_at
            "#,
    )
    .bind(workspace_id)
    .bind(inviter_id)
    .bind(token_hash)
    .bind(expire_at)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    map_invite_link_row(row).map_err(Self::map_db_err)
  }

  /// Fetch the current invite link for a workspace.
  #[instrument(skip(self))]
  async fn get_invite_link(&self, workspace_id: WorkspaceId) -> AuthResult<Option<WorkspaceInviteLink>> {
    let row = sqlx::query(
      r#"
            SELECT id, workspace_id, created_by_user_id, token_hash, expires_at, revoked_at, created_at
            FROM workspace_invite_links
            WHERE workspace_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
            LIMIT 1
            "#,
    )
    .bind(workspace_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.map(map_invite_link_row).transpose().map_err(Self::map_db_err)?)
  }

  /// Look up the deployed opaque token stored unchanged in `token_hash`.
  #[instrument(skip_all)]
  async fn get_invite_link_by_token(&self, token_hash: &str) -> AuthResult<Option<WorkspaceInviteLink>> {
    let row = sqlx::query(
      r#"
            SELECT id, workspace_id, created_by_user_id, token_hash, expires_at, revoked_at, created_at
            FROM workspace_invite_links
            WHERE token_hash = $1
            LIMIT 1
            "#,
    )
    .bind(token_hash)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.map(map_invite_link_row).transpose().map_err(Self::map_db_err)?)
  }

  /// Delete the workspace invite link.
  #[instrument(skip(self))]
  async fn revoke_invite_link(&self, workspace_id: WorkspaceId) -> AuthResult<()> {
    sqlx::query("UPDATE workspace_invite_links SET revoked_at = now() WHERE workspace_id = $1 AND revoked_at IS NULL")
      .bind(workspace_id)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    Ok(())
  }

  /// Store the initial Yjs binary payload for a workspace's root document.
  #[instrument(skip(self, data))]
  async fn init_workspace_root_doc(&self, workspace_id: WorkspaceId, user_id: UserId, data: Vec<u8>) -> AuthResult<()> {
    sqlx::query(
      r#"
            INSERT INTO docs (id, workspace_id, is_workspace_root, created_by, updated_by)
            VALUES ($1, $1, true, $2, $2)
            ON CONFLICT (id) DO NOTHING
            "#,
    )
    .bind(workspace_id)
    .bind(user_id)
    .execute(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    if !data.is_empty() {
      let has_existing_content: bool = sqlx::query_scalar(
        r#"
              SELECT
                EXISTS(SELECT 1 FROM doc_updates WHERE workspace_id = $1 AND doc_id = $1)
                OR
                EXISTS(SELECT 1 FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $1)
              "#,
      )
      .bind(workspace_id)
      .fetch_one(&self.pool)
      .await
      .map_err(Self::map_db_err)?;

      if has_existing_content {
        debug!(
          %workspace_id,
          "workspace root doc already has update or snapshot content; skipping seed payload"
        );
        return Ok(());
      }

      sqlx::query(
        r#"
              INSERT INTO doc_updates (doc_id, workspace_id, payload, sequence)
              VALUES ($1, $1, $2, 1)
              "#,
      )
      .bind(workspace_id)
      .bind(data)
      .execute(&self.pool)
      .await
      .map_err(Self::map_db_err)?;
    }

    Ok(())
  }

  #[instrument(skip_all)]
  async fn workspace_root_doc_exists(&self, workspace_id: WorkspaceId) -> AuthResult<bool> {
    let initialized: bool = sqlx::query_scalar(
      r#"
      SELECT EXISTS(
        SELECT 1
          FROM docs
         WHERE id = $1
           AND workspace_id = $1
           AND is_workspace_root = true
           AND (
             EXISTS(
               SELECT 1
                 FROM doc_updates
                WHERE workspace_id = $1
                  AND doc_id = $1
                  AND octet_length(payload) > 0
             )
             OR
             EXISTS(
               SELECT 1
                 FROM doc_snapshots
                WHERE workspace_id = $1
                  AND doc_id = $1
                  AND octet_length(payload) > 0
             )
           )
      )
      "#,
    )
    .bind(workspace_id)
    .fetch_one(&self.pool)
    .await
    .map_err(Self::map_db_err)?;
    Ok(initialized)
  }

  /// Find the user's personal workspace (INV-WS-01).
  ///
  /// The explicit marker separates this canonical userspace from any number
  /// of additional user-owned workspaces.
  ///
  /// Soft-deleted workspaces (`deleted_at IS NOT NULL`) are excluded.
  #[instrument(skip(self))]
  async fn find_personal_workspace(&self, user_id: UserId) -> AuthResult<Option<Workspace>> {
    trace!(%user_id, "db find_personal_workspace");
    let row = sqlx::query(
      r#"
      SELECT w.id, w.owner_user_id, w.name, w.description, w.avatar_key, w.public,
             w.enable_ai, w.enable_sharing, w.enable_url_preview,
             w.enable_doc_embedding, w.created_at, w.updated_at, w.initial_content_policy, w.overview_settings, w.overview_revision
      FROM   workspaces w
      WHERE  w.owner_user_id = $1
        AND  w.is_personal_workspace = TRUE
        AND  w.deleted_at IS NULL
        AND  w.lifecycle_state = 'active'
      LIMIT  1
      "#,
    )
    .bind(user_id)
    .fetch_optional(&self.pool)
    .await
    .map_err(Self::map_db_err)?;

    Ok(row.map(map_workspace_row).transpose().map_err(Self::map_db_err)?)
  }
}

pub(crate) fn map_workspace_row(row: sqlx::postgres::PgRow) -> Result<Workspace, sqlx::Error> {
  Ok(Workspace {
    initial_content_policy: serde_json::from_value(serde_json::Value::String(row.try_get("initial_content_policy")?))
      .map_err(|error| sqlx::Error::Decode(Box::new(error)))?,
    id: row.try_get("id")?,
    owner_user_id: row.try_get("owner_user_id").ok().flatten(),
    name: row.try_get("name")?,
    description: row.try_get("description")?,
    overview_settings: row.try_get::<sqlx::types::Json<_>, _>("overview_settings")?.0,
    overview_revision: row.try_get("overview_revision")?,
    avatar_key: row.try_get("avatar_key").ok(),
    public: row.try_get("public")?,
    enable_ai: row.try_get("enable_ai")?,
    enable_sharing: row.try_get("enable_sharing")?,
    enable_url_preview: row.try_get("enable_url_preview")?,
    enable_doc_embedding: row.try_get("enable_doc_embedding")?,
    created_at: row.try_get("created_at")?,
    updated_at: row.try_get("updated_at")?,
    deleted_at: row.try_get("deleted_at").ok().flatten(),
  })
}

fn map_user_row_from_users(row: sqlx::postgres::PgRow) -> Result<User, sqlx::Error> {
  let status_str: String = row.get("status");
  let disabled = status_str == "disabled";
  // Use the boolean flag instead of the full hash — avoids loading the bcrypt hash into memory.
  let has_password: bool = row.try_get("has_password").unwrap_or(false);
  Ok(User {
    id: row.get("id"),
    email: row.get("email"),
    name: row.get("name"),
    password_hash: if has_password { Some(String::new()) } else { None },
    avatar_url: None, // avatar_url is not in DB, it's computed or via avatar_key
    avatar_key: row.get("avatar_key"),
    status: if disabled {
      AccountStatus::Disabled
    } else {
      AccountStatus::Active
    },
    is_admin: row.get("is_admin"),
    registered: true, // simplified for now as we don't have the column
    disabled,
    email_verified_at: row.get("email_verified_at"),
    created_at: row.get("created_at"),
    updated_at: row.get("updated_at"),
  })
}

fn map_member_row(row: sqlx::postgres::PgRow) -> Result<WorkspaceMember, sqlx::Error> {
  let status_str: String = row.get("user_status");
  let disabled = status_str == "disabled";
  let user = User {
    id: row.get("user_id"),
    name: row.get("user_name"),
    email: row.get("user_email"),
    email_verified_at: row.get("user_email_verified_at"),
    avatar_url: None,
    avatar_key: row.get("user_avatar_key"),
    status: if disabled {
      AccountStatus::Disabled
    } else {
      AccountStatus::Active
    },
    is_admin: row.get("user_is_admin"),
    registered: true,
    disabled,
    created_at: row.get("user_created_at"),
    updated_at: row.get("user_updated_at"),
    // Use the boolean flag — avoids loading the bcrypt hash into memory.
    password_hash: if row.try_get("user_has_password").unwrap_or(false) {
      Some(String::new())
    } else {
      None
    },
  };

  let role_str: String = row.get("member_role");
  let role = match role_str.as_str() {
    "Owner" => WorkspaceRole::Owner,
    "Admin" => WorkspaceRole::Admin,
    "Manager" => WorkspaceRole::Manager,
    "Collaborator" => WorkspaceRole::Collaborator,
    "Commenter" => WorkspaceRole::Commenter,
    "Reader" => WorkspaceRole::Reader,
    _ => WorkspaceRole::External,
  };

  let status_str: String = row.get("member_status");
  let status = match status_str.as_str() {
    "Pending" => MembershipStatus::Pending,
    "UnderReview" => MembershipStatus::UnderReview,
    "AllocatingSeat" => MembershipStatus::AllocatingSeat,
    "NeedMoreSeat" => MembershipStatus::NeedMoreSeat,
    "Accepted" => MembershipStatus::Accepted,
    "Revoked" => MembershipStatus::Revoked,
    _ => MembershipStatus::Pending,
  };

  Ok(WorkspaceMember {
    workspace_id: row.get("member_workspace_id"),
    invited_by_user_id: row.get("member_inviter_id"),
    user,
    role,
    status,
    invite_id: row.get("member_invite_id"),
  })
}

fn map_invite_link_row(row: sqlx::postgres::PgRow) -> Result<WorkspaceInviteLink, sqlx::Error> {
  Ok(WorkspaceInviteLink {
    id: row.get("id"),
    workspace_id: row.get("workspace_id"),
    created_by_user_id: row.get("created_by_user_id"),
    token_hash: row.get("token_hash"),
    expires_at: row.get("expires_at"),
    revoked_at: row.get("revoked_at"),
    created_at: row.get("created_at"),
  })
}
